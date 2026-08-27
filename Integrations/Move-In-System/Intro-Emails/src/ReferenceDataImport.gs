/**
 * Reference Properties import.
 *
 * Reads the most recent Gmail message whose subject is exactly
 * "Reference Properties [Automated Export]", combines every unique CSV
 * attachment from that one message by header name, and rewrites the
 * "Reference Properties" tab. The current source platform subscription is expected to
 * send two complementary CSV files, but the importer safely handles any
 * positive number of attachments without duplicating identical files or rows.
 */
const REFERENCE_IMPORT = {
  MAIN_SS_ID: 'YOUR_MAIN_SPREADSHEET_ID',
  TARGET_TAB: 'Reference Properties',
  LOG_SS_ID: 'YOUR_LOG_SPREADSHEET_ID',
  LOG_TAB: 'Import Logs',
  SUBJECT: 'Reference Properties [Automated Export]',
  SEARCH_DAYS: 2,
  MAX_AGE_HOURS: 6,
  LAST_SOURCE_KEY: 'REFERENCE_DATA_LAST_SOURCE'
};

function importReferenceData() {
  const started = new Date();
  const functionName = 'importReferenceData';
  try {
    const source = findLatestPropertyCsvMessage_();
    if (!source) {
      logPropertyImport_(functionName, started, 'ERROR',
        'No email with the exact subject "' + REFERENCE_IMPORT.SUBJECT + '" and a CSV attachment was found in the last ' +
        REFERENCE_IMPORT.SEARCH_DAYS + ' day(s).');
      return;
    }

    const properties = PropertiesService.getScriptProperties();
    const sourceKey = propertySourceKey_(source.message, source.attachments);
    const sourceDetails = propertySourceDetails_(source, started);
    if (properties.getProperty(REFERENCE_IMPORT.LAST_SOURCE_KEY) === sourceKey) {
      logPropertyImport_(functionName, started, 'REVIEW', 'No new source. ' + sourceDetails);
      return;
    }

    const combined = combinePropertyCsvAttachments_(source.attachments);
    const requiredHeaders = ['Property Code', 'Address State', 'Address Full'];
    const missingHeaders = requiredHeaders.filter(function(header) {
      return combined.headers.indexOf(header) === -1;
    });
    if (missingHeaders.length) {
      throw new Error('The combined CSV output is missing required header(s): ' + missingHeaders.join(', ') + '.');
    }
    if (!combined.rows.length) throw new Error('The combined CSV output contains no data rows.');

    const spreadsheet = SpreadsheetApp.openById(REFERENCE_IMPORT.MAIN_SS_ID);
    let sheet = spreadsheet.getSheetByName(REFERENCE_IMPORT.TARGET_TAB);
    if (!sheet) sheet = spreadsheet.insertSheet(REFERENCE_IMPORT.TARGET_TAB);
    sheet.clearContents();
    sheet.getRange(1, 1, 1, combined.headers.length).setValues([combined.headers]);
    sheet.getRange(2, 1, combined.rows.length, combined.headers.length).setValues(combined.rows);

    properties.setProperty(REFERENCE_IMPORT.LAST_SOURCE_KEY, sourceKey);
    const ageHours = (started.getTime() - source.message.getDate().getTime()) / 3600000;
    const status = ageHours > REFERENCE_IMPORT.MAX_AGE_HOURS ? 'REVIEW' : 'OK';
    const ageWarning = ageHours > REFERENCE_IMPORT.MAX_AGE_HOURS ? ' Source may be stale.' : '';
    logPropertyImport_(functionName, started, status,
      'Combined ' + source.attachments.length + ' unique CSV attachment(s) into ' + combined.rows.length +
      ' unique row(s) in "' + REFERENCE_IMPORT.TARGET_TAB + '". ' + sourceDetails + ageWarning);

    try { reEnrichSlackRows_(); }
    catch (error) {
      logPropertyImport_('reEnrich(after property import)', started, 'REVIEW', String(error));
    }
  } catch (error) {
    logPropertyImport_(functionName, started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

function findLatestPropertyCsvMessage_() {
  const query = 'subject:"Reference Properties Raw" subject:"Database Automation" has:attachment newer_than:' +
    REFERENCE_IMPORT.SEARCH_DAYS + 'd';
  const threads = GmailApp.search(query, 0, 100);
  let latestMessage = null;
  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      if (String(message.getSubject() || '').trim() !== REFERENCE_IMPORT.SUBJECT) return;
      const csvAttachments = uniqueCsvAttachments_(message.getAttachments());
      if (!csvAttachments.length) return;
      if (!latestMessage || message.getDate().getTime() > latestMessage.message.getDate().getTime()) {
        latestMessage = { message: message, attachments: csvAttachments };
      }
    });
  });
  return latestMessage;
}

