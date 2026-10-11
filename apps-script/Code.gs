// ==========================================
// CONFIGURATION AREA
// ==========================================
// The real values live only in the Apps Script editor — keep placeholders in this repo copy.
const SHEET_ID = "YOUR_SHEET_ID";
const DRIVE_FOLDER_ID = "YOUR_DRIVE_FOLDER_ID";
const MY_EMAIL = "you@example.com";
const APP_URL = "https://karrotz26-rgb.github.io/Gooldbook/";

// Only used once, to fill the "Members" tab the first time it's created.
// After that, the Members tab in the Sheet is the family list (add/remove people there).
// Whoever has MY_EMAIL becomes the admin who approves join requests.
const USER_CONTACTS = {
  "Steven B.": "steven@example.com",
  "Kely Goold": "kely@example.com",
  "Numbuns": "numbuns@example.com",
  "cami wami": "cami@example.com"
};

// How notifications are sent (all as emails to MY_EMAIL, which your iPhone Shortcuts turn into texts):
//   "classic" = the original subjects ("[Gooldbook] New Post", "[Gooldbook] Interaction - Name", "[Gooldbook] Mention - Name")
//   "text"    = one Shortcut for everything: subject "Gooldbook text to: <who>" (what the automation
//               triggers on), body = "<who>###<message>" on one line (what the Shortcut reads)
const NOTIFY_MODE = "text";
const TEXT_SUBJECT = "Gooldbook text to: ";
// "Text", " text " etc. all count as text mode
const TEXT_MODE = String(NOTIFY_MODE).trim().toLowerCase() === "text";
const TEXT_SEPARATOR = "###";
// In "text" mode, also text sign-in codes through the Shortcut (they're still emailed to the person too,
// so sign-in works even if your phone is off). Codes pass through MY_EMAIL's inbox when this is on.
const CODE_BY_TEXT = true;

const CODE_TTL_SECONDS = 600;      // sign-in codes expire after 10 minutes
const CODE_MAX_TRIES = 5;          // wrong guesses allowed per code
const CODES_PER_10_MIN = 3;        // emails per person per 10 minutes
const SESSION_CACHE_SECONDS = 3600;
const MAX_PENDING_REQUESTS = 20;
const JOIN_REQUESTS_PER_DEVICE_PER_DAY = 3;

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

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

let _ss = null;
function openSpreadsheet() {
  if (!_ss) _ss = SpreadsheetApp.openById(SHEET_ID);
  return _ss;
}

function sha256(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

function randomCode() {
  const n = parseInt(Utilities.getUuid().replace(/-/g, "").slice(0, 12), 16) % 1000000;
  return String(n).padStart(6, "0");
}

function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return "your email";
  return local.charAt(0) + "•••••" + (local.length > 1 ? local.charAt(local.length - 1) : "") + "@" + domain;
}

function getOrCreateSheet(name, headers) {
  const ss = openSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

// ==========================================
// MEMBERS (the family list)
// ==========================================
const MEMBER_HEADERS = ["Name", "Email", "Role", "Added", "Text To", "New posts", "Comments", "Reactions", "Mentions"];
const NOTIFY_KEYS = ["newPosts", "comments", "reactions", "mentions"]; // columns F–I

function getMembersSheet() {
  const ss = openSpreadsheet();
  let sheet = ss.getSheetByName("Members");
  if (!sheet) {
    sheet = ss.insertSheet("Members");
    sheet.appendRow(MEMBER_HEADERS);
    Object.entries(USER_CONTACTS).forEach(([name, email]) => {
      sheet.appendRow([name, email, sameName(email, MY_EMAIL) ? "admin" : "member", new Date(), "", "yes", "yes", "yes", "yes"]);
    });
  } else {
    // Older Members tabs only had Name/Email/Role/Added: add the notification column headers
    const header = sheet.getDataRange().getValues()[0] || [];
    MEMBER_HEADERS.forEach((h, i) => { if (!header[i]) sheet.getRange(1, i + 1).setValue(h); });
  }
  return sheet;
}

// Blank means on, so existing members get everything until they switch something off
function isOn(cell) {
  return !/^(no|n|off|false|0)$/i.test(String(cell == null ? "" : cell).trim());
}

// Cached for 5 minutes, so hand edits to the Members tab take up to 5 minutes to apply
function getMembers() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("members");
  if (hit) return JSON.parse(hit);
  const rows = getMembersSheet().getDataRange().getValues();
  const members = rows.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => ({
      name: String(r[0]).trim(),
      email: String(r[1]).trim(),
      role: String(r[2] || "member").trim().toLowerCase(),
      textTo: String(r[4] || "").trim(),
      notify: { newPosts: isOn(r[5]), comments: isOn(r[6]), reactions: isOn(r[7]), mentions: isOn(r[8]) }
    }));
  cache.put("members", JSON.stringify(members), 300);
  return members;
}

