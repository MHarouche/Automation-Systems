/**
 * FAST PATH — bookings that CRM already knows about but the upstream booking platform has not
 * loaded yet.
 *
 * WHY THIS EXISTS
 *   Measured on 2026-08-30:
 *     DEPARTMENT_Y bookings confirmed 2026-08-28 in DATAMART.BOOKING ....... 0
 *     DEPARTMENT_Y bookings confirmed 2026-08-27 in DATAMART.BOOKING ....... 32
 *     Accepted CRM quotes with ACCEPTED_ON = 2026-08-28 ............. 6
 *     STG_QUOTE_TH last loaded ............................................. 2 hours ago
 *     DATAMART.BOOKING newest confirmation ................................. 75 hours ago
 *
 *   USA-4023A, USA-4024A and USA-4025A sat in the queue with no financials for
 *   two days while their accepted quotes had been sitting in CRM since
 *   the same day the Slack posts arrived. The bottleneck is the the upstream booking platform load, not
 *   the BI platform question.
 *
 * WHAT IT DOES
 *   Imports a second BI platform CSV, driven from the CRM quote, into its
 *   own tab. Those rows have no Reference Code and no Record Code, because the
 *   Example Company property does not exist yet. They are keyed on
 *
 *       leading street number  +  "|"  +  postcode        e.g.  310|96734
 *
 *   which the queue can build from the Full Address it captured from Slack.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It never overrides Source Data. loadMbIndex_ consults this tab only when the
 *   normal PO / Record Code lookup finds nothing. As soon as the upstream booking platform catches up,
 *   the row disappears from this feed and the main feed takes over.
 *
 * STABILITY
 *   PIPELINE.REQUIRE_MB_STABLE compares two consecutive Source Data imports, keyed
 *   on Reference Code. A fast-path row has no PO, so mbValueDrift_ finds no previous
 *   snapshot and allows it through (see 2_SlackPipeline.gs line ~1169). That
 *   would send a fast row without the protection that caught the USA-4016A
 *   incident.
 *
 *   So stability is enforced HERE, at import time instead: a row is written to
 *   the tab only when the previous import carried identical values for it. The
 *   comparison snapshot lives in a Script Property. Cost is one extra import
 *   cycle, which at hourly cadence is an hour — against roughly two days saved.
 *
 *   OFF since 2026-09-03 (FASTPATH.REQUIRE_STABLE = false). Every row in the CSV
 *   is published on every import. The snapshot is still written, so turning the
 *   flag back on needs no other change.
 *
 * SOURCE QUERY
 *   Source Data_FASTPATH.sql
 */

const FASTPATH = {
  MAIN_SS_ID: 'YOUR_MAIN_SPREADSHEET_ID',
  FAST_TAB: 'Source Data Fast',
  SUBJECT: 'Automated Reach-Out Intake Email FastPath [Database Automation]',
  SEARCH_DAYS: 7,
  MAX_AGE_HOURS: 6,
  SEARCH_LIMIT: 100,
  LAST_MESSAGE_PROPERTY: 'FASTPATH_LAST_MSG_ID',
  SOURCE_THREAD_PROPERTY: 'FASTPATH_SOURCE_THREAD_ID',
  SOURCE_TIMESTAMP_PROPERTY: 'FASTPATH_LAST_SOURCE_EMAIL_TIMESTAMP',
  SNAPSHOT_PROPERTY: 'FASTPATH_PREVIOUS_SNAPSHOT',
  KEY_HEADER: 'Address Key',
  /** House number + state. Used only when the Slack address carries no postcode. */
  FALLBACK_KEY_HEADER: 'Address Key 2',
  REQUIRED_HEADERS: ['Address Key', 'Monthly Rent', 'Lease Start', 'Email Contact'],
  /** Must hold still across two consecutive imports before a row is published. */
  STABILITY_FIELDS: ['Monthly Rent', 'Lease Start', 'Lease End Date',
    'Security Deposit', 'Prop Cleaning Fee', 'Email Contact'],
  /** Guard against a runaway Script Property. Well above any realistic volume. */
  MAX_SNAPSHOT_ROWS: 400,
  /**
   * When true, a row is published only after two consecutive imports carried
   * identical values for it. Switched OFF on 2026-09-03: it held every new quote
   * for a full import cycle, and BI confirmed the feed is stable. The snapshot
   * is still recorded, so flipping this back on works immediately.
   */
  REQUIRE_STABLE: false,
  /** Master switch. false makes loadMbIndex_ behave exactly as it did before. */
  ENABLED: true
};

