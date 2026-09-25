// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  SPREADSHEET_ID: 'YOUR_TAX_CONTROL_SPREADSHEET_ID',
  SHEET_NAME:     'mb_16290_16074_19375_D',
  EMAILS_SHEET_NAME: 'Contact Emails',
  GMAIL_QUERY:    'label:bi-platform-automations subject:"US Insurance Email Contacts [Database Automation]" has:attachment newer_than:2d',
  OUTPUT_ORDER:   ['q16290', 'q16074', 'q19375'],
  OUTPUT_COLS: [
    'Property Code',
    'Building Name',
    'Building ID Pk',
    'Frontdesk Email',
    'Company Partner Contact Email',
    'Company Partner Email',
    'Property Manager Email',
  ],
  // Columns that feed "Contact Emails". Property Manager stays out.
  EMAIL_COLS: [
    'Frontdesk Email',
    'Company Partner Contact Email',
    'Company Partner Email',
  ],
  // Per-building contacts, imported from "Department Y Move-Outs" with
  // =IMPORTRANGE("YOUR_CONTACT_SOURCE_SPREADSHEET_ID","Contacts!A:E")
  // The three BI platform questions give at most 3 emails per PO and usually one;
  // this table is where the several contacts per building come from.
  PORTFOLIO_CONTACTS_CONTACTS_SHEET: 'PORTFOLIO_CONTACTS Contacts',
  PORTFOLIO_CONTACTS_BUILDING_COL: 'Building ID',
  PORTFOLIO_CONTACTS_EMAIL_COL: 'Email',
  PORTFOLIO_CONTACTS_TITLE_COL: 'Title',
  // Empty = every title is accepted (what the other spreadsheet's formula does).
  // To exclude one, add it lowercase here, e.g. ['landlord'].
  PORTFOLIO_CONTACTS_SKIP_TITLES: [],
  WRITE_CHUNK: 5000,

  LOG_TARGETS: [
    { ID: 'YOUR_LOG_SPREADSHEET_ID', TAB: 'BI platform Data' },
    { ID: 'YOUR_TAX_CONTROL_SPREADSHEET_ID', TAB: 'Logs (Unified)' }
  ],
  LOG_HEADER: ['Function', 'Timestamp', 'Status', 'Duration (sec)', 'Comment', 'Note'],
};

