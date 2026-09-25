/**
 * RENEWAL OFFER FOLLOW-UPS
 * =============================================================================
 */

var CONFIG = {
  // ---- data sources -------------------------------------------------------
  RENEWAL_SHEET_ID: 'YOUR_RENEWAL_SPREADSHEET_ID',
  RENEWAL_TAB: 'RENEWALS VIEW (NEW)',
  REQUEST_LOG_TAB: 'Request_log',

  LOG_SHEET_ID: 'YOUR_LOG_SPREADSHEET_ID',
  LOG_TAB: 'Renewals Follow-Ups',
  PREVIEW_TAB: 'Renewals Follow-Ups (Preview)',

  // Detailed per-PO control log. Lives in the renewal sheet, refreshed on
  // every real send.
  CONTROL_TAB: 'Renewals Follow-Up Control',

  // ---- cadence ------------------------------------------------------------
  // Chasing opens the week after the request email went out, and then runs
  // weekly until the property manager answers or the lease ends. The notice
  // date (lease end - NTV) no longer gates anything; it is still carried
  // through for the email wording and the control tab, because it is the date
  // the business actually cares about.
  FOLLOW_UP_STARTS_AFTER_DAYS: 7,
  FOLLOW_UP_INTERVAL_DAYS: 7,
  RUN_EVERY_DAYS: 7,

  // Hard floor between two follow-ups on the same thread, whatever the tier
  // says. Guards against a manual run landing on top of the weekly trigger.
  MIN_DAYS_BETWEEN_FOLLOWUPS: 5,

  // Runaway guard, not a policy. Weekly chasing over the longest notice
  // period (NTV 90, so about 13 weeks) stays under this. Set to 0 to disable.
  MAX_FOLLOW_UPS_PER_THREAD: 15,

  // ---- sending ------------------------------------------------------------
  // Empty means send as the inbox itself, which is the intended behaviour:
  // a reply from info-bos@ keeps the property manager's own reply landing in
  // that city inbox. Set this to a send-as alias only if the follow-up should
  // appear to come from somewhere else, and only when that alias really is
  // configured on all twelve accounts.
  SEND_AS: '',
  // Address printed in the sign-off. Independent of who sends, so the thread
  // keeps signing the same way the original request email did.
  SIGNATURE_EMAIL: 'operations@example.com',
  MAX_SENDS_PER_RUN: 60,

  // Tells the property manager about our notice date. Motivating, but it does
  // disclose an internal date. Set to false to drop the sentence.
  INCLUDE_DEADLINE_LINE: true,

  // Mirrors the extra paragraph the NYC request email carries.
  ASK_FOR_BUILDING_CONTACTS: false,

  // ---- renewal cycle ------------------------------------------------------
  // "Offer Email sent" stays YES from the previous cycle, so the request date
  // in Request_log is what says which cycle a unit belongs to. A request older
  // than this belongs to a closed cycle: its thread was already answered and
  // the lease already renewed, so replying into it would make no sense. Those
  // units are reported instead, because what they actually need is the request
  // email for the new cycle.
  MAX_REQUEST_AGE_DAYS: 120,

  // ---- thread lookup ------------------------------------------------------
  // Bounds the Gmail search window. Kept just above MAX_REQUEST_AGE_DAYS so
  // every thread that is still chaseable stays findable, and nothing older is
  // even looked at.
  SEARCH_WINDOW: '150d',
  // Optional Gmail label to restrict the search to, e.g. 'Renewal Offers'.
  // Left empty because the label is applied by filter and is not guaranteed.
  LABEL_FILTER: '',

  // ---- scope --------------------------------------------------------------
  // Only units whose request email already went out are chased.
  REQUIRE_OFFER_EMAIL_SENT: true,
  // A value in "Gross Renewal Rate" means the property manager already sent
  // the offer, so there is nothing left to chase.
  SKIP_IF_GROSS_RENEWAL_RATE: true,
  // Also skip units flagged "Is Dropped" even when "Is Actually Dropped" is
  // FALSE. Leaving this false keeps the 168 drop-pending-but-not-final units
  // in the chase.
  SKIP_IF_IS_DROPPED: false,

  // Share of units with no matching thread that is tolerated before the run is
  // logged as REVIEW. Threads older than SEARCH_WINDOW never match, so a small
  // number of misses is normal and flagging every one of them would make
  // REVIEW meaningless.
  REVIEW_IF_UNRESOLVED_RATIO: 0.2,

  // ---- runtime ------------------------------------------------------------
  // Stop processing and log REVIEW past this point, to stay inside the
  // Apps Script 6 minute execution limit. Groups are processed most-urgent
  // first, so anything skipped is the least urgent.
  TIME_BUDGET_MS: 4.5 * 60 * 1000,
  LOCK_WAIT_MS: 30000,

  // ---- identity -----------------------------------------------------------
  INTERNAL_DOMAINS: [
    'example.com',
    'travelershaven.com',
    'units.example.com'
  ],

  // Script property that hard-disables sending, for use as a kill switch.
  KILL_SWITCH_PROPERTY: 'RENEWAL_FOLLOWUPS_ENABLED',

  // ---- replay protection --------------------------------------------------
  // Thread id -> day the last follow-up was sent, kept in script properties.
  // The thread's own message history is already the primary guard, but Gmail
  // can lag by a moment, so this is the second lock that makes a repeat run
  // unable to send twice.
  LEDGER_PROPERTY: 'RENEWAL_FOLLOWUP_LEDGER',
  LEDGER_RETENTION_DAYS: 200,

  // ---- sample email -------------------------------------------------------
  SAMPLE_RECIPIENT: 'maintainer@example.com',
  SAMPLE_TEAM: [
    'maintainer@example.com',
    'renewal-owner@example.com',
    'renewal-reviewer@example.com'
  ],

  // ---- trigger ------------------------------------------------------------
  TRIGGER_WEEKDAY: 'WEDNESDAY',
  TRIGGER_HOUR: 10,
  TRIGGER_TIMEZONE: 'America/New_York'
};

/** Inbox address -> city code used in the renewal sheet. */
var CITY_BY_INBOX = {
  'regional-team@example.com': 'SAN',
  'regional-team@example.com': 'LAX',
  'regional-team@example.com': 'WDC',
  'regional-team@example.com': 'BOS',
  'regional-team@example.com': 'MIA',
  'regional-team@example.com': 'DEN',
  'regional-team@example.com': 'PDX',
  'regional-team@example.com': 'SFO',
  'regional-team@example.com': 'ATX',
  'regional-team@example.com': 'CHI',
  'regional-team@example.com': 'NYC',
  'regional-team@example.com': 'SEA'
};

/** Header names read from the renewal view. */
var COL = {
  CITY: 'City',
  PROPERTY_CODE: 'PO',
  BUILDING: 'Building',
  UNIT: ' Apt',
  NTV_DAYS: 'Notice to Vacate (Days)',
  LEASE_END: 'Latest Lease End Date',
  GROSS_RENEWAL_RATE: 'Gross Renewal Rate',
  OFFER_EMAIL_SENT: 'Offer Email sent',
  IS_DROPPED: 'Is Dropped',
  IS_ACTUALLY_DROPPED: 'Is Actually Dropped'
};

// Property codes are almost always CCC-nnn, but 14 of them carry a letter
// suffix (SEA-974A, BOS-555A, ATX-72A), so the suffix is part of the token.
var UNIT_ALIAS_PATTERN = /\b([A-Z]{3}-\d+[A-Z]?)@example-company-apartments\.com\b/gi;

// Spreadsheet error values, which must never reach an email body.
var SHEET_ERROR_VALUE = /^#(REF|N\/A|VALUE|DIV\/0|NAME\?|NUM|NULL)!?$/i;

// The " Apt" column holds text, and 109 rows were flattened into scientific
// notation ("6.31E+02" instead of 631). The original value cannot be recovered
// without guessing, so these units are reported instead of emailed.
var SCIENTIFIC_NOTATION = /^\s*\d+(\.\d+)?E[+-]?\d+\s*$/i;

