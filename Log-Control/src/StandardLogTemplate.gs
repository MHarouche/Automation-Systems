/**
 * Standard execution log template.
 *
 * Copy this file into an Apps Script project and configure these Script
 * Properties:
 *   STANDARD_LOG_SPREADSHEET_ID - destination spreadsheet ID
 *   STANDARD_LOG_SHEET_NAME     - destination tab (defaults to "Logs")
 *
 * The five output columns intentionally match BlackBox.gs:
 * Function | Timestamp | Status | Duration (sec) | Comment
 */
const STANDARD_LOG = Object.freeze({
  SPREADSHEET_ID_PROPERTY: "STANDARD_LOG_SPREADSHEET_ID",
  SHEET_NAME_PROPERTY: "STANDARD_LOG_SHEET_NAME",
  DEFAULT_SHEET_NAME: "Logs",
  HEADERS: ["Function", "Timestamp", "Status", "Duration (sec)", "Comment"]
});

function runWithStandardLog_(functionName, callback) {
  const startedAt = Date.now();

  try {
    const result = callback();
    appendStandardLog_(functionName, "OK", startedAt, "Completed successfully.");
    return result;
  } catch (error) {
    appendStandardLog_(functionName, "ERROR", startedAt, standardLogError_(error));
    throw error;
  }
}

function appendStandardLog_(functionName, status, startedAt, comment) {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty(STANDARD_LOG.SPREADSHEET_ID_PROPERTY);
  if (!spreadsheetId) {
    throw new Error(
      "Missing Script Property: " + STANDARD_LOG.SPREADSHEET_ID_PROPERTY
    );
  }

  const sheetName =
    properties.getProperty(STANDARD_LOG.SHEET_NAME_PROPERTY) ||
    STANDARD_LOG.DEFAULT_SHEET_NAME;
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const sheet = getOrCreateStandardLogSheet_(spreadsheet, sheetName);
  const durationSeconds = Math.round((Date.now() - startedAt) / 100) / 10;

  sheet.appendRow([
    String(functionName || "unknown"),
    new Date(),
    String(status || "REVIEW"),
    durationSeconds,
    String(comment || "")
  ]);
}

function getOrCreateStandardLogSheet_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, STANDARD_LOG.HEADERS.length).setValues([
      STANDARD_LOG.HEADERS
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function standardLogError_(error) {
  if (!error) return "Unknown error";
  return String(error.stack || error.message || error).slice(0, 5000);
}

function exampleLoggedJob() {
  return runWithStandardLog_("exampleLoggedJob", function () {
    // Replace this line with the automation job.
    return true;
  });
}