// Output column -> candidate header names in that question's CSV.
// More than one candidate where it helps, to tolerate naming drift.
const QUESTIONS = {
  // 10002-relo-app-contact-emails
  q16290: {
    detectFile: /10002|relo.?app/i,
    map: {
      'Property Code':                 ['Property → Property Code', 'Property Code'],
      'Building Name':                 ['Property → Building Name', 'Building Name'],
      'Building ID Pk':                ['Property → Building ID', 'Property → Building ID Pk', 'Building ID Pk', 'Building ID'],
      'Frontdesk Email':               [],
      'Company Partner Contact Email': ['Company Partner Contact Email'],
      'Company Partner Email':         ['Company Partner Email'],
      'Property Manager Email':        ['Property Manager Email'],
    },
  },
  // 10003-frontdesk-emails
  q16074: {
    detectFile: /10003/i,
    map: {
      'Property Code':                 ['Property Code'],
      'Building Name':                 ['Building → Building Name', 'Building Name'],
      'Building ID Pk':                ['Building → Building ID Pk', 'Building ID Pk'],
      'Frontdesk Email':               ['Building → Frontdesk Email', 'Frontdesk Email'],
      'Company Partner Contact Email': [],
      'Company Partner Email':         [],
      'Property Manager Email':        [],
    },
  },
  // 10004-frontdesk-emails-bg-od
  q19375: {
    detectFile: /10004|bg.?od/i,
    map: {
      'Property Code':                 ['Reference Properties - Building ID Pk → Property Code', 'Property Code'],
      'Building Name':                 ['Building Name'],
      'Building ID Pk':                ['Building ID Pk'],
      'Frontdesk Email':               ['Frontdesk Email'],
      'Company Partner Contact Email': [],
      'Company Partner Email':         [],
      'Property Manager Email':        [],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN (this is what the trigger calls)
// ─────────────────────────────────────────────────────────────────────────────
function updateInsuranceContacts() {
  const start = new Date();
  const notes = [];          // anything worth a REVIEW
  const detail = [];         // what the run actually read, for the log
  let status = 'OK';

  try {
    const msg = getLatestMessage_();
    if (!msg) {
      logContactsRun_('updateInsuranceContacts', start, 'REVIEW',
        'No email matched the Gmail query, so nothing was imported. Query: ' + CFG.GMAIL_QUERY);
      Logger.log('No email matched the query. Nothing to do.');
      return;
    }

    const from = msg.getFrom();
    const when = Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');
    detail.push('Source email: "' + msg.getSubject() + '" from ' + from + ' (' + when + ')');
    Logger.log('Email used: %s | %s | %s', when, from, msg.getSubject());

    // 1) Match each attachment to its question and parse it through the map
    const parsed = {};
    const attachments = msg.getAttachments({ includeInlineImages: false });
    let csvCount = 0, ignored = 0;

    attachments.forEach(function (att) {
      const name = att.getName() || '';
      if (!/\.csv$/i.test(name) && att.getContentType().indexOf('csv') === -1) { ignored++; return; }
      csvCount++;

      const rows = Utilities.parseCsv(att.getDataAsString('UTF-8'));
      if (!rows || rows.length < 1) {
        notes.push('CSV "' + name + '" was empty.');
        return;
      }

      const qKey = detectQuestion_(name, rows[0]);
      if (!qKey) {
        notes.push('CSV "' + name + '" did not match any question. Headers: ' + rows[0].join(' | '));
        Logger.log('Attachment not recognised: "%s". Headers: %s', name, rows[0].join(' | '));
        return;
      }
      Logger.log('Attachment "%s" recognised as %s (%s data row(s))', name, qKey, rows.length - 1);
      detail.push(qKey + ' <- "' + name + '" (' + (rows.length - 1) + ' rows)');
      parsed[qKey] = mapRows_(qKey, rows);
    });

    detail.push(csvCount + ' CSV attachment(s) read' + (ignored ? ', ' + ignored + ' non-CSV ignored' : ''));

    // 2) Stack the output in the configured order
    const out = [CFG.OUTPUT_COLS.slice()];
    CFG.OUTPUT_ORDER.forEach(function (qKey) {
      const block = parsed[qKey];
      if (block && block.length) out.push.apply(out, block);
      else {
        notes.push('No data for ' + qKey + ' in this email.');
        Logger.log('No data for %s in this email.', qKey);
      }
    });

    if (out.length < 2) throw new Error('Every attachment failed to parse — nothing was written.');

    // 3) Write the stacked tab
    writeToSheet_(out);
    detail.push((out.length - 1) + ' row(s) written to "' + CFG.SHEET_NAME + '"');
    Logger.log('Done: %s rows written (header included).', out.length);

    // 4) Build the lookup tab the email formulas use
    const built = writeContactEmails_(out);
    detail.push(built.codes + ' Property Code(s) in "' + CFG.EMAILS_SHEET_NAME + '" (' +
      built.noEmail + ' with none, largest list ' + built.max + ')');
    detail.push(built.portfolioContactsEmails + ' building contact(s) merged from "' + CFG.PORTFOLIO_CONTACTS_CONTACTS_SHEET +
      '" into ' + built.portfolioContactsHits + ' Property Code(s)');

    if (notes.length) status = 'REVIEW';
    logContactsRun_('updateInsuranceContacts', start, status,
      detail.join('. ') + '.' + (notes.length ? ' ' + notes.join(' ') : ''));

  } catch (err) {
    logContactsRun_('updateInsuranceContacts', start, 'ERROR',
      (detail.length ? detail.join('. ') + '. ' : '') + String(err && err.stack ? err.stack : err));
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getLatestMessage_() {
  const threads = GmailApp.search(CFG.GMAIL_QUERY, 0, 10);
  let latest = null;
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (!latest || m.getDate() > latest.getDate()) latest = m;
    });
  });
  return latest;
}

/** Normalises a header: strips BOM, turns arrows into "->", collapses spaces. */
function normHeader_(h) {
  return String(h)
    .replace(/^﻿/, '')
    .replace(/[→⟶]/g, '->')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Decides which question an attachment is (file name first, then header signature). */
function detectQuestion_(fileName, headerRow) {
  for (const qKey in QUESTIONS) {
    if (QUESTIONS[qKey].detectFile.test(fileName)) return qKey;
  }
  const hs = headerRow.map(normHeader_);
  const has = function (needle) { return hs.some(function (h) { return h.indexOf(needle) !== -1; }); };

  if (has('company partner contact email')) return 'q16290';
  if (has('property on demand'))            return 'q19375';
  if (has('property code') && has('frontdesk email')) return 'q16074';
  return null;
}

/** Finds a column index for a list of candidates (exact first, then "contains"). */
function findColIdx_(normHeaders, candidates) {
  const wanted = candidates.map(normHeader_);
  for (let i = 0; i < wanted.length; i++) {
    const idx = normHeaders.indexOf(wanted[i]);
    if (idx !== -1) return idx;
  }
  for (let i = 0; i < wanted.length; i++) {
    for (let j = 0; j < normHeaders.length; j++) {
      if (normHeaders[j].indexOf(wanted[i]) !== -1) return j;
    }
  }
  return -1;
}

/** Maps the CSV rows onto the 7 output columns for that question. */
function mapRows_(qKey, rows) {
  const header = rows[0].map(normHeader_);
  const map = QUESTIONS[qKey].map;

  const idx = CFG.OUTPUT_COLS.map(function (outCol) {
    const cands = map[outCol] || [];
    if (!cands.length) return -1;
    const i = findColIdx_(header, cands);
    if (i === -1) Logger.log('[%s] No header found for "%s" (candidates: %s)', qKey, outCol, cands.join(', '));
    return i;
  });

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const src = rows[r];
    if (src.every(function (c) { return c === '' || c == null; })) continue;
    out.push(idx.map(function (i) { return i === -1 ? '' : (src[i] != null ? src[i] : ''); }));
  }
  return out;
}

function writeToSheet_(values) {
  const ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
  let sh = ss.getSheetByName(CFG.SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CFG.SHEET_NAME);
  writeBlock_(sh, values, CFG.OUTPUT_COLS.length);
}

/**
 * Builds "Contact Emails": one row per Property Code with Frontdesk + Company
 * Partner Contact + Company Partner already joined and deduped, plus the
 * per-building contacts. Property Manager Email is deliberately left out.
 *
 * This tab exists so the charge tabs can use a plain VLOOKUP. The old formula
 * ran a FILTER over 25k rows for every one of ~3,900 lines, and that
 * recalculation — not the write itself — is what timed the Spreadsheet service
 * out while this script was saving.
 */
function writeContactEmails_(values) {
  const iCode = CFG.OUTPUT_COLS.indexOf('Property Code');
  const iBld  = CFG.OUTPUT_COLS.indexOf('Building ID Pk');
  const wanted = CFG.EMAIL_COLS
    .map(function (h) { return CFG.OUTPUT_COLS.indexOf(h); })
    .filter(function (i) { return i >= 0; });

  const portfolioContacts = readOdmoContacts_();

  // The key is the code uppercased and trimmed: "atl-1024a", "ATL-1024A " and
  // "ATL-1024A" used to become three rows, and VLOOKUP (which ignores case)
  // took only the first — usually the one with fewer emails.
  const byCode = {}, fromQuestions = {}, buildingOf = {}, order = [];
  for (let r = 1; r < values.length; r++) {
    const raw = String(values[r][iCode] || '').trim();
    if (!raw) continue;
    const code = raw.toUpperCase();
    if (!byCode[code]) { byCode[code] = []; fromQuestions[code] = 0; order.push(code); }

    if (iBld >= 0 && !buildingOf[code]) {
      const b = normBuildingId_(values[r][iBld]);
      if (b) buildingOf[code] = b;
    }

    for (let w = 0; w < wanted.length; w++) {
      const e = String(values[r][wanted[w]] || '').trim().toLowerCase();
      if (e.indexOf('@') === -1) continue;
      if (byCode[code].indexOf(e) === -1) { byCode[code].push(e); fromQuestions[code]++; }
    }
  }

  // Merge the building contacts. This is where the several emails per PO come
  // from — the questions alone almost always return a single one.
  let portfolioContactsHits = 0;
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    const list = portfolioContacts.map[buildingOf[c]];
    if (!list) continue;
    let added = 0;
    for (let k = 0; k < list.length; k++) {
      if (byCode[c].indexOf(list[k]) === -1) { byCode[c].push(list[k]); added++; }
    }
    if (added) portfolioContactsHits++;
  }

  const out = [['Property Code', 'Emails', 'Count', 'From questions', 'From building contacts']];
  let noEmail = 0, max = 0;
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    if (!byCode[c].length) noEmail++;
    if (byCode[c].length > max) max = byCode[c].length;
    out.push([c, byCode[c].join(', '), byCode[c].length,
              fromQuestions[c], byCode[c].length - fromQuestions[c]]);
  }

  const ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
  let sh = ss.getSheetByName(CFG.EMAILS_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CFG.EMAILS_SHEET_NAME);
  writeBlock_(sh, out, 5);

  Logger.log('Contact Emails: %s Property Codes, %s with none, largest list %s.', order.length, noEmail, max);
  Logger.log('   %s Property Code(s) gained an email from the building contacts.', portfolioContactsHits);

  return { codes: order.length, noEmail: noEmail, max: max,
           portfolioContactsEmails: portfolioContacts.total, portfolioContactsHits: portfolioContactsHits };
}