var AUTO_REPLY_SUBJECT = new RegExp([
  'out of (the )?office',
  'automatic reply',
  'auto[- ]?reply',
  'autoreply',
  'auto[- ]?response',
  'away from (my|the) (desk|office)',
  'on vacation',
  'currently out',
  'no longer with'
].join('|'), 'i');

// A bounce means the request email never arrived, which is a different problem
// from an auto-reply and has to surface for a human.
var BOUNCE_SUBJECT = new RegExp([
  'undeliverable',
  'delivery status notification',
  'returned mail',
  'mail delivery (failed|subsystem)',
  'address not found',
  'message blocked'
].join('|'), 'i');

var BOUNCE_SENDER = /(mailer-daemon|postmaster|no-?reply@.*(mail|smtp))/i;

// =============================================================================
// ENTRY POINTS
// =============================================================================

/**
 * Trigger target. Computes the queue and sends the due follow-ups.
 */
function sendRenewalFollowUps() {
  runFollowUps_('sendRenewalFollowUps', false);
}

/**
 * Review pass. Computes the exact same queue but sends nothing and writes the
 * per-thread decision to the Preview tab.
 */
function dryRunRenewalFollowUps() {
  runFollowUps_('dryRunRenewalFollowUps', true);
}

/**
 * Sends one sample follow-up to Maintainer only, to eyeball the wording.
 * Nothing is replied to and no real thread is touched.
 */
function sendSampleEmailToMe() {
  sendSample_([CONFIG.SAMPLE_RECIPIENT]);
}

/**
 * Sends the same sample to Maintainer, Gabriella and Ana together.
 */
function sendSampleEmailToTeam() {
  sendSample_(CONFIG.SAMPLE_TEAM);
}

/**
 * Creates the weekly trigger on this inbox, removing any trigger already
 * pointing at sendRenewalFollowUps first, so re-running the installer can
 * never leave two triggers firing on the same day.
 */
function installWeeklyTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'sendRenewalFollowUps') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  ScriptApp.newTrigger('sendRenewalFollowUps')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay[CONFIG.TRIGGER_WEEKDAY])
    .atHour(CONFIG.TRIGGER_HOUR)
    .create();

  var zone = Session.getScriptTimeZone();
  var lines = ['Weekly trigger set for ' + CONFIG.TRIGGER_WEEKDAY + ' at ' +
    CONFIG.TRIGGER_HOUR + ':00 ' + zone +
    (removed ? ', replacing ' + removed + ' existing trigger(s)' : '') + '.'];

  // Apps Script schedules clock triggers on the PROJECT timezone, so the hour
  // only means what it says when the project is set to the intended zone.
  if (zone !== CONFIG.TRIGGER_TIMEZONE) {
    lines.push('NOTE: the trigger fires at ' + CONFIG.TRIGGER_HOUR + ':00 ' + zone +
      ', not ' + CONFIG.TRIGGER_HOUR + ':00 ' + CONFIG.TRIGGER_TIMEZONE +
      '. Either change the project timezone under Project Settings, or set ' +
      'CONFIG.TRIGGER_TIMEZONE to ' + zone + ' to confirm this is intended. ' +
      'Beware that the gap between a US zone and Sao Paulo moves twice a year, ' +
      'because Brazil no longer observes daylight saving and the US does.');
  }

  // The one that can actually put a wrong date in front of a landlord: sheet
  // dates are read in the SPREADSHEET's zone and rendered in the SCRIPT's, so
  // a mismatch shifts every formatted date by a day.
  try {
    var sheetZone = SpreadsheetApp.openById(CONFIG.RENEWAL_SHEET_ID).getSpreadsheetTimeZone();
    lines.push('Renewal sheet timezone: ' + sheetZone + '.');
    if (sheetZone !== zone) {
      lines.push('WARNING: the renewal sheet is on ' + sheetZone + ' but this script is ' +
        'on ' + zone + '. Lease end dates are read in the sheet timezone and printed in ' +
        'the script timezone, so they can land a day out in the email body and in "' +
        CONFIG.CONTROL_TAB + '". Put both on the same zone before enabling the trigger.');
    }
  } catch (err) {
    lines.push('Could not read the renewal sheet timezone: ' + describeError_(err));
  }

  var message = lines.join(' ');
  Logger.log(message);
  return message;
}

// =============================================================================
// DEPARTMENT_X
// =============================================================================

function runFollowUps_(functionName, dryRun) {
  var started = Date.now();
  var inbox = '';
  var city = '';

  try {
    inbox = Session.getEffectiveUser().getEmail();
    city = CITY_BY_INBOX[String(inbox).toLowerCase()];

    if (!city) {
      logRun_(functionName, 'ERROR', started,
        'Unmapped inbox "' + inbox + '". Add it to CITY_BY_INBOX before enabling the trigger.');
      return;
    }

    if (!dryRun && !sendingEnabled_()) {
      logRun_(functionName, 'REVIEW', started,
        city + ': kill switch is on (script property ' + CONFIG.KILL_SWITCH_PROPERTY +
        ' = false). Nothing was sent.');
      return;
    }

    var candidates = loadCandidates_(city);
    if (!candidates.rows.length) {
      logRun_(functionName, 'OK', started,
        city + ': no live units. ' + candidates.summary);
      return;
    }

    var groups = groupByBuilding_(candidates.rows);
    var cache = readControlThreadIds_();
    var resolved = resolveThreads_(groups, started, cache.map);
    var plans = buildPlans_(resolved.threads, city);
    var outcome = dryRun
      ? { sent: 0, failed: 0, notes: [] }
      : dispatch_(plans, city);

    var control = { written: 0, missingColumns: [] };
    if (dryRun) {
      writePreview_(plans, inbox, city);
    } else {
      // Deliberately non-fatal, and deliberately after the sending. The emails
      // are already out and the ledger already stamped, so a control-tab
      // problem must be reported rather than thrown, or the run log would read
      // as a failure that sent nothing.
      try {
        control = refreshControlTab_(plans, city);
        if (control.missingColumns.length) {
          outcome.notes.push('Tab "' + CONFIG.CONTROL_TAB + '" is missing the column(s) ' +
            control.missingColumns.join(', ') + ', so those values were not written.');
        }
      } catch (controlError) {
        outcome.notes.push('Could not refresh "' + CONFIG.CONTROL_TAB + '": ' +
          describeError_(controlError) + '. The follow-ups themselves went out fine.');
      }
    }

    logRun_(functionName, statusFor_(resolved, outcome, plans, candidates.rows.length),
      started, buildComment_(city, candidates, resolved, plans, outcome, dryRun, control, cache));

  } catch (err) {
    logRun_(functionName, 'ERROR', started,
      (city || inbox || 'unknown') + ': ' + describeError_(err));
    throw err;
  }
}

/**
 * Reads the renewal view and keeps only units that are still worth chasing.
 */
