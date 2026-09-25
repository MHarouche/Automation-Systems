/**
 * US Rent Payments import -> tab "PAYMENT_SOURCE Data" (replaced the old email import).
 * Install with: installPaymentSourceTrigger
 */
var PAYMENT_SOURCE = {
  SRC_ID:  'YOUR_PAYMENT_SOURCE_SPREADSHEET_ID',
  SRC_GID: 1844104132,
  SRC_NAME:'Data',
  DST_ID:  'YOUR_TAX_CONTROL_SPREADSHEET_ID',
  DST_TAB: 'PAYMENT_SOURCE Data',
  LOG_TARGETS: [
    { ID: 'YOUR_TAX_CONTROL_SPREADSHEET_ID', TAB: 'MB Log' },
    { ID: 'YOUR_LOG_SPREADSHEET_ID', TAB: 'BI platform Data' }
  ]
};

function importPAYMENT_SOURCE() {
  var start = new Date(), status = 'OK', comment = '';
  try {
    var ss  = SpreadsheetApp.openById(PAYMENT_SOURCE.SRC_ID);
    var src = sheetByGidOrName_(ss, PAYMENT_SOURCE.SRC_GID, PAYMENT_SOURCE.SRC_NAME);
    if (!src) throw new Error('Source tab not found (gid ' + PAYMENT_SOURCE.SRC_GID + ' / "' + PAYMENT_SOURCE.SRC_NAME + '").');

    var lastRow = src.getLastRow(), lastCol = src.getLastColumn();
    if (lastRow < 1 || lastCol < 1) throw new Error('Tab "' + src.getName() + '" is empty.');
    var values = src.getRange(1, 1, lastRow, lastCol).getValues();
    while (values.length && values[values.length - 1].every(function (c) { return c === '' || c === null; })) values.pop();
    if (!values.length) throw new Error('Nothing to import.');

    var dstSs = SpreadsheetApp.openById(PAYMENT_SOURCE.DST_ID);
    var dst = dstSs.getSheetByName(PAYMENT_SOURCE.DST_TAB) || dstSs.insertSheet(PAYMENT_SOURCE.DST_TAB);
    if (dst.getMaxRows()    < values.length)    dst.insertRowsAfter(dst.getMaxRows(), values.length - dst.getMaxRows());
    if (dst.getMaxColumns() < values[0].length) dst.insertColumnsAfter(dst.getMaxColumns(), values[0].length - dst.getMaxColumns());

    dst.clearContents();
    dst.getRange(1, 1, values.length, values[0].length).setValues(values);
    dst.getRange(1, 1, 1, values[0].length).setFontWeight('bold');
    dst.setFrozenRows(1);
    SpreadsheetApp.flush();

    comment = (values.length - 1) + ' row(s) x ' + values[0].length + ' column(s) from "' + src.getName() + '".';
    Logger.log(comment);
  } catch (err) {
    status = 'ERROR';
    comment = String(err && err.stack ? err.stack : err);
    Logger.log('ERROR: %s', comment);
  }
  logPaymentSourceRun_('importPAYMENT_SOURCE', start, status, comment);
}

function diagnosePAYMENT_SOURCE() {
  var ss  = SpreadsheetApp.openById(PAYMENT_SOURCE.SRC_ID);
  var src = sheetByGidOrName_(ss, PAYMENT_SOURCE.SRC_GID, PAYMENT_SOURCE.SRC_NAME);
  if (!src) { Logger.log('Tabs: %s', ss.getSheets().map(function(s){return s.getName()+' (gid '+s.getSheetId()+')';}).join(' | ')); return; }
  var head = src.getRange(1, 1, 1, src.getLastColumn()).getValues()[0];
  Logger.log('Tab "%s" | %s row(s)', src.getName(), src.getLastRow() - 1);
  head.forEach(function (h, i) { if (String(h).trim() !== '') Logger.log('   [%s] %s', i, h); });
}

function installPaymentSourceTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'importPAYMENT_SOURCE') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('importPAYMENT_SOURCE').timeBased().everyHours(1).create();
  importPAYMENT_SOURCE();
  Logger.log('Hourly trigger installed for importPAYMENT_SOURCE.');
}

function sheetByGidOrName_(ss, gid, name) {
  var sh = ss.getSheets();
  for (var i = 0; i < sh.length; i++) if (sh[i].getSheetId() === gid) return sh[i];
  return ss.getSheetByName(name);
}

function logPaymentSourceRun_(fn, start, status, comment) {
  var dur = Math.round((new Date().getTime() - start.getTime()) / 10) / 100;
  var row = [fn, start, status, dur, comment, ''];
  PAYMENT_SOURCE.LOG_TARGETS.forEach(function (t) {
    try {
      var sh = SpreadsheetApp.openById(t.ID).getSheetByName(t.TAB);
      if (!sh) return;
      if (sh.getLastRow() === 0) sh.appendRow(['Function','Timestamp','Status','Duration (sec)','Comment','Note']);
      sh.appendRow(row);
    } catch (e) { Logger.log('Log write failed (%s): %s', t.TAB, e); }
  });
}