/** Address used by previewFastPathMatches() from the editor Run button. */
const FASTPATH_PREVIEW_DEFAULT_ADDRESS = '310 Manono St, Kailua, HI 96734, USA';

/* ===== KEY BUILDING ===== */

/**
 * Builds "310|96734" from free text. Returns '' when either half is missing,
 * which callers must treat as "do not match".
 *
 * The house number is the leading run of digits and hyphens, so "44-030 Kaimalu
 * Place" keeps its full number. The postcode is the first standalone 5-digit
 * group, so "652 10th Ave, Fairbanks, AK 99701" is not confused by "10th".
 */
function addressKeyFromText_(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const numberMatch = value.match(/^([0-9][0-9-]*)/);
  if (!numberMatch) return '';
  const number = String(numberMatch[1]).replace(/-+$/, '');
  if (!number) return '';
  // The house number is not the postcode. "11011 West North Avenue" used to
  // build the key "11011|11011" and match nothing. See zipFromAddressText_.
  const zip = typeof zipFromAddressText_ === 'function' ? zipFromAddressText_(value) : '';
  if (!zip) return '';
  return number + '|' + zip;
}

/**
 * Fallback key for a Slack address posted WITHOUT a postcode, which happens:
 * "962 Birchfield drive" (ATL-1356A) and "1747 Wickersham Dr, Anchorage, AK,
 * USA" (USA-4044A), both on 2026-09-03. House number + two-letter state, e.g.
 * "1747|AK". Weaker than the postcode key, so findMbMatch_ tries it only when
 * the postcode key cannot be built at all, and the one-candidate rule still
 * applies.
 *
 * The state comes from the queue's State column when it holds a code, else
 * through stateNameToCode_ when it holds a name, else it is read off the end of
 * the address itself. Returns '' when either half is missing.
 */
function addressFallbackKeyFromText_(text, stateHint) {
  const value = String(text || '').trim();
  const numberMatch = value.match(/^([0-9][0-9-]*)/);
  if (!numberMatch) return '';
  const number = String(numberMatch[1]).replace(/-+$/, '');
  if (!number) return '';

  let state = String(stateHint || '').trim().toUpperCase();
  if (state.length !== 2 && state && typeof stateNameToCode_ === 'function') {
    state = String(stateNameToCode_(stateHint) || '').trim().toUpperCase();
  }
  if (state.length !== 2) {
    const fromAddress = value.match(/\b([A-Z]{2})\b(?=[\s,]*(?:USA)?\s*$)/);
    state = fromAddress ? fromAddress[1] : '';
  }
  if (state.length !== 2) return '';
  return number + '|' + state;
}

