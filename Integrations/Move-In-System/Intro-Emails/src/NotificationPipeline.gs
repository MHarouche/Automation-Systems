/**
 * Slack / Intake pipeline.
 *
 * Flow A - captureSlackBookings (every 10 minutes):
 *   Reads today's DEPARTMENT_Y notifications and appends new bookings to the queue.
 *
 * Flow B - monitorIntakeQueue (every 15 minutes):
 *   1. Checks whether a Intake email for the Reference Code was already sent today.
 *   2. If it was sent manually, tracks it and removes the queue row.
 *   3. Otherwise, waits for Source Data, enriches the row and sends the email.
 *   4. Tracks successful sends, updates the external Reference Code control sheet, labels Gmail,
 *      replies in the original Slack thread and removes completed queue rows.
 *
 * Required Script Properties:
 *   SLACK_BOT_TOKEN
 *   TEST_NOTIF_WEBHOOK_URL
 *   SOURCE_THREAD_WEBHOOK_URL
 */

const SLACK = {
  CHANNEL_ID: 'YOUR_SOURCE_CHANNEL_ID',
  MAIN_SS_ID: 'YOUR_MAIN_SPREADSHEET_ID',
  MB_TAB: 'Source Data',
  QUEUE_TAB: 'Pending Queue',
  PROPERTY_TAB: 'Reference Properties',
  TRACKER_TAB: 'Delivery History'
};

const PIPELINE = {
  LIVE: false,
  TIME_ZONE: 'America/Sao_Paulo',
  CAPTURE_LOOKBACK_HOURS: 36,
  TEST_RECIPIENTS: [
    'maintainer@example.com',
    'reviewer-one@example.com',
    'reviewer-two@example.com'
  ]
};

const LOG_CONFIG = {
  SPREADSHEET_ID: 'YOUR_LOG_SPREADSHEET_ID',
  SHEET_NAME: 'Intake Emails Intake'
};

const INTRO_CONTROL = {
  SPREADSHEET_ID: 'YOUR_CONTROL_SPREADSHEET_ID',
  SHEET_NAME: '',
  REFERENCE_HEADER: 'PO',
  INTRO_HEADER: 'Intake Email',
  VALUE: 'C'
};

const SLACK_HEADERS = [
  'Slack Not Date', 'Slack Thread TS', 'Record Code', 'Reference Code', 'Quote Number',
  'Full Address', 'Property Name', 'External Provider', 'Lease Start',
  'Lease End Date', 'Monthly Rent', 'Security Deposit', 'Admin', 'Application',
  'Prop Pet Fee Monthly', 'Prop Pet Fee One-Time', 'Prop Cleaning Fee',
  'Parking Fee', 'Email Contact', 'Unit Email', 'BG Representative',
  'Enterprise', 'Partner', 'State'
];

const EMAIL_HEADERS = [
  'Slack Not Date', 'Slack Thread TS', 'Record Code', 'Reference Code', 'Quote Number', 'Unit No',
  'Full Address', 'Property Name', 'External Provider', 'Lease Start',
  'Lease End Date', 'Monthly Rent', 'Security Deposit', 'Admin', 'Application',
  'Prop Pet Fee Monthly', 'Prop Pet Fee One-Time', 'Prop Cleaning Fee',
  'Parking Fee', 'Email Contact', 'Unit Email', 'BG Representative',
  'Enterprise', 'Partner', 'State'
];

const TRACKER_HEADERS = [
  'Sent Timestamp', 'Record Code', 'Reference Code', 'Property Name', 'Full Address',
  'State', 'External Provider', 'Template', 'Email Contact', 'Recipient', 'Mode',
  'Monthly Rent', 'Lease Start', 'Lease End Date', 'Status', 'Comment'
];

const WARNING_HEADERS = [
  'Timestamp', 'Last Seen', 'Occurrences', 'Severity', 'Stage',
  'Record Code', 'Reference Code', 'Reason', 'Details', 'Slack Not Date',
  'Automation Comment (Please Check it):'
];

const ADMINS = {
  ADMIN_A:  { name: 'Admin A',  slackId: 'YOUR_ADMIN_A_SLACK_ID', label: 'Admin A' },
  ADMIN_B:    { name: 'Admin B',    slackId: 'YOUR_ADMIN_B_SLACK_ID', label: 'Admin B' },
  ADMIN_C: { name: 'Admin C', slackId: 'YOUR_ADMIN_C_SLACK_ID', label: 'Admin C' },
  ADMIN_D:    { name: 'Admin D',    slackId: 'YOUR_ADMIN_D_SLACK_ID', label: 'Admin D' }
};

const STATE_TO_ADMIN = {
  CT:'ADMIN_A', DE:'ADMIN_A', FL:'ADMIN_A', MS:'ADMIN_A', NH:'ADMIN_A', NJ:'ADMIN_A',
  NC:'ADMIN_A', RI:'ADMIN_A', SC:'ADMIN_A', WV:'ADMIN_A', TX:'ADMIN_A', WY:'ADMIN_A',
  DC:'ADMIN_B', GA:'ADMIN_B', IN:'ADMIN_B', ME:'ADMIN_B', MD:'ADMIN_B', MA:'ADMIN_B', MI:'ADMIN_B',
  MN:'ADMIN_B', NY:'ADMIN_B', OH:'ADMIN_B', PA:'ADMIN_B', TN:'ADMIN_B', VT:'ADMIN_B', VA:'ADMIN_B',
  WI:'ADMIN_B', OR:'ADMIN_B', UT:'ADMIN_B', KS:'ADMIN_B', MT:'ADMIN_B',
  AL:'ADMIN_C', AZ:'ADMIN_C', AR:'ADMIN_C', ID:'ADMIN_C', IL:'ADMIN_C', IA:'ADMIN_C',
  KY:'ADMIN_C', LA:'ADMIN_C', MO:'ADMIN_C', NE:'ADMIN_C', NM:'ADMIN_C', NV:'ADMIN_C',
  OK:'ADMIN_C', WA:'ADMIN_C',
  CA:'ADMIN_D', CO:'ADMIN_D', HI:'ADMIN_D', AK:'ADMIN_D', ND:'ADMIN_D', SD:'ADMIN_D'
};

const STATE_NAME_TO_CODE = {
  'alabama':'AL', 'alaska':'AK', 'arizona':'AZ', 'arkansas':'AR', 'california':'CA',
  'colorado':'CO', 'connecticut':'CT', 'delaware':'DE', 'district of columbia':'DC',
  'florida':'FL', 'georgia':'GA', 'hawaii':'HI', 'idaho':'ID', 'illinois':'IL',
  'indiana':'IN', 'iowa':'IA', 'kansas':'KS', 'kentucky':'KY', 'louisiana':'LA',
  'maine':'ME', 'maryland':'MD', 'massachusetts':'MA', 'michigan':'MI', 'minnesota':'MN',
  'mississippi':'MS', 'missouri':'MO', 'montana':'MT', 'nebraska':'NE', 'nevada':'NV',
  'new hampshire':'NH', 'new jersey':'NJ', 'new mexico':'NM', 'new york':'NY',
  'north carolina':'NC', 'north dakota':'ND', 'ohio':'OH', 'oklahoma':'OK', 'oregon':'OR',
  'pennsylvania':'PA', 'rhode island':'RI', 'south carolina':'SC', 'south dakota':'SD',
  'tennessee':'TN', 'texas':'TX', 'utah':'UT', 'vermont':'VT', 'virginia':'VA',
  'washington':'WA', 'west virginia':'WV', 'wisconsin':'WI', 'wyoming':'WY'
};

