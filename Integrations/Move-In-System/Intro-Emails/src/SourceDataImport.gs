/**
 * Import Source Data.
 *
 * Pulls the CSV attachment from the MOST RECENT Gmail message whose subject is
 * exactly "Intake Email Source [Automated Export]".
 *
 * Reliability measures:
 * - Searches Gmail without depending on a label.
 * - Remembers the source thread ID and refreshes that thread on every run.
 * - Scans every message inside every candidate thread.
 * - Compares message dates globally and selects the newest eligible message.
 * - Logs the source email timestamp, age, CSV filename, message ID and thread ID.
 * - Rewrites Source Data only for a new message, unless the destination tab is empty.
 *
 * This script must run under the Gmail account that receives the source platform emails.
 */

const SOURCE_IMPORT = {
  MAIN_SS_ID: 'YOUR_MAIN_SPREADSHEET_ID',
  MB_TAB: 'Source Data',
  LOG_SS_ID: 'YOUR_LOG_SPREADSHEET_ID',
  LOG_TAB: 'Import Logs',
  SUBJECT: 'Intake Email Source [Automated Export]',
  SEARCH_DAYS: 7,
  MAX_AGE_HOURS: 6,
  TIME_ZONE: 'America/Sao_Paulo',
  SEARCH_LIMIT: 100,
  LAST_MESSAGE_PROPERTY: 'MB_LAST_MSG_ID',
  SOURCE_THREAD_PROPERTY: 'MB_SOURCE_THREAD_ID',
  SOURCE_TIMESTAMP_PROPERTY: 'MB_LAST_SOURCE_EMAIL_TIMESTAMP'
};

function importSourceData() {
  const started = new Date();
  const functionName = 'importSourceData';

  try {
    const properties = PropertiesService.getScriptProperties();
    const source = findLatestSourceCsv_(properties);

    if (!source) {
      logImport_(functionName, started, 'ERROR',
        'No email was found with the exact subject "' + SOURCE_IMPORT.SUBJECT +
        '" and a CSV attachment within the last ' + SOURCE_IMPORT.SEARCH_DAYS +
        ' days. Confirm that this script is running under the receiving Gmail account.');
      return;
    }

    // Save the source thread immediately. Future runs will refresh it directly,
    // which avoids waiting for Gmail search indexing when a new message joins the thread.
    properties.setProperty(SOURCE_IMPORT.SOURCE_THREAD_PROPERTY, source.threadId);
    properties.setProperty(SOURCE_IMPORT.SOURCE_TIMESTAMP_PROPERTY, source.messageDate.toISOString());

    const sourceDetails = sourceLogDetails_(source, started);
    const ageHours = Math.max(0, (started.getTime() - source.messageDate.getTime()) / 3600000);
    const ageWarning = ageHours > SOURCE_IMPORT.MAX_AGE_HOURS;
    const lastMessageId = properties.getProperty(SOURCE_IMPORT.LAST_MESSAGE_PROPERTY) || '';
    const isNewMessage = source.messageId !== lastMessageId;

    const spreadsheet = SpreadsheetApp.openById(SOURCE_IMPORT.MAIN_SS_ID);
    let sheet = spreadsheet.getSheetByName(SOURCE_IMPORT.MB_TAB);
    if (!sheet) sheet = spreadsheet.insertSheet(SOURCE_IMPORT.MB_TAB);
    const destinationIsEmpty = sheet.getLastRow() < 2;

    if (!isNewMessage && !destinationIsEmpty) {
      logImport_(functionName, started, 'REVIEW',
        'No new source email; Source Data was not rewritten. ' + sourceDetails +
        (ageWarning ? ' | WARNING: source may be stale.' : ''));
      return;
    }

    const csvText = source.attachment.getDataAsString('UTF-8').replace(/^\uFEFF/, '');
    const rows = Utilities.parseCsv(csvText);
    if (!rows || rows.length < 2) {
      logImport_(functionName, started, 'REVIEW',
        'The selected CSV is empty or contains only a header. ' + sourceDetails);
      return;
    }

    const maximumColumns = rows.reduce(function(maximum, row) {
      return Math.max(maximum, row.length);
    }, 0);
    const normalizedRows = rows.map(function(row) {
      const normalized = row.slice();
      while (normalized.length < maximumColumns) normalized.push('');
      return normalized;
    });

    sheet.clearContents();
    sheet.getRange(1, 1, normalizedRows.length, maximumColumns).setValues(normalizedRows);
    properties.setProperty(SOURCE_IMPORT.LAST_MESSAGE_PROPERTY, source.messageId);

    const reason = isNewMessage ? 'new source email' : 'destination tab was empty';
    logImport_(functionName, started, ageWarning ? 'REVIEW' : 'OK',
      'Imported ' + (normalizedRows.length - 1) + ' row(s) into "' + SOURCE_IMPORT.MB_TAB +
      '" using a ' + reason + '. ' + sourceDetails +
      (ageWarning ? ' | WARNING: source may be stale.' : ''));

    // Compatibility hook: when LIVE is enabled, the queue monitor can immediately
    // reconsider rows that were waiting for Source Data.
    try {
      reEnrichSlackRows_();
    } catch (error) {
      logImport_('reEnrich(after import)', started, 'REVIEW',
        'Source Data imported successfully, but queue reprocessing failed: ' + error);
    }
  } catch (error) {
    logImport_(functionName, started, 'ERROR',
      String(error && error.stack ? error.stack : error));
  }
}