function loadCandidates_(city) {
  var sheet = SpreadsheetApp.openById(CONFIG.RENEWAL_SHEET_ID)
    .getSheetByName(CONFIG.RENEWAL_TAB);
  if (!sheet) {
    throw new Error('Tab "' + CONFIG.RENEWAL_TAB + '" not found in the renewal sheet.');
  }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) {
    return { rows: [], summary: 'Renewal view is empty.' };
  }

  // The view is ~7k rows by ~118 columns. Reading the whole grid is roughly
  // 830k cells, so only the handful of columns actually needed are pulled,
  // one column at a time.
  var index = resolveColumns_(sheet.getRange(1, 1, 1, lastCol).getValues()[0]);
  var columns = readColumns_(sheet, index, lastRow);
  var requestDates = readRequestLog_();
  var today = startOfDay_(new Date());

  var rows = [];
  var previousCycle = [];
  var notStarted = [];
  var skipped = {
    otherCity: 0, notSent: 0, hasRate: 0, dropped: 0,
    missingData: 0, leaseEnded: 0, noRequestDate: 0
  };

  for (var r = 0; r < lastRow - 1; r++) {
    var row = columns[r];
    var propertyCode = trim_(row[index.PROPERTY_CODE]);
    if (!propertyCode) continue;

    if (trim_(row[index.CITY]) !== city) { skipped.otherCity++; continue; }

    if (CONFIG.REQUIRE_OFFER_EMAIL_SENT &&
        trim_(row[index.OFFER_EMAIL_SENT]).toUpperCase() !== 'YES') {
      skipped.notSent++;
      continue;
    }

    // A gross renewal rate on the row means the offer is already in hand.
    if (CONFIG.SKIP_IF_GROSS_RENEWAL_RATE && trim_(row[index.GROSS_RENEWAL_RATE])) {
      skipped.hasRate++;
      continue;
    }

    if (isTrue_(row[index.IS_ACTUALLY_DROPPED]) ||
        (CONFIG.SKIP_IF_IS_DROPPED && isTrue_(row[index.IS_DROPPED]))) {
      skipped.dropped++;
      continue;
    }

    var leaseEnd = asDate_(row[index.LEASE_END]);
    var ntvDays = asNumber_(row[index.NTV_DAYS]);
    if (!leaseEnd || ntvDays === null) { skipped.missingData++; continue; }

    // The notice date is informational now: it is what the follow-up email
    // refers to, and what the control tab reports. The lease end is the only
    // hard stop, because once it has passed there is nothing to negotiate.
    var noticeDate = addDays_(leaseEnd, -ntvDays);
    var daysToNoticeDate = daysBetween_(today, noticeDate);
    var daysToLeaseEnd = daysBetween_(today, leaseEnd);
    if (daysToLeaseEnd < 0) { skipped.leaseEnded++; continue; }

    // Which renewal cycle does the request email belong to? Anything older
    // than the cutoff was answered in a previous cycle, and the lease was
    // already renewed off the back of it. Chasing that thread would be wrong,
    // so the unit is reported as still waiting for this cycle's request.
    var requestDate = requestDates[propertyCode.toUpperCase()] || null;
    if (!requestDate) { skipped.noRequestDate++; continue; }

    var requestAge = daysBetween_(requestDate, today);
    if (requestAge > CONFIG.MAX_REQUEST_AGE_DAYS) {
      previousCycle.push({
        propertyCode: propertyCode,
        building: trim_(row[index.BUILDING]),
        requestAge: requestAge
      });
      continue;
    }

    // Chasing opens one interval after the request email, so the property
    // manager gets a clear week to answer before being nudged.
    var followUpStart = addDays_(requestDate, CONFIG.FOLLOW_UP_STARTS_AFTER_DAYS);
    var daysSinceStart = daysBetween_(followUpStart, today);
    if (daysSinceStart < 0) {
      notStarted.push({
        propertyCode: propertyCode,
        building: trim_(row[index.BUILDING]),
        followUpStart: followUpStart,
        daysUntilStart: -daysSinceStart
      });
      continue;
    }

    // The unit line is rebuilt from its parts rather than read from the
    // "Front desk mail" column, because that column carries #REF! on two rows
    // and has been typed over on at least one other.
    var unit = trim_(row[index.UNIT]);
    var dataIssue = describeUnitIssue_(unit);

    rows.push({
      propertyCode: propertyCode,
      city: city,
      building: trim_(row[index.BUILDING]),
      unit: unit,
      dataIssue: dataIssue,
      requestDate: requestDate,
      requestAge: requestAge,
      unitLine: 'Unit: ' + unit + ' | ' + propertyCode +
                '@units.example.com | Lease end date: ' + formatDate_(leaseEnd),
      leaseEnd: leaseEnd,
      ntvDays: ntvDays,
      noticeDate: noticeDate,
      daysToNoticeDate: daysToNoticeDate,
      followUpStart: followUpStart,
      daysSinceStart: daysSinceStart,
      daysToLeaseEnd: daysToLeaseEnd,
      interval: CONFIG.FOLLOW_UP_INTERVAL_DAYS
    });
  }

  return {
    rows: rows,
    previousCycle: previousCycle,
    notStarted: notStarted,
    summary: 'Skipped ' + skipped.notSent + ' without a request email, ' +
             skipped.hasRate + ' with a gross renewal rate already in, ' +
             skipped.dropped + ' dropped, ' + skipped.leaseEnded +
             ' whose lease already ended, ' + skipped.missingData +
             ' missing NTV or lease end, ' + skipped.noRequestDate +
             ' with no row in ' + CONFIG.REQUEST_LOG_TAB + ', ' +
             notStarted.length + ' still inside the ' +
             CONFIG.FOLLOW_UP_STARTS_AFTER_DAYS + 'd grace period after their request, ' +
             previousCycle.length + ' whose request email belongs to a ' +
             'previous cycle (they need this cycle\'s request, not a follow-up).'
  };
}

/**
 * Latest request-email date per property code, straight out of Request_log.
 * This is what tells a live renewal cycle apart from a closed one.
 */
