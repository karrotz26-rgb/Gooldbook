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