const ZIP3_RANGES = [
  [5,5,'NY'], [10,27,'MA'], [28,29,'RI'], [30,38,'NH'], [39,49,'ME'], [50,59,'VT'],
  [60,69,'CT'], [70,89,'NJ'], [100,149,'NY'], [150,196,'PA'], [197,199,'DE'],
  [200,205,'DC'], [206,219,'MD'], [220,246,'VA'], [247,268,'WV'], [270,289,'NC'],
  [290,299,'SC'], [300,319,'GA'], [320,349,'FL'], [350,369,'AL'], [370,385,'TN'],
  [386,397,'MS'], [398,399,'GA'], [400,427,'KY'], [430,459,'OH'], [460,479,'IN'],
  [480,499,'MI'], [500,528,'IA'], [530,549,'WI'], [550,567,'MN'], [570,577,'SD'],
  [580,588,'ND'], [590,599,'MT'], [600,629,'IL'], [630,658,'MO'], [660,679,'KS'],
  [680,693,'NE'], [700,715,'LA'], [716,729,'AR'], [730,749,'OK'], [750,799,'TX'],
  [800,816,'CO'], [820,831,'WY'], [832,838,'ID'], [840,847,'UT'], [850,865,'AZ'],
  [870,884,'NM'], [889,899,'NV'], [900,961,'CA'], [967,968,'HI'], [970,979,'OR'],
  [980,994,'WA'], [995,999,'AK']
];

/* ===== BASIC HELPERS ===== */

function headerMap_(headers) {
  const map = {};
  headers.forEach(function(header, index) {
    const key = String(header || '').trim();
    if (key) map[key] = index;
  });
  return map;
}

function getScriptProperty_(name, required) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (required && !value) throw new Error('Missing Script Property: ' + name);
  return value || '';
}

function formatDayKey_(date) {
  return Utilities.formatDate(date, PIPELINE.TIME_ZONE, 'yyyy-MM-dd');
}

function valueFrom_(row, map, header) {
  const index = map[header];
  return index === undefined ? '' : row[index];
}

function rowObject_(row, map) {
  const object = {};
  Object.keys(map).forEach(function(header) { object[header] = row[map[header]]; });
  return object;
}

function ensureHeaders_(sheet, requiredHeaders) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return requiredHeaders.slice();
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function(header) { return String(header || '').trim(); });
  requiredHeaders.forEach(function(header) {
    if (headers.indexOf(header) === -1) headers.push(header);
  });
  if (headers.length > sheet.getLastColumn()) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