function readRequestLog_() {
  var sheet = SpreadsheetApp.openById(CONFIG.RENEWAL_SHEET_ID)
    .getSheetByName(CONFIG.REQUEST_LOG_TAB);
  if (!sheet) {
    throw new Error('Tab "' + CONFIG.REQUEST_LOG_TAB + '" not found in the renewal sheet.');
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var latest = {};

  for (var r = 0; r < values.length; r++) {
    var propertyCode = trim_(values[r][1]).toUpperCase();
    var sentOn = asDate_(values[r][0]);
    if (!propertyCode || !sentOn) continue;
    if (!latest[propertyCode] || sentOn > latest[propertyCode]) {
      latest[propertyCode] = sentOn;
    }
  }

  return latest;
}

/**
 * Groups units by building, because one request email covers every unit of a
 * building that was queued in the same batch. Ordered by how little runway is
 * left before the lease ends, so a time-budget cut only ever drops the units
 * with the most room left.
 */
function groupByBuilding_(rows) {
  var byBuilding = {};
  rows.forEach(function (row) {
    var key = row.building || row.propertyCode;
    if (!byBuilding[key]) {
      byBuilding[key] = { building: row.building, units: [], minDays: row.daysToLeaseEnd };
    }
    byBuilding[key].units.push(row);
    byBuilding[key].minDays = Math.min(byBuilding[key].minDays, row.daysToLeaseEnd);
  });

  return Object.keys(byBuilding)
    .map(function (key) { return byBuilding[key]; })
    .sort(function (a, b) { return a.minDays - b.minDays; });
}

/**
 * Finds the Gmail thread that carries each unit. A building can appear in more
 * than one thread when its units were requested in different batches, so every
 * thread is matched back to the unit aliases quoted in its first message.
 */
function resolveThreads_(groups, started, threadIdByPo) {
  var threads = {};
  var unresolved = [];
  var truncated = 0;
  var stats = { fromCache: 0, searches: 0, staleCache: 0 };

  for (var g = 0; g < groups.length; g++) {
    if (Date.now() - started > CONFIG.TIME_BUDGET_MS) {
      truncated = groups.length - g;
      break;
    }

    var group = groups[g];
    var pending = {};
    group.units.forEach(function (u) { pending[u.propertyCode.toUpperCase()] = u; });

    // Pass one: units already on record go straight to their thread.
    group.units.forEach(function (unit) {
      var key = unit.propertyCode.toUpperCase();
      if (!pending[key]) return;

      var cachedId = threadIdByPo[key];
      if (!cachedId) return;

      var cached = loadThreadById_(cachedId);
      if (!cached) { stats.staleCache++; return; }

      // A thread older than the unit's own request email means the unit was
      // re-requested in a newer batch, so the cached thread is the previous
      // one. Dropping through to the search is what picks up the new thread.
      if (unit.requestDate && cached.getLastMessageDate() < unit.requestDate) {
        stats.staleCache++;
        return;
      }

      if (!attachUnit_(threads, cached, unit)) { stats.staleCache++; return; }
      delete pending[key];
      stats.fromCache++;
    });

    if (!hasKeys_(pending)) continue;

    // Pass two: search by building for whatever is left, which is every unit
    // on the first run and only genuinely new ones after that.
    stats.searches++;
    var found = searchThreads_(group);
    // Newest thread first, so a unit re-requested in a later batch is chased in
    // that newer thread.
    found.sort(function (a, b) {
      return b.getLastMessageDate().getTime() - a.getLastMessageDate().getTime();
    });

    for (var t = 0; t < found.length && hasKeys_(pending); t++) {
      var thread = found[t];
      var anchored = findAnchorMessage_(thread);
      if (!anchored.message) continue;

      var matched = [];
      anchored.codes.forEach(function (code) {
        if (pending[code]) {
          matched.push(pending[code]);
          delete pending[code];
        }
      });
      if (!matched.length) continue;

      matched.forEach(function (unit) {
        attachUnit_(threads, thread, unit, anchored.message);
      });
    }

    Object.keys(pending).forEach(function (code) {
      unresolved.push(pending[code]);
    });
  }

  return {
    threads: Object.keys(threads).map(function (id) { return threads[id]; }),
    unresolved: unresolved,
    truncated: truncated,
    stats: stats
  };
}

/**
 * Files a unit under its thread, resolving that thread's anchor message once.
 * Returns false when the thread carries no usable anchor, which is the signal
 * that a cached id no longer points at a renewal request.
 */
function attachUnit_(threads, thread, unit, knownAnchor) {
  var threadId = thread.getId();

  if (!threads[threadId]) {
    var anchor = knownAnchor || findAnchorMessage_(thread).message;
    if (!anchor) return false;
    threads[threadId] = { thread: thread, anchor: anchor, units: [] };
  }

  threads[threadId].units.push(unit);
  return true;
}

/**
 * Turns each resolved thread into a decision: send, or skip with a reason.
 */
function buildPlans_(resolvedThreads, city) {
  var ledger = readLedger_();
  var today = startOfDay_(new Date());

  return resolvedThreads.map(function (entry) {
    var state = inspectThread_(entry.thread);
    // The most urgent unit on the thread sets the pace.
    var all = entry.units.slice().sort(function (a, b) {
      return a.daysToLeaseEnd - b.daysToLeaseEnd;
    });
    var blocked = all.filter(function (u) { return !!u.dataIssue; });
    var units = all.filter(function (u) { return !u.dataIssue; });
    // Pace on the most urgent unit that can actually be emailed.
    var lead = units.length ? units[0] : all[0];

    var plan = {
      city: city,
      building: lead.building,
      lead: lead,
      units: units,
      blocked: blocked,
      thread: entry.thread,
      anchor: entry.anchor,
      subject: entry.thread.getFirstMessageSubject(),
      permalink: entry.thread.getPermalink(),
      interval: lead.interval,
      followUpStart: lead.followUpStart,
      daysSinceStart: lead.daysSinceStart,
      noticeDate: lead.noticeDate,
      daysToNoticeDate: lead.daysToNoticeDate,
      daysToLeaseEnd: lead.daysToLeaseEnd,
      ntvDays: lead.ntvDays,
      daysSinceLastOutbound: state.daysSinceLastOutbound,
      followUpsSent: state.followUpsSent,
      externalReply: state.externalReply,
      sentAt: null,
      decision: 'SKIP',
      reason: ''
    };

    if (state.bounced) {
      plan.reason = 'Delivery failure in the thread. The request email never reached the property manager.';
      plan.decision = 'REVIEW';
      return plan;
    }
    if (state.externalReply) {
      plan.reason = 'Answered by ' + state.externalReply.from + ' on ' +
                    formatDate_(state.externalReply.date) + '.';
      return plan;
    }
    if (state.daysSinceLastOutbound === null) {
      plan.reason = 'No outbound message found in the thread.';
      plan.decision = 'REVIEW';
      return plan;
    }
    // Replay protection. The thread history above is the primary guard; this
    // is the independent one, so a second run on the same day cannot send a
    // duplicate even if Gmail has not surfaced the first reply yet.
    var lastLogged = ledger[entry.thread.getId()];
    if (lastLogged) {
      var sinceLogged = daysBetween_(lastLogged, today);
      if (sinceLogged < CONFIG.MIN_DAYS_BETWEEN_FOLLOWUPS) {
        plan.reason = 'A follow-up was already sent ' + sinceLogged +
                      'd ago on this thread, under the ' +
                      CONFIG.MIN_DAYS_BETWEEN_FOLLOWUPS + 'd floor.';
        return plan;
      }
    }
    if (state.daysSinceLastOutbound < CONFIG.MIN_DAYS_BETWEEN_FOLLOWUPS) {
      plan.reason = 'Last outbound was only ' + state.daysSinceLastOutbound +
                    'd ago, under the ' + CONFIG.MIN_DAYS_BETWEEN_FOLLOWUPS + 'd floor.';
      return plan;
    }

    if (CONFIG.MAX_FOLLOW_UPS_PER_THREAD > 0 &&
        state.followUpsSent >= CONFIG.MAX_FOLLOW_UPS_PER_THREAD) {
      plan.reason = state.followUpsSent + ' follow-ups already sent with no answer. Needs a manual call.';
      plan.decision = 'REVIEW';
      return plan;
    }
    if (state.daysSinceLastOutbound < plan.interval) {
      plan.reason = 'Last outbound was ' + state.daysSinceLastOutbound +
                    'd ago, interval is ' + plan.interval + 'd.';
      return plan;
    }

    if (!units.length) {
      plan.reason = 'Due, but no unit on this thread can be quoted. ' +
                    blocked.map(function (u) {
                      return u.propertyCode + ': ' + u.dataIssue;
                    }).join(' ');
      plan.decision = 'REVIEW';
      return plan;
    }

    plan.decision = 'SEND';
    plan.reason = 'Silent for ' + state.daysSinceLastOutbound + 'd. Request went out ' +
                  plan.lead.requestAge + 'd ago, notice date ' +
                  (plan.daysToNoticeDate < 0
                    ? 'passed ' + (-plan.daysToNoticeDate) + 'd ago'
                    : 'in ' + plan.daysToNoticeDate + 'd') +
                  ', ' + plan.daysToLeaseEnd + 'd until the lease ends.';
    if (blocked.length) {
      plan.reason += ' ' + blocked.length + ' unit(s) left out of the email: ' +
                     blocked.map(function (u) {
                       return u.propertyCode + ' (' + u.dataIssue + ')';
                     }).join('; ');
    }
    return plan;
  });
}

/**
 * Reads a thread once and reports everything the decision needs.
 */
function inspectThread_(thread) {
  var messages = thread.getMessages();
  var today = startOfDay_(new Date());
  var state = {
    externalReply: null,
    bounced: false,
    lastOutbound: null,
    daysSinceLastOutbound: null,
    outboundCount: 0,
    followUpsSent: 0
  };

  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    var from = extractEmail_(message.getFrom());
    var date = message.getDate();

    if (isBounce_(message, from)) {
      state.bounced = true;
      continue;
    }

    // Auto-replies are ignored on both sides. An internal out-of-office
    // landing in the thread must not read as a fresh nudge from us, or it
    // would silently reset the follow-up clock.
    if (isAutoReply_(message)) continue;

    if (isInternal_(from)) {
      state.outboundCount++;
      if (!state.lastOutbound || date > state.lastOutbound) {
        state.lastOutbound = date;
      }
      continue;
    }

    if (!state.externalReply || date > state.externalReply.date) {
      state.externalReply = { from: from, date: date };
    }
  }

  // The first outbound message is the original request; anything after it is a
  // nudge, whether this script sent it or a person did.
  state.followUpsSent = Math.max(0, state.outboundCount - 1);
  if (state.lastOutbound) {
    state.daysSinceLastOutbound = daysBetween_(startOfDay_(state.lastOutbound), today);
  }
  return state;
}

/**
 * Sends the due follow-ups, newest deadline first, capped per run.
 */
