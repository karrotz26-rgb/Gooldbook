/**
 * ⚙️ SETTINGS
 * NAME_QUESTIONS: the form question title(s) that hold the staff member's name.
 * The first one found in the form responses is used. If your form asks for
 * first and last name separately, both are combined automatically.
 */
var NAME_QUESTIONS = ["Name", "Full Name", "Staff Name", "Employee Name", "Your Name"];
var FIRST_NAME_QUESTION = "First Name";
var LAST_NAME_QUESTION = "Last Name";

var TRACKER_HEADERS = ["Name", "Email Address", "BLS", "HIPAA", "ISSA Training", "MCN Training", "Last Updated", "Last Alert Sent"];

// Column numbers on the "Training Tracker" sheet (1 = column A)
var COL = {
  name: 1,
  email: 2,
  bls: 3,
  hipaa: 4,
  issa: 5,
  mcn: 6,
  lastUpdated: 7,
  lastAlert: 8
};

// Form question title -> tracker column. Titles must match the form EXACTLY.
var TRAINING_COLUMNS = {
  'BLS': COL.bls,
  'HIPAA': COL.hipaa,
  'ISSA Training': COL.issa,
  'MCN Training': COL.mcn
};

/**
 * 🛠️ ADMIN TOOLS: CUSTOM MENU
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('🛠️ Admin Tools')
      .addItem('Sync History to Master Table (3-Year Filter)', 'populateTrackerFromHistory')
      .addItem('🚀 Send Past Due Emails Now', 'sendManualPastDueAlerts')
      .addToUi();
}

/**
 * Pulls the staff member's name out of a form submission (e.namedValues).
 */
function getNameFromSubmission(namedValues) {
  for (var i = 0; i < NAME_QUESTIONS.length; i++) {
    var v = namedValues[NAME_QUESTIONS[i]];
    if (v && v[0] && v[0].toString().trim() !== "") return v[0].toString().trim();
  }
  var first = (namedValues[FIRST_NAME_QUESTION] || [""])[0].toString().trim();
  var last = (namedValues[LAST_NAME_QUESTION] || [""])[0].toString().trim();
  return (first + " " + last).trim();
}

/**
 * Pulls the staff member's name out of a row of the "Form Responses 1" sheet.
 */
function getNameFromRow(row, headers) {
  for (var i = 0; i < NAME_QUESTIONS.length; i++) {
    var idx = headers.indexOf(NAME_QUESTIONS[i]);
    if (idx !== -1 && row[idx] && row[idx].toString().trim() !== "") return row[idx].toString().trim();
  }
  var firstIdx = headers.indexOf(FIRST_NAME_QUESTION);
  var lastIdx = headers.indexOf(LAST_NAME_QUESTION);
  var first = firstIdx !== -1 ? row[firstIdx].toString().trim() : "";
  var last = lastIdx !== -1 ? row[lastIdx].toString().trim() : "";
  return (first + " " + last).trim();
}

/**
 * 🔄 AUTOMATIC UPDATE (ON FORM SUBMIT)
 * Updates the specific column for the staff member, their name, and the "Last Updated" time.
 */
function updateStaffTrainingSmart(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var masterSheet = ss.getSheetByName("Training Tracker");

  if (masterSheet.getLastRow() === 0) {
    masterSheet.appendRow(TRACKER_HEADERS);
  }

  var email = (e.namedValues['Email Address'] || e.namedValues['Username'] || [""])[0].toString().toLowerCase().trim();
  if (!email) return;

  var name = getNameFromSubmission(e.namedValues);

  var data = masterSheet.getDataRange().getValues();
  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][COL.email - 1]).toLowerCase().trim() === email) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex === -1) {
    masterSheet.appendRow([name, email, "", "", "", "", "", ""]);
    rowIndex = masterSheet.getLastRow();
  } else if (name) {
    // Keep the name current (e.g. if they fixed a typo or changed their name)
    masterSheet.getRange(rowIndex, COL.name).setValue(name);
  }

  var wasUpdated = false;
  for (var question in TRAINING_COLUMNS) {
    if (e.namedValues[question] && e.namedValues[question][0] !== "") {
      masterSheet.getRange(rowIndex, TRAINING_COLUMNS[question]).setValue(e.namedValues[question][0]);
      wasUpdated = true;
    }
  }

  if (wasUpdated) {
    masterSheet.getRange(rowIndex, COL.lastUpdated).setValue(new Date());
  }
}

/**
 * 📂 HISTORICAL SYNC
 * Rebuilds the Master Table from old responses, ignoring data > 3 years old.
 */