function uniqueValues_(values) {
  const seen = {};
  return values.filter(function(value) {
    const key = String(value || '').trim();
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function withDocumentLock_(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Could not acquire the pipeline lock.');
  try { return callback(); }
  finally { lock.releaseLock(); }
}

/* ===== WARNINGS ===== */

function warningEntry_(stage, source, severity, reason, details) {
  const item = source || {};
  return {
    timestamp: new Date(),
    lastSeen: new Date(),
    occurrences: 1,
    severity: severity || 'WARNING',
    stage: stage || '',
    bookingCode: String(item['Record Code'] || item.bookingCode || '').trim(),
    poNumber: String(item['Reference Code'] || item.po || '').trim(),
    reason: String(reason || '').trim(),
    details: String(details || '').trim(),
    slackNotDate: item['Slack Not Date'] || item.notedDate || ''
  };
}

function warningKey_(entry) {
  return [entry.stage, entry.bookingCode, entry.poNumber, entry.reason].join('|').toLowerCase();
}

function warningComment_(entry) {
  const references = [];
  if (entry.bookingCode) references.push('Booking ' + entry.bookingCode);
  if (entry.poNumber) references.push('Reference Code ' + entry.poNumber);
  const prefix = '[' + String(entry.severity || 'WARNING').toUpperCase() + '] ' +
    (references.length ? references.join(' | ') + ' - ' : '');
  const reason = String(entry.reason || '').trim();
  const details = String(entry.details || '').trim();
  return prefix + reason + (details ? '. ' + details : '');
}

function upsertWarnings_(entries) {
  if (!entries || !entries.length) return;
  const compacted = {};
  entries.forEach(function(entry) {
    const key = warningKey_(entry);
    if (!compacted[key]) compacted[key] = entry;
    else {
      compacted[key].lastSeen = entry.lastSeen;
      compacted[key].occurrences += Number(entry.occurrences || 1);
      compacted[key].severity = entry.severity;
      compacted[key].details = entry.details;
      if (entry.slackNotDate) compacted[key].slackNotDate = entry.slackNotDate;
    }
  });
  entries = Object.keys(compacted).map(function(key) { return compacted[key]; });

  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  let sheet = spreadsheet.getSheetByName('Warnings');
  if (!sheet) sheet = spreadsheet.insertSheet('Warnings');
  const headers = ensureHeaders_(sheet, WARNING_HEADERS);
  const map = headerMap_(headers);

  const existing = {};
  if (sheet.getLastRow() >= 2) {
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
    data.forEach(function(row, index) {
      const entry = {
        stage: valueFrom_(row, map, 'Stage'),
        bookingCode: valueFrom_(row, map, 'Record Code'),
        poNumber: valueFrom_(row, map, 'Reference Code'),
        reason: valueFrom_(row, map, 'Reason')
      };
      existing[warningKey_(entry)] = { sheetRow: index + 2, row: row };
    });
  }

  const newRows = [];
  function setValue(row, header, value) {
    if (map[header] !== undefined) row[map[header]] = value;
  }
  function populateWarningRow(row, entry, occurrences) {
    setValue(row, 'Timestamp', row[map.Timestamp] || entry.timestamp);
    setValue(row, 'Last Seen', entry.lastSeen);
    setValue(row, 'Occurrences', occurrences);
    setValue(row, 'Severity', entry.severity);
    setValue(row, 'Stage', entry.stage);
    setValue(row, 'Record Code', entry.bookingCode);
    setValue(row, 'Reference Code', entry.poNumber);
    setValue(row, 'Reason', entry.reason);
    setValue(row, 'Details', entry.details);
    setValue(row, 'Slack Not Date', entry.slackNotDate);
    setValue(row, 'Automation Comment (Please Check it):', warningComment_(entry));
    return row;
  }

  entries.forEach(function(entry) {
    const key = warningKey_(entry);
    const found = existing[key];
    if (found) {
      const occurrences = Number(valueFrom_(found.row, map, 'Occurrences') || 0) + Number(entry.occurrences || 1);
      const updated = populateWarningRow(found.row.slice(), entry, occurrences);
      sheet.getRange(found.sheetRow, 1, 1, headers.length).setValues([updated]);
    } else {
      const row = populateWarningRow(new Array(headers.length).fill(''), entry, Number(entry.occurrences || 1));
      newRows.push(row);
      existing[key] = { sheetRow: sheet.getLastRow() + newRows.length, row: row };
    }
  });

  if (newRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, headers.length).setValues(newRows);
  }
}

function clearWarningsDaily() {
  const started = new Date();
  try {
    withDocumentLock_(function() {
      const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
      let sheet = spreadsheet.getSheetByName('Warnings');
      if (!sheet) sheet = spreadsheet.insertSheet('Warnings');
      ensureHeaders_(sheet, WARNING_HEADERS);
      if (sheet.getLastRow() >= 2) {
        sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
      }
    });
    logSender_('clearWarningsDaily', started, 'OK', 'Warnings cleared; headers preserved.');
  } catch (error) {
    logSender_('clearWarningsDaily', started, 'ERROR', String(error));
  }
}

/* ===== STATE AND ADMIN ROUTING ===== */

function stateNameToCode_(value) {
  const normalized = normalizeLookupText_(value);
  if (!normalized) return '';
  const upper = normalized.toUpperCase();
  if (upper.length === 2 && STATE_TO_ADMIN[upper]) return upper;
  return STATE_NAME_TO_CODE[normalized] || '';
}

function zipToState_(zip) {
  const prefix = parseInt(String(zip || '').substring(0, 3), 10);
  if (isNaN(prefix)) return '';
  for (let i = 0; i < ZIP3_RANGES.length; i++) {
    if (prefix >= ZIP3_RANGES[i][0] && prefix <= ZIP3_RANGES[i][1]) return ZIP3_RANGES[i][2];
  }
  return '';
}

function stateFromAddress_(address) {
  const text = String(address || '');
  const codeMatch = text.match(/,\s*([A-Z]{2})\s+\d{5}/);
  if (codeMatch && STATE_TO_ADMIN[codeMatch[1]]) return codeMatch[1];

  const normalized = normalizeLookupText_(text);
  const stateNames = Object.keys(STATE_NAME_TO_CODE).sort(function(a, b) { return b.length - a.length; });
  for (let i = 0; i < stateNames.length; i++) {
    if ((' ' + normalized + ' ').indexOf(' ' + stateNames[i] + ' ') !== -1) return STATE_NAME_TO_CODE[stateNames[i]];
  }

  const zip = (text.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1];
  return zip ? zipToState_(zip) : '';
}

function loadPropertyMap_() {
  const map = {};
  const sheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID).getSheetByName(SLACK.PROPERTY_TAB);
  if (!sheet || sheet.getLastRow() < 2) return map;
  const data = sheet.getDataRange().getValues();
  const headers = headerMap_(data[0]);
  const propertyIndex = headers['Property Code'];
  if (propertyIndex === undefined) return map;

  for (let row = 1; row < data.length; row++) {
    const po = String(data[row][propertyIndex] || '').trim();
    if (!po || map[po]) continue;
    map[po] = {
      state: String(valueFrom_(data[row], headers, 'Address State') || '').trim(),
      fullAddress: String(valueFrom_(data[row], headers, 'Address Full') || '').trim(),
      buildingName: String(valueFrom_(data[row], headers, 'Building Name') || '').trim()
    };
  }
  return map;
}

function resolveAdmin_(po, propertyMap, fallbackAddress, fallbackState) {
  const property = propertyMap[po] || {};
  let state = stateNameToCode_(property.state);
  if (!state) state = stateFromAddress_(property.fullAddress);
  if (!state) state = stateNameToCode_(fallbackState);
  if (!state) state = stateFromAddress_(fallbackAddress);
  const adminKey = STATE_TO_ADMIN[state];
  return adminKey ? Object.assign({ state: state }, ADMINS[adminKey]) : null;
}

/* ===== SLACK MESSAGE PARSING ===== */

function extractSlackText_(message) {
  const parts = [];
  if (message.text) parts.push(message.text);
  (message.attachments || []).forEach(function(attachment) {
    if (attachment.text) parts.push(attachment.text);
    if (attachment.fallback) parts.push(attachment.fallback);
  });
  if (message.blocks) parts.push(JSON.stringify(message.blocks));
  return parts.join('\n');
}

function parseBooking_(text, timestamp) {
  if (!text) return null;
  const decoded = String(text).replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
  if (!/New booking for/i.test(decoded)) return null;

  const linkedPo = decoded.match(/New booking for\s*<[^>|]*\|([A-Z0-9]+-[0-9]+[A-Z]?)/i);
  const plainPo = decoded.match(/New booking for\s+([A-Z0-9]+-[0-9]+[A-Z]?)/i);
  const linkedBooking = decoded.match(/Booking\s*<[^>|]*\|([A-Z0-9]+-[0-9]+)/i);
  const plainBooking = decoded.match(/Booking\s+([A-Z0-9]+-[0-9]+)/i);

  const po = (linkedPo || plainPo || [])[1] || '';
  const bookingCode = (linkedBooking || plainBooking || [])[1] || '';
  if (!po && !bookingCode) return null;

  const address = ((decoded.match(/Address:\s*([^\n]+)/i) || [])[1] || '').trim();
  const dates = decoded.match(/\(([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*-\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\)/);
  const rentText = (decoded.match(/Monthly rent:\s*\$?([\d,]+(?:\.\d+)?)/i) || [])[1] || '';

  return {
    po: po,
    bookingCode: bookingCode,
    address: address,
    leaseStart: dates ? new Date(dates[1]) : '',
    leaseEnd: dates ? new Date(dates[2]) : '',
    monthlyRent: rentText ? Number(rentText.replace(/,/g, '')) : '',
    partner: ((decoded.match(/Partner:\s*([^\n]*)/i) || [])[1] || '').trim(),
    bgRepresentative: ((decoded.match(/BG representative:\s*(?:<mailto:)?([^|>\n]+)/i) || [])[1] || '').trim(),
    enterprise: ((decoded.match(/Enterprise:\s*([^\n]*)/i) || [])[1] || '').trim(),
    salesAllocation: ((decoded.match(/Sales Allocation:\s*([A-Z_]+)/i) || [])[1] || '').trim().toUpperCase(),
    state: stateFromAddress_(address),
    notedDate: new Date(parseFloat(timestamp) * 1000),
    slackTs: String(timestamp || '')
  };
}

/* ===== SLACK CAPTURE -> QUEUE ===== */

function captureSlackBookings() {
  const started = new Date();
  try {
    withDocumentLock_(function() {
      captureSlackBookingsWindow_(PIPELINE.CAPTURE_LOOKBACK_HOURS, true);
    });
  } catch (error) {
    logSender_('captureSlackBookings', started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

function captureSlackBookingsWindow_(hours, useCursorProperty) {
  const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
  const properties = PropertiesService.getScriptProperties();
  const savedTimestamp = useCursorProperty ? Number(properties.getProperty('MOVE_IN_LAST_SLACK_TS') || 0) : 0;
  const lookbackTimestamp = Math.floor((Date.now() - Number(hours || 36) * 3600000) / 1000);
  const oldest = Math.max(lookbackTimestamp, savedTimestamp ? savedTimestamp - 2 : 0);
  const today = formatDayKey_(new Date());

  let cursor = '';
  let maximumTimestamp = savedTimestamp;
  const parsed = [];
  const warnings = [];
  do {
    const url = 'https://slack.com/api/conversations.history?channel=' + encodeURIComponent(SLACK.CHANNEL_ID) +
      '&oldest=' + oldest + '&limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const response = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    const payload = JSON.parse(response.getContentText());
    if (!payload.ok) throw new Error('Slack API conversations.history: ' + payload.error);

    (payload.messages || []).forEach(function(message) {
      maximumTimestamp = Math.max(maximumTimestamp, Number(message.ts || 0));
      const rawText = extractSlackText_(message);
      const booking = parseBooking_(rawText, message.ts);
      if (!booking) {
        if (/New booking for/i.test(rawText) && formatDayKey_(new Date(Number(message.ts) * 1000)) === today) {
          warnings.push(warningEntry_('SLACK_CAPTURE', {}, 'ERROR',
            'Slack notification could not be parsed',
            'The message contains "New booking for", but the Record Code or Reference Code could not be extracted. Slack timestamp: ' + message.ts));
        }
        return;
      }
      if (formatDayKey_(booking.notedDate) !== today) return;
      if (booking.salesAllocation !== 'DEPARTMENT_Y') {
        warnings.push(warningEntry_('SLACK_CAPTURE', booking, 'INFO',
          'Sales Allocation is not DEPARTMENT_Y',
          'Found "' + (booking.salesAllocation || 'blank') + '". The notification was intentionally skipped.'));
        return;
      }
      if (!/A$/i.test(booking.po)) {
        warnings.push(warningEntry_('SLACK_CAPTURE', booking, 'INFO',
          'Reference Code does not end in A',
          'Reference Code "' + booking.po + '" is outside the Intake automation rule and was skipped.'));
        return;
      }
      parsed.push(booking);
    });
    cursor = payload.response_metadata && payload.response_metadata.next_cursor || '';
  } while (cursor);

  parsed.sort(function(a, b) { return a.notedDate.getTime() - b.notedDate.getTime(); });
  const added = appendNewBookingsToQueue_(parsed);
  upsertWarnings_(warnings);
  if (useCursorProperty && maximumTimestamp) properties.setProperty('MOVE_IN_LAST_SLACK_TS', String(maximumTimestamp));
  logSender_('captureSlackBookings', new Date(), 'OK', added + ' new booking(s) queued; ' + parsed.length + ' eligible notification(s) reviewed.');
  return added;
}

function appendNewBookingsToQueue_(bookings) {
  if (!bookings.length) return 0;
  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  let sheet = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
  if (!sheet) sheet = spreadsheet.insertSheet(SLACK.QUEUE_TAB);
  const headers = ensureHeaders_(sheet, SLACK_HEADERS);
  const map = headerMap_(headers);

  const existing = {};
  if (sheet.getLastRow() >= 2) {
    const bookingIndex = map['Record Code'];
    sheet.getRange(2, bookingIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues().forEach(function(row) {
      const bookingCode = String(row[0] || '').trim();
      if (bookingCode) existing[bookingCode] = true;
    });
  }

  const output = [];
  bookings.forEach(function(booking) {
    if (!booking.bookingCode || existing[booking.bookingCode]) return;
    existing[booking.bookingCode] = true;
    const values = {
      'Slack Not Date': booking.notedDate,
      'Slack Thread TS': booking.slackTs,
      'Record Code': booking.bookingCode,
      'Reference Code': booking.po,
      'Full Address': booking.address,
      'Lease Start': booking.leaseStart,
      'Lease End Date': booking.leaseEnd,
      'Monthly Rent': booking.monthlyRent,
      'BG Representative': booking.bgRepresentative,
      'Enterprise': booking.enterprise,
      'Partner': booking.partner,
      'State': booking.state
    };
    output.push(headers.map(function(header) { return values[header] !== undefined ? values[header] : ''; }));
  });

  if (output.length) sheet.getRange(sheet.getLastRow() + 1, 1, output.length, headers.length).setValues(output);
  return output.length;
}

function backfillSlackToday() {
  const started = new Date();
  try {
    withDocumentLock_(function() { captureSlackBookingsWindow_(36, false); });
  } catch (error) {
    logSender_('backfillSlackToday', started, 'ERROR', String(error));
  }
}

function backfillSlack(hours) {
  const started = new Date();
  try {
    withDocumentLock_(function() { captureSlackBookingsWindow_(hours || 48, false); });
  } catch (error) {
    logSender_('backfillSlack', started, 'ERROR', String(error));
  }
}

/* ===== Source Data LOOKUP ===== */

function loadMbIndex_() {
  const sheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID).getSheetByName(SLACK.MB_TAB);
  if (!sheet || sheet.getLastRow() < 2) return { headerMap: {}, byBooking: {}, byPo: {} };
  const data = sheet.getDataRange().getValues();
  const map = headerMap_(data[0]);
  const byBooking = {};
  const byPo = {};

  for (let row = 1; row < data.length; row++) {
    const values = data[row];
    const booking = String(valueFrom_(values, map, 'Record Code') || '').trim();
    const po = String(valueFrom_(values, map, 'Reference Code') || '').trim();
    if (booking && !byBooking[booking]) byBooking[booking] = values;
    if (po) {
      if (!byPo[po]) byPo[po] = [];
      byPo[po].push(values);
    }
  }
  return { headerMap: map, byBooking: byBooking, byPo: byPo };
}

function sameDateValue_(left, right) {
  if (!left || !right) return false;
  return fmtDateOnly(left) === fmtDateOnly(right);
}

function findMbMatch_(queueObject, mbIndex) {
  const booking = String(queueObject['Record Code'] || '').trim();
  const po = String(queueObject['Reference Code'] || '').trim();
  if (booking && mbIndex.byBooking[booking]) return { row: mbIndex.byBooking[booking], method: 'BOOKING' };

  const candidates = mbIndex.byPo[po] || [];
  if (candidates.length === 1) return { row: candidates[0], method: 'PO_UNIQUE' };
  if (candidates.length > 1) {
    const exactDates = candidates.filter(function(candidate) {
      return sameDateValue_(queueObject['Lease Start'], valueFrom_(candidate, mbIndex.headerMap, 'Lease Start')) &&
        sameDateValue_(queueObject['Lease End Date'], valueFrom_(candidate, mbIndex.headerMap, 'Lease End Date'));
    });
    if (exactDates.length === 1) return { row: exactDates[0], method: 'PO_DATES' };
  }
  return null;
}

function extractUnitNoFromAddress_(address) {
  const text = String(address || '').trim();
  let match = text.match(/#\s*([A-Za-z0-9-]+)\s*$/);
  if (match) return match[1];
  match = text.match(/\b(?:unit|apt|apartment|suite)\s*#?\s*([A-Za-z0-9-]+)\s*$/i);
  return match ? match[1] : '';
}

function buildEmailObject_(queueObject, mbRow, mbMap, propertyMap) {
  function mb(header) { return mbRow && mbMap[header] !== undefined ? mbRow[mbMap[header]] : ''; }
  function preferred(header) { return mb(header) !== '' && mb(header) != null ? mb(header) : queueObject[header]; }

  const po = String(queueObject['Reference Code'] || mb('Reference Code') || '').trim();
  const propertyData = propertyMap[po] || {};
  const address = String(preferred('Full Address') || propertyData.fullAddress || '').trim();
  const unitNo = mb('Unit No') || extractUnitNoFromAddress_(address);
  const state = queueObject.State || mb('State') || propertyData.state || stateFromAddress_(address);

  return {
    'Slack Not Date': queueObject['Slack Not Date'],
    'Slack Thread TS': queueObject['Slack Thread TS'],
    'Record Code': queueObject['Record Code'] || mb('Record Code'),
    'Reference Code': po,
    'Quote Number': mb('Quote Number') || queueObject['Quote Number'],
    'Unit No': unitNo,
    'Full Address': address,
    'Property Name': mb('Property Name') || queueObject['Property Name'] || propertyData.buildingName || po,
    'External Provider': mb('External Provider') || queueObject['External Provider'],
    'Lease Start': preferred('Lease Start'),
    'Lease End Date': preferred('Lease End Date'),
    'Monthly Rent': preferred('Monthly Rent'),
    'Security Deposit': mb('Security Deposit'),
    'Admin': mb('Admin'),
    'Application': mb('Application'),
    'Prop Pet Fee Monthly': mb('Prop Pet Fee Monthly'),
    'Prop Pet Fee One-Time': mb('Prop Pet Fee One-Time'),
    'Prop Cleaning Fee': mb('Prop Cleaning Fee'),
    'Parking Fee': mb('Parking Fee'),
    'Email Contact': mb('Email Contact') || queueObject['Email Contact'],
    'Unit Email': queueObject['Unit Email'],
    'BG Representative': queueObject['BG Representative'],
    'Enterprise': queueObject.Enterprise,
    'Partner': queueObject.Partner,
    'State': stateNameToCode_(state) || stateFromAddress_(address) || state
  };
}

function missingEmailData_(item) {
  const missing = [];
  if (!isValidEmail(item['Email Contact'])) missing.push('Email Contact');
  return missing;
}

function describeMbMiss_(queueObject, mbIndex) {
  const booking = String(queueObject['Record Code'] || '').trim();
  const po = String(queueObject['Reference Code'] || '').trim();
  const poCandidates = mbIndex.byPo[po] || [];
  if (!poCandidates.length) {
    return 'Record Code "' + booking + '" and Reference Code "' + po + '" were not found in Source Data. The row remains in the queue and will be checked again.';
  }
  if (poCandidates.length > 1) {
    return 'Record Code "' + booking + '" was not found. Reference Code "' + po + '" matched ' + poCandidates.length + ' Source Data rows, but none could be uniquely identified by lease dates. The row remains in the queue.';
  }
  return 'The Source Data record could not be uniquely matched. The row remains in the queue and will be checked again.';
}

function updateQueueRow_(row, queueMap, item) {
  const updated = row.slice();
  SLACK_HEADERS.forEach(function(header) {
    const index = queueMap[header];
    if (index !== undefined && item[header] !== undefined && item[header] !== '') updated[index] = item[header];
  });
  return updated;
}

/* ===== SAME-DAY MANUAL SENT CHECK ===== */

function loadTodaySentIntakeMessages_() {
  const query = 'in:sent newer_than:2d from:' + FROM_ALIAS + ' {subject:"move in" subject:"move-in"}';
  const threads = GmailApp.search(query, 0, 500);
  const today = formatDayKey_(new Date());
  const messages = [];

  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      if (String(message.getFrom() || '').toLowerCase().indexOf(FROM_ALIAS.toLowerCase()) === -1) return;
      if (formatDayKey_(message.getDate()) !== today) return;
      const subject = String(message.getSubject() || '');
      if (!/move[\s-]*in/i.test(subject)) return;
      if (/\btest\b/i.test(subject)) return;
      messages.push({
        subject: subject,
        normalizedSubject: normalizeLookupText_(subject),
        message: message,
        thread: thread,
        sentDate: message.getDate(),
        recipients: message.getTo()
      });
    });
  });
  return messages;
}

function findManualSentForPo_(po, sentMessages) {
  const normalizedPo = normalizeLookupText_(po);
  if (!normalizedPo) return null;
  for (let i = 0; i < sentMessages.length; i++) {
    if ((' ' + sentMessages[i].normalizedSubject + ' ').indexOf(' ' + normalizedPo + ' ') !== -1) return sentMessages[i];
  }
  return null;
}

/* ===== TRACKER ===== */

function ensureTracker_(spreadsheet) {
  let tracker = spreadsheet.getSheetByName(SLACK.TRACKER_TAB);
  if (!tracker) tracker = spreadsheet.insertSheet(SLACK.TRACKER_TAB);
  ensureHeaders_(tracker, TRACKER_HEADERS);
  return tracker;
}

function loadFinalizedTrackerKeys_(tracker) {
  const keys = {};
  if (tracker.getLastRow() < 2) return keys;
  const data = tracker.getDataRange().getValues();
  const map = headerMap_(data[0]);
  for (let row = 1; row < data.length; row++) {
    const mode = String(valueFrom_(data[row], map, 'Mode') || '').trim().toUpperCase();
    const status = String(valueFrom_(data[row], map, 'Status') || '').trim().toUpperCase();
    if (mode === 'TEST' || status !== 'OK') continue;
    const booking = String(valueFrom_(data[row], map, 'Record Code') || '').trim();
    const po = String(valueFrom_(data[row], map, 'Reference Code') || '').trim();
    if (booking) keys['B|' + booking] = true;
    else if (po) keys['P|' + po] = true;
  }
  return keys;
}

function isAlreadyFinalized_(queueObject, finalizedKeys) {
  const booking = String(queueObject['Record Code'] || '').trim();
  const po = String(queueObject['Reference Code'] || '').trim();
  return Boolean((booking && finalizedKeys['B|' + booking]) || (!booking && po && finalizedKeys['P|' + po]));
}

function trackerRow_(sentTimestamp, item, context, recipient, mode, status, comment) {
  return [
    sentTimestamp,
    item['Record Code'] || '',
    item['Reference Code'] || '',
    item['Property Name'] || '',
    item['Full Address'] || '',
    item.State || '',
    item['External Provider'] || '',
    context ? context.templateType : '',
    item['Email Contact'] || '',
    recipient || '',
    mode,
    item['Monthly Rent'] || '',
    item['Lease Start'] || '',
    item['Lease End Date'] || '',
    status,
    comment
  ];
}

function appendTrackerRows_(tracker, rows) {
  if (!rows.length) return;
  tracker.getRange(tracker.getLastRow() + 1, 1, rows.length, TRACKER_HEADERS.length).setValues(rows);
}

/* ===== GMAIL LABELS ===== */

function applyAdminLabels_(thread, admins) {
  const applied = [];
  const seen = {};
  (admins || []).forEach(function(admin) {
    if (!admin || !admin.label || seen[admin.label]) return;
    seen[admin.label] = true;
    const label = GmailApp.getUserLabelByName(admin.label) || GmailApp.createLabel(admin.label);
    thread.addLabel(label);
    applied.push(admin.label);
  });
  return applied;
}

/* ===== EXTERNAL Reference Code / INTRO EMAIL CONTROL ===== */

function recordAutomationIntroEmails_(poNumbers) {
  const pos = uniqueValues_(poNumbers);
  if (!pos.length) return;
  const spreadsheet = SpreadsheetApp.openById(INTRO_CONTROL.SPREADSHEET_ID);
  const sheet = INTRO_CONTROL.SHEET_NAME ? spreadsheet.getSheetByName(INTRO_CONTROL.SHEET_NAME) : spreadsheet.getSheets()[0];
  if (!sheet) throw new Error('Intake Email control sheet was not found.');

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function(header) { return String(header || '').trim(); });
  const map = headerMap_(headers);
  if (map[INTRO_CONTROL.REFERENCE_HEADER] === undefined || map[INTRO_CONTROL.INTRO_HEADER] === undefined) {
    throw new Error('The external control sheet must contain Reference Code and Intake Email headers.');
  }

  const existingRows = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, map[INTRO_CONTROL.REFERENCE_HEADER] + 1, sheet.getLastRow() - 1, 1).getDisplayValues()
      .forEach(function(row, index) {
        const po = String(row[0] || '').trim();
        if (po && existingRows[po] === undefined) existingRows[po] = index + 2;
      });
  }

  pos.forEach(function(po) {
    if (existingRows[po]) {
      sheet.getRange(existingRows[po], map[INTRO_CONTROL.INTRO_HEADER] + 1).setValue(INTRO_CONTROL.VALUE);
    } else {
      const output = new Array(headers.length).fill('');
      output[map[INTRO_CONTROL.REFERENCE_HEADER]] = po;
      output[map[INTRO_CONTROL.INTRO_HEADER]] = INTRO_CONTROL.VALUE;
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([output]);
    }
  });
}

/* ===== EMAIL / PARTNER CONTEXT ===== */

function contextForItem_(item, propertyMap) {
  const property = propertyMap[item['Reference Code']] || {};
  let partnerCompanyName = '';
  try {
    partnerCompanyName = findPartnerMatch_([item['Full Address'], item['Property Name'], property.buildingName]);
  } catch (error) {
    logSender_('PARTNER matching', new Date(), 'REVIEW', String(error));
  }
  return resolveEmailContext_(item['External Provider'], partnerCompanyName);
}

function emailRows_(items) {
  const map = headerMap_(EMAIL_HEADERS);
  return {
    headerMap: map,
    items: items.map(function(wrapper, index) {
      return {
        dataIndex: index,
        rowValues: EMAIL_HEADERS.map(function(header) { return wrapper.item[header] !== undefined ? wrapper.item[header] : ''; })
      };
    })
  };
}

function sendIntakeMessage_(recipient, subject, htmlBody, context) {
  const options = { htmlBody: htmlBody, replyTo: FROM_ALIAS, name: 'Real Estate Admin' };
  options.from = FROM_ALIAS;
  if (context.templateType === 'PRIVATE_OWNER') {
    const attachment = getPrivatePdfBlobFromUrl();
    if (!attachment) throw new Error('PRIVATE OWNER attachment could not be loaded.');
    options.attachments = [attachment];
  }
  return GmailApp.createDraft(recipient, subject, '', options).send();
}

/* ===== SLACK NOTIFICATIONS ===== */

function slackWebhookPost_(propertyName, text) {
  const url = getScriptProperty_(propertyName, true);
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(propertyName + ' returned ' + response.getResponseCode() + ': ' + response.getContentText());
  }
}