function dispatch_(plans, city) {
  var alias = resolveAlias_();
  var outcome = { sent: 0, failed: 0, notes: [] };

  // Least runway first, so the per-run cap only ever defers the units that
  // have the most time left before their lease ends.
  var due = plans
    .filter(function (p) { return p.decision === 'SEND'; })
    .sort(function (a, b) { return a.daysToLeaseEnd - b.daysToLeaseEnd; });

  // Only a misconfiguration is worth a note: an alias was asked for and is not
  // there. Sending as the inbox when none was asked for is the normal path and
  // must not push every single run into REVIEW.
  if (alias.requested && !alias.available) {
    outcome.notes.push('Alias ' + CONFIG.SEND_AS + ' is not configured on this inbox, ' +
      'so the follow-ups were sent as the inbox address instead. Either configure the ' +
      'alias or clear CONFIG.SEND_AS.');
  }

  for (var i = 0; i < due.length; i++) {
    var plan = due[i];

    if (outcome.sent >= CONFIG.MAX_SENDS_PER_RUN) {
      plan.decision = 'DEFERRED';
      plan.reason = 'Per-run cap of ' + CONFIG.MAX_SENDS_PER_RUN + ' reached.';
      continue;
    }

    try {
      // Plain text, matching the request email these threads already carry.
      var options = alias.available ? { from: alias.address } : {};
      plan.anchor.replyAll(buildBody_(plan, city), options);
      plan.sentAt = new Date();
      outcome.sent++;
      // Recorded one thread at a time, so a crash mid-run cannot lose the
      // record of what already went out.
      recordSent_(plan.thread.getId());
    } catch (err) {
      outcome.failed++;
      plan.decision = 'FAILED';
      plan.reason = describeError_(err);
      outcome.notes.push(plan.building + ': ' + describeError_(err));
    }
  }

  return outcome;
}

// =============================================================================
// SAMPLE EMAIL
// =============================================================================

/**
 * Renders the real follow-up body and sends it to internal reviewers. Uses the
 * most urgent live unit in this inbox's city so the sample shows real wording,
 * and falls back to a worked example when the queue is empty. Reads the sheet
 * only, never Gmail, and never replies into a property manager thread.
 */
function sendSample_(recipients) {
  var started = Date.now();
  var inbox = Session.getEffectiveUser().getEmail();
  var city = CITY_BY_INBOX[String(inbox).toLowerCase()] || 'LAX';

  try {
    var sample = buildSamplePlan_(city);
    var subject = '[SAMPLE - not sent to the landlord] Renewals ' + sample.plan.building +
      ': ' + sample.plan.units.map(function (u) { return u.unit; }).join(' | ') +
      ' | Example Company';

    var preamble = [
      'This is a preview of the renewal follow-up wording. It was NOT sent to any',
      'property manager. In production this text is posted as a reply inside the',
      'original "Renewals <Building>" thread.',
      '',
      'Source: ' + sample.source,
      'City: ' + city + '  |  Inbox: ' + inbox,
      'Follow-ups start: ' + formatDate_(sample.plan.followUpStart) +
        '  (request email + ' + CONFIG.FOLLOW_UP_STARTS_AFTER_DAYS + ' days)',
      'Notice date: ' + formatDate_(sample.plan.noticeDate) +
        '  (lease end ' + formatDate_(sample.plan.lead.leaseEnd) +
        ' minus ' + sample.plan.ntvDays + ' NTV days)',
      'State: ' + sample.plan.daysSinceStart + ' days into the chase, ' +
        sample.plan.daysToLeaseEnd + ' days until the lease ends',
      'Cadence: every ' + weeklyEffectiveInterval_(sample.plan.interval) +
        ' days, on the weekly ' + CONFIG.TRIGGER_WEEKDAY + ' trigger',
      '',
      '--------------------------- email starts here ---------------------------',
      ''
    ].join('\n');

    GmailApp.sendEmail(recipients.join(','), subject,
      preamble + buildBody_(sample.plan, city));

    logRun_('sendSample_', 'OK', started,
      city + ': sample sent to ' + recipients.join(', ') + '. ' + sample.source);

  } catch (err) {
    logRun_('sendSample_', 'ERROR', started, city + ': ' + describeError_(err));
    throw err;
  }
}

/**
 * A plan shaped exactly like the real ones, for preview purposes only.
 */
function buildSamplePlan_(city) {
  var candidates = loadCandidates_(city);
  var sendable = candidates.rows.filter(function (row) { return !row.dataIssue; });

  if (sendable.length) {
    var group = groupByBuilding_(sendable)[0];
    var units = group.units.filter(function (u) { return !u.dataIssue; })
      .sort(function (a, b) { return a.daysToLeaseEnd - b.daysToLeaseEnd; });
    var lead = units[0];

    return {
      source: 'Most urgent live unit in ' + city + ' (' +
              units.map(function (u) { return u.propertyCode; }).join(', ') + ').',
      plan: {
        building: group.building, lead: lead, units: units, blocked: [],
        interval: lead.interval, followUpStart: lead.followUpStart,
        daysSinceStart: lead.daysSinceStart, noticeDate: lead.noticeDate,
        daysToNoticeDate: lead.daysToNoticeDate,
        daysToLeaseEnd: lead.daysToLeaseEnd, ntvDays: lead.ntvDays
      }
    };
  }

  var today = startOfDay_(new Date());
  var leaseEnd = addDays_(today, 75);
  var noticeDate = addDays_(leaseEnd, -60);
  var requestDate = addDays_(today, -15);
  var followUpStart = addDays_(requestDate, CONFIG.FOLLOW_UP_STARTS_AFTER_DAYS);
  var unit = {
    propertyCode: city + '-000', unit: '000', dataIssue: '', leaseEnd: leaseEnd,
    unitLine: 'Unit: 000 | ' + city + 'unit-placeholder@units.example.com | ' +
              'Lease end date: ' + formatDate_(leaseEnd),
    ntvDays: 60, noticeDate: noticeDate,
    daysToNoticeDate: daysBetween_(today, noticeDate),
    requestDate: requestDate, requestAge: 15,
    followUpStart: followUpStart,
    daysSinceStart: daysBetween_(followUpStart, today),
    daysToLeaseEnd: daysBetween_(today, leaseEnd),
    interval: CONFIG.FOLLOW_UP_INTERVAL_DAYS
  };

  return {
    source: 'No live unit in ' + city + ' right now, so this is a worked example.',
    plan: {
      building: 'Example Building', lead: unit, units: [unit], blocked: [],
      interval: unit.interval, followUpStart: followUpStart,
      daysSinceStart: unit.daysSinceStart, noticeDate: noticeDate,
      daysToNoticeDate: unit.daysToNoticeDate,
      daysToLeaseEnd: unit.daysToLeaseEnd, ntvDays: 60
    }
  };
}

/** What an interval actually becomes once the trigger only fires weekly. */
function weeklyEffectiveInterval_(interval) {
  var every = CONFIG.RUN_EVERY_DAYS;
  return Math.ceil(interval / every) * every;
}

// =============================================================================
// EMAIL BODY
// =============================================================================

function buildBody_(plan, city) {
  var plural = plan.units.length > 1;
  var lines = [];

  lines.push('Hello team at ' + plan.building + ',');
  lines.push('');
  lines.push('Following up on my message below about our lease' + (plural ? 's' : '') +
             ' coming up for expiration:');
  lines.push('');
  lines.push(plan.units.map(function (u) { return u.unitLine; }).join(';\n\n'));
  lines.push('');
  lines.push('Have you had a chance to put together renewal offers for us? If you can ' +
             'please share rates for any available lease durations (including ' +
             'month-to-month rates), we will analyze and come back to you as soon as possible.');

  if (CONFIG.INCLUDE_DEADLINE_LINE) {
    lines.push('');
    // Past the notice date the future-tense version would read as a mistake,
    // so the urgent wording takes over.
    if (plan.daysToNoticeDate < 0) {
      lines.push('We are already inside the notice period on our end, as of ' +
                 formatDate_(plan.noticeDate) + ', so we would really ' +
                 'appreciate the rates as soon as you can get them to us.');
    } else {
      lines.push('We need to give notice by ' + formatDate_(plan.noticeDate) +
                 ', so anything you can share before then really helps us keep the unit' +
                 (plural ? 's' : '') + '.');
    }
  }

  if (CONFIG.ASK_FOR_BUILDING_CONTACTS) {
    lines.push('');
    lines.push('If you can also please share the main building contact emails and phone ' +
               'numbers so we can make sure they are updated on our system, we would ' +
               'really appreciate it!');
  }

  lines.push('');
  lines.push('Thank you,');
  lines.push('');
  lines.push('RE Team - ' + city + ' ' + CONFIG.SIGNATURE_EMAIL);

  return lines.join('\n');
}

// =============================================================================
// GMAIL HELPERS
// =============================================================================