function findMember(name) {
  return getMembers().find(m => sameName(m.name, name)) || null;
}

function adminEmails() {
  const admins = getMembers().filter(m => m.role === "admin").map(m => m.email);
  return admins.length ? admins : [MY_EMAIL];
}

// Names and photos for the sign-in screen (no emails)
function publicMembers() {
  const usersData = (openSpreadsheet().getSheetByName("Users") || { getDataRange: () => ({ getValues: () => [] }) }).getDataRange().getValues();
  return getMembers().map(m => {
    const row = usersData.find((r, i) => i > 0 && sameName(r[0], m.name));
    return { name: m.name, avatar: row ? (row[2] || "") : "" };
  });
}

// ==========================================
// SIGN-IN SESSIONS
// ==========================================
// Each signed-in device has its own token. Only a hash of it is stored, in the Sessions tab.
function getSessionsSheet() {
  return getOrCreateSheet("Sessions", ["TokenHash", "Name", "Created", "LastSeen", "Device"]);
}

function createSession(name, device) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "");
  getSessionsSheet().appendRow([sha256(token), name, new Date(), new Date(), String(device || "").slice(0, 80)]);
  return token;
}

// Returns the signed-in member, or null (bad token, signed out, or removed from Members)
function getSessionMember(token) {
  if (!token || String(token).length < 20) return null;
  const hash = sha256(token);
  const cache = CacheService.getScriptCache();
  let name = cache.get("s_" + hash);
  if (!name) {
    const sheet = getSessionsSheet();
    const rows = sheet.getDataRange().getValues();
    const i = rows.findIndex((r, idx) => idx > 0 && r[0] === hash);
    if (i < 1) return null;
    name = String(rows[i][1]);
    sheet.getRange(i + 1, 4).setValue(new Date());
    cache.put("s_" + hash, name, SESSION_CACHE_SECONDS);
  }
  return findMember(name);
}

function endSessions(token, everywhere) {
  const hash = sha256(token);
  const sheet = getSessionsSheet();
  const rows = sheet.getDataRange().getValues();
  const mine = rows.find((r, idx) => idx > 0 && r[0] === hash);
  if (!mine) return;
  const cache = CacheService.getScriptCache();
  // Delete from the bottom up so row numbers stay valid
  for (let i = rows.length - 1; i >= 1; i--) {
    if (everywhere ? sameName(rows[i][1], mine[1]) : rows[i][0] === hash) {
      cache.remove("s_" + rows[i][0]);
      sheet.deleteRow(i + 1);
    }
  }
}

// ==========================================
// SIGN-IN CODES
// ==========================================
function codeKey(name) {
  return "code_" + sha256(String(name).trim().toLowerCase());
}

function requestCode(data) {
  const member = findMember(data.name);
  if (!member) return { error: "unknown", message: "That name isn't on the family list." };
  const cache = CacheService.getScriptCache();
  const key = codeKey(member.name);
  const sentCount = parseInt(cache.get("sent_" + key) || "0");
  if (sentCount >= CODES_PER_10_MIN) {
    return { error: "tooMany", message: "Too many codes sent. Please wait 10 minutes and try again." };
  }
  const code = randomCode();
  cache.put(key, JSON.stringify({ hash: sha256(code), tries: 0, expires: Date.now() + CODE_TTL_SECONDS * 1000 }), CODE_TTL_SECONDS);
  cache.put("sent_" + key, String(sentCount + 1), CODE_TTL_SECONDS);
  MailApp.sendEmail({
    to: member.email,
    subject: `Your Gooldbook code: ${code}`,
    body: `Hi ${member.name}!\n\nYour theGooldbook sign-in code is: ${code}\n\nIt works for 10 minutes. If you didn't ask for this, you can ignore this email.\n\n🦄 ${APP_URL}`
  });
  let textedTo = "";
  if (TEXT_MODE && CODE_BY_TEXT) {
    try {
      sendTextEmail([textTarget(member)], `Your Gooldbook sign-in code is ${code}. It works for 10 minutes.`);
      textedTo = textHint(textTarget(member));
    } catch (err) { Logger.log("Code text failed: " + err); }
  }
  return { ok: true, name: member.name, emailHint: maskEmail(member.email), textHint: textedTo };
}