function bookingThreadWebhookPost_(threadTs, text) {
  const timestamp = String(threadTs || '').trim();
  if (!timestamp) throw new Error('The original Slack message timestamp is missing.');

  const propertyName = 'SOURCE_THREAD_WEBHOOK_URL';
  const url = getScriptProperty_(propertyName, true);
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: text, thread_ts: timestamp }),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error(propertyName + ' returned ' + response.getResponseCode() + ': ' + response.getContentText());
  }
}

function buildBookingThreadReply_(item, admin, isTest) {
  const bookingCode = String(item['Record Code'] || '').trim();
  const po = String(item['Reference Code'] || '').trim();
  const prefix = isTest ? ':test_tube: *TEST* - ' : ':white_check_mark: ';
  let text = prefix + 'The Intake intro email for booking *' + bookingCode + '* / Reference Code *' + po +
    '* was ' + (isTest ? 'not sent; this message only tests the threaded-reply integration.' : 'sent automatically.');

  if (isTest) {
    text += '\n<@YOUR_MAINTAINER_SLACK_ID>, please confirm that this test reply appeared inside the original booking thread.';
  } else if (admin && admin.slackId) {
    text += '\n<@' + admin.slackId + '>, please review and follow up as needed.';
  } else {
    text += '\nThe responsible Operations Admin could not be identified automatically; please review.';
  }
  return text;
}

