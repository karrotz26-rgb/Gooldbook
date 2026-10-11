// ==========================================
// CONFIGURATION AREA
// ==========================================
// The real values live only in the Apps Script editor — keep placeholders in this repo copy.
const SHEET_ID = "YOUR_SHEET_ID";
const DRIVE_FOLDER_ID = "YOUR_DRIVE_FOLDER_ID";
const MY_EMAIL = "you@example.com";

const USER_CONTACTS = {
  "Steven B.": "steven@example.com",
  "Kely Goold": "kely@example.com",
  "Numbuns": "numbuns@example.com",
  "cami wami": "cami@example.com"
};

// ==========================================
// HELPERS
// ==========================================
// Names are case-insensitive everywhere ("cami wami" === "Cami wami")
function sameName(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findContact(name) {
  const key = Object.keys(USER_CONTACTS).find(k => sameName(k, name));
  return key ? USER_CONTACTS[key] : null;
}

// ==========================================
// CHANGE TRACKING
// ==========================================
// The app sends back the version it already has; if nothing changed it gets a tiny reply
// instead of the whole feed. Covers app writes (feedVersion) and hand edits to the Sheet (lastUpdated).
function getFeedVersion() {
  const written = PropertiesService.getScriptProperties().getProperty("feedVersion") || "0";
  let edited = 0;
  try { edited = DriveApp.getFileById(SHEET_ID).getLastUpdated().getTime(); } catch (err) {}
  return written + "-" + edited;
}

function bumpFeedVersion() {
  PropertiesService.getScriptProperties().setProperty("feedVersion", String(Date.now()));
}

// ==========================================
// READ DATA
// ==========================================
function doGet(e) {
  const version = getFeedVersion();
  const clientVersion = e && e.parameter ? e.parameter.v : null;
  if (clientVersion && clientVersion === version) {
    return ContentService.createTextOutput(JSON.stringify({ unchanged: true, version: version }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheets()[0];
  const userSheet = ss.getSheetByName("Users") || ss.insertSheet("Users");
  const streakSheet = ss.getSheetByName("Streaks") || ss.insertSheet("Streaks");

  const postsData = sheet.getDataRange().getValues();
  let posts = [];

  for (let i = postsData.length - 1; i >= 1; i--) {
    if (!postsData[i][1]) continue;
    const imgCell = postsData[i][3];
    let imagesArray = [];
    if (imgCell) {
      try {
        const parsed = JSON.parse(imgCell);
        imagesArray = Array.isArray(parsed) ? parsed : [imgCell];
      } catch {
        imagesArray = [imgCell];
      }
    }
    posts.push({
      rowIndex: i + 1,
      timestamp: postsData[i][0],
      user: postsData[i][1],
      message: postsData[i][2],
      image: imagesArray[0] || "",
      images: imagesArray,
      likes: JSON.parse(postsData[i][4] || "[]"),
      comments: JSON.parse(postsData[i][5] || "[]")
    });
  }

  const usersData = userSheet.getDataRange().getValues();
  let bios = {};
  let avatars = {};
  for (let i = 1; i < usersData.length; i++) {
    const nameKey = usersData[i][0];
    if (!nameKey) continue;
    bios[nameKey] = usersData[i][1] || "";
    avatars[nameKey] = usersData[i][2] || "";
  }

  const streaksData = streakSheet.getDataRange().getValues();
  let streaks = [];
  for (let i = 1; i < streaksData.length; i++) {
    if (!streaksData[i][0]) continue;
    streaks.push({
      user: streaksData[i][0],
      streak: parseInt(streaksData[i][1] || "0"),
      lastUpdated: streaksData[i][2] ? new Date(streaksData[i][2]).toISOString().split('T')[0] : null
    });
  }

  const output = { posts: posts, bios: bios, avatars: avatars, streaks: streaks, version: version };
  return ContentService.createTextOutput(JSON.stringify(output)).setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// WRITE DATA
// ==========================================
function doPost(e) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheets()[0];
  const userSheet = ss.getSheetByName("Users") || ss.insertSheet("Users");
  const streakSheet = ss.getSheetByName("Streaks") || ss.insertSheet("Streaks");

  let data = {};
  let imageBlob = null;

  if (e.postData && e.postData.contents) {
    try {
      data = JSON.parse(e.postData.contents);
    } catch(err) {
      data = e.parameter;
    }
  } else {
    data = e.parameter;
  }

  if (data.avatar) {
    imageBlob = convertBase64ToBlob(data.avatar, data.username);
  }

  // --- ACTION: NEW POST ---
  if (data.action === "post") {
    const sources = Array.isArray(data.images) && data.images.length ? data.images
                  : (data.image ? [data.image] : []);
    let imgValue = "";
    if (sources.length > 0) {
      const urls = sources.map(src => {
        if (src.startsWith("https://")) return src;
        const blob = convertBase64ToBlob(src, data.username);
        return blob ? processAndSaveBlob(blob, "post") : "";
      }).filter(u => u);
      if (urls.length > 0) imgValue = JSON.stringify(urls);
    }
    sheet.appendRow([new Date(), data.username, data.message, imgValue, "[]", "[]"]);
    const newRowIndex = sheet.getLastRow();
    sendFamilyNotification("Post", data.username, data.message, "All", "", "", newRowIndex);
    sendMentionNotifications(data.message, data.username, newRowIndex);
  }

  // --- ACTION: UPDATE BIO ---
  else if (data.action === "updateBio") {
    const userRows = userSheet.getDataRange().getValues();
    let imgUrl = "";
    if (imageBlob) imgUrl = processAndSaveBlob(imageBlob, "avatar");

    let foundRow = -1;
    for (let i = 1; i < userRows.length; i++) {
      if (sameName(userRows[i][0], data.username)) { foundRow = i + 1; break; }
    }
    if (foundRow !== -1) {
      userSheet.getRange(foundRow, 2).setValue(data.bio);
      if (imgUrl) userSheet.getRange(foundRow, 3).setValue(imgUrl);
    } else {
      if (userSheet.getLastRow() === 0) {
        userSheet.appendRow(["User", "Bio", "AvatarUrl"]);
      }
      userSheet.appendRow([data.username, data.bio, imgUrl || ""]);
    }
  }

  // --- ACTION: LIKE ---
  else if (data.action === "like") {
    const rowIndex = parseInt(data.rowIndex);
    const range = sheet.getRange(rowIndex, 5);
    let likesData = {};
    try {
      const raw = range.getValue() || '[]';
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach(n => { if (n) likesData[String(n)] = '❤️'; });
      } else if (typeof parsed === 'object' && parsed !== null) {
        likesData = parsed;
      }
    } catch(e) { likesData = {}; }

    const em = data.emoji || '❤️';
    // Reuse the existing spelling so one person can't end up with two reactions
    const existingKey = Object.keys(likesData).find(k => sameName(k, data.username));
    const likeKey = existingKey !== undefined ? existingKey : data.username;
    const isNewLike = existingKey === undefined;
    if (likesData[likeKey] === em) {
      delete likesData[likeKey];
    } else {
      likesData[likeKey] = em;
    }
    range.setValue(JSON.stringify(likesData));

    if (isNewLike) {
      let originalAuthor = "Unknown";
      let originalMessage = "";
      let targetContact = "All";
      try {
        originalAuthor = sheet.getRange(rowIndex, 2).getValue();
        originalMessage = sheet.getRange(rowIndex, 3).getValue();
        targetContact = findContact(originalAuthor) || "All";
      } catch(err) { Logger.log("Contact error: " + err); }
      if (!sameName(data.username, originalAuthor)) {
        sendFamilyNotification("Like", data.username, "reacted to your post!", targetContact, originalAuthor, originalMessage, rowIndex);
      }
    }
  }

  // --- ACTION: NEW COMMENT ---
  else if (data.action === "comment") {
    const rowIndex = parseInt(data.rowIndex);
    const range = sheet.getRange(rowIndex, 6);
    let comments = JSON.parse(range.getValue() || "[]");
    comments.push({ user: data.username, text: data.text, time: new Date() });
    range.setValue(JSON.stringify(comments));

    let originalAuthor = "Unknown";
    let originalMessage = "";
    let targetContact = "All";
    try {
      originalAuthor = sheet.getRange(rowIndex, 2).getValue();
      originalMessage = sheet.getRange(rowIndex, 3).getValue();
      targetContact = findContact(originalAuthor) || "All";
    } catch(err) { Logger.log("Contact error: " + err); }
    if (!sameName(data.username, originalAuthor)) {
      sendFamilyNotification("Comment", data.username, data.text, targetContact, originalAuthor, originalMessage, rowIndex);
    }
    sendMentionNotifications(data.text, data.username, rowIndex);
  }

  // GLOBAL BACKEND STREAK TRACKER
  // The app now sends a streak computed from real post/comment dates
  if (data.username && data.streak !== undefined && data.streak !== null) {
    const streakRows = streakSheet.getDataRange().getValues();
    let userFound = false;
    for (let i = 1; i < streakRows.length; i++) {
      if (sameName(streakRows[i][0], data.username)) {
        streakSheet.getRange(i + 1, 2).setValue(data.streak);
        streakSheet.getRange(i + 1, 3).setValue(new Date());
        userFound = true;
        break;
      }
    }
    if (!userFound) {
      if (streakSheet.getLastRow() === 0) {
        streakSheet.appendRow(["User", "Streak", "LastUpdated"]);
      }
      streakSheet.appendRow([data.username, data.streak, new Date()]);
    }
  }

  bumpFeedVersion();
  return ContentService.createTextOutput("Success").setMimeType(ContentService.MimeType.TEXT);
}

// ==========================================
// IMAGE PROCESSING UTILITIES
// ==========================================
function convertBase64ToBlob(base64Data, username) {
  if (!base64Data || !base64Data.startsWith("data:image")) return null;
  const contentType = base64Data.substring(5, base64Data.indexOf(";"));
  const extension = contentType.split("/")[1] || "png";
  const base64Image = base64Data.split(",")[1];
  return Utilities.newBlob(Utilities.base64Decode(base64Image), contentType, `${username}_${Date.now()}.${extension}`);
}

function processAndSaveBlob(blob, folderPrefix) {
  try {
    let folder;
    try {
      folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    } catch(fErr) {
      const folderName = "Gooldbook_Photos";
      let folders = DriveApp.getFoldersByName(folderName);
      folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
    }
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileId = file.getId();
    return "https://lh3.googleusercontent.com/d/" + fileId + "=s800";
  } catch (err) {
    Logger.log("Drive upload failed: " + err);
    return "";
  }
}

// ==========================================
// NOTIFICATION SYSTEM
// ==========================================
// Same rules as the app: "@Steven B.", "@StevenB." and "@Steven" all mention "Steven B."
function getMentionedEmails(text, authorName) {
  const lower = String(text || "").toLowerCase();
  const results = [];
  if (!lower.includes("@")) return results;
  for (const [fullName, email] of Object.entries(USER_CONTACTS)) {
    if (sameName(fullName, authorName)) continue;
    const full = fullName.trim().toLowerCase();
    const aliases = [full, full.replace(/\s+/g, ""), full.split(/\s+/)[0]];
    const mentioned = aliases.some(a => a && new RegExp("@" + escapeRegex(a) + "(?![\\w])").test(lower));
    if (mentioned && !results.find(r => r.email === email)) {
      results.push({ name: fullName, email: email });
    }
  }
  return results;
}

function sendMentionNotifications(text, authorName, rowIndex) {
  const baseUrl = "https://karrotz26-rgb.github.io/Gooldbook/";
  const appUrl = rowIndex ? baseUrl + "?post=" + rowIndex : baseUrl;
  const mentioned = getMentionedEmails(text, authorName);
  mentioned.forEach(m => {
    try {
      MailApp.sendEmail({
        to: MY_EMAIL,
        subject: `[Gooldbook] Mention - ${m.name}`,
        body: `${authorName} mentioned ${m.name}:\n\n"${(text || "").substring(0, 200)}"\n\nView post: ${appUrl}`
      });
    } catch(e) { Logger.log("Mention notify failed: " + e); }
  });
}

function sendFamilyNotification(type, author, content, targetRecipient, originalAuthorName, originalPostText, rowIndex) {
  const baseUrl = "https://karrotz26-rgb.github.io/Gooldbook/";
  const appUrl = rowIndex ? baseUrl + "?post=" + rowIndex : baseUrl;
  const safeContent = content ? String(content) : "[No text provided]";
  const previewContent = safeContent.length > 120 ? safeContent.substring(0, 117) + "..." : safeContent;
  const safePostText = originalPostText ? String(originalPostText) : "";
  const postPreview = safePostText.length > 80 ? safePostText.substring(0, 77) + "..." : safePostText;
  const postContext = postPreview ? `\nOn post: "${postPreview}"` : "";

  let subject = "";
  if (type === "Post") {
    subject = `[Gooldbook] New Post`;
  } else {
    subject = `[Gooldbook] Interaction - ${originalAuthorName}`;
  }

  let body = "";
  if (type === "Post") {
    body = `🦄 ${author} just posted on theGooldbook!\n\n"${previewContent}"\n\nOpen the app: ${appUrl}`;
  } else if (type === "Like") {
    body = `❤️ ${author} reacted to your post!${postContext}\n\nJump to the post: ${appUrl}`;
  } else if (type === "Comment") {
    body = `💬 ${author} commented on your post:\n"${previewContent}"${postContext}\n\nJump to the post: ${appUrl}`;
  }

  try {
    MailApp.sendEmail({ to: MY_EMAIL, subject: subject, body: body });
  } catch (err) {
    Logger.log(`Notify failed: ${err}`);
  }
}