function verifyCode(data) {
  const member = findMember(data.name);
  if (!member) return { error: "unknown", message: "That name isn't on the family list." };
  const cache = CacheService.getScriptCache();
  const key = codeKey(member.name);
  const raw = cache.get(key);
  if (!raw) return { error: "expired", message: "That code has expired. Tap \"Resend code\" for a new one." };
  const state = JSON.parse(raw);
  const secondsLeft = Math.floor((state.expires - Date.now()) / 1000);
  if (secondsLeft <= 0 || state.tries >= CODE_MAX_TRIES) {
    cache.remove(key);
    return { error: "expired", message: "That code has expired. Tap \"Resend code\" for a new one." };
  }
  const entered = String(data.code || "").replace(/\D/g, "");
  if (sha256(entered) !== state.hash) {
    state.tries++;
    if (state.tries >= CODE_MAX_TRIES) cache.remove(key);
    else cache.put(key, JSON.stringify(state), secondsLeft);
    const left = CODE_MAX_TRIES - state.tries;
    return { error: "wrong", message: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Tap \"Resend code\" for a new one." };
  }
  cache.remove(key);
  const token = createSession(member.name, data.device);
  return { ok: true, token: token, me: { name: member.name, role: member.role } };
}

// ==========================================
// REQUESTS TO JOIN
// ==========================================
const REQUEST_HEADERS = ["Id", "Name", "Email", "Note", "Requested", "Status", "Phone"];

function getRequestsSheet() {
  const sheet = getOrCreateSheet("Requests", REQUEST_HEADERS);
  // Requests tabs made before the phone field existed: add the Phone header
  const header = sheet.getDataRange().getValues()[0] || [];
  if (!header[6]) sheet.getRange(1, 7).setValue("Phone");
  return sheet;
}

// Optional cell number from the join form: digits with the usual separators, 7–15 digits
function cleanPhone(raw) {
  const phone = String(raw || "").trim().slice(0, 30);
  if (!phone) return { ok: true, phone: "" };
  const digits = phone.replace(/\D/g, "");
  if (!/^\+?[0-9 ()\-.]+$/.test(phone) || digits.length < 7 || digits.length > 15) return { ok: false };
  return { ok: true, phone: phone.replace(/\s+/g, " ") };
}