function findOriginalSlackThreadTs_(bookingCode, poNumber) {
  const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
  const wantedBooking = String(bookingCode || '').trim().toUpperCase();
  const wantedPo = String(poNumber || '').trim().toUpperCase();
  const oldest = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  let cursor = '';
  let poFallback = '';
  let page = 0;

  do {
    const url = 'https://slack.com/api/conversations.history?channel=' + encodeURIComponent(SLACK.CHANNEL_ID) +
      '&oldest=' + oldest + '&limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const response = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    const payload = JSON.parse(response.getContentText());
    if (!payload.ok) throw new Error('Slack API conversations.history: ' + payload.error);

    let exactBookingTs = '';
    (payload.messages || []).forEach(function(message) {
      const parsed = parseBooking_(extractSlackText_(message), message.ts);
      if (!parsed) return;
      if (!exactBookingTs && wantedBooking && String(parsed.bookingCode || '').toUpperCase() === wantedBooking) {
        exactBookingTs = String(message.ts || '');
      }
      if (!poFallback && wantedPo && String(parsed.po || '').toUpperCase() === wantedPo) {
        poFallback = String(message.ts || '');
      }
    });
    if (exactBookingTs) return exactBookingTs;

    cursor = payload.response_metadata && payload.response_metadata.next_cursor || '';
    page++;
  } while (cursor && page < 5);

  return poFallback;
}