function searchThreads_(group) {
  var building = sanitizeForQuery_(group.building);
  var scope;

  if (building) {
    scope = 'subject:"Renewals ' + building + '"';
  } else {
    // No building name to key on, so fall back to the unit aliases themselves.
    scope = 'subject:Renewals {' + group.units.map(function (u) {
      return '"' + u.propertyCode + '@units.example.com"';
    }).join(' ') + '}';
  }

  var query = scope;
  if (CONFIG.LABEL_FILTER) query += ' label:"' + CONFIG.LABEL_FILTER + '"';
  if (CONFIG.SEARCH_WINDOW) query += ' newer_than:' + CONFIG.SEARCH_WINDOW;

  try {
    return GmailApp.search(query, 0, 25);
  } catch (err) {
    return [];
  }
}

/**
 * The message a reply should hang off: the earliest internal message that
 * quotes unit aliases, i.e. the original request, whose recipient list is
 * exactly the property manager team plus this inbox. Returns the codes it
 * quotes too, so the body is only fetched once.
 */
function findAnchorMessage_(thread) {
  var messages = thread.getMessages();
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    if (!isInternal_(extractEmail_(message.getFrom()))) continue;
    // Today the PO only ever appears in the body, and the subject carries the
    // apt number instead. Both are scanned so the match survives a subject
    // that does carry it, or one a property manager has edited.
    var codes = extractPropertyCodes_(message.getSubject() + ' ' + message.getBody());
    if (codes.length) return { message: message, codes: codes };
  }
  return { message: null, codes: [] };
}

function extractPropertyCodes_(body) {
  var codes = [];
  var seen = {};
  var match;
  UNIT_ALIAS_PATTERN.lastIndex = 0;
  while ((match = UNIT_ALIAS_PATTERN.exec(String(body || ''))) !== null) {
    var code = match[1].toUpperCase();
    if (!seen[code]) { seen[code] = true; codes.push(code); }
  }
  return codes;
}

/**
 * Pulls the bare address out of a From header, which arrives either as
 * "Name <user@domain.com>" or as a plain address.
 */
function extractEmail_(from) {
  var text = String(from || '').trim();
  var bracketed = text.match(/<([^>]+)>/);
  return (bracketed ? bracketed[1] : text).trim().toLowerCase();
}

function isInternal_(email) {
  var address = String(email || '').toLowerCase();
  for (var i = 0; i < CONFIG.INTERNAL_DOMAINS.length; i++) {
    if (endsWith_(address, '@' + CONFIG.INTERNAL_DOMAINS[i])) return true;
  }
  return false;
}

function isAutoReply_(message) {
  if (AUTO_REPLY_SUBJECT.test(String(message.getSubject() || ''))) return true;

  var autoSubmitted = header_(message, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true;

  if (header_(message, 'X-Autoreply')) return true;
  if (header_(message, 'X-Autorespond')) return true;

  var precedence = String(header_(message, 'Precedence') || '').toLowerCase();
  if (precedence === 'auto_reply' || precedence === 'bulk' || precedence === 'junk') return true;

  return false;
}

function isBounce_(message, from) {
  if (BOUNCE_SENDER.test(String(from || ''))) return true;
  if (BOUNCE_SUBJECT.test(String(message.getSubject() || ''))) return true;
  return String(header_(message, 'Content-Type') || '').indexOf('report-type=delivery-status') !== -1;
}

function header_(message, name) {
  try {
    return message.getHeader(name);
  } catch (err) {
    return '';
  }
}

function resolveAlias_() {
  // No alias asked for, so sending as the inbox is the correct outcome, not a
  // fallback worth reporting.
  if (!CONFIG.SEND_AS) return { available: false, requested: false, address: '' };

  try {
    var aliases = GmailApp.getAliases() || [];
    for (var i = 0; i < aliases.length; i++) {
      if (String(aliases[i]).toLowerCase() === CONFIG.SEND_AS.toLowerCase()) {
        return { available: true, requested: true, address: aliases[i] };
      }
    }
  } catch (err) {
    // Fall through to sending as the inbox itself.
  }
  return { available: false, requested: true, address: '' };
}

// =============================================================================
// REPLAY PROTECTION
// =============================================================================

/**
 * Thread id -> date of the last follow-up, read from script properties.
 * A corrupt or missing value simply yields an empty ledger, which falls back
 * to the thread history as the only guard rather than blocking the run.
 */
function readLedger_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.LEDGER_PROPERTY);
    if (!raw) return {};

    var stored = JSON.parse(raw);
    var ledger = {};
    Object.keys(stored).forEach(function (threadId) {
      var parsed = asDate_(stored[threadId]);
      if (parsed) ledger[threadId] = parsed;
    });
    return ledger;
  } catch (err) {
    Logger.log('Ledger unreadable, falling back to thread history: ' + describeError_(err));
    return {};
  }
}

/**
 * Stamps a thread as chased today and drops entries past the retention
 * window, so the property stays small enough to keep writing.
 */