function requestJoin(data) {
  const name = String(data.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const email = String(data.email || "").trim().toLowerCase().slice(0, 100);
  const note = String(data.note || "").trim().slice(0, 300);
  const phone = cleanPhone(data.phone);
  if (name.length < 2) return { error: "name", message: "Please enter your name." };
  if (!phone.ok) return { error: "phone", message: "That phone number doesn't look right. Include the country code if you're outside the US, or leave it blank." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "email", message: "Please enter a valid email address." };
  if (findMember(name)) return { error: "nameTaken", message: "Someone in the family already uses that name. Try adding a last initial." };
  if (getMembers().some(m => m.email.toLowerCase() === email)) {
    return { error: "alreadyMember", message: "That email already has an account. Go back and pick your name to sign in." };
  }

  const sheet = getRequestsSheet();
  const rows = sheet.getDataRange().getValues();
  const pending = rows.slice(1).filter(r => r[5] === "pending");
  const existing = pending.find(r => String(r[2]).toLowerCase() === email);
  if (existing) return { ok: true, id: existing[0], name: existing[1], emailHint: maskEmail(email) };
  if (pending.some(r => sameName(r[1], name))) {
    return { error: "nameTaken", message: "Someone already asked to join with that name. Try adding a last initial." };
  }
  if (pending.length >= MAX_PENDING_REQUESTS) return { error: "busy", message: "Too many requests are waiting right now. Please try again later." };

  const cache = CacheService.getScriptCache();
  const deviceKey = "join_" + sha256(String(data.device || "unknown"));
  const deviceCount = parseInt(cache.get(deviceKey) || "0");
  if (deviceCount >= JOIN_REQUESTS_PER_DEVICE_PER_DAY) {
    return { error: "tooMany", message: "Too many requests from this device today. Please try again tomorrow." };
  }
  cache.put(deviceKey, String(deviceCount + 1), 86400);

  const id = Utilities.getUuid();
  sheet.appendRow([id, name, email, note, new Date(), "pending", phone.phone]);
  bumpFeedVersion();
  try {
    MailApp.sendEmail({
      to: adminEmails().join(","),
      subject: `[Gooldbook] ${name} asked to join`,
      body: `✋ ${name} (${email}${phone.phone ? ", " + phone.phone : ""}) asked to join theGooldbook.${note ? `\n\nTheir note: "${note}"` : ""}\n\nOpen the app to approve or decline: ${APP_URL}`
    });
  } catch (err) { Logger.log("Join request email failed: " + err); }
  return { ok: true, id: id, name: name, emailHint: maskEmail(email) };
}

function joinStatus(data) {
  const rows = getRequestsSheet().getDataRange().getValues();
  const row = rows.find((r, i) => i > 0 && r[0] === data.id);
  if (!row) return { status: "missing" };
  return { status: row[5], name: row[1] };
}

function pendingRequests() {
  const rows = getRequestsSheet().getDataRange().getValues();
  return rows.slice(1).filter(r => r[5] === "pending")
    .map(r => ({ id: r[0], name: r[1], email: r[2], note: r[3], time: r[4], phone: r[6] || "" }));
}

function decideRequest(id, approve) {
  const sheet = getRequestsSheet();
  const rows = sheet.getDataRange().getValues();
  const i = rows.findIndex((r, idx) => idx > 0 && r[0] === id);
  if (i < 1 || rows[i][5] !== "pending") return { error: "missing", message: "That request was already handled." };
  const name = rows[i][1], email = rows[i][2], phone = String(rows[i][6] || "").trim();
  if (!approve) {
    sheet.getRange(i + 1, 6).setValue("declined");
    bumpFeedVersion();
    return { ok: true, name: name };
  }
  if (findMember(name)) return { error: "nameTaken", message: `Someone is already called "${name}". Rename them in the Requests tab first.` };
  // Their texts (notifications and sign-in codes) go to the phone they gave, if any
  getMembersSheet().appendRow([name, email, "member", new Date(), phone, "yes", "yes", "yes", "yes"]);
  CacheService.getScriptCache().remove("members");
  sheet.getRange(i + 1, 6).setValue("approved");
  bumpFeedVersion();
  try {
    MailApp.sendEmail({
      to: email,
      subject: "You're in! Welcome to theGooldbook 🦄",
      body: `Hi ${name}!\n\nYou've been approved to join theGooldbook.\n\nOpen ${APP_URL}, tap your name and we'll email you a sign-in code.\n\nTip: on iPhone or iPad, tap the Share button and "Add to Home Screen" to use it like an app.`
    });
  } catch (err) { Logger.log("Approval email failed: " + err); }
  return { ok: true, name: name };
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
  const params = (e && e.parameter) || {};
  if (params.action === "members") return json({ members: publicMembers() });

  const me = getSessionMember(params.token);
  if (!me) return json({ error: "auth" });

  const version = getFeedVersion();
  if (params.v && params.v === version) {
    return json({ unchanged: true, version: version });
  }

  const ss = openSpreadsheet();
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

  const output = {
    posts: posts, bios: bios, avatars: avatars, streaks: streaks, version: version,
    me: { name: me.name, role: me.role, notify: me.notify, textTo: textHint(textTarget(me)), notifyMode: TEXT_MODE ? "text" : "classic", email: me.email, textToRaw: me.textTo },
    requests: me.role === "admin" ? pendingRequests() : []
  };
  return json(output);
}

// ==========================================
// WRITE DATA
// ==========================================
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return json(handlePost(e));
  } finally {
    lock.releaseLock();
  }
}