function uniqueCsvAttachments_(attachments) {
  const seen = {};
  const output = [];
  (attachments || []).forEach(function(attachment) {
    if (!/\.csv$/i.test(String(attachment.getName() || ''))) return;
    const digest = Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, attachment.getBytes())
    );
    if (seen[digest]) return;
    seen[digest] = true;
    output.push(attachment);
  });
  return output;
}

function combinePropertyCsvAttachments_(attachments) {
  const files = attachments.map(function(attachment) {
    const text = attachment.getDataAsString('UTF-8').replace(/^\uFEFF/, '');
    const parsed = Utilities.parseCsv(text);
    if (!parsed || !parsed.length) return { name: attachment.getName(), headers: [], rows: [] };
    return {
      name: attachment.getName(),
      headers: parsed[0].map(function(header) { return String(header || '').trim(); }),
      rows: parsed.slice(1)
    };
  }).filter(function(file) { return file.headers.length; });

  if (!files.length) throw new Error('Every CSV attachment was empty.');

  const headers = [];
  files.forEach(function(file) {
    file.headers.forEach(function(header) {
      if (header && headers.indexOf(header) === -1) headers.push(header);
    });
  });

  const output = [];
  const seenRows = {};
  files.forEach(function(file) {
    const sourceMap = {};
    file.headers.forEach(function(header, index) { if (header) sourceMap[header] = index; });
    file.rows.forEach(function(sourceRow) {
      const row = headers.map(function(header) {
        return sourceMap[header] === undefined ? '' : sourceRow[sourceMap[header]];
      });
      if (!row.some(function(value) { return String(value || '').trim() !== ''; })) return;
      const propertyIndex = headers.indexOf('Property Code');
      const propertyCode = propertyIndex === -1 ? '' : String(row[propertyIndex] || '').trim();
      const key = propertyCode ? 'PROPERTY|' + propertyCode : 'ROW|' + JSON.stringify(row);
      if (seenRows[key]) return;
      seenRows[key] = true;
      output.push(row);
    });
  });
  return { headers: headers, rows: output };
}

function propertySourceKey_(message, attachments) {
  const fileParts = attachments.map(function(attachment) {
    return attachment.getName() + ':' + attachment.getBytes().length;
  }).sort();
  return message.getId() + '|' + fileParts.join('|');
}

function propertySourceDetails_(source, referenceDate) {
  const dateText = Utilities.formatDate(source.message.getDate(), 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm:ss');
  const ageHours = (referenceDate.getTime() - source.message.getDate().getTime()) / 3600000;
  const fileNames = source.attachments.map(function(attachment) { return attachment.getName(); }).join(', ');
  return 'Source email: ' + dateText + ' America/Sao_Paulo (' + ageHours.toFixed(1) + 'h old). Files: ' + fileNames + '.';
}

function logPropertyImport_(functionName, startedDate, status, comment) {
  try {
    const durationSeconds = Number(((Date.now() - startedDate.getTime()) / 1000).toFixed(1));
    const spreadsheet = SpreadsheetApp.openById(REFERENCE_IMPORT.LOG_SS_ID);
    let sheet = spreadsheet.getSheetByName(REFERENCE_IMPORT.LOG_TAB);
    if (!sheet) sheet = spreadsheet.insertSheet(REFERENCE_IMPORT.LOG_TAB);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Function', 'Timestamp', 'Status', 'Duration (sec)', 'Comment', 'Note']);
    }
    sheet.appendRow([functionName, startedDate, status, durationSeconds, comment || '', '']);
  } catch (error) {
    Logger.log('Property import logging failed: ' + error);
  }
}

function createReferenceImportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'importReferenceData') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('importReferenceData').timeBased().everyHours(1).create();
}

function inspectLatestReferenceCsv() {
  const source = findLatestPropertyCsvMessage_();
  if (!source) {
    Logger.log('No eligible Reference Properties source email found.');
    return;
  }
  Logger.log(propertySourceDetails_(source, new Date()));
}