function replyToOriginalBookingThread_(wrapper, isTest) {
  const item = wrapper.item || {};
  const threadTs = String(item['Slack Thread TS'] || '').trim() ||
    findOriginalSlackThreadTs_(item['Record Code'], item['Reference Code']);
  if (!threadTs) {
    throw new Error('Could not locate the original Slack notification for booking ' +
      String(item['Record Code'] || '') + ' / Reference Code ' + String(item['Reference Code'] || '') + '.');
  }
  bookingThreadWebhookPost_(threadTs, buildBookingThreadReply_(item, wrapper.admin, Boolean(isTest)));
  return threadTs;
}

function buildSlackNotification_(wrappers, isTest) {
  const lines = wrappers.map(function(wrapper) {
    const item = wrapper.item;
    const adminTag = wrapper.admin ? '<@' + wrapper.admin.slackId + '>' : '*Operations Admin unresolved*';
    return '• ' + adminTag + ' | *' + item['Reference Code'] + '* - ' + item['Property Name'] +
      (item['Unit No'] ? ' - Unit #' + unitNumberText_(item['Unit No']) : '') +
      (item['Full Address'] ? '\n  ' + item['Full Address'] : '') +
      (item['Record Code'] ? '\n  Booking: ' + item['Record Code'] : '');
  }).join('\n');
  return (isTest ? ':test_tube: *TEST* - ' : '') +
    'Hello Operations Admins, a New Intake email was sent for the following propert' + (wrappers.length === 1 ? 'y' : 'ies') + ':\n' + lines;
}

/* ===== QUEUE MONITOR ===== */