/** Building ID arrives as a number ("534" or "534.0"); normalise to compare. */
function normBuildingId_(v) {
  return String(v == null ? '' : v).trim().replace(/\.0+$/, '');
}

/**
 * Reads the tab holding the IMPORTRANGE of "Contacts" from Department Y Move-Outs
 * and returns { map: { BuildingID: [emails] }, total }. A missing tab is not
 * fatal — the import just carries on without it.
 */
function readOdmoContacts_() {
  const empty = { map: {}, total: 0 };
  const ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
  const sh = ss.getSheetByName(CFG.PORTFOLIO_CONTACTS_CONTACTS_SHEET);
  if (!sh) {
    Logger.log('Tab "%s" does not exist — carrying on with the BI platform questions only.', CFG.PORTFOLIO_CONTACTS_CONTACTS_SHEET);
    return empty;
  }

  const values = sh.getDataRange().getValues();
  if (values.length < 2) {
    Logger.log('Tab "%s" is empty (IMPORTRANGE still loading, or no access?).', CFG.PORTFOLIO_CONTACTS_CONTACTS_SHEET);
    return empty;
  }

  const header = values[0].map(normHeader_);
  const iB = header.indexOf(normHeader_(CFG.PORTFOLIO_CONTACTS_BUILDING_COL));
  const iE = header.indexOf(normHeader_(CFG.PORTFOLIO_CONTACTS_EMAIL_COL));
  const iT = header.indexOf(normHeader_(CFG.PORTFOLIO_CONTACTS_TITLE_COL));
  if (iB === -1 || iE === -1) {
    Logger.log('Tab "%s" has no "%s"/"%s" column. Headers: %s',
      CFG.PORTFOLIO_CONTACTS_CONTACTS_SHEET, CFG.PORTFOLIO_CONTACTS_BUILDING_COL, CFG.PORTFOLIO_CONTACTS_EMAIL_COL, values[0].join(' | '));
    return empty;
  }

  const skip = CFG.PORTFOLIO_CONTACTS_SKIP_TITLES.map(function (t) { return String(t).toLowerCase(); });
  const map = {};
  let n = 0;

  for (let r = 1; r < values.length; r++) {
    const bid = normBuildingId_(values[r][iB]);
    if (!bid) continue;
    const e = String(values[r][iE] || '').trim().toLowerCase();
    if (e.indexOf('@') === -1) continue;
    if (iT !== -1 && skip.length) {
      const title = String(values[r][iT] || '').trim().toLowerCase();
      if (skip.indexOf(title) !== -1) continue;
    }
    if (!map[bid]) map[bid] = [];
    if (map[bid].indexOf(e) === -1) { map[bid].push(e); n++; }
  }

  Logger.log('PORTFOLIO_CONTACTS Contacts: %s email(s) across %s building(s).', n, Object.keys(map).length);
  return { map: map, total: n };
}