function handlePost(e) {
  let data = {};
  if (e.postData && e.postData.contents) {
    try {
      data = JSON.parse(e.postData.contents);
    } catch(err) {
      data = e.parameter;
    }
  } else {
    data = e.parameter;
  }

  // --- Actions that work before signing in ---
  if (data.action === "requestCode") return requestCode(data);
  if (data.action === "verifyCode") return verifyCode(data);
  if (data.action === "requestJoin") return requestJoin(data);
  if (data.action === "joinStatus") return joinStatus(data);

  // --- Everything else needs a signed-in member ---
  const me = getSessionMember(data.token);
  if (!me) return { error: "auth" };
  // The name always comes from the sign-in, never from what the app sends
  data.username = me.name;

  if (data.action === "signOut") { endSessions(data.token, false); return { ok: true }; }
  if (data.action === "signOutAll") { endSessions(data.token, true); return { ok: true }; }
  if (data.action === "setNotify") return setNotify(me, data.notify || {});
  if (data.action === "setTextTo") return setTextTo(me, data.textTo);
  if (data.action === "requestEmailChange") return requestEmailChange(me, data.email);
  if (data.action === "confirmEmailChange") return confirmEmailChange(me, data.code);
  if (data.action === "approveRequest" || data.action === "declineRequest") {
    if (me.role !== "admin") return { error: "forbidden", message: "Only the family admin can do that." };
    return decideRequest(data.id, data.action === "approveRequest");
  }

  const ss = openSpreadsheet();
  const sheet = ss.getSheets()[0];
  const userSheet = ss.getSheetByName("Users") || ss.insertSheet("Users");
  const streakSheet = ss.getSheetByName("Streaks") || ss.insertSheet("Streaks");

  let imageBlob = null;
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
    if (TEXT_MODE) {
      sendTextNotifications({ type: "post", author: data.username, text: data.message, rowIndex: newRowIndex });
    } else {
      sendFamilyNotification("Post", data.username, data.message, "All", "", "", newRowIndex);
      sendMentionNotifications(data.message, data.username, newRowIndex);
    }
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
      if (TEXT_MODE) {
        sendTextNotifications({ type: "reaction", author: data.username, emoji: em, rowIndex: rowIndex, postAuthor: originalAuthor, postText: originalMessage });
      } else if (!sameName(data.username, originalAuthor)) {
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
    if (TEXT_MODE) {
      sendTextNotifications({ type: "comment", author: data.username, text: data.text, rowIndex: rowIndex, postAuthor: originalAuthor, postText: originalMessage });
    } else {
      if (!sameName(data.username, originalAuthor)) {
        sendFamilyNotification("Comment", data.username, data.text, targetContact, originalAuthor, originalMessage, rowIndex);
      }
      sendMentionNotifications(data.text, data.username, rowIndex);
    }
  }

  else {
    return { error: "unknownAction" };
  }

  // GLOBAL BACKEND STREAK TRACKER
  // The app sends a streak computed from real post/comment dates
  if (data.streak !== undefined && data.streak !== null) {
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
  return { ok: true };
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
function findContact(name) {
  const member = findMember(name);
  return member ? member.email : null;
}

// Same rules as the app: "@Steven B.", "@StevenB." and "@Steven" all mention "Steven B."
function getMentionedMembers(text, authorName) {
  const lower = String(text || "").toLowerCase();
  if (!lower.includes("@")) return [];
  return getMembers().filter(m => {
    if (sameName(m.name, authorName)) return false;
    const full = m.name.trim().toLowerCase();
    const aliases = [full, full.replace(/\s+/g, ""), full.split(/\s+/)[0]];
    return aliases.some(a => a && new RegExp("@" + escapeRegex(a) + "(?![\\w])").test(lower));
  });
}

function getMentionedEmails(text, authorName) {
  return getMentionedMembers(text, authorName).map(m => ({ name: m.name, email: m.email }));
}

// ---- "text" mode: one email per message, listing everyone who should get it ----

// Where a member's texts go: the Text To column, or their sign-in email (iMessage) if it's blank
function textTarget(member) {
  return member.textTo || member.email;
}

function textHint(target) {
  if (String(target).includes("@")) return maskEmail(target);
  const digits = String(target).replace(/\D/g, "");
  return "•••" + digits.slice(-4);
}

function shortPreview(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 100 ? s.substring(0, 97) + "..." : s;
}

// Each person gets at most one text per event; a mention beats "commented on your post" and "new post"
function sendTextNotifications(ev) {
  const url = APP_URL + "?post=" + ev.rowIndex;
  const done = {};
  done[String(ev.author).trim().toLowerCase()] = true;
  const groups = {};
  const add = (member, pref, message) => {
    const key = member.name.trim().toLowerCase();
    if (done[key] || !member.notify[pref]) return;
    done[key] = true;
    (groups[message] = groups[message] || []).push(textTarget(member));
  };

  if (ev.type !== "reaction") {
    getMentionedMembers(ev.text, ev.author).forEach(m =>
      add(m, "mentions", `📣 ${ev.author} mentioned you on theGooldbook: "${shortPreview(ev.text)}" ${url}`));
  }
  const owner = ev.postAuthor ? findMember(ev.postAuthor) : null;
  if (ev.type === "comment" && owner) {
    add(owner, "comments", `💬 ${ev.author} commented on your post: "${shortPreview(ev.text)}" ${url}`);
  }
  if (ev.type === "reaction" && owner) {
    add(owner, "reactions", `${ev.emoji || "❤️"} ${ev.author} reacted to your post "${shortPreview(ev.postText)}" ${url}`);
  }
  if (ev.type === "post") {
    getMembers().forEach(m => add(m, "newPosts", `🦄 ${ev.author} posted on theGooldbook: "${shortPreview(ev.text)}" ${url}`));
  }

  Object.keys(groups).forEach(message => {
    try {
      sendTextEmail(groups[message], message);
    } catch (err) { Logger.log("Text notify failed: " + err); }
  });
}

// One email for the Shortcut. Shortcuts can read the body but not always the subject, so the body
// carries everything on a single line: recipients (comma-separated, no spaces), ###, then the message.
function sendTextEmail(targets, message) {
  const recipients = targets.map(t => String(t).replace(/[,#]/g, "").trim()).filter(t => t);
  if (!recipients.length) return;
  // Keep the separator unique so the Shortcut's split always gives exactly two parts
  const text = String(message).replace(/\s+/g, " ").replace(/#{3,}/g, "#").trim();
  MailApp.sendEmail({
    to: MY_EMAIL,
    subject: TEXT_SUBJECT + recipients.join(", "),
    body: recipients.join(",") + TEXT_SEPARATOR + text
  });
}

// ==========================================
// SELF-SERVICE CONTACT DETAILS (from each person's profile)
// ==========================================
function memberRowIndex(sheet, name) {
  const rows = sheet.getDataRange().getValues();
  return rows.findIndex((r, idx) => idx > 0 && sameName(r[0], name));
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Where my texts go: a phone number, an iMessage email, or blank for my sign-in email
function setTextTo(me, raw) {
  const value = String(raw || "").trim();
  let clean = "";
  if (value) {
    if (isEmail(value)) clean = value.toLowerCase().slice(0, 100);
    else {
      const phone = cleanPhone(value);
      if (!phone.ok || !phone.phone) return { error: "textTo", message: "Enter a phone number (with country code if outside the US) or an iMessage email — or leave it blank to use your email." };
      clean = phone.phone;
    }
  }
  const sheet = getMembersSheet();
  const i = memberRowIndex(sheet, me.name);
  if (i < 1) return { error: "missing" };
  sheet.getRange(i + 1, 5).setValue(clean);
  CacheService.getScriptCache().remove("members");
  return { ok: true, textToRaw: clean, textTo: textHint(clean || me.email) };
}

// Changing the sign-in email: a code goes to the NEW address and nothing changes until it's entered
function emailChangeKey(name) {
  return "emailchg_" + sha256(String(name).trim().toLowerCase());
}

function requestEmailChange(me, raw) {
  const email = String(raw || "").trim().toLowerCase().slice(0, 100);
  if (!isEmail(email)) return { error: "email", message: "Please enter a valid email address." };
  if (email === me.email.toLowerCase()) return { error: "same", message: "That's already your email." };
  if (getMembers().some(m => !sameName(m.name, me.name) && m.email.toLowerCase() === email)) {
    return { error: "taken", message: "Someone else in the family already uses that email." };
  }
  const cache = CacheService.getScriptCache();
  const key = emailChangeKey(me.name);
  const sentCount = parseInt(cache.get("sent_" + key) || "0");
  if (sentCount >= CODES_PER_10_MIN) return { error: "tooMany", message: "Too many codes sent. Please wait 10 minutes and try again." };
  const code = randomCode();
  cache.put(key, JSON.stringify({ hash: sha256(code), email: email, tries: 0, expires: Date.now() + CODE_TTL_SECONDS * 1000 }), CODE_TTL_SECONDS);
  cache.put("sent_" + key, String(sentCount + 1), CODE_TTL_SECONDS);
  MailApp.sendEmail({
    to: email,
    subject: `Your Gooldbook code: ${code}`,
    body: `Hi ${me.name}!\n\nTo make this your theGooldbook email, enter this code: ${code}\n\nIt works for 10 minutes. If you didn't ask for this, you can ignore this email.\n\n🦄 ${APP_URL}`
  });
  return { ok: true, emailHint: maskEmail(email) };
}

function confirmEmailChange(me, rawCode) {
  const cache = CacheService.getScriptCache();
  const key = emailChangeKey(me.name);
  const raw = cache.get(key);
  if (!raw) return { error: "expired", message: "That code has expired. Start the change again." };
  const state = JSON.parse(raw);
  const secondsLeft = Math.floor((state.expires - Date.now()) / 1000);
  if (secondsLeft <= 0 || state.tries >= CODE_MAX_TRIES) {
    cache.remove(key);
    return { error: "expired", message: "That code has expired. Start the change again." };
  }
  if (sha256(String(rawCode || "").replace(/\D/g, "")) !== state.hash) {
    state.tries++;
    if (state.tries >= CODE_MAX_TRIES) cache.remove(key);
    else cache.put(key, JSON.stringify(state), secondsLeft);
    const left = CODE_MAX_TRIES - state.tries;
    return { error: "wrong", message: left > 0 ? `That code isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong tries. Start the change again." };
  }
  cache.remove(key);
  if (getMembers().some(m => !sameName(m.name, me.name) && m.email.toLowerCase() === state.email)) {
    return { error: "taken", message: "Someone else in the family already uses that email." };
  }
  const sheet = getMembersSheet();
  const i = memberRowIndex(sheet, me.name);
  if (i < 1) return { error: "missing" };
  const oldEmail = me.email;
  sheet.getRange(i + 1, 2).setValue(state.email);
  CacheService.getScriptCache().remove("members");
  try {
    MailApp.sendEmail({
      to: oldEmail,
      subject: "Your Gooldbook email was changed",
      body: `Hi ${me.name}!\n\nYour theGooldbook sign-in email was changed to ${state.email}. From now on your sign-in codes go there.\n\nIf you didn't do this, tell Steven right away.\n\n🦄 ${APP_URL}`
    });
  } catch (err) { Logger.log("Email-change notice failed: " + err); }
  const updated = findMember(me.name);
  return { ok: true, email: state.email, textTo: textHint(textTarget(updated || me)) };
}

// Lets each person switch their own texts on and off from their profile
function setNotify(me, prefs) {
  const sheet = getMembersSheet();
  const rows = sheet.getDataRange().getValues();
  const i = rows.findIndex((r, idx) => idx > 0 && sameName(r[0], me.name));
  if (i < 1) return { error: "missing" };
  NOTIFY_KEYS.forEach((key, k) => {
    if (typeof prefs[key] === "boolean") sheet.getRange(i + 1, 6 + k).setValue(prefs[key] ? "yes" : "no");
  });
  CacheService.getScriptCache().remove("members");
  const updated = findMember(me.name);
  return { ok: true, notify: updated ? updated.notify : null };
}

function sendMentionNotifications(text, authorName, rowIndex) {
  const appUrl = rowIndex ? APP_URL + "?post=" + rowIndex : APP_URL;
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
  const appUrl = rowIndex ? APP_URL + "?post=" + rowIndex : APP_URL;
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