function recordSent_(threadId) {
  try {
    var ledger = readLedger_();
    var today = startOfDay_(new Date());
    ledger[threadId] = today;

    var kept = {};
    Object.keys(ledger).forEach(function (id) {
      if (daysBetween_(ledger[id], today) <= CONFIG.LEDGER_RETENTION_DAYS) {
        kept[id] = Utilities.formatDate(ledger[id], Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
    });

    PropertiesService.getScriptProperties()
      .setProperty(CONFIG.LEDGER_PROPERTY, JSON.stringify(kept));
  } catch (err) {
    // The thread now carries our reply, which is guard enough on its own.
    Logger.log('Could not record thread ' + threadId + ': ' + describeError_(err));
  }
}

function sendingEnabled_() {
  var value = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.KILL_SWITCH_PROPERTY);
  return String(value).toLowerCase() !== 'false';
}

function sanitizeForQuery_(text) {
  return String(text || '').replace(/["\\{}()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// =============================================================================
// LOGGING
// =============================================================================

function statusFor_(resolved, outcome, plans, candidateCount) {
  if (outcome.failed) return 'ERROR';
  if (resolved.truncated) return 'REVIEW';
  if (outcome.notes.length) return 'REVIEW';

  // Some units will always be unmatched, because their request thread predates
  // the search window. Only an unusual share of them is worth a flag, so that
  // REVIEW keeps meaning something.
  if (candidateCount > 0 &&
      resolved.unresolved.length / candidateCount > CONFIG.REVIEW_IF_UNRESOLVED_RATIO) {
    return 'REVIEW';
  }

  for (var i = 0; i < plans.length; i++) {
    if (plans[i].decision === 'REVIEW' || plans[i].decision === 'DEFERRED') return 'REVIEW';
  }
  return 'OK';
}

function buildComment_(city, candidates, resolved, plans, outcome, dryRun, control, cache) {
  var counts = { SEND: 0, SKIP: 0, REVIEW: 0, DEFERRED: 0, FAILED: 0 };
  plans.forEach(function (p) { counts[p.decision] = (counts[p.decision] || 0) + 1; });

  var parts = [];
  parts.push(city + (dryRun ? ' dry run' : '') + ': ' + candidates.rows.length +
             ' live unit(s) across ' + plans.length + ' thread(s)');
  parts.push((dryRun ? counts.SEND + ' would be sent' : outcome.sent + ' sent'));
  // "Skipped" on its own says nothing useful, so the two reasons are split:
  // answered is a win, not due is just timing.
  var answered = 0;
  var notDue = 0;
  plans.forEach(function (p) {
    if (p.decision !== 'SKIP') return;
    if (p.externalReply) answered++; else notDue++;
  });
  if (answered) parts.push(answered + ' already answered by the property manager');
  if (notDue) parts.push(notDue + ' not due yet');

  var blocked = 0;
  plans.forEach(function (p) { blocked += p.blocked.length; });
  if (blocked) {
    parts.push(blocked + ' unit(s) left out because their Apt value is unusable in the renewal view');
  }

  if (counts.REVIEW) parts.push(counts.REVIEW + ' flagged for review');
  if (counts.DEFERRED) parts.push(counts.DEFERRED + ' deferred by the per-run cap');
  if (outcome.failed) parts.push(outcome.failed + ' failed to send');
  if (resolved.unresolved.length) {
    parts.push(resolved.unresolved.length + ' unit(s) with no matching thread (' +
               resolved.unresolved.slice(0, 10).map(function (u) { return u.propertyCode; }).join(', ') +
               (resolved.unresolved.length > 10 ? ', ...' : '') + ')');
  }
  if (control && control.written) {
    parts.push(control.written + ' row(s) refreshed in "' + CONFIG.CONTROL_TAB + '"');
  }

  var stats = resolved.stats;
  parts.push('thread lookup: ' + stats.fromCache + ' from the cached Thread Id, ' +
             stats.searches + ' Gmail search(es)' +
             (stats.staleCache ? ', ' + stats.staleCache + ' stale cache entr(ies) re-searched' : ''));
  if (cache && !cache.available && cache.reason) {
    parts.push('Thread Id cache unavailable (' + cache.reason + ')');
  }

  if (candidates.notStarted.length) {
    parts.push(candidates.notStarted.length + ' unit(s) still in the ' +
               CONFIG.FOLLOW_UP_STARTS_AFTER_DAYS + 'd grace period after their request');
  }

  if (candidates.previousCycle.length) {
    parts.push(candidates.previousCycle.length + ' unit(s) still on a previous ' +
               'cycle request, so they need this cycle\'s renewal request email rather ' +
               'than a follow-up (' +
               candidates.previousCycle.slice(0, 10).map(function (u) {
                 return u.propertyCode;
               }).join(', ') +
               (candidates.previousCycle.length > 10 ? ', ...' : '') + ')');
  }

  if (resolved.truncated) {
    parts.push(resolved.truncated + ' building(s) skipped on the time budget, they are the ' +
               'least urgent and will be picked up next run');
  }
  outcome.notes.forEach(function (note) { parts.push(note); });
  parts.push(candidates.summary);

  return parts.join('. ') + '.';
}

function logRun_(functionName, status, startedMs, comment) {
  try {
    var sheet = getOrCreateTab_(CONFIG.LOG_SHEET_ID, CONFIG.LOG_TAB,
      ['Function', 'Timestamp', 'Status', 'Duration (sec)', 'Comment', 'Note']);
    var duration = Math.round((Date.now() - startedMs) / 100) / 10;
    withLock_(function () {
      sheet.appendRow([functionName, new Date(), status, duration, truncate_(comment, 4500), '']);
    });
  } catch (err) {
    Logger.log('Could not write the run log: ' + describeError_(err));
    Logger.log(functionName + ' | ' + status + ' | ' + comment);
  }
}

function writePreview_(plans, inbox, city) {
  var headers = ['Run Timestamp', 'Inbox', 'City', 'Building', 'Property Codes', 'Units',
                 'Lease End', 'NTV (Days)', 'Notice Date', 'Follow-Up Start Date',
                 'Days Past Start', 'Days To Lease End', 'Days Since Last Outbound',
                 'Follow-Ups Sent',
                 'Decision', 'Reason', 'Thread Subject', 'Thread Link'];
  var sheet = getOrCreateTab_(CONFIG.LOG_SHEET_ID, CONFIG.PREVIEW_TAB, headers);
  if (!plans.length) return;

  var now = new Date();
  var rows = plans
    .slice()
    .sort(function (a, b) { return a.daysToLeaseEnd - b.daysToLeaseEnd; })
    .map(function (p) {
      var shown = p.units.concat(p.blocked);
      return [
        now, inbox, city, p.building,
        shown.map(function (u) { return u.propertyCode; }).join(', '),
        shown.map(function (u) { return u.unit; }).join(', '),
        formatDate_(p.lead.leaseEnd), p.ntvDays, formatDate_(p.noticeDate),
        formatDate_(p.followUpStart), p.daysSinceStart, p.daysToLeaseEnd,
        p.daysSinceLastOutbound === null ? '' : p.daysSinceLastOutbound,
        p.followUpsSent, p.decision, truncate_(p.reason, 500), p.subject, p.permalink
      ];
    });

  withLock_(function () {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  });
}

/** Canonical column set of the control tab, in order. */
var CONTROL_HEADERS = [
  'Property Code', 'City', 'Building', 'Unit', 'Lease End Date', 'NTV (Days)',
  'Follow-Up Start Date', 'Days Past Start', 'Days To Lease End',
  'Follow-Ups Sent', 'Last Follow-Up Sent', 'Last Email Sent Without Reply',
  'Notice Date', 'Days Since Last Email', 'Replied', 'Replied By', 'Replied On',
  'Status', 'Reason', 'Thread Subject', 'Thread Link', 'Thread Id',
  'Last Refreshed'
];

/**
 * Property code -> thread id, read back out of the control tab.
 *
 * A thread's set of property codes never changes, so once a unit has been
 * matched to a thread the answer is permanent and there is no reason to search
 * Gmail for it again. Using the control tab as the cache keeps it visible and
 * hand-fixable, and getThreadById has no time window, which is what removes
 * the SEARCH_WINDOW fragility for every unit already on record.
 *
 * Returns an empty map, never an error, when the tab or the column is absent:
 * the run then behaves exactly as it did before the cache existed.
 */
function readControlThreadIds_() {
  try {
    var sheet = SpreadsheetApp.openById(CONFIG.RENEWAL_SHEET_ID)
      .getSheetByName(CONFIG.CONTROL_TAB);
    if (!sheet) {
      return { map: {}, available: false, reason: 'tab not created yet' };
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) {
      return { map: {}, available: true, reason: '' };
    }

    var header = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var position = {};
    header.forEach(function (name, i) {
      var normalized = normalizeHeader_(name);
      if (normalized && !(normalized in position)) position[normalized] = i;
    });

    var keyColumn = position[normalizeHeader_('Property Code')];
    var idColumn = position[normalizeHeader_('Thread Id')];
    if (keyColumn === undefined || idColumn === undefined) {
      return {
        map: {}, available: false,
        reason: 'no "Thread Id" column, so threads are found by search every run'
      };
    }

    var values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
    var map = {};
    for (var r = 0; r < values.length; r++) {
      var propertyCode = trim_(values[r][keyColumn]).toUpperCase();
      var threadId = trim_(values[r][idColumn]);
      if (propertyCode && threadId) map[propertyCode] = threadId;
    }

    return { map: map, available: true, reason: '' };

  } catch (err) {
    return { map: {}, available: false, reason: describeError_(err) };
  }
}

/** getThreadById, made null-safe. */
function loadThreadById_(threadId) {
  try {
    return GmailApp.getThreadById(threadId) || null;
  } catch (err) {
    return null;
  }
}

/**
 * Refreshes one row per property code in the control tab: who was chased, when
 * the last unanswered email went out, and where the thread is.
 *
 * Rows are keyed on the property code and updated in place, so the tab stays
 * one row per unit rather than growing on every run, and the twelve inboxes
 * only ever touch their own units. Columns are resolved by header name, which
 * means the tab can be reordered or trimmed by hand without the script writing
 * into the wrong place.
 */
function refreshControlTab_(plans, city) {
  var sheet = getOrCreateTab_(CONFIG.RENEWAL_SHEET_ID, CONFIG.CONTROL_TAB, CONTROL_HEADERS);
  var records = buildControlRecords_(plans, city);
  if (!records.length) return { written: 0, missingColumns: [] };

  var result = { written: 0, missingColumns: [] };

  withLock_(function () {
    var lastColumn = Math.max(sheet.getLastColumn(), CONTROL_HEADERS.length);
    var header = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var position = {};
    header.forEach(function (name, i) {
      var normalized = normalizeHeader_(name);
      if (normalized && !(normalized in position)) position[normalized] = i;
    });

    // If the tab was pre-created empty, lay the canonical headers down.
    if (!Object.keys(position).length) {
      sheet.getRange(1, 1, 1, CONTROL_HEADERS.length)
        .setValues([CONTROL_HEADERS]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      CONTROL_HEADERS.forEach(function (name, i) {
        position[normalizeHeader_(name)] = i;
      });
      lastColumn = CONTROL_HEADERS.length;
    }

    result.missingColumns = CONTROL_HEADERS.filter(function (name) {
      return !(normalizeHeader_(name) in position);
    });

    var keyColumn = position[normalizeHeader_('Property Code')];
    if (keyColumn === undefined) {
      throw new Error('Tab "' + CONFIG.CONTROL_TAB +
        '" has no "Property Code" column, so rows cannot be keyed.');
    }

    var lastRow = sheet.getLastRow();
    var existing = {};
    if (lastRow > 1) {
      var keys = sheet.getRange(2, keyColumn + 1, lastRow - 1, 1).getValues();
      for (var r = 0; r < keys.length; r++) {
        var key = trim_(keys[r][0]).toUpperCase();
        if (key && !(key in existing)) existing[key] = r + 2;
      }
    }

    records.forEach(function (record) {
      var rowNumber = existing[record['Property Code'].toUpperCase()];

      if (rowNumber) {
        var current = sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0];
        sheet.getRange(rowNumber, 1, 1, lastColumn)
          .setValues([mergeControlRow_(current, record, position, lastColumn)]);
      } else {
        // appendRow rather than a computed lastRow+1 block. Each inbox runs its
        // own script project, so the script lock does not serialise the twelve
        // of them against each other, and all twelve triggers fire on the same
        // morning. Row updates are safe because a city only ever touches its
        // own units, and appendRow is the one write that stays correct when two
        // inboxes add rows at the same moment.
        sheet.appendRow(mergeControlRow_(new Array(lastColumn), record, position, lastColumn));
      }
      result.written++;
    });
  });

  return result;
}

/**
 * Lays a record over a row, touching only the columns the tab actually has.
 * A blank value in the record leaves whatever the row already held, which is
 * what preserves "Last Follow-Up Sent" on a run that sent nothing.
 */
function mergeControlRow_(current, record, position, lastColumn) {
  var row = new Array(lastColumn);
  for (var i = 0; i < lastColumn; i++) {
    row[i] = current && current[i] !== undefined && current[i] !== null ? current[i] : '';
  }

  Object.keys(record).forEach(function (name) {
    var column = position[normalizeHeader_(name)];
    if (column === undefined || column >= lastColumn) return;
    var value = record[name];
    if (value === '' || value === null || value === undefined) return;
    row[column] = value;
  });

  return row;
}

function buildControlRecords_(plans, city) {
  var now = new Date();
  var records = [];

  plans.forEach(function (plan) {
    var answered = !!plan.externalReply;
    var sentThisRun = !!plan.sentAt;

    plan.units.concat(plan.blocked).forEach(function (unit) {
      records.push({
        'Property Code': unit.propertyCode,
        'City': city,
        'Building': plan.building,
        'Unit': unit.dataIssue ? '' : unit.unit,
        'Lease End Date': formatDate_(unit.leaseEnd),
        'NTV (Days)': unit.ntvDays,
        'Notice Date': formatDate_(unit.noticeDate),
        'Follow-Up Start Date': formatDate_(unit.followUpStart),
        'Days Past Start': unit.daysSinceStart,
        'Days To Lease End': unit.daysToLeaseEnd,
        'Follow-Ups Sent': plan.followUpsSent + (sentThisRun ? 1 : 0),
        'Last Follow-Up Sent': sentThisRun ? formatDate_(plan.sentAt) : '',
        // The whole point of the tab: the last thing we said that nobody
        // answered. Blank once they have answered.
        'Last Email Sent Without Reply': answered
          ? ''
          : formatDate_(sentThisRun ? plan.sentAt : lastOutboundDate_(plan)),
        'Days Since Last Email': answered
          ? ''
          : (sentThisRun ? 0 : plan.daysSinceLastOutbound),
        'Replied': answered ? 'YES' : 'NO',
        'Replied By': answered ? plan.externalReply.from : '',
        'Replied On': answered ? formatDate_(plan.externalReply.date) : '',
        'Status': sentThisRun ? 'FOLLOW-UP SENT' : plan.decision,
        'Reason': truncate_(unit.dataIssue || plan.reason, 500),
        'Thread Subject': plan.subject,
        'Thread Link': plan.permalink,
        // Doubles as the PO -> thread cache for later runs. Kept in the sheet
        // rather than in script properties so it stays visible and fixable.
        'Thread Id': plan.thread.getId(),
        'Last Refreshed': now
      });
    });
  });

  return records;
}

/** Reconstructs the last outbound date from the days the thread reported. */
function lastOutboundDate_(plan) {
  if (plan.daysSinceLastOutbound === null) return null;
  return addDays_(startOfDay_(new Date()), -plan.daysSinceLastOutbound);
}

function getOrCreateTab_(spreadsheetId, tabName, headers) {
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(tabName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function withLock_(action) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    // Twelve inboxes write to the same tabs. Losing a log row is worse than a
    // rare interleave, so the write still goes through.
    Logger.log('Could not acquire the lock after ' + CONFIG.LOCK_WAIT_MS + 'ms, writing anyway.');
    action();
    return;
  }
  try {
    action();
  } finally {
    lock.releaseLock();
  }
}

// =============================================================================
// SMALL HELPERS
// =============================================================================

function resolveColumns_(headerRow) {
  var normalized = headerRow.map(function (h) { return normalizeHeader_(h); });
  var index = {};
  Object.keys(COL).forEach(function (key) {
    var wanted = normalizeHeader_(COL[key]);
    var position = normalized.indexOf(wanted);
    if (position === -1) {
      throw new Error('Column "' + COL[key] + '" not found in "' + CONFIG.RENEWAL_TAB + '".');
    }
    index[key] = position;
  });
  return index;
}

/**
 * Pulls only the needed columns, one range per column, and rebuilds rows that
 * are addressable by the very same header index. Ten narrow reads instead of
 * one 830k cell read.
 */
function readColumns_(sheet, index, lastRow) {
  var numRows = lastRow - 1;
  var rows = new Array(numRows);
  for (var i = 0; i < numRows; i++) rows[i] = [];

  var positions = {};
  Object.keys(index).forEach(function (key) { positions[index[key]] = true; });

  Object.keys(positions).forEach(function (positionText) {
    var position = Number(positionText);
    var values = sheet.getRange(2, position + 1, numRows, 1).getValues();
    for (var r = 0; r < numRows; r++) rows[r][position] = values[r][0];
  });

  return rows;
}

function normalizeHeader_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Reports why a unit number cannot be put in front of a property manager, or
 * an empty string when it is fine.
 */
function describeUnitIssue_(unit) {
  if (!unit) return 'Apt is blank in the renewal view.';
  if (SHEET_ERROR_VALUE.test(unit)) return 'Apt holds the error value ' + unit + '.';
  if (SCIENTIFIC_NOTATION.test(unit)) {
    return 'Apt reads "' + unit + '" (scientific notation), so the real unit ' +
           'number is unknown. Fix the cell in the renewal view.';
  }
  return '';
}

function trim_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function isTrue_(value) {
  if (value === true) return true;
  return trim_(value).toUpperCase() === 'TRUE';
}

function asNumber_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  var parsed = parseFloat(trim_(value));
  return isFinite(parsed) ? parsed : null;
}

function asDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return startOfDay_(value);
  var text = trim_(value);
  if (!text) return null;

  // "yyyy-MM-dd" is built by hand, because new Date() reads it as UTC midnight
  // and would land on the previous day everywhere west of Greenwich.
  var iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  var parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : startOfDay_(parsed);
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Whole days between two local dates, immune to DST shifts. */
function daysBetween_(from, to) {
  var a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  var b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

function addDays_(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function formatDate_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MM/dd/yyyy');
}

function hasKeys_(object) {
  for (var key in object) {
    if (Object.prototype.hasOwnProperty.call(object, key)) return true;
  }
  return false;
}

function endsWith_(text, suffix) {
  return text.length >= suffix.length &&
         text.substring(text.length - suffix.length) === suffix;
}

function truncate_(text, limit) {
  var value = String(text === null || text === undefined ? '' : text);
  return value.length <= limit ? value : value.substring(0, limit - 3) + '...';
}

function describeError_(err) {
  if (!err) return 'Unknown error.';
  var message = err.message || String(err);
  return err.name ? err.name + ': ' + message : message;
}