function monitorIntakeQueue() {
  const started = new Date();
  if (!PIPELINE.LIVE) {
    Logger.log('monitorIntakeQueue skipped because PIPELINE.LIVE is false. Use testFullCircuit for testing.');
    return;
  }

  try {
    withDocumentLock_(function() { monitorIntakeQueueInternal_(started); });
  } catch (error) {
    logSender_('monitorIntakeQueue', started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

function monitorIntakeQueueInternal_(started) {
  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  const queue = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
  if (!queue || queue.getLastRow() < 2) return;

  const tracker = ensureTracker_(spreadsheet);
  const finalizedKeys = loadFinalizedTrackerKeys_(tracker);
  const sentMessages = loadTodaySentIntakeMessages_();
  const mbIndex = loadMbIndex_();
  const propertyMap = loadPropertyMap_();

  const queueHeaders = ensureHeaders_(queue, SLACK_HEADERS);
  const queueMap = headerMap_(queueHeaders);
  const range = queue.getRange(2, 1, queue.getLastRow() - 1, queueHeaders.length);
  const rows = range.getValues();
  const rowsToDelete = [];
  const candidates = [];
  const manualTrackerRows = [];
  const warnings = [];
  let enrichedCount = 0;

  rows.forEach(function(row, index) {
    const sheetRow = index + 2;
    const queueObject = rowObject_(row, queueMap);
    const po = String(queueObject['Reference Code'] || '').trim();
    if (!po) return;

    if (isAlreadyFinalized_(queueObject, finalizedKeys)) {
      warnings.push(warningEntry_('QUEUE_MONITOR', queueObject, 'INFO',
        'Already recorded in Delivery History',
        'A successful non-test tracker record already exists. The queue row was removed without sending another email.'));
      rowsToDelete.push(sheetRow);
      return;
    }

    const manualSent = findManualSentForPo_(po, sentMessages);
    if (manualSent) {
      const property = propertyMap[po] || {};
      const manualItem = Object.assign({}, queueObject, {
        'Property Name': queueObject['Property Name'] || property.buildingName || po,
        'Full Address': queueObject['Full Address'] || property.fullAddress || '',
        'State': stateNameToCode_(property.state) || queueObject.State || stateFromAddress_(queueObject['Full Address'])
      });
      const admin = resolveAdmin_(po, propertyMap, manualItem['Full Address'], manualItem.State);
      if (admin) {
        try { applyAdminLabels_(manualSent.thread, [admin]); }
        catch (error) { logSender_('manual Gmail label', started, 'REVIEW', po + ': ' + error); }
      }
      const manualContext = contextForItem_(manualItem, propertyMap);
      manualTrackerRows.push(trackerRow_(manualSent.sentDate, manualItem, manualContext, manualSent.recipients, 'MANUAL', 'OK', 'Manual sent'));
      warnings.push(warningEntry_('QUEUE_MONITOR', manualItem, 'INFO',
        'Intake email was already sent manually today',
        'Matched sent email subject: "' + manualSent.subject + '". Automation did not send a duplicate; the queue row was moved to Delivery History.'));
      finalizedKeys['B|' + String(queueObject['Record Code'] || '').trim()] = true;
      rowsToDelete.push(sheetRow);
      return;
    }

    const match = findMbMatch_(queueObject, mbIndex);
    if (!match) {
      warnings.push(warningEntry_('QUEUE_MONITOR', queueObject, 'WARNING',
        'No unique Source Data match', describeMbMiss_(queueObject, mbIndex)));
      return;
    }
    const item = buildEmailObject_(queueObject, match.row, mbIndex.headerMap, propertyMap);
    rows[index] = updateQueueRow_(row, queueMap, item);
    enrichedCount++;
    const missing = missingEmailData_(item);
    if (missing.length) {
      warnings.push(warningEntry_('QUEUE_MONITOR', item, 'ERROR',
        'Invalid or missing Email Contact',
        'Source Data matched by ' + match.method + ', but Email Contact is "' + String(item['Email Contact'] || '') + '". The row remains in the queue.'));
      return;
    }

    const context = contextForItem_(item, propertyMap);
    const admin = resolveAdmin_(po, propertyMap, item['Full Address'], item.State);
    if (!admin) {
      warnings.push(warningEntry_('QUEUE_MONITOR', item, 'WARNING',
        'Operations Admin could not be resolved',
        'The email is still eligible to send, but no admin label or Slack user could be assigned from State/Address.'));
    }
    candidates.push({ sheetRow: sheetRow, item: item, context: context, admin: admin, matchMethod: match.method });
  });

  if (enrichedCount) range.setValues(rows);
  appendTrackerRows_(tracker, manualTrackerRows);
  upsertWarnings_(warnings);

  const successfulRows = sendAutomationCandidates_(candidates, tracker, started);
  successfulRows.forEach(function(row) { rowsToDelete.push(row); });
  deleteSheetRows_(queue, uniqueValues_(rowsToDelete.map(String)).map(Number));

  const pending = Math.max(0, rows.length - uniqueValues_(rowsToDelete.map(String)).length);
  logSender_('monitorIntakeQueue', started, pending ? 'REVIEW' : 'OK',
    manualTrackerRows.length + ' manual send(s), ' + successfulRows.length + ' automated row(s), ' + pending + ' pending row(s).');
}

function sendAutomationCandidates_(candidates, tracker, started) {
  if (!candidates.length) return [];
  const groups = {};
  candidates.forEach(function(candidate) {
    const email = String(candidate.item['Email Contact'] || '').trim().toLowerCase();
    const contextKey = candidate.context.templateType + '|' + normalizeLookupText_(candidate.context.partnerCompanyName);
    const key = email + '|' + contextKey;
    if (!groups[key]) groups[key] = { email: email, context: candidate.context, wrappers: [] };
    groups[key].wrappers.push(candidate);
  });

  const completedRows = [];
  Object.keys(groups).forEach(function(key) {
    const group = groups[key];
    const first = group.wrappers[0].item;
    const propertyName = String(first['Property Name'] || '').trim();
    const poList = uniqueValues_(group.wrappers.map(function(wrapper) { return wrapper.item['Reference Code']; })).join(', ');
    const subject = buildIntakeSubject_(propertyName, poList, group.context, '');
    const emailData = emailRows_(group.wrappers);
    const htmlBody = buildHtmlBody(
      group.context.templateType,
      emailData.items[0].rowValues,
      emailData.items,
      emailData.headerMap,
      propertyName,
      group.context
    );

    let sentMessage;
    try {
      sentMessage = sendIntakeMessage_(group.email, subject, htmlBody, group.context);
    } catch (error) {
      try {
        appendTrackerRows_(tracker, [trackerRow_(new Date(), first, group.context, group.email, 'LIVE', 'ERROR', String(error))]);
      } catch (trackerError) {}
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('EMAIL_SEND', wrapper.item, 'ERROR',
          'Email send failed', 'Recipient: ' + group.email + '. Error: ' + error);
      }));
      logSender_('Automation send', started, 'ERROR', 'To ' + group.email + ' | Reference Codes: ' + poList + ' | ' + error);
      return;
    }

    // From this point onward, the email was sent. The queue rows must be completed
    // even if a secondary action (tracker, label, control sheet or Slack) fails.
    group.wrappers.forEach(function(wrapper) { completedRows.push(wrapper.sheetRow); });
    const now = new Date();

    try {
      appendTrackerRows_(tracker, group.wrappers.map(function(wrapper) {
        return trackerRow_(now, wrapper.item, wrapper.context, group.email, 'LIVE', 'OK', 'Automation sent');
      }));
    } catch (error) {
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('SENDER_TRACKER', wrapper.item, 'ERROR',
          'Email sent but Delivery History update failed', String(error));
      }));
    }

    let labels = [];
    try {
      const admins = group.wrappers.map(function(wrapper) { return wrapper.admin; }).filter(Boolean);
      labels = applyAdminLabels_(sentMessage.getThread(), admins);
    } catch (error) {
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('GMAIL_LABEL', wrapper.item, 'WARNING',
          'Email sent but Gmail label failed', String(error));
      }));
      logSender_('Gmail label', started, 'REVIEW', 'Email sent, but Gmail label failed: ' + error);
    }

    try {
      recordAutomationIntroEmails_(group.wrappers.map(function(wrapper) { return wrapper.item['Reference Code']; }));
    } catch (error) {
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('INTRO_EMAIL_CONTROL', wrapper.item, 'WARNING',
          'Email sent but external Intake Email control update failed', String(error));
      }));
      logSender_('Intake Email control', started, 'REVIEW', 'Email sent, but the external Reference Code control update failed: ' + error);
    }

    group.wrappers.forEach(function(wrapper) {
      try {
        replyToOriginalBookingThread_(wrapper, false);
      } catch (error) {
        upsertWarnings_([warningEntry_('BOOKING_THREAD_REPLY', wrapper.item, 'WARNING',
          'Email sent but the original Slack thread reply failed', String(error))]);
        logSender_('Slack booking thread reply', started, 'REVIEW',
          'Email sent for ' + wrapper.item['Record Code'] + ', but the thread reply failed: ' + error);
      }
    });

    logSender_('Automation send', started, 'OK', 'To ' + group.email + ' | Reference Codes: ' + poList +
      ' | Template: ' + group.context.templateType + (labels.length ? ' | Labels: ' + labels.join(', ') : ''));
  });
  return completedRows;
}

function deleteSheetRows_(sheet, rows) {
  uniqueValues_(rows.map(String)).map(Number).sort(function(a, b) { return b - a; }).forEach(function(row) {
    if (row >= 2 && row <= sheet.getLastRow()) sheet.deleteRow(row);
  });
}

/* ===== FULL CIRCUIT TEST ===== */

