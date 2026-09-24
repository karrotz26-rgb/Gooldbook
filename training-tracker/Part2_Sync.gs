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