/**
 * Returns the most recent exact-subject message with a CSV attachment.
 * The remembered source thread is checked first, then Gmail search results are added.
 */
function findLatestSourceCsv_(properties) {
  const candidateThreads = [];
  const seenThreadIds = {};

  function addThread(thread) {
    if (!thread) return;
    const threadId = thread.getId();
    if (!threadId || seenThreadIds[threadId]) return;
    seenThreadIds[threadId] = true;
    try { GmailApp.refreshThread(thread); } catch (error) {}
    candidateThreads.push(thread);
  }

  const rememberedThreadId = properties.getProperty(SOURCE_IMPORT.SOURCE_THREAD_PROPERTY);
  if (rememberedThreadId) {
    try { addThread(GmailApp.getThreadById(rememberedThreadId)); }
    catch (error) { Logger.log('Remembered Gmail thread could not be loaded: ' + error); }
  }

  const query = 'in:anywhere subject:"' + SOURCE_IMPORT.SUBJECT +
    '" has:attachment newer_than:' + SOURCE_IMPORT.SEARCH_DAYS + 'd';
  GmailApp.search(query, 0, SOURCE_IMPORT.SEARCH_LIMIT).forEach(addThread);

  let latest = null;
  let eligibleMessageCount = 0;

  candidateThreads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      if (String(message.getSubject() || '').trim() !== SOURCE_IMPORT.SUBJECT) return;

      const csvAttachments = message.getAttachments().filter(function(attachment) {
        return /\.csv$/i.test(String(attachment.getName() || '').trim());
      });
      if (!csvAttachments.length) return;

      eligibleMessageCount++;
      const messageDate = message.getDate();
      if (!latest || messageDate.getTime() > latest.messageDate.getTime()) {
        latest = {
          message: message,
          attachment: csvAttachments[0],
          messageId: message.getId(),
          threadId: thread.getId(),
          messageDate: messageDate,
          attachmentName: csvAttachments[0].getName(),
          candidateThreadCount: candidateThreads.length,
          eligibleMessageCount: eligibleMessageCount
        };
      }
    });
  });

  if (latest) {
    latest.candidateThreadCount = candidateThreads.length;
    latest.eligibleMessageCount = eligibleMessageCount;
  }
  return latest;
}

function sourceLogDetails_(source, referenceDate) {
  const timestamp = Utilities.formatDate(
    source.messageDate,
    SOURCE_IMPORT.TIME_ZONE,
    'yyyy-MM-dd HH:mm:ss z'
  );
  const ageMinutes = Math.max(0, Math.round(
    (referenceDate.getTime() - source.messageDate.getTime()) / 60000
  ));
  const ageText = ageMinutes < 120
    ? ageMinutes + ' minute(s) old'
    : (ageMinutes / 60).toFixed(1) + ' hour(s) old';

  return 'Source email: ' + timestamp +
    ' | Age: ' + ageText +
    ' | CSV: "' + source.attachmentName + '"' +
    ' | Message ID: ' + source.messageId +
    ' | Thread ID: ' + source.threadId +
    ' | Candidate threads scanned: ' + source.candidateThreadCount +
    ' | Eligible exact-subject messages scanned: ' + source.eligibleMessageCount;
}

/** Log for data automations -> "Import Logs" tab. */
function logImport_(functionName, startedDate, status, comment) {
  try {
    const durationSeconds = Number(((Date.now() - startedDate.getTime()) / 1000).toFixed(1));
    const logSpreadsheet = SpreadsheetApp.openById(SOURCE_IMPORT.LOG_SS_ID);
    let logSheet = logSpreadsheet.getSheetByName(SOURCE_IMPORT.LOG_TAB);
    if (!logSheet) logSheet = logSpreadsheet.insertSheet(SOURCE_IMPORT.LOG_TAB);
    if (logSheet.getLastRow() === 0) {
      logSheet.appendRow(['Function', 'Timestamp', 'Status', 'Duration (sec)', 'Comment', 'Note']);
    }
    logSheet.appendRow([functionName, startedDate, status, durationSeconds, comment || '', '']);
  } catch (error) {
    Logger.log('logImport_ failed: ' + error);
  }
}

/** Creates/recreates the time trigger. Run once. */
function createSourceImportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'importSourceData') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('importSourceData').timeBased().everyMinutes(30).create();
}

/** Diagnostic: logs the latest eligible source without importing it. */
function inspectLatestSourceCsv() {
  const source = findLatestSourceCsv_(PropertiesService.getScriptProperties());
  if (!source) {
    Logger.log('No eligible source email found.');
    return;
  }
  Logger.log(sourceLogDetails_(source, new Date()));
}