/**
 * Writes a block WITHOUT the clear-then-write cycle. A clearContents() makes
 * every dependent formula recalculate against an empty tab and recalculate
 * again when the data lands — that double pass is what times the service out.
 * Only rows left over from a previous, longer run are cleared, at the end.
 */
function writeBlock_(sh, values, cols) {
  const rows = values.length;
  if (!rows) return;

  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());

  for (let i = 0; i < rows; i += CFG.WRITE_CHUNK) {
    const slice = values.slice(i, i + CFG.WRITE_CHUNK);
    sh.getRange(i + 1, 1, slice.length, cols).setValues(slice);
    SpreadsheetApp.flush();
  }

  const lastRow = sh.getLastRow();
  if (lastRow > rows) sh.getRange(rows + 1, 1, lastRow - rows, cols).clearContent();

  sh.getRange(1, 1, 1, cols).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function logContactsRun_(fnName, start, status, comment) {
  const dur = Math.round((new Date().getTime() - start.getTime()) / 10) / 100;
  const row = [fnName, start, status, dur, comment, ''];
  CFG.LOG_TARGETS.forEach(function (t) {
    try {
      const sh = SpreadsheetApp.openById(t.ID).getSheetByName(t.TAB);
      if (!sh) { Logger.log('Log tab "%s" not found.', t.TAB); return; }
      if (sh.getLastRow() === 0) sh.appendRow(CFG.LOG_HEADER);
      sh.appendRow(row);
    } catch (e) {
      Logger.log('Log write failed (%s): %s', t.TAB, e);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER — run this ONCE by hand to install the hourly job
// ─────────────────────────────────────────────────────────────────────────────
function installContactsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'updateInsuranceContacts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('updateInsuranceContacts').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger installed for updateInsuranceContacts.');
}