function testFullCircuit() {
  const started = new Date();
  try {
    const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
    const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
    const tracker = ensureTracker_(spreadsheet);
    const mbIndex = loadMbIndex_();
    const propertyMap = loadPropertyMap_();

    const response = UrlFetchApp.fetch(
      'https://slack.com/api/conversations.history?channel=' + encodeURIComponent(SLACK.CHANNEL_ID) + '&limit=150',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    const payload = JSON.parse(response.getContentText());
    if (!payload.ok) throw new Error('Slack API conversations.history: ' + payload.error);

    const selected = [];
    const testWarnings = [];
    (payload.messages || []).some(function(message) {
      const booking = parseBooking_(extractSlackText_(message), message.ts);
      if (!booking || booking.salesAllocation !== 'DEPARTMENT_Y' || !/A$/i.test(booking.po)) return false;
      const queueObject = {
        'Slack Not Date': booking.notedDate,
        'Slack Thread TS': booking.slackTs,
        'Record Code': booking.bookingCode,
        'Reference Code': booking.po,
        'Full Address': booking.address,
        'Lease Start': booking.leaseStart,
        'Lease End Date': booking.leaseEnd,
        'Monthly Rent': booking.monthlyRent,
        'BG Representative': booking.bgRepresentative,
        'Enterprise': booking.enterprise,
        'Partner': booking.partner,
        'State': booking.state
      };
      const match = findMbMatch_(queueObject, mbIndex);
      if (!match) {
        testWarnings.push(warningEntry_('TEST_FULL_CIRCUIT', queueObject, 'WARNING',
          'Test candidate has no unique Source Data match', describeMbMiss_(queueObject, mbIndex)));
        return false;
      }
      const item = buildEmailObject_(queueObject, match.row, mbIndex.headerMap, propertyMap);
      if (missingEmailData_(item).length) {
        testWarnings.push(warningEntry_('TEST_FULL_CIRCUIT', item, 'ERROR',
          'Test candidate has an invalid Email Contact',
          'Source Data matched, but Email Contact is "' + String(item['Email Contact'] || '') + '".'));
        return false;
      }
      const context = contextForItem_(item, propertyMap);
      const admin = resolveAdmin_(booking.po, propertyMap, item['Full Address'], item.State);
      selected.push({ item: item, context: context, admin: admin, booking: booking });
      return selected.length >= 3;
    });

    upsertWarnings_(testWarnings);

    if (!selected.length) {
      logSender_('testFullCircuit', started, 'REVIEW', 'No recent Slack booking has all required Source Data data yet.');
      return;
    }

    selected.forEach(function(wrapper) {
      const propertyName = wrapper.item['Property Name'];
      const templateLabel = wrapper.context.templateType === 'PRIVATE_OWNER' ? 'Private Owner' : wrapper.context.templateType;
      const subject = buildIntakeSubject_(propertyName, wrapper.item['Reference Code'], wrapper.context, templateLabel);
      const emailData = emailRows_([wrapper]);
      const htmlBody = buildHtmlBody(
        wrapper.context.templateType,
        emailData.items[0].rowValues,
        emailData.items,
        emailData.headerMap,
        propertyName,
        wrapper.context
      );
      const internalRecipients = PIPELINE.TEST_RECIPIENTS.join(',');
      const sentMessage = sendIntakeMessage_(internalRecipients, subject, htmlBody, wrapper.context);
      applyAdminLabels_(sentMessage.getThread(), wrapper.admin ? [wrapper.admin] : []);
      appendTrackerRows_(tracker, [
        trackerRow_(new Date(), wrapper.item, wrapper.context, internalRecipients, 'TEST', 'OK', 'Test sent internally')
      ]);
      slackWebhookPost_('TEST_NOTIF_WEBHOOK_URL', buildSlackNotification_([wrapper], true));
      logSender_('testFullCircuit', started, 'OK', wrapper.item['Reference Code'] + ' | ' + templateLabel +
        ' | ' + (wrapper.admin ? wrapper.admin.name : 'admin unresolved'));
    });
  } catch (error) {
    logSender_('testFullCircuit', started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

/* ===== DIAGNOSTIC TESTS ===== */

function testSlackRead() {
  const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
  const response = UrlFetchApp.fetch(
    'https://slack.com/api/conversations.history?channel=' + encodeURIComponent(SLACK.CHANNEL_ID) + '&limit=3',
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
  );
  Logger.log(response.getContentText());
}

function testSlackWhoAmI() {
  const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
  Logger.log(UrlFetchApp.fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  }).getContentText());
}

function testNotificationChannel() {
  const propertyMap = loadPropertyMap_();
  const item = {
    'Reference Code': 'REF-1004A', 'Record Code': 'REC-2004', 'Unit No': 'K2',
    'Property Name': 'Test Property', 'Full Address': '400 Placeholder Lane, Demo City, FL 32003'
  };
  const admin = resolveAdmin_(item['Reference Code'], propertyMap, item['Full Address'], 'NC');
  slackWebhookPost_('TEST_NOTIF_WEBHOOK_URL', buildSlackNotification_([{ item: item, admin: admin }], true));
}

/**
 * Posts one clearly marked TEST reply inside the newest eligible booking thread.
 * This function does not send an email and does not write to Delivery History.
 */
function testBookingThreadReply() {
  const started = new Date();
  try {
    const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
    const response = UrlFetchApp.fetch(
      'https://slack.com/api/conversations.history?channel=' + encodeURIComponent(SLACK.CHANNEL_ID) + '&limit=100',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    const payload = JSON.parse(response.getContentText());
    if (!payload.ok) throw new Error('Slack API conversations.history: ' + payload.error);

    let booking = null;
    (payload.messages || []).some(function(message) {
      const parsed = parseBooking_(extractSlackText_(message), message.ts);
      if (!parsed || parsed.salesAllocation !== 'DEPARTMENT_Y' || !/A$/i.test(parsed.po)) return false;
      booking = parsed;
      return true;
    });
    if (!booking) throw new Error('No eligible DEPARTMENT_Y booking ending in A was found in the latest 100 messages.');

    const propertyMap = loadPropertyMap_();
    const admin = resolveAdmin_(booking.po, propertyMap, booking.address, booking.state);
    const wrapper = {
      item: {
        'Slack Thread TS': booking.slackTs,
        'Record Code': booking.bookingCode,
        'Reference Code': booking.po
      },
      admin: admin
    };
    const threadTs = replyToOriginalBookingThread_(wrapper, true);
    logSender_('testBookingThreadReply', started, 'OK',
      'TEST reply posted to booking ' + booking.bookingCode + ' / Reference Code ' + booking.po + ' / thread ' + threadTs + '. No email was sent.');
  } catch (error) {
    logSender_('testBookingThreadReply', started, 'ERROR', String(error && error.stack ? error.stack : error));
    throw error;
  }
}

function testPartnerAccess() {
  const names = loadPartnerNames_();
  Logger.log('PARTNER names loaded: ' + names.length + '. First values: ' + names.slice(0, 10).map(function(item) { return item.display; }).join(', '));
}

function testManualSentIndex() {
  const messages = loadTodaySentIntakeMessages_();
  Logger.log(messages.map(function(item) { return item.subject; }).join('\n'));
}

/* ===== LOGGING ===== */

function logSender_(functionName, startedDate, status, comment) {
  try {
    const duration = Number(((Date.now() - startedDate.getTime()) / 1000).toFixed(1));
    const spreadsheet = SpreadsheetApp.openById(LOG_CONFIG.SPREADSHEET_ID);
    let sheet = spreadsheet.getSheetByName(LOG_CONFIG.SHEET_NAME);
    if (!sheet) sheet = spreadsheet.insertSheet(LOG_CONFIG.SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Function', 'Timestamp', 'Status', 'Duration (sec)', 'Comment', 'Note']);
    }
    sheet.appendRow([functionName, startedDate, status, duration, comment || '', '']);
  } catch (error) {
    Logger.log('Sender log failed: ' + error);
  }
}

/* ===== ORCHESTRATOR AND TRIGGERS ===== */

function runIntakePipeline() {
  captureSlackBookings();
  monitorIntakeQueue();
}

// Compatibility hook used by the existing Source Data import file after a fresh CSV import.
function reEnrichSlackRows_() {
  monitorIntakeQueue();
}

function createPipelineTriggers() {
  const managedFunctions = ['captureSlackBookings', 'monitorIntakeQueue', 'runIntakePipeline', 'clearWarningsDaily'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (managedFunctions.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('captureSlackBookings').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('monitorIntakeQueue').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('clearWarningsDaily').timeBased().atHour(22).nearMinute(0).everyDays(1).create();
}

function createPipelineTrigger() {
  createPipelineTriggers();
}

/** Emergency stop / rollback: removes every trigger managed by this Intake project. */
function disableIntakeAutomationTriggers() {
  const managedFunctions = [
    'captureSlackBookings',
    'monitorIntakeQueue',
    'runIntakePipeline',
    'clearWarningsDaily',
    'importSourceData',
    'importReferenceData'
  ];
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (managedFunctions.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  logSender_('disableIntakeAutomationTriggers', new Date(), 'OK', removed + ' managed trigger(s) removed.');
  Logger.log(removed + ' managed trigger(s) removed.');
}