/** Uppercase alphanumerics only, matching the normalisation used in the SQL. */
function normalizeUnitToken_(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Placeholders the quote uses when it is not naming a real unit. */
function isSentinelUnitToken_(token) {
  const value = normalizeUnitToken_(token);
  if (!value) return true;
  return ['TBD', 'NA', 'MULTI', 'VARIOUS', 'NONE', 'HOUSE', 'SFH'].indexOf(value) !== -1;
}

/**
 * Decides whether a queue row and a fast-path row describe the same unit.
 *
 * The address key (house number + postcode) has ALREADY matched by the time
 * this runs, and there is exactly one quote at that address. So the only thing
 * that can still prove a wrong match is an explicit contradiction: both sides
 * name a real unit and they disagree - Slack says #2005, the quote says 2008.
 *
 * Everything else is not evidence of a different unit and is accepted:
 *   - one side blank                              (Slack rarely carries a unit)
 *   - a placeholder such as NA / TBD              (the quote did not name one)
 *   - a description such as GUEST HOUSE or ADU    (one per address by nature)
 *
 * Simplified on 2026-09-03 after USA-4043A sat in the queue because the quote
 * said GUEST HOUSE and the Slack address named no unit. Requiring both sides to
 * agree on a unit that only one of them carries was blocking good matches
 * without protecting against anything.
 */
function fastPathUnitAgrees_(queueUnit, fastUnit) {
  const queue = normalizeUnitToken_(queueUnit);
  const fast = normalizeUnitToken_(fastUnit);
  if (isSentinelUnitToken_(queue) || isSentinelUnitToken_(fast)) return true;
  return queue === fast;
}
/* ===== INDEX ===== */

/**
 * Reads the fast tab and returns { byAddress: { key: [row, ...] } } where each
 * row is an array laid out to match Source Data's own header map. Shaping the rows
 * here means buildEmailObject_ and every downstream reader work unchanged.
 *
 * Never throws. A missing tab, a missing header or any read error yields an
 * empty index, so the pipeline degrades to exactly its previous behaviour.
 */
function loadFastPathIndex_(mbHeaderMap) {
  const empty = { byAddress: {}, byAddressFallback: {}, rowCount: 0 };
  if (!FASTPATH.ENABLED) return empty;
  if (!mbHeaderMap || !Object.keys(mbHeaderMap).length) return empty;

  let data;
  try {
    const sheet = SpreadsheetApp.openById(FASTPATH.MAIN_SS_ID).getSheetByName(FASTPATH.FAST_TAB);
    if (!sheet || sheet.getLastRow() < 2) return empty;
    data = sheet.getDataRange().getValues();
  } catch (error) {
    Logger.log('Fast path index skipped: ' + error);
    return empty;
  }

  const fastMap = headerMap_(data[0]);
  if (fastMap[FASTPATH.KEY_HEADER] === undefined) return empty;

  // Width of a synthetic row: enough to hold every Source Data column.
  let width = 0;
  Object.keys(mbHeaderMap).forEach(function(header) {
    if (mbHeaderMap[header] + 1 > width) width = mbHeaderMap[header] + 1;
  });
  if (!width) return empty;

  const byAddress = {};
  const byAddressFallback = {};
  const hasFallback = fastMap[FASTPATH.FALLBACK_KEY_HEADER] !== undefined;
  let rowCount = 0;

  for (let row = 1; row < data.length; row++) {
    const source = data[row];
    const key = String(valueFrom_(source, fastMap, FASTPATH.KEY_HEADER) || '').trim();
    if (!key) continue;

    const shaped = [];
    for (let column = 0; column < width; column++) shaped.push('');
    Object.keys(mbHeaderMap).forEach(function(header) {
      if (fastMap[header] === undefined) return;
      shaped[mbHeaderMap[header]] = source[fastMap[header]];
    });

    // The quote writes an absent unit as "n/a", "TBD" or "MULTI". buildEmailObject_
    // copies Unit No straight into the email, so a placeholder must not survive.
    if (mbHeaderMap['Unit No'] !== undefined &&
        isSentinelUnitToken_(shaped[mbHeaderMap['Unit No']])) {
      shaped[mbHeaderMap['Unit No']] = '';
    }

    if (!byAddress[key]) byAddress[key] = [];
    byAddress[key].push(shaped);
    rowCount++;

    // Second index on house number + state, for Slack addresses with no postcode.
    if (hasFallback) {
      const key2 = String(valueFrom_(source, fastMap, FASTPATH.FALLBACK_KEY_HEADER) || '').trim();
      if (key2) {
        if (!byAddressFallback[key2]) byAddressFallback[key2] = [];
        byAddressFallback[key2].push(shaped);
      }
    }
  }
  return { byAddress: byAddress, byAddressFallback: byAddressFallback, rowCount: rowCount };
}

/* ===== IMPORT ===== */

/**
 * Returns the most recent exact-subject message with a CSV attachment for the
 * fast path. Mirrors findLatestAutomatedReachOutCsv_ but reads the FASTPATH constants, so
 * the two feeds cannot pick up each other's emails.
 */
function findLatestFastPathCsv_(properties) {
  const candidateThreads = [];
  const seenThreadIds = {};

  function addFastPathThread_(thread) {
    if (!thread) return;
    const threadId = thread.getId();
    if (!threadId || seenThreadIds[threadId]) return;
    seenThreadIds[threadId] = true;
    try { GmailApp.refreshThread(thread); } catch (error) {}
    candidateThreads.push(thread);
  }

  const rememberedThreadId = properties.getProperty(FASTPATH.SOURCE_THREAD_PROPERTY);
  if (rememberedThreadId) {
    try { addFastPathThread_(GmailApp.getThreadById(rememberedThreadId)); }
    catch (error) { Logger.log('Remembered fast path thread could not be loaded: ' + error); }
  }

  const query = 'in:anywhere subject:"' + FASTPATH.SUBJECT +
    '" has:attachment newer_than:' + FASTPATH.SEARCH_DAYS + 'd';
  GmailApp.search(query, 0, FASTPATH.SEARCH_LIMIT).forEach(addThread);

  let latest = null;
  let eligibleMessageCount = 0;

  candidateThreads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      if (String(message.getSubject() || '').trim() !== FASTPATH.SUBJECT) return;

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
          attachmentName: csvAttachments[0].getName()
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

/** Signature of one row for the stability comparison. */
function fastPathRowSignature_(row, map) {
  const parts = [];
  (FASTPATH.STABILITY_FIELDS || []).forEach(function(header) {
    const raw = map[header] === undefined ? '' : row[map[header]];
    parts.push(header + '=' + normalizeMbFieldForCompare_(header, raw));
  });
  return parts.join('|');
}

/**
 * Imports the fast path CSV.
 *
 * Only rows whose stability fields are identical to the previous import are
 * written to the tab. Everything else is held back and reported, so a value
 * that is still moving can never reach an email.
 */
function importAutomatedReachOutFastPathData() {
  const started = new Date();
  const functionName = 'importAutomatedReachOutFastPathData';

  if (!FASTPATH.ENABLED) {
    logImport_(functionName, started, 'REVIEW', 'FASTPATH.ENABLED is false; nothing was imported.');
    return;
  }

  try {
    const properties = PropertiesService.getScriptProperties();
    const source = findLatestFastPathCsv_(properties);

    if (!source) {
      logImport_(functionName, started, 'ERROR',
        'No email was found with the exact subject "' + FASTPATH.SUBJECT +
        '" and a CSV attachment within the last ' + FASTPATH.SEARCH_DAYS + ' days.');
      return;
    }

    properties.setProperty(FASTPATH.SOURCE_THREAD_PROPERTY, source.threadId);
    properties.setProperty(FASTPATH.SOURCE_TIMESTAMP_PROPERTY, source.messageDate.toISOString());

    const ageHours = Math.max(0, (started.getTime() - source.messageDate.getTime()) / 3600000);
    const ageWarning = ageHours > FASTPATH.MAX_AGE_HOURS;
    const lastMessageId = properties.getProperty(FASTPATH.LAST_MESSAGE_PROPERTY) || '';
    const isNewMessage = source.messageId !== lastMessageId;

    const spreadsheet = SpreadsheetApp.openById(FASTPATH.MAIN_SS_ID);
    let sheet = spreadsheet.getSheetByName(FASTPATH.FAST_TAB);
    if (!sheet) sheet = spreadsheet.insertSheet(FASTPATH.FAST_TAB);
    const destinationIsEmpty = sheet.getLastRow() < 2;

    if (!isNewMessage && !destinationIsEmpty) {
      logImport_(functionName, started, 'REVIEW',
        'No new fast path source email; the tab was not rewritten.' +
        (ageWarning ? ' | WARNING: source may be stale.' : ''));
      return;
    }

    const csvText = source.attachment.getDataAsString('UTF-8').replace(/^﻿/, '');
    const rows = Utilities.parseCsv(csvText);
    if (!rows || rows.length < 2) {
      logImport_(functionName, started, 'REVIEW', 'The fast path CSV is empty or header only.');
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

    const headers = normalizedRows[0].map(function(header) { return String(header || '').trim(); });
    const missingHeaders = FASTPATH.REQUIRED_HEADERS.filter(function(header) {
      return headers.indexOf(header) === -1;
    });
    if (missingHeaders.length) {
      throw new Error('The fast path CSV is missing required header(s): ' +
        missingHeaders.join(', ') + '. Existing tab data was preserved.');
    }
    normalizedRows[0] = headers;

    const map = headerMap_(headers);
    const keyIndex = map[FASTPATH.KEY_HEADER];

    // Compare against the previous import before publishing anything.
    let previous = {};
    try {
      const stored = properties.getProperty(FASTPATH.SNAPSHOT_PROPERTY);
      if (stored) previous = JSON.parse(stored) || {};
    } catch (error) {
      Logger.log('Fast path snapshot unreadable, treating as empty: ' + error);
      previous = {};
    }

    const snapshot = {};
    const stableRows = [headers];
    const heldKeys = [];
    let dataRowCount = 0;

    for (let row = 1; row < normalizedRows.length; row++) {
      const values = normalizedRows[row];
      const key = String(values[keyIndex] || '').trim();
      if (!key) continue;
      dataRowCount++;

      const signature = fastPathRowSignature_(values, map);
      if (Object.keys(snapshot).length < FASTPATH.MAX_SNAPSHOT_ROWS) snapshot[key] = signature;

      if (!FASTPATH.REQUIRE_STABLE || previous[key] === signature) {
        stableRows.push(values);
      } else {
        heldKeys.push(key + (previous[key] === undefined ? ' (first sighting)' : ' (changed)'));
      }
    }

    replaceMbSheetData_(sheet, stableRows, maximumColumns);
    properties.setProperty(FASTPATH.LAST_MESSAGE_PROPERTY, source.messageId);
    properties.setProperty(FASTPATH.SNAPSHOT_PROPERTY, JSON.stringify(snapshot));

    const heldNote = heldKeys.length
      ? ' | HELD for stability: ' + heldKeys.length + ' row(s): ' + heldKeys.slice(0, 20).join(', ') +
        (heldKeys.length > 20 ? ' ...' : '')
      : '';
    logImport_(functionName, started, ageWarning ? 'REVIEW' : 'OK',
      'Fast path: ' + (stableRows.length - 1) + ' of ' + dataRowCount +
      ' row(s) published to "' + FASTPATH.FAST_TAB + '".' +
      (ageWarning ? ' | WARNING: source may be stale.' : '') + heldNote);

    try {
      reEnrichSlackRows_();
    } catch (error) {
      logImport_('reEnrich(after fast path)', started, 'REVIEW',
        'Fast path imported, but queue reprocessing failed: ' + error);
    }
  } catch (error) {
    logImport_(functionName, started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

/** Hourly trigger, matching the BI platform subscription cadence. */
function createFastPathImportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'importAutomatedReachOutFastPathData') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('importAutomatedReachOutFastPathData').timeBased().everyHours(1).create();
}

/* ===== DIAGNOSTICS ===== */

/**
 * Shows what the fast tab would resolve for one address. Sends nothing.
 * The Run button cannot pass arguments, so it falls back to
 * FASTPATH_PREVIEW_DEFAULT_ADDRESS.
 */
function previewFastPathMatches(address) {
  const target = String(address || FASTPATH_PREVIEW_DEFAULT_ADDRESS || '').trim();
  const key = addressKeyFromText_(target);
  const lines = ['Address : ' + target, 'Key     : ' + (key || '(none - no house number or no postcode)')];

  const mbSheet = SpreadsheetApp.openById(FASTPATH.MAIN_SS_ID).getSheetByName(SLACK.MB_TAB);
  const mbMap = mbSheet && mbSheet.getLastRow() ? headerMap_(mbSheet.getDataRange().getValues()[0]) : {};
  const index = loadFastPathIndex_(mbMap);
  lines.push('Fast tab rows loaded: ' + index.rowCount);

  const hits = key ? (index.byAddress[key] || []) : [];
  lines.push('Rows for this key   : ' + hits.length);
  hits.forEach(function(row) {
    lines.push('  quote=' + valueFrom_(row, mbMap, 'Source Quote Number') +
      ' unit=' + valueFrom_(row, mbMap, 'Unit No') +
      ' rent=' + valueFrom_(row, mbMap, 'Monthly Rent') +
      ' deposit=' + valueFrom_(row, mbMap, 'Security Deposit') +
      ' cleaning=' + valueFrom_(row, mbMap, 'Prop Cleaning Fee') +
      ' start=' + fmtDateOnly(valueFrom_(row, mbMap, 'Lease Start')) +
      ' email=' + valueFrom_(row, mbMap, 'Email Contact'));
  });

  const text = lines.join('\n');
  Logger.log(text);
  return text;
}

/** Lists every key currently published on the fast tab. Sends nothing. */
function previewFastPathTab() {
  const mbSheet = SpreadsheetApp.openById(FASTPATH.MAIN_SS_ID).getSheetByName(SLACK.MB_TAB);
  const mbMap = mbSheet && mbSheet.getLastRow() ? headerMap_(mbSheet.getDataRange().getValues()[0]) : {};
  const index = loadFastPathIndex_(mbMap);
  const keys = Object.keys(index.byAddress);
  const lines = ['Fast tab: ' + index.rowCount + ' row(s) across ' + keys.length + ' key(s).'];
  keys.forEach(function(key) {
    index.byAddress[key].forEach(function(row) {
      lines.push('  ' + key + '  rent=' + valueFrom_(row, mbMap, 'Monthly Rent') +
        '  start=' + fmtDateOnly(valueFrom_(row, mbMap, 'Lease Start')) +
        '  email=' + valueFrom_(row, mbMap, 'Email Contact'));
    });
  });
  const text = lines.join('\n');
  Logger.log(text);
  return text;
}

/* ===== TEMPLATE ON THE FAST PATH ===== */

/**
 * Every spelling of a private owner type seen in the Reference Properties export
 * on 2026-09-15, as the Slack "Partner:" line would normalise them.
 *
 * This is an EXACT-MATCH list on purpose, and does NOT use the PRIV pattern
 * that isPrivateProviderValue_ applies to External Provider. The two fields are
 * not the same kind of thing: External Provider is a system value from
 * SMT_PROPERTY with a known vocabulary, while Partner is free text scraped out
 * of a Slack message with a regex. On free text, "contains PRIV" would classify
 * a company called Privilege Homes or Privet Partners as a private owner and
 * send it the wrong template with the wrong attachments.
 */
const PRIVATE_PARTNER_VALUES = [
  'PRIVATE_OWNER',
  'INDEPENDENT_OWNER',
  'PRIVATE_MANAGEMENT_GROUP',
  'PRIVATE_OWNER',
  'PRIVIATE_OWNER',
  'PRIVATELY_HELD_COMPANY',
  'PRIVATE_RENTAL',
  'PRIVATELY_MANAGED',
  'PRIVATE_INDIVDIUAL'
];

/**
 * Maps the Slack booking's free-text "Partner:" line onto an External Provider
 * code, but ONLY when it names one of the known private types exactly. Anything
 * else returns '' so the email falls back to GENERAL or PARTNER exactly as before.
 *
 * Why this exists: External Provider comes from SMT_PROPERTY. On the fast path
 * that property has not loaded, so the field is blank and resolveEmailContext_
 * picks GENERAL. A private owner would then receive the wrong template with no
 * Automated Reach-Out Doc attachment.
 *
 * Widened on 2026-09-16 from the three values in PRIVATE_PROVIDERS to the nine
 * in PRIVATE_PARTNER_VALUES. Without this, a booking whose Partner line reads
 * "Privately Held Company" was recognised as private when SMT_PROPERTY had
 * loaded, and silently not recognised when it had not - the same property
 * getting a different template depending only on how fast the upstream booking platform ran.
 *
 * Called from contextForItem_ only after the PARTNER match came back empty.
 */
function providerFromPartner_(partner) {
  const code = String(partner || '').trim().toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
  if (!code) return '';
  return PRIVATE_PARTNER_VALUES.indexOf(code) !== -1 ? code : '';
}
