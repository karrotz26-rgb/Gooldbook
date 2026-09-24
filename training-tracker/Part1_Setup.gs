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
 * Finds which column(s) hold the name. Checks NAME_QUESTIONS first, then any
 * question with "name" in its title (ignoring "Username"), then First/Last Name.
 */
function findNameColumns(headers) {
  var clean = headers.map(function(h) { return String(h).toLowerCase().trim(); });
  for (var i = 0; i < NAME_QUESTIONS.length; i++) {
    var exact = clean.indexOf(NAME_QUESTIONS[i].toLowerCase());
    if (exact !== -1) return { full: exact };
  }
  var first = -1, last = -1, full = -1;
  for (var j = 0; j < clean.length; j++) {
    var h = clean[j];
    if (h.indexOf("name") === -1 || h.indexOf("user") !== -1 || h.indexOf("email") !== -1) continue;
    if (h.indexOf("first") !== -1) { if (first === -1) first = j; }
    else if (h.indexOf("last") !== -1 || h.indexOf("sur") !== -1) { if (last === -1) last = j; }
    else if (full === -1) full = j;
  }
  if (full !== -1) return { full: full };
  return { first: first, last: last };
}

/**
 * Backup plan when the form has no name answer: turn "jane.doe@company.com"
 * into "Jane Doe".
 */
function nameFromEmail(email) {
  var local = String(email || "").split("@")[0].replace(/[0-9]/g, "");
  return local.split(/[._\-]+/).filter(String).map(function(part) {
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join(" ");
}

/**
 * Gets the name from a list of headers and the matching answers.
 */
function readName(headers, values) {
  var cols = findNameColumns(headers);
  var name = "";
  if (cols.full !== undefined) {
    name = String(values[cols.full] || "").trim();
  } else {
    var first = cols.first !== -1 ? String(values[cols.first] || "").trim() : "";
    var last = cols.last !== -1 ? String(values[cols.last] || "").trim() : "";
    name = (first + " " + last).trim();
  }
  if (!name) {
    var clean = headers.map(function(h) { return String(h).toLowerCase().trim(); });
    var emailIdx = clean.indexOf("email address") !== -1 ? clean.indexOf("email address") : clean.indexOf("username");
    if (emailIdx !== -1) name = nameFromEmail(values[emailIdx]);
  }
  return name;
}

/**
 * Pulls the staff member's name out of a form submission (e.namedValues).
 */
function getNameFromSubmission(namedValues) {
  var headers = Object.keys(namedValues);
  var values = headers.map(function(k) { return (namedValues[k] || [""])[0]; });
  return readName(headers, values);
}

/**
 * Pulls the staff member's name out of a row of the "Form Responses 1" sheet.
 */
function getNameFromRow(row, headers) {
  return readName(headers, row);
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

