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