function populateTrackerFromHistory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var responseSheet = ss.getSheetByName("Form Responses 1");
  var masterSheet = ss.getSheetByName("Training Tracker");

  var rawData = responseSheet.getDataRange().getValues();
  var headers = rawData[0];

  var cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 3);

  function getValidDate(val) {
    if (!val || val === "") return "";
    var d = new Date(val);
    return (d >= cutoffDate) ? val : "";
  }

  // Keep any "Last Alert Sent" dates so a sync doesn't erase them
  var previousAlerts = {};
  var oldData = masterSheet.getLastRow() > 1 ? masterSheet.getDataRange().getValues() : [];
  for (var r = 1; r < oldData.length; r++) {
    var oldEmail = String(oldData[r][COL.email - 1]).toLowerCase().trim();
    if (oldEmail && oldData[r][COL.lastAlert - 1]) previousAlerts[oldEmail] = oldData[r][COL.lastAlert - 1];
  }

  if (masterSheet.getLastRow() > 0) { masterSheet.clearContents(); }
  masterSheet.appendRow(TRACKER_HEADERS);

  var colMap = {
    email: headers.indexOf("Email Address") !== -1 ? headers.indexOf("Email Address") : headers.indexOf("Username"),
    bls: headers.indexOf("BLS"),
    hipaa: headers.indexOf("HIPAA"),
    issa: headers.indexOf("ISSA Training"),
    mcn: headers.indexOf("MCN Training"),
    timestamp: 0
  };

  var tracker = {};

  for (var i = 1; i < rawData.length; i++) {
    var row = rawData[i];
    var email = row[colMap.email].toString().toLowerCase().trim();
    if (!email) continue;

    if (!tracker[email]) {
      tracker[email] = {name: "", bls: "", hipaa: "", issa: "", mcn: "", lastUpdated: new Date(0)};
    }

    // Responses are in date order, so the latest non-blank name wins
    var name = getNameFromRow(row, headers);
    if (name) tracker[email].name = name;

    var blsVal = colMap.bls !== -1 ? getValidDate(row[colMap.bls]) : "";
    var hipaaVal = colMap.hipaa !== -1 ? getValidDate(row[colMap.hipaa]) : "";
    var issaVal = colMap.issa !== -1 ? getValidDate(row[colMap.issa]) : "";
    var mcnVal = colMap.mcn !== -1 ? getValidDate(row[colMap.mcn]) : "";

    if (blsVal !== "") tracker[email].bls = blsVal;
    if (hipaaVal !== "") tracker[email].hipaa = hipaaVal;
    if (issaVal !== "") tracker[email].issa = issaVal;
    if (mcnVal !== "") tracker[email].mcn = mcnVal;

    var rowTimestamp = new Date(row[colMap.timestamp]);
    if (rowTimestamp > tracker[email].lastUpdated) {
      tracker[email].lastUpdated = rowTimestamp;
    }
  }

  var finalRows = [];
  for (var userEmail in tracker) {
    var t = tracker[userEmail];
    finalRows.push([t.name, userEmail, t.bls, t.hipaa, t.issa, t.mcn, t.lastUpdated, previousAlerts[userEmail] || ""]);
  }

  // Alphabetical by name (people without a name go to the bottom)
  finalRows.sort(function(a, b) {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    return a[0].toString().localeCompare(b[0].toString());
  });

  if (finalRows.length > 0) {
    masterSheet.getRange(2, 1, finalRows.length, TRACKER_HEADERS.length).setValues(finalRows);
  }
  SpreadsheetApp.getUi().alert("Sync Complete!");
}

/**
 * 📧 MANUAL PAST DUE ALERTS
 * Sends one email per person listing all their expired/missing trainings.
 * Logic: BLS (2 years), Others (1 year).
 */
function sendManualPastDueAlerts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Training Tracker");
  var data = sheet.getDataRange().getValues();
  var today = new Date();

  var twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(today.getFullYear() - 2);

  var oneYearAgo = new Date();
  oneYearAgo.setFullYear(today.getFullYear() - 1);

  var emailsSent = 0;

  for (var i = 1; i < data.length; i++) {
    var name = data[i][COL.name - 1];
    var email = String(data[i][COL.email - 1]).trim();
    if (!email) continue;

    var trainings = [
      { name: "BLS", date: data[i][COL.bls - 1], cutoff: twoYearsAgo },
      { name: "HIPAA", date: data[i][COL.hipaa - 1], cutoff: oneYearAgo },
      { name: "ISSA Training", date: data[i][COL.issa - 1], cutoff: oneYearAgo },
      { name: "MCN Training", date: data[i][COL.mcn - 1], cutoff: oneYearAgo }
    ];

    var pastDueList = [];
    trainings.forEach(function(item) {
      var trainingDate = item.date ? new Date(item.date) : null;
      if (!trainingDate || isNaN(trainingDate.getTime()) || trainingDate < item.cutoff) {
        pastDueList.push(item.name);
      }
    });

    if (pastDueList.length > 0) {
      var greeting = name ? "Hello " + name + "," : "Hello,";
      var subject = "Required Staff Trainings Past Due";
      var message = greeting + "\n\nIt looks like the following required trainings are missing or expired (BLS is required every 2 years; all others are required annually):\n\n" +
                    " • " + pastDueList.join("\n • ") +
                    "\n\nPlease complete these as soon as possible and submit the update form via the link below:\n\n" +
                    "https://docs.google.com/forms/d/e/1FAIpQLSc5NSnkEUI0cZGkbQL4Wvw3OiMkWkZnP6O3rsj8e8Y0ihGiaw/viewform";

      try {
        MailApp.sendEmail(email, subject, message);
        emailsSent++;
        sheet.getRange(i + 1, COL.lastAlert).setValue(new Date());
      } catch (err) {
        Logger.log("Failed to send to: " + email);
      }
    }
  }

  SpreadsheetApp.getUi().alert("Process Complete: " + emailsSent + " alert emails were sent.");
}
