/**
 * Slack / Automated Reach-Out pipeline.
 *
 * Flow A - captureSlackBookings (every 10 minutes):
 *   Reads DEPARTMENT_Y notifications inside the lookback window and appends any
 *   booking that has not been sent yet (manually or automatically) to the queue.
 *
 * Flow B - monitorAutomatedReachOutQueue (every 15 minutes):
 *   1. Checks whether a Automated Reach-Out email for the PO was already sent in the last 3 days.
 *   2. If it was sent manually, tracks it and removes the queue row.
 *   3. Otherwise, waits for Source Data, enriches the row and sends the email.
 *      When Source Data has no usable Email Contact, the fallback sources are searched.
 *   4. Tracks successful sends, updates the external PO control sheet, labels Gmail,
 *      replies in the original Slack thread and removes completed queue rows.
 *
 * Required Script Properties:
 *   SLACK_BOT_TOKEN
 *   TEST_NOTIF_WEBHOOK_URL
 *   SOURCE_THREAD_WEBHOOK_URL
 */

const SPREADSHEET_ID = 'YOUR_MAIN_SPREADSHEET_ID';

const SLACK = {
  CHANNEL_ID: 'YOUR_SOURCE_CHANNEL_ID',
  MAIN_SS_ID: 'YOUR_MAIN_SPREADSHEET_ID',
  MB_TAB: 'Source Data',
  QUEUE_TAB: 'Pending Queue',
  PROPERTY_TAB: 'Reference Properties',
  TRACKER_TAB: 'Delivery History'
};

const PIPELINE = {
  LIVE: true,
  TIME_ZONE: 'America/Sao_Paulo',
  // Bookings are no longer restricted to the current day. Anything inside this
  // window that has not been sent yet is still eligible.
  CAPTURE_LOOKBACK_HOURS: 72,
  // Duplicate-send protection window over the Sent mailbox.
  SENT_LOOKBACK_DAYS: 3,
  /**
   * When true, an email only goes out once Source Data itself carries the fields in
   * REQUIRED_MB_FIELDS. Nothing financial is ever taken from the Slack booking,
   * which is the value at booking creation and not the lease term.
   * Set to false to go back to sending with whatever is available.
   */
  REQUIRE_MB_FINANCIALS: true,
  REQUIRED_MB_FIELDS: ['Monthly Rent', 'Lease Start'],
  /**
   * When true, an email only goes out once the fields in STABILITY_FIELDS held
   * the same value across two consecutive Source Data imports.
   *
   * Source Data has been seen alternating between two different complete records for
   * the same Reference Code, hour by hour. Both look valid, so only stability tells
   * them apart. Set to false to stop checking.
   *
   * Switched OFF on 2026-09-03. The alternation was traced to the old BI platform
   * question reading declined quotes; that query has been replaced and BI
   * confirmed the feed is stable. The check was holding good emails for a full
   * import cycle. The machinery stays in place - flip back to true to re-enable.
   */
  REQUIRE_MB_STABLE: false,
  STABILITY_FIELDS: ['Monthly Rent', 'Lease Start', 'Lease End Date',
    'Security Deposit', 'Prop Cleaning Fee', 'Email Contact'],
  /**
   * GIVE-UP RULE. A booking is worked for this many hours after its Slack
   * notification and then dropped from the queue instead of being retried for
   * ever.
   *
   * REPLACED THE LEASE-START RULE on 2026-09-21, at Maintainer's request. The old
   * one gave up once the lease had already started, which tied the decision to
   * a date that comes from BI platform - so the bookings most likely to be stuck
   * were exactly the ones whose Lease Start never arrived. The scope is now the
   * notification itself: a booking is worked for a fixed window after it is
   * announced, and then let go.
   *
   * WHY HOURS AND NOT "THE CALENDAR DAY". A booking notified at 23:50 would
   * get ten minutes of a calendar day - and with a 20-minute COD window it
   * could never be sent at all, only expired. Counting hours from each
   * notification gives every booking the same window, whatever time it landed.
   *
   * RAISED FROM 24 TO 48 on 2026-09-23, at Maintainer's request. One day was
   * cutting off bookings whose quote had simply not been accepted yet.
   *
   * WHAT 48 STILL DOES NOT COVER. Measured over 90 days: no quote is accepted
   * and no booking is confirmed on a Saturday or Sunday. So a booking notified
   * on Friday evening expires on Sunday evening, several hours before the
   * Monday morning that could have given it a quote. Covering that needs 72.
   *
   * The case that prompted a give-up rule at all: USA-4051A, booked
   * 2026-09-09, no quote in CRM so no fees would ever arrive. It sat in
   * the queue producing the identical warning 1,662 times and turned out to be
   * a transfer from USA-1763 that nobody needed an email for.
   *
   * Interaction with CAPTURE_LOOKBACK_HOURS (72): after an outage, capture
   * still picks up everything from the last three days. Anything already past
   * this limit is then recorded once in Delivery History as EXPIRED - which is
   * the list of bookings to send by hand - and never queued again.
   *
   * Set to 0 to disable and go back to retrying indefinitely.
   */
  EXPIRE_AFTER_NOTIFICATION_HOURS: 48,
  /**
   * WEEKDAY OVERRIDE. A booking notified on one of these days gets this window
   * instead of the one above. Keyed by the day of the NOTIFICATION, in
   * PIPELINE.TIME_ZONE.
   *
   * Added 2026-09-23. Friday is the only day that needs it: measured over 90
   * days, no quote is accepted and no booking is confirmed on a Saturday or a
   * Sunday, so a Friday booking spends two of its hours-to-live on days when
   * nothing can possibly arrive. 48 hours expires it on Sunday evening,
   * several hours before the Monday that could have given it a quote.
   *
   * WHY 84 AND NOT 72. 72 was the first attempt and was one hour short. The
   * first CRM report of the week arrives at 7 AM MST, which is 10h BRT,
   * and a booking announced at 10h on Friday would have died at exactly that
   * hour - racing its own first chance. 84 clears it:
   *
   *   Friday 10:00 -> Monday 22:00
   *   Friday 18:00 -> Tuesday 06:00
   *
   * so every Friday booking gets the whole of Monday, whatever time it landed.
   *
   * Remove a key, or set it to 0, and that day falls back to the base window.
   */
  EXPIRE_AFTER_NOTIFICATION_HOURS_BY_WEEKDAY: {
    FRI: 84
  },
  /**
   * THE COD WINDOW. Added 2026-09-21.
   *
   * No intro email leaves before this many minutes have passed since the Slack
   * notification. The delay is not caution for its own sake - it is the window
   * in which the team logs a Change of Date, and an intro email that quotes a
   * start date which has already moved is worse than a late one.
   *
   * The booking is NOT idle during the wait. Every cycle still checks whether
   * an admin sent it by hand, and re-reads the COD list, so a COD logged at
   * minute 3 stops the email at minute 3 rather than at minute 20.
   *
   * It costs less than it looks. BULK.QUIET_MINUTES is also 20 and runs off the
   * same notification timestamp, so every booking that was already waiting for
   * a sibling at the same address releases at the same moment it did before.
   *
   * Set to 0 to send as soon as the data is ready, the way it worked before.
   */
  COD_WINDOW_MINUTES: 20,
  /**
   * BULK SEND.
   *
   * One owner, one building, several units booked within minutes of each other
   * must receive ONE email with one table per unit - not three near-identical
   * emails. sendAutomationCandidates_ has always merged whatever sits in the
   * same cycle; the problem is that the notifications do not arrive together.
   * Measured on 2026-09-10, Arrive Danbury: 4:20pm, 4:22pm and 4:48pm BRT for
   * the same owner and the same building. Whatever was ready at 4:20 went out
   * alone.
   *
   * So a candidate with a sibling waits. QUIET_MINUTES restarts every time a
   * new sibling lands, and MAX_HOLD_MINUTES is the ceiling from the first one,
   * so a booking can never be held indefinitely by a stuck neighbour.
   *
   * A LONE candidate is never held - a normal single booking keeps today's
   * speed. It is only held when another queue row shares its building, whether
   * or not that row is ready to send yet.
   */
  BULK: {
    ENABLED: true,
    // Same recipient AND same building. Same recipient alone would merge two
    // unrelated properties that happen to share a leasing inbox.
    GROUP_BY_ADDRESS: true,
    QUIET_MINUTES: 20,
    MAX_HOLD_MINUTES: 60
  },
  TEST_RECIPIENTS: [
    'maintainer@example.com',
    'reviewer-one@example.com',
    'reviewer-two@example.com'
  ]
};

const LOG_CONFIG = {
  SPREADSHEET_ID: 'YOUR_LOG_SPREADSHEET_ID',
  SHEET_NAME: 'Intake Emails Automated Reach-Out'
};

const INTRO_CONTROL = {
  SPREADSHEET_ID: 'YOUR_CONTROL_SPREADSHEET_ID',
  SHEET_NAME: 'Operations Team Main',
  REFERENCE_HEADER: 'PO',
  INTRO_HEADER: 'Intake Email',
  ASSIGNEE_HEADER: 'Assignee',
  HANDOFF_HEADER: 'Handoff Date',
  NOTES_HEADER: 'Notes/Escalations',
  NOTE: 'Intro email sent by automation',
  VALUE: 'C'
};

/**
 * COD LIST - spreadsheet "Department Y Case Workflow Results", tab COD.
 *
 * A COD is a Change of Date: the client's start date moved after the booking
 * was made. The intro email quotes the lease term, so it must not go out on a
 * booking that has one - the Operations Team reviews it and sends it by hand.
 *
 * The tab holds DEPARTMENT_X and Department Y rows side by side ("USA-36" next to
 * "SFO-9206A"), so the PO is matched exactly through poKey_. A DEPARTMENT_X PO can
 * never collide with an on-demand booking, which always ends in "A".
 */
const COD_SOURCE = {
  SPREADSHEET_ID: 'YOUR_FALLBACK_SPREADSHEET_ID',
  SHEET_NAMES: ['COD'],
  REFERENCE_HEADER: 'PO',
  NEW_START_HEADER: 'New Client Start Date',
  /**
   * What happens when the list cannot be read at all - permissions changed,
   * the tab renamed, the Spreadsheets service having a bad minute.
   *
   * false (the default): the email still goes out and an ERROR warning is
   * raised. A list the automation cannot open must not quietly stop every
   * intro email in the queue.
   *
   * true: nothing is sent until the list can be read again. Choose this if a
   * missed COD is worse for you than a stalled queue.
   */
  BLOCK_WHEN_UNREADABLE: false
};

/**
 * Email Contact fallback - spreadsheet "Department Y Move-Outs".
 * Used only when Source Data has no usable Email Contact for the PO.
 * Tabs and columns are resolved by name with tolerant matching, so a small
 * wording difference in the tab title does not silently disable a source.
 */
const EMAIL_FALLBACK_SPREADSHEET_ID = 'YOUR_CONTACT_SOURCE_SPREADSHEET_ID';

const EMAIL_FALLBACK_SOURCES = [
  {
    label: 'Frontdesk Emails (mb_16074)',
    sheetNames: ['Frontdesk Emails (mb_16074)', 'Frontdesk Emails', 'mb_16074'],
    poHeaders: ['Property Code'],
    emailHeaders: ['Frontdesk Emails', 'Frontdesk Email']
  },
  {
    label: 'Frontdesk Emails BG DEPARTMENT_Y (mb_19375)',
    sheetNames: ['Frontdesk Emails (BG DEPARTMENT_Y)', 'BG DEPARTMENT_Y (mb_19375)', 'BG DEPARTMENT_Y', 'mb_19375'],
    poHeaders: ['Reference Properties - Building ID Pk', 'Property Code'],
    emailHeaders: ['Frontdesk Email', 'Frontdesk Emails']
  },
  {
    label: 'Relo/APP Email (mb_16290)',
    sheetNames: ['Relo/APP Email (mb_16290)', 'Relo/APP Email', 'Relo APP Email', 'mb_16290'],
    poHeaders: ['Property', 'Property Code'],
    emailHeaders: ['Company Partner Contact Email', 'Company Partner Email', 'Property Manager Email']
  }
];

const EMAIL_FALLBACK_CACHE_SECONDS = 21600;

// Per-execution memo so one run never rebuilds the fallback index twice.
var __EMAIL_FALLBACK_INDEX = null;

/**
 * Manual kill switch on the queue. Every captured booking arrives with NO.
 * Setting the cell to YES stops that email from being sent, for as long as it
 * stays YES. The row is kept in the queue, so flipping it back to NO releases
 * the send on the next cycle.
 */
const STOP_SENT = {
  HEADER: 'Stop Sent?',
  YES: 'YES',
  NO: 'NO',
  YES_COLOR: '#D9EAD3',
  NO_COLOR: '#F4CCCC'
};

const SLACK_HEADERS = [
  'Stop Sent?',
  'Slack Not Date', 'Slack Thread TS', 'Record Code', 'Reference Code', 'Source Quote Number',
  'Full Address', 'Property Name', 'External Provider', 'Lease Start',
  'Lease End Date', 'Monthly Rent', 'Security Deposit', 'Admin', 'Application',
  'Prop Pet Fee Monthly', 'Prop Pet Fee One-Time', 'Prop Cleaning Fee',
  'Parking Fee', 'Email Contact', 'Unit Email', 'BG Representative',
  'Enterprise', 'Partner', 'State'
];

// Internal only - drives the row values handed to the templates.
const EMAIL_HEADERS = [
  'Slack Not Date', 'Slack Thread TS', 'Record Code', 'Reference Code', 'Source Quote Number', 'Unit No',
  'Full Address', 'Property Name', 'Display Name', 'External Provider', 'Lease Start',
  'Lease End Date', 'Monthly Rent', 'Security Deposit', 'Admin', 'Application',
  'Prop Pet Fee Monthly', 'Prop Pet Fee One-Time', 'Prop Cleaning Fee',
  'Parking Fee',
  // Added 2026-08-31. Every TH_* fee on the accepted quote that the owner
  // actually receives. TH_FEE__C is excluded on purpose - it is a flat 199
  // Example Housing Company service fee, not an amount paid to the property.
  'Renters Insurance', 'Prop Tax Amount', 'Prop Utilities', 'Monthly Other', 'Monthly Other Desc',
  'Pet Deposit', 'Other Fee', 'Other Fee Desc', 'Other Deposit', 'Other Deposit Desc',
  'Email Contact', 'Email Source', 'Unit Email', 'BG Representative',
  'Enterprise', 'Partner', 'State',
  // Added 2026-09-16. Not printed anywhere in the email: these two only feed
  // the Florida contract rule and the PARTNER name matching, both of which read the
  // row through the same header map as everything else.
  'Building Name', 'Landlord Name'
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
  COORDINATOR_A:  { name: 'Coordinator A',  slackId: 'YOUR_COORDINATOR_A_SLACK_ID', label: 'Coordinator A' },
  COORDINATOR_B:    { name: 'Coordinator B',    slackId: 'YOUR_COORDINATOR_B_SLACK_ID', label: 'Coordinator B' },
  COORDINATOR_C: { name: 'Coordinator C', slackId: 'YOUR_COORDINATOR_C_SLACK_ID', label: 'Coordinator C' },
  COORDINATOR_D:    { name: 'Coordinator D',    slackId: 'YOUR_COORDINATOR_D_SLACK_ID', label: 'Coordinator D' },
  COORDINATOR_E:    { name: 'Coordinator E',    slackId: 'YOUR_COORDINATOR_E_SLACK_ID', label: 'Coordinator E' }
};

const STATE_TO_ADMIN = {
  CT:'COORDINATOR_A', DE:'COORDINATOR_A', FL:'COORDINATOR_A', MS:'COORDINATOR_A', NH:'COORDINATOR_A', NJ:'COORDINATOR_A',
  NC:'COORDINATOR_A', RI:'COORDINATOR_A', SC:'COORDINATOR_A', WV:'COORDINATOR_A', TX:'COORDINATOR_A', WY:'COORDINATOR_A',
  DC:'COORDINATOR_B', GA:'COORDINATOR_B', IN:'COORDINATOR_B', ME:'COORDINATOR_B', MD:'COORDINATOR_B', MA:'COORDINATOR_B', MI:'COORDINATOR_B',
  MN:'COORDINATOR_B', NY:'COORDINATOR_B', OH:'COORDINATOR_B', PA:'COORDINATOR_B', TN:'COORDINATOR_B', VT:'COORDINATOR_B', VA:'COORDINATOR_B',
  WI:'COORDINATOR_B', OR:'COORDINATOR_B', UT:'COORDINATOR_B', KS:'COORDINATOR_B', MT:'COORDINATOR_B',
  AL:'COORDINATOR_C', AZ:'COORDINATOR_C', AR:'COORDINATOR_C', ID:'COORDINATOR_C', IL:'COORDINATOR_C', IA:'COORDINATOR_C',
  KY:'COORDINATOR_C', LA:'COORDINATOR_C', MO:'COORDINATOR_C', NE:'COORDINATOR_C', NM:'COORDINATOR_C', NV:'COORDINATOR_C',
  OK:'COORDINATOR_C', WA:'COORDINATOR_C',
  CA:'COORDINATOR_D', CO:'COORDINATOR_D', HI:'COORDINATOR_E', AK:'COORDINATOR_E', ND:'COORDINATOR_D', SD:'COORDINATOR_D'
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

/** Day keys covered by the duplicate-send window, most recent first. */
function recentDayKeys_(days) {
  const keys = {};
  const total = Math.max(1, Number(days || 1));
  const now = Date.now();
  for (let i = 0; i < total; i++) {
    keys[formatDayKey_(new Date(now - i * 24 * 3600000))] = true;
  }
  return keys;
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

/** Returned instead of throwing when a best-effort caller finds the lock taken. */
const PIPELINE_LOCK_BUSY = 'PIPELINE_LOCK_BUSY';

/**
 * Runs the callback holding the pipeline lock.
 *
 * With several triggers on different intervals (capture every 10 min, monitor
 * every 15, imports every 30 and every hour) two runs overlapping is routine,
 * not a fault. Pass skipIfBusy for the scheduled callers: they simply stand
 * down and let the run that already holds the lock finish the work.
 * Manual functions leave skipIfBusy off, so the operator sees the conflict.
 */
function withDocumentLock_(callback, skipIfBusy) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    if (skipIfBusy) return PIPELINE_LOCK_BUSY;
    throw new Error('Could not acquire the pipeline lock.');
  }
  try { return callback(); }
  finally { lock.releaseLock(); }
}

function reportSystemWarning_(stage, reason, error) {
  try {
    upsertWarnings_([warningEntry_(stage, {}, 'ERROR', reason,
      String(error && error.stack ? error.stack : error))]);
  } catch (warningError) {
    Logger.log('Could not write the system error to Warnings: ' + warningError);
  }
}

/**
 * A Slack ts is "1756327234.123456" - 16 significant digits. If it is ever
 * stored in a Sheets cell as a number, the last digit is lost and trailing
 * zeros are stripped, which makes Slack answer invalid_thread_ts.
 * This puts the value back into the exact shape Slack expects.
 */
function normalizeSlackTs_(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return isFinite(value) ? value.toFixed(6) : '';
  }
  const text = String(value).trim();
  if (!text) return '';
  if (/^\d+\.\d{6}$/.test(text)) return text;
  const parts = text.match(/^(\d+)(?:\.(\d*))?$/);
  if (parts) {
    const fraction = (parts[2] || '') + '000000';
    return parts[1] + '.' + fraction.substring(0, 6);
  }
  return text;
}

/** True when a human has flipped the queue row to YES to hold the email back. */
function isSendStopped_(queueObject) {
  return String(queueObject[STOP_SENT.HEADER] || '').trim().toUpperCase() === STOP_SENT.YES;
}

/**
 * Keeps the Stop Sent? column usable: a NO/YES dropdown on every row plus the
 * colour rules. Re-applied whenever rows are added, so a new booking is never
 * left with a free-text cell.
 */
function ensureStopSentColumn_(sheet, headers) {
  const index = headerMap_(headers)[STOP_SENT.HEADER];
  if (index === undefined) return -1;
  const column = index + 1;
  const rowCount = Math.max(1, sheet.getMaxRows() - 1);
  const range = sheet.getRange(2, column, rowCount, 1);

  try {
    range.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList([STOP_SENT.NO, STOP_SENT.YES], true)
      .setAllowInvalid(false)
      .build());
  } catch (error) {
    Logger.log('Stop Sent? dropdown could not be applied: ' + error);
  }

  try {
    // Drop any previous rule on this column, then re-add the two colour rules.
    const kept = sheet.getConditionalFormatRules().filter(function(rule) {
      return !rule.getRanges().some(function(ruleRange) { return ruleRange.getColumn() === column; });
    });
    const yesRule = SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(STOP_SENT.YES)
      .setBackground(STOP_SENT.YES_COLOR)
      .setRanges([range]).build();
    const noRule = SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(STOP_SENT.NO)
      .setBackground(STOP_SENT.NO_COLOR)
      .setRanges([range]).build();
    sheet.setConditionalFormatRules(kept.concat([yesRule, noRule]));
  } catch (error) {
    Logger.log('Stop Sent? colour rules could not be applied: ' + error);
  }
  return column;
}

/**
 * Whole hours since the Slack notification for this queue row.
 *
 * Returns null when the timestamp is missing or unreadable, and callers must
 * treat that as "unknown" rather than as zero: a booking whose notification
 * time cannot be read must never be expired on the strength of it. That is the
 * same choice the COD window and the bulk hold make.
 *
 * bulkNotifiedAtMs_ does the parsing, so all three rules read the timestamp
 * exactly the same way.
 */
function hoursSinceNotification_(queueObject) {
  const stamp = bulkNotifiedAtMs_(queueObject);
  if (!stamp) return null;
  const hours = (Date.now() - stamp) / 3600000;
  return hours < 0 ? 0 : Math.floor(hours);
}

/**
 * The day of the week the Slack notification landed, as SUN..SAT, or '' when
 * the timestamp cannot be read.
 *
 * Deliberately NOT Date.getDay(), which answers in the script's own timezone,
 * and not a formatted weekday name, which depends on the account locale. The
 * calendar day is rendered in PIPELINE.TIME_ZONE and read back as UTC midnight,
 * so the answer is the same whoever runs it - the same trick the old
 * lease-start rule used.
 */
function notificationWeekdayKey_(queueObject) {
  const stamp = bulkNotifiedAtMs_(queueObject);
  if (!stamp) return '';
  const day = new Date(formatDayKey_(new Date(stamp)) + 'T00:00:00Z');
  if (isNaN(day.getTime())) return '';
  return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][day.getUTCDay()] || '';
}

/**
 * How many hours this booking gets before it is given up on.
 *
 * The base window, unless the notification landed on a day listed in
 * EXPIRE_AFTER_NOTIFICATION_HOURS_BY_WEEKDAY - Friday, which has to survive a
 * weekend in which no quote is ever accepted.
 */
function expireWindowHoursFor_(queueObject) {
  const base = Number(PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS || 0);
  const byWeekday = PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS_BY_WEEKDAY || {};
  const key = notificationWeekdayKey_(queueObject);
  const override = key ? Number(byWeekday[key] || 0) : 0;
  return override > 0 ? override : base;
}

/** Identity of a booking for dedupe: Record Code when present, otherwise PO. */
function bookingIdentityKey_(bookingCode, poNumber) {
  const booking = String(bookingCode || '').trim().toUpperCase();
  if (booking) return 'B|' + booking;
  const po = String(poNumber || '').trim().toUpperCase();
  return po ? 'P|' + po : '';
}

/* ===== EMAIL CONTACT FALLBACK ===== */

/**
 * Builds one {po -> email} map per fallback source. A source that cannot be
 * resolved is skipped and reported, never fatal.
 */
function loadEmailFallbackIndex_() {
  if (__EMAIL_FALLBACK_INDEX) return __EMAIL_FALLBACK_INDEX;

  const cached = getChunkedCache_('AUTOMATED_REACHOUT_EMAIL_FALLBACK_V1');
  if (cached) {
    try {
      __EMAIL_FALLBACK_INDEX = JSON.parse(cached);
      return __EMAIL_FALLBACK_INDEX;
    } catch (error) {
      Logger.log('Email fallback cache could not be parsed: ' + error);
    }
  }

  const result = [];
  let spreadsheet = null;
  try {
    spreadsheet = SpreadsheetApp.openById(EMAIL_FALLBACK_SPREADSHEET_ID);
  } catch (error) {
    Logger.log('Email fallback spreadsheet could not be opened: ' + error);
    __EMAIL_FALLBACK_INDEX = result;
    return result;
  }

  EMAIL_FALLBACK_SOURCES.forEach(function(source) {
    const entry = { label: source.label, map: {}, resolvedSheet: '', resolvedColumns: [], error: '' };
    try {
      const sheet = resolveSheetByNames_(spreadsheet, source.sheetNames);
      if (!sheet) {
        entry.error = 'Tab not found. Tried: ' + source.sheetNames.join(' | ');
        result.push(entry);
        return;
      }
      entry.resolvedSheet = sheet.getName();
      if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) {
        entry.error = 'Tab is empty.';
        result.push(entry);
        return;
      }
      const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
      const poIndex = resolveColumnIndex_(headerRow, source.poHeaders);
      if (poIndex === -1) {
        entry.error = 'PO column not found. Tried: ' + source.poHeaders.join(' | ');
        result.push(entry);
        return;
      }
      const emailIndexes = [];
      source.emailHeaders.forEach(function(header) {
        const index = resolveColumnIndex_(headerRow, [header]);
        if (index !== -1 && emailIndexes.indexOf(index) === -1) {
          emailIndexes.push(index);
          entry.resolvedColumns.push(String(headerRow[index] || '').trim());
        }
      });
      if (!emailIndexes.length) {
        entry.error = 'No email column found. Tried: ' + source.emailHeaders.join(' | ');
        result.push(entry);
        return;
      }

      // Read each column on its own. These tabs are very wide, so a contiguous
      // block read between the PO column and the furthest email column would
      // pull a large amount of unrelated data into memory.
      const rowCount = sheet.getLastRow() - 1;
      const poValues = sheet.getRange(2, poIndex + 1, rowCount, 1).getDisplayValues();
      const emailColumns = emailIndexes.map(function(columnIndex) {
        return sheet.getRange(2, columnIndex + 1, rowCount, 1).getDisplayValues();
      });
      for (let row = 0; row < rowCount; row++) {
        const po = poKey_(poValues[row][0]);
        if (!po || entry.map[po]) continue;
        for (let c = 0; c < emailColumns.length; c++) {
          const email = firstValidEmail_(emailColumns[c][row][0]);
          if (email) { entry.map[po] = email; break; }
        }
      }
    } catch (error) {
      entry.error = String(error);
    }
    result.push(entry);
  });

  putChunkedCache_('AUTOMATED_REACHOUT_EMAIL_FALLBACK_V1', JSON.stringify(result), EMAIL_FALLBACK_CACHE_SECONDS);
  __EMAIL_FALLBACK_INDEX = result;
  return result;
}

/**
 * Source Data first. When it holds nothing usable, each fallback source is searched
 * in order and the first valid address wins.
 */
function resolveEmailContact_(po, mbEmail) {
  const direct = firstValidEmail_(mbEmail);
  if (direct) return { email: direct, source: 'Source Data' };

  const key = poKey_(po);
  if (!key) return { email: '', source: '' };

  let sources = [];
  try {
    sources = loadEmailFallbackIndex_();
  } catch (error) {
    Logger.log('Email fallback index failed: ' + error);
    return { email: '', source: '' };
  }

  for (let i = 0; i < sources.length; i++) {
    const found = sources[i].map ? sources[i].map[key] : '';
    if (found && isValidEmail(found)) return { email: found, source: sources[i].label };
  }
  return { email: '', source: '' };
}


/* ===== COD LIST ===== */

let __COD_INDEX = null;

/**
 * Resolves a COD column by header, but only on an exact name.
 *
 * resolveColumnIndex_ ends with a forgiving substring pass, which is right for
 * the email fallback tabs and wrong here: asked for "PO" it would happily
 * return "PO Link". Blocking an intro email on the wrong column is worse than
 * not finding the column at all, so a loose hit is refused.
 */
function codColumnIndex_(headerRow, candidates) {
  const index = resolveColumnIndex_(headerRow, candidates);
  if (index === -1) return -1;
  const found = normalizeLookupText_(headerRow[index]);
  for (let i = 0; i < candidates.length; i++) {
    if (normalizeLookupText_(candidates[i]) === found) return index;
  }
  return -1;
}

/**
 * PO -> { newStart } for every row on the COD tab.
 *
 * DELIBERATELY NOT CACHED ACROSS EXECUTIONS, unlike every other lookup in this
 * project. The whole value of the COD window is that the answer is current at
 * the moment the email would go out; a five-minute cache would put a
 * five-minute blind spot at the end of a twenty-minute wait, which is exactly
 * where a late COD lands.
 *
 * Two single columns are read rather than the span between them - the tab is
 * 33 columns wide and over a year deep, and pulling all of it once a minute is
 * what put "Service Spreadsheets failed" in the Warnings tab before.
 *
 * Memoized within one execution, and built only when a booking actually needs
 * the answer, so a cycle with nothing live never opens the file.
 */
function loadCodIndex_() {
  if (__COD_INDEX) return __COD_INDEX;
  const index = { map: {}, error: '', sheetName: '', rows: 0, hasStartColumn: false };

  try {
    const spreadsheet = SpreadsheetApp.openById(COD_SOURCE.SPREADSHEET_ID);
    const sheet = resolveSheetByNames_(spreadsheet, COD_SOURCE.SHEET_NAMES);
    if (!sheet) {
      throw new Error('No tab named "' + COD_SOURCE.SHEET_NAMES.join('" or "') +
        '" in the COD spreadsheet.');
    }
    index.sheetName = sheet.getName();

    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) {
      __COD_INDEX = index;
      return index;
    }

    const headerRow = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    const poColumn = codColumnIndex_(headerRow, [COD_SOURCE.REFERENCE_HEADER]);
    if (poColumn === -1) {
      throw new Error('The "' + index.sheetName + '" tab has no "' + COD_SOURCE.REFERENCE_HEADER +
        '" column. Headers found: ' + headerRow.join(' | '));
    }
    const startColumn = codColumnIndex_(headerRow, [COD_SOURCE.NEW_START_HEADER]);
    index.hasStartColumn = startColumn !== -1;

    const pos = sheet.getRange(2, poColumn + 1, lastRow - 1, 1).getDisplayValues();
    const starts = index.hasStartColumn
      ? sheet.getRange(2, startColumn + 1, lastRow - 1, 1).getDisplayValues()
      : null;

    for (let row = 0; row < pos.length; row++) {
      const key = poKey_(pos[row][0]);
      if (!key) continue;
      index.rows++;
      // The same PO can pick up several CODs over time. The last row wins: the
      // tab is filled by a form in time order, so the newest entry carries the
      // start date that is current now.
      index.map[key] = { newStart: starts ? String(starts[row][0] || '').trim() : '' };
    }
  } catch (error) {
    index.error = String(error && error.message ? error.message : error);
  }

  __COD_INDEX = index;
  return index;
}

/**
 * The new start date as the team should read it.
 *
 * The column holds real dates on some rows and free text on others, so a value
 * that is not a date is shown exactly as it was typed rather than guessed at,
 * and the placeholders the team writes for "nothing yet" are treated as blank.
 */
function codDateText_(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (/^(n\s*\/?\s*a|na|tbd|-|--)$/i.test(text)) return '';
  const formatted = fmtDateOnly(text);
  return formatted || text;
}

/**
 * The message posted in the booking thread when a COD blocks the email.
 *
 * Wording is Maintainer's, with the comma splice fixed: "the intro email was not
 * sent, please review it" is two sentences joined by a comma, so the dash does
 * the joining instead.
 */
function buildCodThreadReply_(item, admin, newStart) {
  const po = String(item['Reference Code'] || '').trim();
  const date = codDateText_(newStart);
  const tag = admin && admin.slackId ? '<@' + admin.slackId + '>' : '*Operations Teams*';

  let text = ':warning: *Heads-up!* This booking has a COD' +
    (date ? ' to *' + date + '*' : '') + '.';
  text += '\n' + tag + ', the intro email was not sent - please review it and send it manually.';
  if (!date) {
    text += '\n_No new client start date is recorded on the COD list for PO ' + po + ' yet._';
  }
  if (!admin || !admin.slackId) {
    text += '\n_The responsible Operations Team could not be identified automatically._';
  }
  return text;
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
  if (entry.poNumber) references.push('PO ' + entry.poNumber);
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

/**
 * DAILY - removes only what no longer needs a person:
 *   - INFO rows (bookings intentionally skipped by the rules)
 *   - rows produced by the internal test circuit
 *   - any row whose booking already has a successful send in Delivery History
 * WARNING and ERROR rows that are still unresolved stay put, however old.
 */
function clearWarningsDaily() {
  const started = new Date();
  let removed = 0;
  let kept = 0;
  try {
    withDocumentLock_(function() {
      const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
      let sheet = spreadsheet.getSheetByName('Warnings');
      if (!sheet) sheet = spreadsheet.insertSheet('Warnings');
      const headers = ensureHeaders_(sheet, WARNING_HEADERS);
      if (sheet.getLastRow() < 2) return;

      const map = headerMap_(headers);
      const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
      const finalizedKeys = loadFinalizedTrackerKeys_(ensureTracker_(spreadsheet));

      const survivors = [];
      data.forEach(function(row) {
        const hasContent = row.some(function(value) { return String(value || '').trim() !== ''; });
        if (!hasContent) return;

        const severity = String(valueFrom_(row, map, 'Severity') || '').trim().toUpperCase();
        const stage = String(valueFrom_(row, map, 'Stage') || '').trim().toUpperCase();
        const key = bookingIdentityKey_(
          valueFrom_(row, map, 'Record Code'),
          valueFrom_(row, map, 'Reference Code')
        );

        const isNoise = severity === 'INFO';
        const isTest = stage.indexOf('TEST') !== -1;
        const isSettled = Boolean(key && finalizedKeys[key]);

        if (isNoise || isTest || isSettled) { removed++; return; }
        survivors.push(row);
      });

      kept = survivors.length;
      sheet.getRange(2, 1, data.length, headers.length).clearContent();
      if (survivors.length) {
        sheet.getRange(2, 1, survivors.length, headers.length).setValues(survivors);
      }
    }, true);
    logSender_('clearWarningsDaily', started, 'OK',
      removed + ' resolved warning(s) removed; ' + kept + ' still open.');
  } catch (error) {
    logSender_('clearWarningsDaily', started, 'ERROR', String(error));
  }
}

/**
 * WEEKLY (Mondays) - full reset of the Warnings tab, headers preserved.
 * This is the one that also clears anything still open, so the week starts
 * from a clean slate. Anything that is still failing comes back on its own,
 * because upsertWarnings_ writes it again on the next run.
 */
function clearWarningsWeekly() {
  const started = new Date();
  let cleared = 0;
  try {
    withDocumentLock_(function() {
      const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
      let sheet = spreadsheet.getSheetByName('Warnings');
      if (!sheet) sheet = spreadsheet.insertSheet('Warnings');
      ensureHeaders_(sheet, WARNING_HEADERS);
      if (sheet.getLastRow() >= 2) {
        cleared = sheet.getLastRow() - 1;
        sheet.getRange(2, 1, cleared, sheet.getLastColumn()).clearContent();
      }
    }, true);
    logSender_('clearWarningsWeekly', started, 'OK',
      'Weekly reset: ' + cleared + ' row(s) cleared; headers preserved.');
  } catch (error) {
    logSender_('clearWarningsWeekly', started, 'ERROR', String(error));
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

  // NOT a bare /\d{5}/ search. A five-digit HOUSE NUMBER used to be read as the
  // postcode here, and zipToState_ then answered with whatever state that range
  // belongs to: "11011 West North Avenue, Wauwatosa, WI" came back as NY,
  // because 110xx is New York. See zipFromAddressText_ in 1_Sender.gs.
  const zip = typeof zipFromAddressText_ === 'function' ? zipFromAddressText_(text) : '';
  const fromZip = zip ? zipToState_(zip) : '';
  if (fromZip) return fromZip;

  // LAST RESORT - a two-letter code at the very end, with no postcode anywhere.
  // Slack posts addresses in this shape often enough to matter: on 2026-09-11
  // "1747 Wickersham Dr, Anchorage, AK, USA" produced a blank State, which left
  // the Operations Team unresolved on USA-4044A. Every earlier rule is stronger and
  // has already been tried, so this can only fill a gap, never override.
  //
  // A trailing unit is removed first: "..., Wauwatosa, WI, USA #102" ends in
  // the unit, not in the state, and without this the whole rule missed it.
  const tail = text.replace(/#\s*[A-Za-z0-9-]+\s*$/, '').trim()
    .match(/,\s*([A-Za-z]{2})\s*(?:,\s*(?:USA|US|U\.S\.A\.?)\s*)?\.?\s*$/i);
  if (tail) {
    const code = tail[1].toUpperCase();
    if (STATE_TO_ADMIN[code]) return code;
  }
  return '';
}

/**
 * Reference Properties index.
 *
 * The tab is the heaviest read in the whole pipeline: 8,969 rows on 2026-09-15,
 * and the queue monitor consulted it on every single cycle. With the triggers
 * running as often as they do, that is tens of millions of cells a day against
 * one spreadsheet, and the Warnings tab recorded the consequence -
 * "Service Spreadsheets failed while accessing document" on both the monitor
 * and the Source Data import on 2026-09-14.
 *
 * So the index is memoized for the execution AND cached across executions. The
 * cache is a nice-to-have: if the payload will not fit, putChunkedCache_ says
 * so and the next run simply reads the sheet again.
 *
 * Values are cached as compact arrays rather than named objects - the names
 * would be repeated 9,000 times and roughly double the payload.
 */
const PROPERTY_MAP_CACHE_KEY = 'AUTOMATED_REACHOUT_PROPERTY_MAP_V2';
const PROPERTY_MAP_CACHE_SECONDS = 900;

// Per-execution memo, so one run never reads the tab twice.
var __PROPERTY_MAP = null;

function propertyMapFromCompact_(compact) {
  const map = {};
  Object.keys(compact).forEach(function(po) {
    const value = compact[po] || [];
    map[po] = {
      state: value[0] || '',
      fullAddress: value[1] || '',
      buildingName: value[2] || '',
      landlordName: value[3] || ''
    };
  });
  return map;
}

function loadPropertyMap_() {
  if (__PROPERTY_MAP) return __PROPERTY_MAP;

  const cached = getChunkedCache_(PROPERTY_MAP_CACHE_KEY);
  if (cached) {
    try {
      __PROPERTY_MAP = propertyMapFromCompact_(JSON.parse(cached));
      return __PROPERTY_MAP;
    } catch (error) {
      Logger.log('Reference Properties cache could not be parsed: ' + error);
    }
  }

  const compact = {};
  const sheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID).getSheetByName(SLACK.PROPERTY_TAB);
  if (!sheet || sheet.getLastRow() < 2) {
    __PROPERTY_MAP = {};
    return __PROPERTY_MAP;
  }
  const headerValues = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const headers = headerMap_(headerValues);
  const required = ['Property Code'];
  const missing = required.filter(function(header) { return headers[header] === undefined; });
  if (missing.length) throw new Error('Reference Properties is missing header(s): ' + missing.join(', ') + '.');

  // Read only the columns used by the automation. All enrichment columns are
  // optional; missing values must not block an otherwise eligible email.
  const rowCount = sheet.getLastRow() - 1;
  const propertyCodes = sheet.getRange(2, headers['Property Code'] + 1, rowCount, 1).getDisplayValues();
  function optionalColumn_(header) {
    if (headers[header] === undefined) {
      return Array.from({ length: rowCount }, function() { return ['']; });
    }
    return sheet.getRange(2, headers[header] + 1, rowCount, 1).getDisplayValues();
  }
  const states = optionalColumn_('Address State');
  const fullAddresses = optionalColumn_('Address Full');
  const buildingNames = optionalColumn_('Building Name');
  // Added 2026-09-16 for the Florida contract rule. It is one of the fields
  // Reviewer asked to be searched for the partner name.
  const landlordNames = optionalColumn_('Landlord Name');

  for (let row = 0; row < rowCount; row++) {
    const po = String(propertyCodes[row][0] || '').trim().toUpperCase();
    if (!po || compact[po]) continue;
    compact[po] = [
      String(states[row][0] || '').trim(),
      String(fullAddresses[row][0] || '').trim(),
      String(buildingNames[row][0] || '').trim(),
      String(landlordNames[row][0] || '').trim()
    ];
  }

  if (!putChunkedCache_(PROPERTY_MAP_CACHE_KEY, JSON.stringify(compact), PROPERTY_MAP_CACHE_SECONDS)) {
    Logger.log('Reference Properties index was too large to cache; it will be re-read next run.');
  }
  __PROPERTY_MAP = propertyMapFromCompact_(compact);
  return __PROPERTY_MAP;
}

function resolveAdmin_(po, propertyMap, fallbackAddress, fallbackState) {
  const property = propertyMap[String(po || '').trim().toUpperCase()] || {};
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
    const outcome = withDocumentLock_(function() {
      captureSlackBookingsWindow_(PIPELINE.CAPTURE_LOOKBACK_HOURS, true, started);
    }, true);
    if (outcome === PIPELINE_LOCK_BUSY) {
      // The cursor is not advanced, so the next run re-reads the same window.
      logSender_('captureSlackBookings', started, 'OK',
        'Skipped: another pipeline run was already in progress. No booking was lost; the window is re-read next cycle.');
      return;
    }
  } catch (error) {
    reportSystemWarning_('SLACK_CAPTURE', 'Slack capture failed', error);
    logSender_('captureSlackBookings', started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

function captureSlackBookingsWindow_(hours, useCursorProperty, startedDate) {
  const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
  const properties = PropertiesService.getScriptProperties();
  const savedTimestamp = useCursorProperty ? Number(properties.getProperty('AUTOMATED_REACHOUT_LAST_SLACK_TS') || 0) : 0;
  const lookbackTimestamp = Math.floor((Date.now() - Number(hours || 72) * 3600000) / 1000);
  const oldest = Math.max(lookbackTimestamp, savedTimestamp ? savedTimestamp - 2 : 0);

  let cursor = '';
  let maximumTimestamp = savedTimestamp;
  let page = 0;
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
        if (/New booking for/i.test(rawText)) {
          warnings.push(warningEntry_('SLACK_CAPTURE', {}, 'ERROR',
            'Slack notification could not be parsed',
            'The message contains "New booking for", but the Record Code or Reference Code could not be extracted. Slack timestamp: ' + message.ts));
        }
        return;
      }
      if (booking.salesAllocation !== 'DEPARTMENT_Y') {
        warnings.push(warningEntry_('SLACK_CAPTURE', booking, 'INFO',
          'Sales Allocation is not DEPARTMENT_Y',
          'Found "' + (booking.salesAllocation || 'blank') + '". The notification was intentionally skipped.'));
        return;
      }
      if (!/A$/i.test(booking.po)) {
        // A PO that does not end in A is a DEPARTMENT_X unit, not Department Y. The team
        // marks these by hand with :coreunit:; the reaction is left here so the
        // channel shows at a glance that the skip was deliberate and not a
        // failure. Slack rejects a duplicate reaction with already_reacted,
        // which addSlackReaction_ swallows, so re-running capture is harmless.
        const reaction = addSlackReaction_(booking.slackTs, DEPARTMENT_X_UNIT_EMOJI);
        warnings.push(warningEntry_('SLACK_CAPTURE', booking, 'INFO',
          'Reference Code does not end in A',
          'Reference Code "' + booking.po + '" is a DEPARTMENT_X unit, outside the Automated Reach-Out automation rule, and was skipped. ' +
          'Slack :' + DEPARTMENT_X_UNIT_EMOJI + ': reaction: ' + reaction + '.'));
        return;
      }
      parsed.push(booking);
    });
    cursor = payload.response_metadata && payload.response_metadata.next_cursor || '';
    page++;
  } while (cursor && page < 25);

  parsed.sort(function(a, b) { return a.notedDate.getTime() - b.notedDate.getTime(); });
  const outcome = appendNewBookingsToQueue_(parsed);
  outcome.warnings.forEach(function(warning) { warnings.push(warning); });
  upsertWarnings_(warnings);
  if (useCursorProperty && maximumTimestamp) properties.setProperty('AUTOMATED_REACHOUT_LAST_SLACK_TS', String(maximumTimestamp));
  logSender_('captureSlackBookings', startedDate || new Date(), 'OK',
    outcome.added + ' new booking(s) queued; ' + parsed.length + ' eligible notification(s) reviewed; ' +
    outcome.alreadySent + ' skipped as already sent; ' + outcome.alreadyQueued + ' already in the queue.');
  return outcome.added;
}

/**
 * Appends bookings that are not queued yet and were not already sent.
 * A booking without a Record Code is kept and identified by its Reference Code.
 */
function appendNewBookingsToQueue_(bookings) {
  const outcome = { added: 0, alreadySent: 0, alreadyQueued: 0, warnings: [] };
  if (!bookings.length) return outcome;

  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  let sheet = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
  if (!sheet) sheet = spreadsheet.insertSheet(SLACK.QUEUE_TAB);
  const headers = ensureHeaders_(sheet, SLACK_HEADERS);
  const map = headerMap_(headers);

  const tracker = ensureTracker_(spreadsheet);
  const finalizedKeys = loadFinalizedTrackerKeys_(tracker);

  const existing = {};
  if (sheet.getLastRow() >= 2) {
    const bookingIndex = map['Record Code'];
    const poIndex = map['Reference Code'];
    const width = Math.max(bookingIndex, poIndex) + 1;
    const block = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getDisplayValues();
    block.forEach(function(row) {
      const key = bookingIdentityKey_(row[bookingIndex], row[poIndex]);
      if (key) existing[key] = true;
    });
  }

  const output = [];
  bookings.forEach(function(booking) {
    const key = bookingIdentityKey_(booking.bookingCode, booking.po);
    if (!key) {
      outcome.warnings.push(warningEntry_('SLACK_CAPTURE', booking, 'ERROR',
        'Booking has neither Record Code nor Reference Code',
        'The notification could not be identified and was not queued. Slack timestamp: ' + booking.slackTs));
      return;
    }
    if (existing[key]) { outcome.alreadyQueued++; return; }
    if (finalizedKeys[key]) { outcome.alreadySent++; return; }
    existing[key] = true;
    const values = {
      // Every new booking starts released. A human sets YES to hold it back.
      'Stop Sent?': STOP_SENT.NO,
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

  if (output.length) {
    const startRow = sheet.getLastRow() + 1;
    // Force the Slack ts column to plain text BEFORE writing, otherwise Sheets
    // stores it as a number and silently drops precision.
    const tsIndex = map['Slack Thread TS'];
    if (tsIndex !== undefined) {
      sheet.getRange(startRow, tsIndex + 1, output.length, 1).setNumberFormat('@');
    }
    sheet.getRange(startRow, 1, output.length, headers.length).setValues(output);
    ensureStopSentColumn_(sheet, headers);
  }
  outcome.added = output.length;
  return outcome;
}

function backfillSlackToday() {
  backfillSlack(PIPELINE.CAPTURE_LOOKBACK_HOURS);
}

/** Re-scans the last N hours ignoring the cursor. Already-sent bookings are skipped. */
function backfillSlack(hours) {
  const started = new Date();
  try {
    withDocumentLock_(function() { captureSlackBookingsWindow_(hours || 72, false, started); });
  } catch (error) {
    reportSystemWarning_('SLACK_BACKFILL', 'Slack backfill failed', error);
    logSender_('backfillSlack', started, 'ERROR', String(error));
  }
}

/* ===== Source Data LOOKUP ===== */

function loadMbIndex_() {
  const sheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID).getSheetByName(SLACK.MB_TAB);
  if (!sheet || sheet.getLastRow() < 2) {
    return { headerMap: {}, byBooking: {}, byPo: {}, byAddress: {}, byAddressFallback: {} };
  }
  const data = sheet.getDataRange().getValues();
  const map = headerMap_(data[0]);

  // Checked BEFORE the reservation below, which would otherwise invent the very
  // columns this guard exists to miss.
  const required = ['Record Code', 'Reference Code', 'Email Contact'];
  const missing = required.filter(function(header) { return map[header] === undefined; });
  if (missing.length) throw new Error('Source Data is missing header(s): ' + missing.join(', ') + '.');

  // ROOM FOR COLUMNS Source Data DOES NOT HAVE.
  //
  // loadDirectSourceIndex_ shapes every CRM quote into a row positioned by
  // THIS map, and its put() silently drops any value whose header is missing
  // here. So a field that exists in the CRM report but not in the
  // BI platform question - "Other Fee", "Prop Utilities" - was read, translated
  // and then thrown away without a word.
  //
  // Adding the column to the Source Data tab by hand does not help: the importer
  // rewrites row 1 from the CSV every thirty minutes and clears anything past
  // the CSV width.
  //
  // So the map is extended past the real columns. The extra slots exist only
  // in memory. A genuine Source Data row is shorter than the extended width and
  // simply reads undefined there, which buildEmailObject_ already treats as
  // blank, so nothing about the BI platform path changes.
  let nextIndex = data[0].length;
  function reserveColumn_(header) {
    if (!header || map[header] !== undefined) return;
    map[header] = nextIndex++;
  }
  if (typeof DIRECT_SOURCE !== 'undefined' && DIRECT_SOURCE.HEADER_ALIASES) {
    Object.keys(DIRECT_SOURCE.HEADER_ALIASES).forEach(function(sfHeader) {
      reserveColumn_(DIRECT_SOURCE.HEADER_ALIASES[sfHeader]);
    });
  }
  // The three the shaped row fills directly, outside the alias table.
  ['Property Name', 'Unit No', 'Email Contact'].forEach(reserveColumn_);
  const byBooking = {};
  const byPo = {};

  for (let row = 1; row < data.length; row++) {
    const values = data[row];
    const booking = String(valueFrom_(values, map, 'Record Code') || '').trim().toUpperCase();
    const po = String(valueFrom_(values, map, 'Reference Code') || '').trim().toUpperCase();
    if (booking) {
      if (!byBooking[booking]) byBooking[booking] = [];
      byBooking[booking].push(values);
    }
    if (po) {
      if (!byPo[po]) byPo[po] = [];
      byPo[po].push(values);
    }
  }

  // Fast path (5_FastPath.gs). Bookings that CRM already has but the upstream booking platform
  // has not loaded, so they carry no Reference Code and are keyed on the address.
  // Any failure here leaves byAddress empty and the lookup behaves as before.
  let byAddress = {};
  let byAddressFallback = {};
  try {
    if (typeof loadFastPathIndex_ === 'function') {
      const fast = loadFastPathIndex_(map);
      byAddress = fast.byAddress || {};
      byAddressFallback = fast.byAddressFallback || {};
    }
  } catch (error) {
    Logger.log('Fast path index unavailable, continuing without it: ' + error);
    byAddress = {};
    byAddressFallback = {};
  }

  // Direct Source (6_SFDirect_Import.gs). Read straight from the CRM report,
  // so it carries same-day quotes that neither Source Data nor the fast path can
  // have yet - DATAMART.BOOKING runs two to three days behind, measured
  // 2026-09-07: newest booking was 2026-09-03. Any failure here leaves the
  // index empty and the lookup behaves as it did before.
  let directSource = null;
  try {
    if (typeof loadDirectSourceIndex_ === 'function') directSource = loadDirectSourceIndex_(map);
  } catch (error) {
    Logger.log('Direct Source index unavailable, continuing without it: ' + error);
    directSource = null;
  }

  return { headerMap: map, byBooking: byBooking, byPo: byPo,
           byAddress: byAddress, byAddressFallback: byAddressFallback,
           directSource: directSource };
}


function sameDateValue_(left, right) {
  if (!left || !right) return false;
  return fmtDateOnly(left) === fmtDateOnly(right);
}

function findMbMatch_(queueObject, mbIndex) {
  const booking = String(queueObject['Record Code'] || '').trim().toUpperCase();
  const po = String(queueObject['Reference Code'] || '').trim().toUpperCase();
  const bookingCandidates = booking ? (mbIndex.byBooking[booking] || []) : [];
  if (bookingCandidates.length === 1) {
    // A Record Code hit is only trusted when the Reference Code agrees. Without this
    // check a single mismatched code in Source Data would pull another booking's
    // fees and recipient into this email.
    const candidatePo = String(valueFrom_(bookingCandidates[0], mbIndex.headerMap, 'Reference Code') || '')
      .trim().toUpperCase();
    if (po && candidatePo && candidatePo !== po) return null;
    return { row: bookingCandidates[0], method: 'BOOKING' };
  }
  if (bookingCandidates.length > 1) {
    const samePo = bookingCandidates.filter(function(candidate) {
      return String(valueFrom_(candidate, mbIndex.headerMap, 'Reference Code') || '').trim().toUpperCase() === po;
    });
    if (samePo.length === 1) return { row: samePo[0], method: 'BOOKING_PO' };
    const exactDates = samePo.filter(function(candidate) {
      return sameDateValue_(queueObject['Lease Start'], valueFrom_(candidate, mbIndex.headerMap, 'Lease Start')) &&
        sameDateValue_(queueObject['Lease End Date'], valueFrom_(candidate, mbIndex.headerMap, 'Lease End Date'));
    });
    if (exactDates.length === 1) return { row: exactDates[0], method: 'BOOKING_PO_DATES' };
    return null;
  }

  const candidates = mbIndex.byPo[po] || [];
  if (candidates.length === 1) return { row: candidates[0], method: 'PO_UNIQUE' };
  if (candidates.length > 1) {
    const exactDates = candidates.filter(function(candidate) {
      return sameDateValue_(queueObject['Lease Start'], valueFrom_(candidate, mbIndex.headerMap, 'Lease Start')) &&
        sameDateValue_(queueObject['Lease End Date'], valueFrom_(candidate, mbIndex.headerMap, 'Lease End Date'));
    });
    if (exactDates.length === 1) return { row: exactDates[0], method: 'PO_DATES' };
    return null;
  }

  // ---- DIRECT SOURCE -----------------------------------------------------------
  // Tried before the fast path because it is the fresher of the two
  // address-keyed sources: straight from the CRM report, against the
  // fast path's trip through data warehouse's once-a-day load. Both are consulted
  // only after PO and Record Code have missed, so Source Data still wins whenever
  // it has the booking.
  if (typeof findDirectSourceRow_ === 'function') {
    const sfMatch = findDirectSourceRow_(queueObject, mbIndex.directSource);
    if (sfMatch) return sfMatch;
  }

  // ---- FAST PATH -----------------------------------------------------------
  // Reached only when Source Data has nothing at all for this Record Code or PO,
  // which is exactly the window where the upstream booking platform has not loaded the property yet.
  // Source Data always wins: this code never runs when the normal lookup succeeded.
  if (typeof addressKeyFromText_ !== 'function') return null;
  const addressKey = addressKeyFromText_(queueObject['Full Address']);
  let fastCandidates = addressKey ? ((mbIndex.byAddress || {})[addressKey] || []) : [];
  let method = 'FASTPATH_ADDRESS';

  // Slack sometimes posts the address with no postcode ("962 Birchfield drive",
  // "1747 Wickersham Dr, Anchorage, AK, USA" - both on 2026-09-03). Then the
  // postcode key cannot be built and house number + state is used instead. It
  // is weaker, so it is tried ONLY when the postcode key is impossible - never
  // as a second chance after a postcode miss.
  if (!addressKey && typeof addressFallbackKeyFromText_ === 'function') {
    const fallbackKey = addressFallbackKeyFromText_(queueObject['Full Address'], queueObject.State);
    if (!fallbackKey) return null;
    fastCandidates = (mbIndex.byAddressFallback || {})[fallbackKey] || [];
    method = 'FASTPATH_ADDRESS_STATE';
  }

  // One key must resolve to exactly one quote. The SQL already guarantees this
  // for the postcode key; more than one row here means ambiguity, so refuse.
  if (fastCandidates.length !== 1) return null;

  const fastRow = fastCandidates[0];
  const queueUnit = typeof extractUnitNoFromAddress_ === 'function'
    ? extractUnitNoFromAddress_(queueObject['Full Address'])
    : '';
  const fastUnit = valueFrom_(fastRow, mbIndex.headerMap, 'Unit No');
  if (typeof fastPathUnitAgrees_ === 'function' && !fastPathUnitAgrees_(queueUnit, fastUnit)) return null;

  return { row: fastRow, method: method };
}

/**
 * Kept for reference. The Reference Properties "Address Apt" column frequently
 * holds the postcode, so no unit is inferred any more: when Source Data has no
 * Unit No the field is simply left blank. To also accept an explicit "#123"
 * written at the end of the address, add this call back in buildEmailObject_.
 */
function extractUnitNoFromAddress_(address) {
  const text = String(address || '').trim();
  let match = text.match(/#\s*([A-Za-z0-9-]+)\s*$/);
  if (match) return match[1];
  match = text.match(/\b(?:unit|apt|apartment|suite)\s*#?\s*([A-Za-z0-9-]+)\s*$/i);
  return match ? match[1] : '';
}

function buildEmailObject_(queueObject, mbRow, mbMap, propertyMap) {
  function mb(header) { return mbRow && mbMap[header] !== undefined ? mbRow[mbMap[header]] : ''; }

  const po = String(queueObject['Reference Code'] || mb('Reference Code') || '').trim();
  const propertyData = propertyMap[po.toUpperCase()] || {};

  // FULL ADDRESS COMES FROM THE SLACK NOTIFICATION.
  //
  // Changed 2026-09-18 at Maintainer's request. It used to prefer the quote and
  // fall back to Slack; now Slack wins outright.
  //
  // Why it matters: the notification carries the unit, the quote frequently
  // does not. For USA-4065A Slack posted
  //   "60 N Beretania St, Honolulu, HI 96817, USA #1710"
  // and that "#1710" is what the owner needs to see. CRM also records
  // addresses that are plainly wrong - quote 296817 said "1564 Hilton Ave
  // (approx)" for a booking at 1422 Lathrop St.
  //
  // The other two sources are kept ONLY for when Slack posted no address at
  // all, which would otherwise leave the line blank.
  //
  // Known cost: Slack sometimes posts a short address with no postcode
  // ("962 Birchfield drive" on ATL-1356A, "1747 Wickersham Dr, Anchorage, AK,
  // USA" on USA-4044A, both 2026-09-03). Those emails now show the short form
  // even when the quote held a fuller one. That is the trade for never showing
  // an address the team did not see in the channel.
  const address = String(queueObject['Full Address'] ||
    mb('Full Address') || propertyData.fullAddress || '').trim();
  // Unit No comes from Source Data only and blank still stays blank. There is one
  // exception: a SENTINEL is not a unit. A quote written for a whole building
  // carries "MULTI" (also TBD, NA, VARIOUS, SFH, HOUSE), which would print
  // "Unit #MULTI" in the subject and on top of every fee table. When the quote
  // says that, the Slack booking is the better source - it names the real unit,
  // "#12-220" - and on a bulk send it is the only thing telling the tables
  // apart, because all of them come from that one quote.
  //
  // Quote Unit keeps the original: MULTI is what flags a bulk send in the first
  // place, so it must survive the substitution.
  const quoteUnit = String(mb('Unit No') || '').trim();
  const sentinelUnit = quoteUnit && typeof isSentinelUnitToken_ === 'function' && isSentinelUnitToken_(quoteUnit);
  const addressUnit = extractUnitNoFromAddress_(address);
  const unitNo = (sentinelUnit && addressUnit) ? addressUnit : quoteUnit;
  const state = queueObject.State || mb('State') || propertyData.state || stateFromAddress_(address);
  const propertyName = String(mb('Property Name') || queueObject['Property Name'] || propertyData.buildingName || po).trim();
  const displayName = resolveDisplayName_(po, propertyName, propertyData.buildingName);
  const emailResolution = resolveEmailContact_(po, mb('Email Contact') || queueObject['Email Contact']);

  // CENTRAL PARTNER DESK. Added 2026-09-18.
  //
  // When the counterparty is Example Partner the email goes to their applications
  // desk, never to whatever contact the quote happens to carry for that
  // individual building. partnerInboxFor_ in 1_Sender.gs decides, and it trusts
  // External Provider first - see the note there for the 147 POs that merely
  // have "Example Partner" in a name and belong to someone else entirely.
  //
  // The replaced address is not thrown away: it goes into Email Source, so the
  // Delivery History and previewQueuedSends still show what the property-level
  // contact would have been.
  const partnerInbox = partnerInboxFor_({
    'External Provider': mb('External Provider') || queueObject['External Provider'],
    'Property Name': propertyName,
    'Display Name': displayName,
    'Building Name': propertyData.buildingName || '',
    'Landlord Name': propertyData.landlordName || ''
  });
  const contactEmail = partnerInbox ? partnerInbox.email : emailResolution.email;
  const contactSource = partnerInbox
    ? partnerInbox.label + ' desk' + (emailResolution.email
        ? ' (replaced ' + emailResolution.email + ')'
        : ' (no property contact was on file)')
    : emailResolution.source;

  // Which authoritative fields Source Data still owes us. The queue monitor uses
  // this to hold the email back instead of filling the gap from Slack.
  const missingFromMb = (PIPELINE.REQUIRED_MB_FIELDS || []).filter(function(header) {
    const value = mb(header);
    return value === '' || value === null || value === undefined;
  });

  return {
    'Slack Not Date': queueObject['Slack Not Date'],
    'Slack Thread TS': queueObject['Slack Thread TS'],
    'Record Code': queueObject['Record Code'] || mb('Record Code'),
    'Reference Code': po,
    'Source Quote Number': mb('Source Quote Number') || queueObject['Source Quote Number'],
    'Unit No': unitNo,
    // Not an email column. Only the bulk-send rule reads it.
    'Quote Unit': quoteUnit,
    'Full Address': address,
    'Property Name': propertyName,
    'Display Name': displayName || propertyName || po,
    'External Provider': mb('External Provider') || queueObject['External Provider'],
    // Lease terms and money come from Source Data ONLY. The Slack booking carries
    // the figures at booking creation, which are not the lease terms, and
    // mixing the two produced a table that matched neither source.
    'Lease Start': mb('Lease Start'),
    'Lease End Date': mb('Lease End Date'),
    'Monthly Rent': mb('Monthly Rent'),
    'Security Deposit': mb('Security Deposit'),
    'Admin': mb('Admin'),
    'Application': mb('Application'),
    'Prop Pet Fee Monthly': mb('Prop Pet Fee Monthly'),
    'Prop Pet Fee One-Time': mb('Prop Pet Fee One-Time'),
    'Prop Cleaning Fee': mb('Prop Cleaning Fee'),
    'Parking Fee': mb('Parking Fee'),
    // Added 2026-08-31. Same rule as every other money field: Source Data only,
    // never the Slack booking. buildPerPOTable skips whatever comes back zero.
    'Renters Insurance': mb('Renters Insurance'),
    'Prop Tax Amount': mb('Prop Tax Amount'),
    'Prop Utilities': mb('Prop Utilities'),
    'Monthly Other': mb('Monthly Other'),
    'Monthly Other Desc': mb('Monthly Other Desc'),
    'Pet Deposit': mb('Pet Deposit'),
    // One-time PROP charges. buildPerPOTable prints these only when the
    // description starts with PROP, so a TH charge in the same box stays out.
    'Other Fee': mb('Other Fee'),
    'Other Fee Desc': mb('Other Fee Desc'),
    'Other Deposit': mb('Other Deposit'),
    'Other Deposit Desc': mb('Other Deposit Desc'),
    'Email Contact': contactEmail,
    'Email Source': contactSource,
    'MB Missing Fields': missingFromMb.join(', '),
    'Unit Email': queueObject['Unit Email'],
    'BG Representative': queueObject['BG Representative'],
    'Enterprise': queueObject.Enterprise,
    'Partner': queueObject.Partner,
    'State': stateNameToCode_(state) || stateFromAddress_(address) || state,
    // Not shown in the email. Searched by the Florida contract rule and by the
    // PARTNER name matching, which is why they travel with the row.
    'Building Name': propertyData.buildingName || '',
    'Landlord Name': propertyData.landlordName || ''
  };
}

/**
 * Puts a value in a comparable shape. The current row comes from the sheet
 * (dates arrive as Date objects, money as numbers) while the previous snapshot
 * comes from raw CSV text, so a plain string compare would always disagree.
 */
function normalizeMbFieldForCompare_(header, value) {
  if (value === null || value === undefined) return '';
  if (header === 'Lease Start' || header === 'Lease End Date') return fmtDateOnly(value);
  if (header === 'Email Contact') return String(value).trim().toLowerCase();
  const text = String(value).trim();
  if (text === '') return '';
  if (/^[\d.,$()\s-]+$/.test(text) || typeof value === 'number') return String(moneyAmount_(value));
  return text.toLowerCase();
}

/**
 * Compares the Source Data row about to be used against the same PO in the previous
 * import. Returns a list of human-readable differences, empty when stable.
 */
function mbValueDrift_(po, currentRow, mbMap) {
  const key = String(po || '').trim().toUpperCase();
  if (!key) return [];
  let snapshot;
  try {
    snapshot = loadPreviousMbSnapshot_();
  } catch (error) {
    Logger.log('Stability check skipped: ' + error);
    return [];
  }
  const previous = snapshot ? snapshot[key] : null;
  // No previous import to compare against yet, or the PO is brand new: allow.
  if (!previous) return [];

  const drift = [];
  (PIPELINE.STABILITY_FIELDS || []).forEach(function(header) {
    const nowValue = normalizeMbFieldForCompare_(header,
      mbMap[header] === undefined ? '' : currentRow[mbMap[header]]);
    const thenValue = normalizeMbFieldForCompare_(header, previous[header]);
    if (nowValue !== thenValue) {
      drift.push(header + ': "' + (thenValue || 'blank') + '" -> "' + (nowValue || 'blank') + '"');
    }
  });
  return drift;
}

function missingEmailData_(item) {
  const missing = [];
  if (!isValidEmail(item['Email Contact'])) missing.push('Email Contact');
  return missing;
}

function describeMbMiss_(queueObject, mbIndex) {
  const booking = String(queueObject['Record Code'] || '').trim().toUpperCase();
  const po = String(queueObject['Reference Code'] || '').trim().toUpperCase();
  const bookingCandidates = booking ? (mbIndex.byBooking[booking] || []) : [];
  if (bookingCandidates.length > 1) {
    return 'Record Code "' + booking + '" matched ' + bookingCandidates.length +
      ' Source Data rows and could not be uniquely resolved by Reference Code and lease dates. The row remains in the queue.';
  }
  if (bookingCandidates.length === 1) {
    const candidatePo = String(valueFrom_(bookingCandidates[0], mbIndex.headerMap, 'Reference Code') || '')
      .trim().toUpperCase();
    if (po && candidatePo && candidatePo !== po) {
      return 'Record Code "' + booking + '" exists in Source Data but on Reference Code "' + candidatePo +
        '", not "' + po + '". The row was NOT matched, to avoid sending another booking\'s fees and ' +
        'recipient. Check Source Data for a wrong Record Code.';
    }
  }
  const poCandidates = mbIndex.byPo[po] || [];
  if (!poCandidates.length) {
    // Before blaming Source Data, check whether CRM holds a DECLINED quote
    // for this address. That is a different problem with a different fix, and
    // the old wording pointed at the wrong file.
    const declinedNote = typeof sfDeclinedNoteFor_ === 'function'
      ? sfDeclinedNoteFor_(queueObject)
      : '';
    return 'Record Code "' + booking + '" and Reference Code "' + po + '" were not found in Source Data, ' +
      'and no usable quote was found in Direct Source Data either. The row remains in the queue and ' +
      'will be checked again.' + declinedNote;
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

/* ===== RECENT MANUAL SENT CHECK ===== */

function loadRecentSentAutomatedReachOutMessages_() {
  const days = Math.max(1, Number(PIPELINE.SENT_LOOKBACK_DAYS || 3));
  const query = 'in:sent newer_than:' + (days + 1) + 'd from:' + FROM_ALIAS + ' {subject:"move in" subject:"move-in"}';
  const threads = GmailApp.search(query, 0, 500);
  const allowedDays = recentDayKeys_(days);
  const messages = [];

  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      if (String(message.getFrom() || '').toLowerCase().indexOf(FROM_ALIAS.toLowerCase()) === -1) return;
      if (!allowedDays[formatDayKey_(message.getDate())]) return;
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
    // EXPIRED and COD count as settled even though nothing was sent. Each one
    // was a deliberate decision not to send - the notification is older than the
    // give-up window (EXPIRE_AFTER_NOTIFICATION_HOURS), or the booking is on the
    // COD list - and without this the next capture would put it straight back
    // in the queue and post the COD notice in the thread all over again.
    if (mode === 'TEST') continue;
    if (status !== 'OK' && status !== 'EXPIRED' && status !== 'COD') continue;
    const key = bookingIdentityKey_(
      valueFrom_(data[row], map, 'Record Code'),
      valueFrom_(data[row], map, 'Reference Code')
    );
    if (key) keys[key] = true;
  }
  return keys;
}

function isAlreadyFinalized_(queueObject, finalizedKeys) {
  const key = bookingIdentityKey_(queueObject['Record Code'], queueObject['Reference Code']);
  return Boolean(key && finalizedKeys[key]);
}

function trackerRow_(sentTimestamp, item, context, recipient, mode, status, comment) {
  return [
    sentTimestamp,
    item['Record Code'] || '',
    item['Reference Code'] || '',
    item['Display Name'] || item['Property Name'] || '',
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

/* ===== EXTERNAL PO / INTRO EMAIL CONTROL ===== */

/**
 * Writes the PO into the "Operations Team Main" tab with Intake Email = C.
 * An existing PO is updated in place; a new PO is appended to the first row
 * after the current data. No blank rows are created.
 */
/** Last row that actually holds a PO. Ignores stray content in other columns. */
function lastFilledPoRow_(sheet, poIndex) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const values = sheet.getRange(2, poIndex + 1, lastRow - 1, 1).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0] || '').trim() !== '') return i + 2;
  }
  return 1;
}

/** True when the cell text already carries the automation note. */
function hasControlNote_(value) {
  const current = normalizeLookupText_(value);
  if (!current) return false;
  return current.indexOf(normalizeLookupText_(INTRO_CONTROL.NOTE)) !== -1;
}

/**
 * Adds the automation note to Notes/Escalations without destroying anything.
 * An empty cell receives the note; a cell that already holds a team note gets
 * the automation note appended after it. Never runs twice on the same cell.
 */
function appendControlNote_(sheet, row, notesIndex) {
  if (notesIndex === undefined) return false;
  const cell = sheet.getRange(row, notesIndex + 1);
  const current = String(cell.getDisplayValue() || '').trim();
  if (hasControlNote_(current)) return false;
  cell.setValue(current ? current + '; ' + INTRO_CONTROL.NOTE : INTRO_CONTROL.NOTE);
  return true;
}

/**
 * Assignee is a dropdown. Reads the values the sheet actually allows and returns
 * the one matching this admin, so the automation can never write a value that
 * the validation would reject. Returns '' when there is no match.
 */
function resolveAssigneeValue_(sheet, assigneeIndex, admin) {
  if (!admin || assigneeIndex === undefined) return '';
  const candidates = [admin.name, admin.label].filter(Boolean);
  let allowed = [];
  try {
    const rule = sheet.getRange(2, assigneeIndex + 1).getDataValidation();
    if (rule) {
      const type = rule.getCriteriaType();
      const criteria = rule.getCriteriaValues();
      if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
        allowed = (criteria[0] || []).map(function(value) { return String(value || '').trim(); });
      } else if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && criteria[0]) {
        allowed = criteria[0].getDisplayValues().map(function(row) { return String(row[0] || '').trim(); });
      }
    }
  } catch (error) {
    Logger.log('Assignee dropdown could not be read: ' + error);
  }
  allowed = allowed.filter(Boolean);
  if (!allowed.length) return candidates[0] || '';

  for (let i = 0; i < candidates.length; i++) {
    const wanted = normalizeLookupText_(candidates[i]);
    for (let j = 0; j < allowed.length; j++) {
      if (normalizeLookupText_(allowed[j]) === wanted) return allowed[j];
    }
  }
  return '';
}

/**
 * Writes the PO into Operations Team Main with Intake Email = C, the responsible RE
 * Admin in Assignee and the send date in Handoff Date.
 *
 * Rules:
 *   - a new PO goes on the first row after the last filled PO, never further
 *   - an existing PO is updated in place
 *   - Intake Email is the automation's own field and is always set
 *   - Assignee and Handoff Date belong to the team: filled only when empty,
 *     never overwritten
 *
 * entries: [{ po, admin, sentAt }]
 */
function recordAutomationIntroEmails_(entries) {
  const seenPo = {};
  const list = (entries || []).filter(function(entry) {
    const key = poKey_(entry && entry.po);
    if (!key || seenPo[key]) return false;
    seenPo[key] = true;
    return true;
  });
  if (!list.length) return;

  const spreadsheet = SpreadsheetApp.openById(INTRO_CONTROL.SPREADSHEET_ID);
  const sheet = resolveSheetByNames_(spreadsheet, [INTRO_CONTROL.SHEET_NAME]);
  if (!sheet) throw new Error('Intake Email control tab not found: ' + INTRO_CONTROL.SHEET_NAME);

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function(header) { return String(header || '').trim(); });
  const map = headerMap_(headers);
  const poIndex = map[INTRO_CONTROL.REFERENCE_HEADER];
  const introIndex = map[INTRO_CONTROL.INTRO_HEADER];
  if (poIndex === undefined || introIndex === undefined) {
    throw new Error('The external control sheet must contain PO and Intake Email headers.');
  }
  const assigneeIndex = map[INTRO_CONTROL.ASSIGNEE_HEADER];
  const handoffIndex = map[INTRO_CONTROL.HANDOFF_HEADER];
  const notesIndex = map[INTRO_CONTROL.NOTES_HEADER];

  const lastPoRow = lastFilledPoRow_(sheet, poIndex);
  const existingRows = {};
  if (lastPoRow >= 2) {
    sheet.getRange(2, poIndex + 1, lastPoRow - 1, 1).getDisplayValues()
      .forEach(function(row, index) {
        const key = poKey_(row[0]);
        if (key && existingRows[key] === undefined) existingRows[key] = index + 2;
      });
  }

  function fillIfEmpty(row, columnIndex, value) {
    if (columnIndex === undefined || value === '' || value === null || value === undefined) return;
    const cell = sheet.getRange(row, columnIndex + 1);
    if (String(cell.getDisplayValue() || '').trim() !== '') return;
    cell.setValue(value);
  }

  let nextRow = lastPoRow + 1;
  list.forEach(function(entry) {
    const key = poKey_(entry.po);
    const sentAt = (entry.sentAt instanceof Date) ? entry.sentAt : new Date();
    const assigneeValue = resolveAssigneeValue_(sheet, assigneeIndex, entry.admin);

    let targetRow = existingRows[key];
    if (!targetRow) {
      // Walk forward until the PO cell is genuinely empty. Existing data is
      // never touched and no blank rows are left behind.
      while (!targetRow) {
        if (nextRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
        if (String(sheet.getRange(nextRow, poIndex + 1).getDisplayValue() || '').trim() === '') {
          targetRow = nextRow;
        }
        nextRow++;
      }
      sheet.getRange(targetRow, poIndex + 1).setValue(String(entry.po).trim());
      existingRows[key] = targetRow;
    }

    sheet.getRange(targetRow, introIndex + 1).setValue(INTRO_CONTROL.VALUE);
    fillIfEmpty(targetRow, assigneeIndex, assigneeValue);
    fillIfEmpty(targetRow, handoffIndex, sentAt);
    appendControlNote_(sheet, targetRow, notesIndex);
  });
}

/* ===== EMAIL / PARTNER CONTEXT ===== */

function contextForItem_(item, propertyMap) {
  const property = propertyMap[String(item['Reference Code'] || '').trim().toUpperCase()] || {};
  let partnerCompanyName = '';
  try {
    // Widened 2026-09-16 at Reviewer's request: the PARTNER is looked for in every
    // field that can carry a partner name, not just the address and the
    // property name. External Provider matters most - it is the only field
    // where a partner like Fort Family appears at all, since their buildings
    // are named "Fusion" and "Pinnacle".
    partnerCompanyName = findPartnerMatch_([
      item['Full Address'],
      item['Property Name'],
      item['Display Name'],
      property.buildingName,
      property.landlordName,
      item['External Provider']
    ]);
  } catch (error) {
    logSender_('PARTNER matching', new Date(), 'REVIEW', String(error));
  }
  // External Provider lives only in SMT_PROPERTY, so when that property has not
  // loaded yet it arrives blank and a private owner silently gets the GENERAL
  // template. The Slack booking still states the partner type, so fall back to it.
  //
  // PARTNER and private are INDEPENDENT rules. resolveEmailContext_ already lets
  // private win the template while brandRestricted keeps the PARTNER branding, so
  // partnerCompanyName is passed through untouched and a private owner inside a PARTNER still
  // resolves correctly. Only the blank External Provider is filled in here.
  // See providerFromPartner_ in 5_FastPath.gs.
  let provider = item['External Provider'];
  if (!String(provider || '').trim() && typeof providerFromPartner_ === 'function') {
    provider = providerFromPartner_(item['Partner']);
  }
  return resolveEmailContext_(provider, partnerCompanyName);
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

/**
 * Who this execution can send as. Memoized: both calls hit Gmail.
 *
 *   effectiveUser    the account the project actually runs as
 *   isAliasAccount   that account IS readmin-ondemand@, so "from" is a no-op
 *   canSendAsAlias   it is that account, or holds it as a configured alias
 */
var __SENDER_IDENTITY = null;

function senderIdentity_() {
  if (__SENDER_IDENTITY) return __SENDER_IDENTITY;
  const wanted = String(FROM_ALIAS || '').trim().toLowerCase();
  const result = { effectiveUser: '', aliases: [], isAliasAccount: false, canSendAsAlias: false, error: '' };
  try {
    result.effectiveUser = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  } catch (error) {
    result.error = String(error);
  }
  try {
    result.aliases = GmailApp.getAliases().map(function(value) {
      return String(value || '').trim().toLowerCase();
    }).filter(Boolean);
  } catch (error) {
    result.error = (result.error ? result.error + ' | ' : '') + String(error);
  }
  result.isAliasAccount = Boolean(wanted) && result.effectiveUser === wanted;
  result.canSendAsAlias = result.isAliasAccount || result.aliases.indexOf(wanted) !== -1;
  __SENDER_IDENTITY = result;
  return result;
}

/**
 * READ-ONLY. Prints the exact envelope the next Automated Reach-Out email would carry.
 * Sends nothing, writes nothing, touches no sheet.
 *
 * READ THE LAST BLOCK. A time trigger runs as the account that INSTALLED it,
 * not as whoever has the editor open, so running this by hand only proves what
 * a manual send would do. That gap is exactly how an intro email left from
 * realestate-admin@ on 2026-09-16 while a manual check reported everything fine.
 */
function testSendingAddress() {
  const identity = senderIdentity_();
  const cc = (typeof CC_RECIPIENT === 'string') ? CC_RECIPIENT.trim() : '';
  const lines = [];

  lines.push('=== WHAT THE NEXT EMAIL WOULD CARRY ===');
  lines.push('');
  if (identity.canSendAsAlias) {
    lines.push('  From     : ' + FROM_ALIAS +
      (identity.isAliasAccount ? '   (this account itself)' : '   (alias on ' + identity.effectiveUser + ')'));
  } else {
    lines.push('  From     : *** NOTHING WOULD BE SENT ***');
    lines.push('             sendAutomatedReachOutMessage_ refuses before building the draft.');
  }
  lines.push('  Reply-To : ' + FROM_ALIAS + '   (set on every path, always)');
  lines.push('  Cc       : ' + (cc || '(none - CC_RECIPIENT is missing from 1_Sender.gs)'));
  lines.push('  Name     : Real Estate Admin');
  lines.push('');

  lines.push('=== THIS EXECUTION ===');
  lines.push('  Running as : ' + (identity.effectiveUser || '(could not be identified)'));
  lines.push('  Aliases    : ' + (identity.aliases.join(', ') || '(none)'));
  lines.push('  Verdict    : ' + (identity.canSendAsAlias
    ? 'OK - can send as ' + FROM_ALIAS
    : 'BLOCKED - cannot send as ' + FROM_ALIAS + ', so every send is refused'));
  if (identity.error) lines.push('  Problem    : ' + identity.error);
  lines.push('');

  lines.push('=== WHAT THIS DOES NOT PROVE ===');
  lines.push('  You ran this by hand, so it describes a MANUAL send.');
  lines.push('  The automatic sends run under whichever account installed the');
  lines.push('  trigger, and that can be a different one - the Triggers page only');
  lines.push('  ever shows you your own.');
  lines.push('');
  lines.push('  To see the account behind the automatic runs: open the Central Log,');
  lines.push('  tab "' + LOG_CONFIG.SHEET_NAME + '", and read the Note column after a cycle.');
  lines.push('  It says "ran as: ..." on every row.');

  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

/**
 * Sends the email. Returns the sent message plus the list of attachments that
 * could not be loaded, so the caller can record a warning without losing the send.
 */
function sendAutomatedReachOutMessage_(recipient, subject, htmlBody, context, isInternalTest) {
  const options = { htmlBody: htmlBody, replyTo: FROM_ALIAS, name: 'Real Estate Admin' };
  options.from = FROM_ALIAS;
  // Central Ops is copied on every real send, whatever the template. Guarded on
  // purpose: a copy is a nice-to-have and must never be able to block an email.
  if (!isInternalTest) {
    const cc = (typeof CC_RECIPIENT === 'string') ? CC_RECIPIENT.trim() : '';
    if (cc) options.cc = cc;
  }
  const pack = attachmentsForContext_(context);
  if (context.templateType === 'PRIVATE_OWNER') {
    // A Private Owner email without its documents must not go out.
    if (!pack.attachments.length) {
      throw new Error('No Private Owner attachment could be loaded from the Drive folder. ' +
        (pack.missing.length ? pack.missing.join(' ') : ''));
    }
    options.attachments = pack.attachments;
  }
  // WHO IS SENDING. Checked before anything leaves.
  //
  // An email to an external property owner must come from readmin-ondemand@.
  // If this project is authorised under an account that cannot send as that
  // address, refusing is the only correct answer: the booking stays in the
  // queue, the error is logged, and nothing reaches the owner under the wrong
  // identity. Re-authorise the project as readmin-ondemand@, or add the alias
  // to whichever account runs it, and the queued rows go out on the next cycle.
  const identity = senderIdentity_();
  if (!identity.canSendAsAlias) {
    throw new Error('Refusing to send: this project is running as "' +
      (identity.effectiveUser || 'an account that could not be identified') +
      '", which cannot send as ' + FROM_ALIAS + '. Aliases available to it: ' +
      (identity.aliases.join(', ') || 'none') + '. Nothing was sent. Run diagnoseAccess().' +
      (identity.error ? ' Identity check reported: ' + identity.error : ''));
  }

  // THE ALIAS RETRY.
  //
  // Gmail intermittently rejects the explicit from with
  //   "Exception: Invalid argument: operations-queue@example.com"
  // even though the alias is configured. It happened twice in the Sender
  // Tracker - USA-4056A on 2026-09-10 and USA-4061A on 2026-09-11 - and each
  // time the very next cycle sent the same email without complaint.
  //
  // NARROWED ON 2026-09-17, after it did real damage. The first version dropped
  // "from" on any failure, on the assumption that the project always runs as
  // readmin-ondemand@. It does not necessarily: authorise it under another
  // account and dropping "from" sends from THAT account instead. An intro email
  // went to an owner from operations@example.com, and because the
  // retry succeeded nothing failed loudly enough to notice.
  //
  // So the retry now only runs when the executing account IS the alias, which
  // is the one case where removing "from" cannot change the visible sender.
  // Otherwise the original error is re-thrown and the row stays in the queue.
  let message;
  let aliasFallback = '';
  try {
    message = GmailApp.createDraft(recipient, subject, '', options).send();
  } catch (error) {
    if (!options.from || !identity.isAliasAccount) throw error;
    Logger.log('Gmail rejected the "from" alias; retrying without it, which is safe ' +
      'because this execution already runs as ' + FROM_ALIAS + ': ' + error);
    delete options.from;
    message = GmailApp.createDraft(recipient, subject, '', options).send();
    aliasFallback = String(error);
  }
  return {
    message: message,
    missingAttachments: pack.missing,
    attachmentNames: pack.names,
    aliasFallback: aliasFallback
  };
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

/**
 * Emoji put on a booking notification the automation deliberately skipped
 * because the PO is a DEPARTMENT_X unit. The workspace has :coreunit:, :department X-unit: and
 * :department X-unit-1:; this is the one the team already uses by hand.
 */
const DEPARTMENT_X_UNIT_EMOJI = 'coreunit';

/**
 * Adds an emoji reaction to a channel message. Never throws: a reaction is a
 * courtesy and must not be able to break the capture run.
 *
 * Needs the reactions:write scope on SLACK_BOT_TOKEN. Everything else here only
 * reads, so the scope is probably not granted yet - the return string says so
 * in plain language and lands in the warning, rather than failing silently.
 */
function addSlackReaction_(messageTs, emojiName) {
  const timestamp = normalizeSlackTs_(messageTs);
  if (!timestamp) return 'skipped, no message timestamp';
  try {
    const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
    const response = UrlFetchApp.fetch('https://slack.com/api/reactions.add', {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        channel: SLACK.CHANNEL_ID,
        timestamp: timestamp,
        name: String(emojiName || '').replace(/:/g, '')
      }),
      muteHttpExceptions: true
    });
    const payload = JSON.parse(response.getContentText() || '{}');
    if (payload.ok) return 'added';
    if (payload.error === 'already_reacted') return 'already there';
    if (payload.error === 'missing_scope') {
      return 'NOT added - the Slack app needs the reactions:write scope';
    }
    return 'NOT added - Slack said "' + payload.error + '"';
  } catch (error) {
    return 'NOT added - ' + error;
  }
}

/** Puts :coreunit: on the last DEPARTMENT_X bookings by hand, to check the scope. */
function testCoreUnitReaction() {
  const token = getScriptProperty_('SLACK_BOT_TOKEN', true);
  const response = UrlFetchApp.fetch(
    'https://slack.com/api/conversations.history?channel=' + encodeURIComponent(SLACK.CHANNEL_ID) + '&limit=100',
    { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  const payload = JSON.parse(response.getContentText());
  if (!payload.ok) throw new Error('conversations.history: ' + payload.error);

  const lines = [];
  (payload.messages || []).forEach(function(message) {
    const booking = parseBooking_(extractSlackText_(message), message.ts);
    if (!booking || !booking.po || /A$/i.test(booking.po)) return;
    lines.push(booking.po + ' / ' + booking.bookingCode + ' -> ' +
      addSlackReaction_(message.ts, DEPARTMENT_X_UNIT_EMOJI));
  });
  const text = lines.length
    ? 'DEPARTMENT_X bookings found in the last 100 messages:\n' + lines.join('\n')
    : 'No DEPARTMENT_X booking (PO not ending in A) in the last 100 messages.';
  Logger.log(text);
  return text;
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

/**
 * Emoji that opens the Slack thread reply on a real send.
 * :bird: is the standard blue bird. To use a workspace emoji instead, the ones
 * available are :example-company:, :example-company-icon:, :example-company-logo:,
 * :example-company_logo_slack: and :theexample-company:.
 */
const THREAD_REPLY_EMOJI = ':bird:';

/**
 * Text posted back into the original booking thread.
 *
 * siblings, when given, are the OTHER bookings that went out inside the same
 * email. Every thread still gets its own reply - the team reads one thread at a
 * time - but each one says that a single email covered the whole set, so nobody
 * goes looking for an email that was never sent separately.
 */
function buildBookingThreadReply_(item, admin, isTest, siblings) {
  const bookingCode = String(item['Record Code'] || '').trim();
  const po = String(item['Reference Code'] || '').trim();
  const prefix = isTest ? ':test_tube: *TEST* - ' : '';
  let text = prefix + 'The Automated Reach-Out intro email for booking *' + bookingCode + '* / PO *' + po + '* was ' +
    (isTest
      ? 'not sent; this message only tests the threaded-reply integration.'
      : 'sent automatically! ' + THREAD_REPLY_EMOJI);

  const others = (siblings || []).filter(function(entry) {
    return String(entry.po || '').trim() && String(entry.po).trim() !== po;
  });
  if (others.length) {
    text += '\n\n:package: *Bulk send* - one email covered ' + (others.length + 1) +
      ' bookings at this address, with a separate fee table for each unit:\n' +
      [{ po: po, bookingCode: bookingCode, unit: String(item['Unit No'] || '').trim() }]
        .concat(others)
        .map(function(entry) {
          const unit = unitNumberText_(entry.unit);
          return '  • *' + entry.po + '* / ' + (entry.bookingCode || 'no booking code') +
            (unit ? ' - unit #' + unit : '');
        }).join('\n');
  }

  if (isTest) {
    text += '\n<@YOUR_MAINTAINER_SLACK_ID>, please confirm that this test reply appeared inside the original booking thread.';
  } else if (admin && admin.slackId) {
    text += '\n\n<@' + admin.slackId + '>, please review it and follow-up as needed.';
  } else {
    text += '\n\nThe responsible Operations Team could not be identified automatically; please review.';
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

/**
 * Posts text into the original booking thread and returns the timestamp used.
 *
 * Split out of replyToOriginalBookingThread_ on 2026-09-21 so the COD notice
 * can reuse it. The value here is the recovery: a timestamp that round-tripped
 * through a spreadsheet cell can lose its last digit, and this is where the
 * original message gets looked up again instead of the reply being lost.
 */
function postToBookingThread_(item, text) {
  const stored = normalizeSlackTs_(item['Slack Thread TS']);
  if (stored) {
    try {
      bookingThreadWebhookPost_(stored, text);
      return stored;
    } catch (error) {
      // Anything other than invalid_thread_ts is a real failure.
      if (String(error).indexOf('invalid_thread_ts') === -1) throw error;
      Logger.log('Stored thread ts "' + stored + '" was rejected by Slack; looking the message up again.');
    }
  }

  const fresh = findOriginalSlackThreadTs_(item['Record Code'], item['Reference Code']);
  if (!fresh) {
    throw new Error('Could not locate the original Slack notification for booking ' +
      String(item['Record Code'] || '') + ' / PO ' + String(item['Reference Code'] || '') +
      (stored ? '. The stored timestamp "' + stored + '" was rejected by Slack.' : '.'));
  }
  bookingThreadWebhookPost_(fresh, text);
  return fresh;
}

function replyToOriginalBookingThread_(wrapper, isTest, siblings) {
  const item = wrapper.item || {};
  return postToBookingThread_(item,
    buildBookingThreadReply_(item, wrapper.admin, Boolean(isTest), siblings));
}

/** The COD notice, in the booking's own thread. Nothing is sent by email. */
function replyToCodThread_(item, admin, newStart) {
  return postToBookingThread_(item, buildCodThreadReply_(item, admin, newStart));
}

function buildSlackNotification_(wrappers, isTest) {
  const lines = wrappers.map(function(wrapper) {
    const item = wrapper.item;
    const adminTag = wrapper.admin ? '<@' + wrapper.admin.slackId + '>' : '*Operations Team unresolved*';
    return '- ' + adminTag + ' | *' + item['Reference Code'] + '* - ' + (item['Display Name'] || item['Property Name']) +
      (item['Unit No'] ? ' - Unit #' + unitNumberText_(item['Unit No']) : '') +
      (item['Full Address'] ? '\n  ' + item['Full Address'] : '') +
      (item['Record Code'] ? '\n  Booking: ' + item['Record Code'] : '');
  }).join('\n');
  return (isTest ? ':test_tube: *TEST* - ' : '') +
    'Hello Operations Teams, a New Automated Reach-Out email was sent for the following propert' + (wrappers.length === 1 ? 'y' : 'ies') + ':\n' + lines;
}

/* ===== QUEUE MONITOR ===== */

function monitorAutomatedReachOutQueue() {
  const started = new Date();
  if (!PIPELINE.LIVE) {
    Logger.log('monitorAutomatedReachOutQueue skipped because PIPELINE.LIVE is false. Use testFullCircuit for testing.');
    return;
  }

  try {
    const outcome = withDocumentLock_(function() { monitorAutomatedReachOutQueueInternal_(started); }, true);
    if (outcome === PIPELINE_LOCK_BUSY) {
      // Another run of the pipeline is already working. Nothing is lost: the
      // queue rows stay put and the next cycle picks them up.
      logSender_('monitorAutomatedReachOutQueue', started, 'OK',
        'Skipped: another pipeline run was already in progress. Nothing was lost; the queue is retried next cycle.');
      return;
    }
  } catch (error) {
    reportSystemWarning_('QUEUE_MONITOR', 'Queue monitoring failed', error);
    logSender_('monitorAutomatedReachOutQueue', started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

function monitorAutomatedReachOutQueueInternal_(started) {
  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  const queue = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
  if (!queue || queue.getLastRow() < 2) return;

  const tracker = ensureTracker_(spreadsheet);
  const finalizedKeys = loadFinalizedTrackerKeys_(tracker);
  const mbIndex = loadMbIndex_();
  const propertyMap = loadPropertyMap_();

  /**
   * The Gmail search behind loadRecentSentAutomatedReachOutMessages_ reads up to 500
   * threads and opens every message in them, which makes it the most expensive
   * call in the cycle. It used to run unconditionally, including on the cycles
   * where every queue row was stopped, already tracked or expired and nothing
   * could possibly be sent.
   *
   * It is built on first use instead. Deliberately NOT cached across
   * executions: this is the guard that stops the automation from sending a
   * second copy of an email an admin has just sent by hand, and a stale answer
   * would reopen exactly the duplicate it exists to prevent.
   */
  let sentMessagesCache = null;
  function recentSentMessages_() {
    if (sentMessagesCache === null) sentMessagesCache = loadRecentSentAutomatedReachOutMessages_();
    return sentMessagesCache;
  }

  const queueHeaders = ensureHeaders_(queue, SLACK_HEADERS);
  const queueMap = headerMap_(queueHeaders);
  const range = queue.getRange(2, 1, queue.getLastRow() - 1, queueHeaders.length);
  const rows = range.getValues();
  const rowsToDelete = [];
  const candidates = [];
  const manualTrackerRows = [];
  const warnings = [];
  const stoppedPos = [];
  const expiredPos = [];
  const codPos = [];
  const codWaitingPos = [];
  let enrichedCount = 0;

  // Buildings that still have a queue row waiting for something. A candidate
  // that is ready at one of these addresses waits too, so the two go out in one
  // email instead of two minutes apart. Only recoverable waits count: a row on
  // Stop Sent?, or one already finalized, must never hold a sibling back.
  const pendingAddressKeys = {};
  function markAddressPending(source) {
    const key = bulkAddressKey_(source);
    if (key) pendingAddressKeys[key] = true;
  }

  rows.forEach(function(row, index) {
    const sheetRow = index + 2;
    const queueObject = rowObject_(row, queueMap);
    const po = String(queueObject['Reference Code'] || '').trim();
    if (!po) return;

    // Manual hold. Checked before anything else so a stopped booking costs
    // nothing and never touches Gmail, BI platform or the templates.
    if (isSendStopped_(queueObject)) {
      stoppedPos.push(po);
      warnings.push(warningEntry_('QUEUE_MONITOR', queueObject, 'WARNING',
        'Send blocked manually (Stop Sent? = YES)',
        'Someone set Stop Sent? to YES on the queue row for this booking, so no email was sent. ' +
        'The row stays in the queue: set it back to NO to release the send on the next cycle.'));
      return;
    }

    if (isAlreadyFinalized_(queueObject, finalizedKeys)) {
      warnings.push(warningEntry_('QUEUE_MONITOR', queueObject, 'INFO',
        'Already recorded in Delivery History',
        'A successful non-test tracker record already exists. The queue row was removed without sending another email.'));
      rowsToDelete.push(sheetRow);
      return;
    }

    // A FIXED WINDOW PER NOTIFICATION, THEN GIVE UP.
    //
    // Checked here, before the Gmail search and before any matching, so a dead
    // row costs almost nothing. Slack Not Date is written when the booking is
    // captured and never depends on BI platform, which is the point: the rows that
    // get stuck are precisely the ones whose BI platform data never arrives, and a
    // give-up rule that reads a BI platform field would never fire on them.
    const expireAfterHours = expireWindowHoursFor_(queueObject);
    const notificationAgeHours = hoursSinceNotification_(queueObject);
    if (expireAfterHours > 0 && notificationAgeHours !== null && notificationAgeHours >= expireAfterHours) {
      const expiredProperty = propertyMap[po.toUpperCase()] || {};
      const expiredItem = Object.assign({}, queueObject, {
        'Display Name': queueObject['Property Name'] || expiredProperty.buildingName || po,
        'Full Address': queueObject['Full Address'] || expiredProperty.fullAddress || '',
        'State': stateNameToCode_(expiredProperty.state) || queueObject.State ||
          stateFromAddress_(queueObject['Full Address'])
      });
      manualTrackerRows.push(trackerRow_(new Date(), expiredItem, null, '', 'SKIPPED', 'EXPIRED',
        'Notified ' + notificationAgeHours + 'h ago and never sent. Dropped from the queue by the ' +
        expireAfterHours + '-hour give-up rule.'));
      warnings.push(warningEntry_('QUEUE_MONITOR', expiredItem, 'WARNING',
        'Booking dropped: the notification is older than the give-up window',
        'The Slack notification landed ' + notificationAgeHours + ' hours ago and the email never ' +
        'went out, so the row was removed from the queue and recorded in Delivery History as ' +
        'EXPIRED. The limit is ' + expireAfterHours + ' hours. If this booking does ' +
        'still need an intro email, send it manually. Common causes: BI platform never produced the ' +
        'lease terms, CRM never got a quote, the booking was cancelled, or it is a ' +
        'transfer from another unit.'));
      const expiredKey = bookingIdentityKey_(queueObject['Record Code'], po);
      if (expiredKey) finalizedKeys[expiredKey] = true;
      expiredPos.push(po);
      rowsToDelete.push(sheetRow);
      return;
    }

    const manualSent = findManualSentForPo_(po, recentSentMessages_());
    if (manualSent) {
      const property = propertyMap[po.toUpperCase()] || {};
      const manualMatch = findMbMatch_(queueObject, mbIndex);
      const manualItem = manualMatch
        ? buildEmailObject_(queueObject, manualMatch.row, mbIndex.headerMap, propertyMap)
        : Object.assign({}, queueObject, {
            'Property Name': queueObject['Property Name'] || property.buildingName || po,
            'Display Name': resolveDisplayName_(po, queueObject['Property Name'] || po, property.buildingName),
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
        'Automated Reach-Out email was already sent manually',
        'Matched sent email subject: "' + manualSent.subject + '". Automation did not send a duplicate; the queue row was moved to Delivery History.'));
      const manualKey = bookingIdentityKey_(queueObject['Record Code'], po);
      if (manualKey) finalizedKeys[manualKey] = true;
      rowsToDelete.push(sheetRow);
      return;
    }

    // THE COD CHECK.
    //
    // Placed AFTER the manual-send check on purpose. Telling an admin "the
    // intro email was not sent, please send it manually" when they already sent
    // it by hand would produce a duplicate, so the Gmail evidence gets to speak
    // first. It costs nothing extra: that index is built for any row that is
    // not stopped, finalized or expired anyway.
    //
    // Placed BEFORE the COD window so a COD logged at minute 3 stops the email
    // at minute 3, and before the Source Data match so a blocked booking never
    // needs a quote, fees or a template.
    const codIndex = loadCodIndex_();
    if (codIndex.error) {
      warnings.push(warningEntry_('COD_CHECK', queueObject, 'ERROR',
        'The COD list could not be read',
        codIndex.error + (COD_SOURCE.BLOCK_WHEN_UNREADABLE
          ? ' COD_SOURCE.BLOCK_WHEN_UNREADABLE is true, so nothing is sent until the list can be read again.'
          : ' The booking was NOT blocked: a list the automation cannot open must not stop every intro ' +
            'email in the queue. Set COD_SOURCE.BLOCK_WHEN_UNREADABLE to true to reverse that.')));
      if (COD_SOURCE.BLOCK_WHEN_UNREADABLE) {
        markAddressPending(queueObject);
        return;
      }
    }

    const codHit = codIndex.error ? null : codIndex.map[poKey_(po)];
    if (codHit) {
      const codProperty = propertyMap[po.toUpperCase()] || {};
      const codItem = Object.assign({}, queueObject, {
        'Display Name': queueObject['Property Name'] || codProperty.buildingName || po,
        'Full Address': queueObject['Full Address'] || codProperty.fullAddress || '',
        'State': stateNameToCode_(codProperty.state) || queueObject.State ||
          stateFromAddress_(queueObject['Full Address'])
      });
      const codAdmin = resolveAdmin_(po, propertyMap, codItem['Full Address'], codItem.State);
      const codDate = codDateText_(codHit.newStart);

      // The thread reply is the whole point of the rule - it is how the admin
      // finds out - but it must not be able to block the decision. If Slack
      // refuses, the booking is still recorded and the failure is logged loudly
      // rather than the email going out by accident.
      let replyNote = '';
      try {
        replyToCodThread_(codItem, codAdmin, codHit.newStart);
        replyNote = 'The Operations Team was tagged in the booking thread.';
      } catch (error) {
        replyNote = 'THE SLACK THREAD REPLY FAILED (' + error + ') - nobody was tagged, tell the Operations Team by hand.';
        logSender_('COD thread reply', started, 'REVIEW', po + ': ' + error);
      }

      manualTrackerRows.push(trackerRow_(new Date(), codItem, null, '', 'SKIPPED', 'COD',
        'On the COD list; new client start date ' + (codDate || '(not recorded)') +
        '. No email was sent. ' + replyNote));
      warnings.push(warningEntry_('COD_CHECK', codItem, 'WARNING',
        'Booking has a COD - no intro email was sent',
        'This PO is on the COD tab of "Department Y Case Workflow Results"' +
        (codDate ? ', with a new client start date of ' + codDate : ', with no new start date recorded yet') +
        '. The intro email quotes the lease term, so it was not sent and the booking was recorded ' +
        'in Delivery History as COD. ' + replyNote + ' The Operations Team reviews it and sends the email by hand.'));

      const codKey = bookingIdentityKey_(queueObject['Record Code'], po);
      if (codKey) finalizedKeys[codKey] = true;
      codPos.push(po);
      rowsToDelete.push(sheetRow);
      return;
    }

    // THE COD WINDOW. Nothing leaves before PIPELINE.COD_WINDOW_MINUTES have
    // passed since the notification, which is the time the team has to log a
    // COD. The row simply stays in the queue and is looked at again next cycle.
    //
    // A booking whose Slack Not Date cannot be read is NOT held. The same
    // choice the bulk hold makes: send rather than hold something forever on a
    // missing timestamp.
    const codWindowMinutes = Number(PIPELINE.COD_WINDOW_MINUTES || 0);
    const notifiedAtMs = bulkNotifiedAtMs_(queueObject);
    if (codWindowMinutes > 0 && notifiedAtMs > 0) {
      const waitedMinutes = Math.floor((Date.now() - notifiedAtMs) / 60000);
      if (waitedMinutes < codWindowMinutes) {
        markAddressPending(queueObject);
        codWaitingPos.push(po);
        warnings.push(warningEntry_('COD_WINDOW', queueObject, 'INFO',
          'Waiting out the COD window',
          'Notified ' + waitedMinutes + ' minute(s) ago; the email may go out after ' +
          codWindowMinutes + '. The COD list is re-read every cycle during the wait, so a COD ' +
          'logged in the meantime still stops it. The row stays in the queue.'));
        return;
      }
    }

    const match = findMbMatch_(queueObject, mbIndex);
    if (!match) {
      markAddressPending(queueObject);
      warnings.push(warningEntry_('QUEUE_MONITOR', queueObject, 'WARNING',
        'No unique Source Data match', describeMbMiss_(queueObject, mbIndex)));
      return;
    }
    const item = buildEmailObject_(queueObject, match.row, mbIndex.headerMap, propertyMap);
    rows[index] = updateQueueRow_(row, queueMap, item);
    enrichedCount++;
    const missing = missingEmailData_(item);
    if (missing.length) {
      markAddressPending(item);
      warnings.push(warningEntry_('QUEUE_MONITOR', item, 'ERROR',
        'No usable Email Contact',
        'Source Data matched by ' + match.method + ', but neither Source Data nor any fallback source ' +
        '(Frontdesk Emails, BG DEPARTMENT_Y, Relo/APP) returned a valid address for this PO. The row remains in the queue.'));
      return;
    }

    // Hold the email until BI platform itself has the lease terms. Sending with a
    // figure taken from the Slack booking put wrong values in front of an owner.
    const mbMissing = String(item['MB Missing Fields'] || '').trim();
    if (PIPELINE.REQUIRE_MB_FINANCIALS && mbMissing) {
      markAddressPending(item);
      warnings.push(warningEntry_('QUEUE_MONITOR', item, 'WARNING',
        'Waiting for BI platform lease terms',
        'Source Data matched by ' + match.method + ', but ' + mbMissing + ' is still blank there. ' +
        'The email was NOT sent, so no value from the Slack booking reaches the owner. ' +
        'The row stays in the queue and is retried every cycle.'));
      return;
    }

    // BI platform has been seen alternating between two different records for the
    // same PO. Quote nothing until the figures hold still across two imports.
    if (PIPELINE.REQUIRE_MB_STABLE) {
      const drift = mbValueDrift_(po, match.row, mbIndex.headerMap);
      if (drift.length) {
        markAddressPending(item);
        warnings.push(warningEntry_('QUEUE_MONITOR', item, 'ERROR',
          'Source Data values are not stable yet',
          'These fields changed between the last two BI platform imports: ' + drift.join(' ; ') +
          '. The email was NOT sent, because there is no way to tell which version is correct. ' +
          'If this keeps repeating for the same PO, the BI platform question is returning two ' +
          'different records for it and the data team needs to look at it.'));
        return;
      }
    }

    const context = contextForItem_(item, propertyMap);
    const admin = resolveAdmin_(po, propertyMap, item['Full Address'], item.State);
    if (!admin) {
      warnings.push(warningEntry_('QUEUE_MONITOR', item, 'WARNING',
        'Operations Team could not be resolved',
        'The email is still eligible to send, but no admin label or Slack user could be assigned from State/Address.'));
    }
    candidates.push({ sheetRow: sheetRow, item: item, context: context, admin: admin, matchMethod: match.method });
  });

  if (enrichedCount) range.setValues(rows);
  appendTrackerRows_(tracker, manualTrackerRows);

  // Bulk grouping decided before anything is sent: which ready bookings go out
  // now, and which wait a few minutes for a sibling at the same address.
  const split = partitionBulkHolds_(candidates, pendingAddressKeys, Date.now());
  split.held.forEach(function(hold) {
    const pos = hold.candidates.map(function(candidate) { return candidate.item['Reference Code']; }).join(', ');
    hold.candidates.forEach(function(candidate) {
      warnings.push(warningEntry_('BULK_HOLD', candidate.item, 'INFO',
        'Held briefly to be sent as one bulk email',
        'Held because ' + hold.reason + '. Waiting with: ' + pos + '. ' +
        'Quiet for ' + hold.minutesQuiet + ' min of ' + PIPELINE.BULK.QUIET_MINUTES + ', ' +
        'held for ' + hold.minutesHeld + ' min of ' + PIPELINE.BULK.MAX_HOLD_MINUTES + ' max. ' +
        'The rows stay in the queue and go out together on a later cycle.'));
    });
  });
  upsertWarnings_(warnings);

  const successfulRows = sendAutomationCandidates_(split.send, tracker, started);
  successfulRows.forEach(function(row) { rowsToDelete.push(row); });
  const removed = uniqueValues_(rowsToDelete.map(String)).map(Number);
  deleteSheetRows_(queue, removed);

  if (stoppedPos.length) {
    logSender_('Stop Sent block', started, 'REVIEW',
      stoppedPos.length + ' booking(s) held back by Stop Sent? = YES: ' + uniqueValues_(stoppedPos).join(', ') +
      '. No email was sent for these; set the cell back to NO to release them.');
  }

  const heldCount = split.held.reduce(function(total, hold) { return total + hold.candidates.length; }, 0);
  const pending = Math.max(0, rows.length - removed.length);
  if (expiredPos.length) {
    logSender_('Expired bookings', started, 'REVIEW',
      expiredPos.length + ' booking(s) dropped for being past their give-up window (' +
      PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS + 'h, ' +
      PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS_BY_WEEKDAY.FRI + 'h when notified on a Friday): ' +
      uniqueValues_(expiredPos).join(', ') +
      '. No email was sent; each one is in Delivery History with Status EXPIRED.');
  }

  if (codPos.length) {
    logSender_('COD blocked', started, 'REVIEW',
      codPos.length + ' booking(s) blocked by the COD list: ' + uniqueValues_(codPos).join(', ') +
      '. No email was sent; each one is in Delivery History with Status COD and the Operations Team was ' +
      'tagged in the booking thread to send it manually.');
  }

  logSender_('monitorAutomatedReachOutQueue', started, pending ? 'REVIEW' : 'OK',
    (manualTrackerRows.length - expiredPos.length - codPos.length) + ' manual send(s), ' +
    successfulRows.length + ' automated row(s), ' +
    heldCount + ' held for bulk, ' +
    codWaitingPos.length + ' inside the ' + PIPELINE.COD_WINDOW_MINUTES + '-min COD window, ' +
    codPos.length + ' blocked by a COD, ' +
    stoppedPos.length + ' blocked by Stop Sent?, ' +
    expiredPos.length + ' expired, ' + pending + ' pending row(s).');
}

/* ===== BULK SEND ===== */

/**
 * Building key for an item: house number + postcode, falling back to house
 * number + state, then to the normalized address text. Same key means the same
 * building, so "50 Saw Mill Road, Danbury, CT 06810, USA #12-220" and the same
 * address with "#9-322" both land on "50|06810".
 */
function bulkAddressKey_(item) {
  const address = String(item['Full Address'] || '').trim();
  if (!address) return '';
  let key = typeof addressKeyFromText_ === 'function' ? addressKeyFromText_(address) : '';
  if (!key && typeof addressFallbackKeyFromText_ === 'function') {
    key = addressFallbackKeyFromText_(address, item['State']);
  }
  return key || normalizeLookupText_(address);
}

/**
 * Everything that has to match for two bookings to share one email: the
 * recipient, the template, the PARTNER branding and - unless GROUP_BY_ADDRESS is
 * turned off - the building. Address is part of the key because a leasing
 * inbox can cover several unrelated properties, and merging those would put
 * two buildings under one subject line.
 */
function bulkGroupKey_(candidate) {
  const email = String(candidate.item['Email Contact'] || '').trim().toLowerCase();
  const contextKey = candidate.context.templateType + '|' + normalizeLookupText_(candidate.context.partnerCompanyName);
  const addressKey = PIPELINE.BULK.GROUP_BY_ADDRESS ? bulkAddressKey_(candidate.item) : '';
  return email + '|' + contextKey + '|' + addressKey;
}

/** True when the quote behind this booking was written for a whole building. */
function isMultiUnitQuote_(item) {
  const quoteUnit = String(item['Quote Unit'] || '').trim();
  if (!quoteUnit) return false;
  const normalized = typeof normalizeUnitToken_ === 'function'
    ? normalizeUnitToken_(quoteUnit)
    : quoteUnit.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalized === 'MULTI';
}

function bulkNotifiedAtMs_(item) {
  const value = item['Slack Not Date'];
  if (value instanceof Date) return value.getTime();
  const parsed = value ? new Date(value) : null;
  return parsed && !isNaN(parsed.getTime()) ? parsed.getTime() : 0;
}

/**
 * Decides which ready candidates go out now and which wait for a sibling.
 *
 * A booking is only ever held when there is a concrete reason to expect
 * another one at the same address:
 *
 *   - the quote is written MULTI, so by definition it covers several units and
 *     several bookings will land against it (4.3% of accepted quotes over the
 *     last 60 days, measured 2026-09-11 - holding these costs almost nothing);
 *   - another queue row at the same building is still waiting for its data, so
 *     it would otherwise be sent minutes later in its own email;
 *   - it already has a ready sibling in this same cycle, in which case the wait
 *     simply gives a third one a chance to join.
 *
 * A lone booking with none of the above is sent immediately, exactly as before.
 *
 * Releases on the FIRST of: quiet for QUIET_MINUTES since the newest sibling,
 * or MAX_HOLD_MINUTES since the oldest. The ceiling matters - without it a
 * neighbour stuck without data would hold a good email forever.
 */
function partitionBulkHolds_(candidates, pendingAddressKeys, nowMs) {
  const result = { send: [], held: [] };
  if (!PIPELINE.BULK || !PIPELINE.BULK.ENABLED) {
    result.send = candidates;
    return result;
  }

  const groups = {};
  candidates.forEach(function(candidate) {
    const key = bulkGroupKey_(candidate);
    if (!groups[key]) groups[key] = [];
    groups[key].push(candidate);
  });

  const quietMs = PIPELINE.BULK.QUIET_MINUTES * 60000;
  const maxHoldMs = PIPELINE.BULK.MAX_HOLD_MINUTES * 60000;

  Object.keys(groups).forEach(function(key) {
    const group = groups[key];
    const addressKey = bulkAddressKey_(group[0].item);
    const neighbourWaiting = Boolean(addressKey && pendingAddressKeys[addressKey]);
    const multiQuote = group.some(isMultiUnitQuote_);

    if (group.length === 1 && !neighbourWaiting && !multiQuote) {
      result.send.push(group[0]);
      return;
    }

    const stamps = group.map(function(candidate) { return bulkNotifiedAtMs_(candidate.item); })
      .filter(function(stamp) { return stamp > 0; });
    // No usable timestamp means no way to time the wait. Send rather than hold
    // something forever on a missing value.
    if (!stamps.length) {
      group.forEach(function(candidate) { result.send.push(candidate); });
      return;
    }

    const quietFor = nowMs - Math.max.apply(null, stamps);
    const heldFor = nowMs - Math.min.apply(null, stamps);
    if (quietFor >= quietMs || heldFor >= maxHoldMs) {
      group.forEach(function(candidate) { result.send.push(candidate); });
      return;
    }

    result.held.push({
      candidates: group,
      reason: multiQuote
        ? 'the quote is written MULTI, so more bookings are expected against it'
        : (neighbourWaiting
            ? 'another booking at this address is still waiting for its data'
            : 'another booking at this address is ready in the same cycle'),
      minutesQuiet: Math.floor(quietFor / 60000),
      minutesHeld: Math.floor(heldFor / 60000)
    });
  });

  return result;
}

function sendAutomationCandidates_(candidates, tracker, started) {
  if (!candidates.length) return [];
  const groups = {};
  candidates.forEach(function(candidate) {
    const key = bulkGroupKey_(candidate);
    if (!groups[key]) {
      groups[key] = {
        email: String(candidate.item['Email Contact'] || '').trim().toLowerCase(),
        context: candidate.context,
        wrappers: []
      };
    }
    groups[key].wrappers.push(candidate);
  });

  const completedRows = [];
  Object.keys(groups).forEach(function(key) {
    const group = groups[key];
    const first = group.wrappers[0].item;
    const displayName = String(first['Display Name'] || first['Property Name'] || '').trim();
    const poList = uniqueValues_(group.wrappers.map(function(wrapper) { return wrapper.item['Reference Code']; })).join(', ');

    // The address only goes in the subject when every PO in the email really
    // shares it. Bulk sends normally do - same building, different units - but
    // if GROUP_BY_ADDRESS is ever turned off, naming one of several addresses
    // would be worse than naming none.
    const addressKeys = uniqueValues_(group.wrappers.map(function(wrapper) {
      return bulkAddressKey_(wrapper.item);
    }).filter(Boolean));
    const sharedAddress = addressKeys.length === 1 ? first['Full Address'] : '';
    const unitList = uniqueValues_(group.wrappers.map(function(wrapper) {
      return unitNumberText_(wrapper.item['Unit No']);
    }).filter(Boolean)).join(', ');

    const subject = buildAutomatedReachOutSubject_(displayName, poList, group.context, '', sharedAddress, unitList);
    const emailData = emailRows_(group.wrappers);
    const htmlBody = buildHtmlBody(
      group.context.templateType,
      emailData.items[0].rowValues,
      emailData.items,
      emailData.headerMap,
      displayName,
      group.context
    );

    let sendResult;
    try {
      sendResult = sendAutomatedReachOutMessage_(group.email, subject, htmlBody, group.context);
    } catch (error) {
      try {
        appendTrackerRows_(tracker, [trackerRow_(new Date(), first, group.context, group.email, 'LIVE', 'ERROR', String(error))]);
      } catch (trackerError) {}
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('EMAIL_SEND', wrapper.item, 'ERROR',
          'Email send failed', 'Recipient: ' + group.email + '. Error: ' + error);
      }));
      logSender_('Automation send', started, 'ERROR', 'To ' + group.email + ' | POs: ' + poList + ' | ' + error);
      return;
    }

    // From this point onward, the email was sent. The queue rows must be completed
    // even if a secondary action (tracker, label, control sheet or Slack) fails.
    group.wrappers.forEach(function(wrapper) { completedRows.push(wrapper.sheetRow); });
    const now = new Date();

    if (sendResult.aliasFallback) {
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('EMAIL_SEND', wrapper.item, 'WARNING',
          'Gmail rejected the sending alias; the email went out without it',
          'The email WAS sent and the sending account is ' + FROM_ALIAS + ' either way, so the ' +
          'recipient sees no difference. Reported because a repeat suggests the alias needs ' +
          'attention in Gmail settings. Original error: ' + sendResult.aliasFallback);
      }));
    }

    if (sendResult.missingAttachments && sendResult.missingAttachments.length) {
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('EMAIL_ATTACHMENT', wrapper.item, 'WARNING',
          'Email sent without an expected attachment',
          'Attached: ' + (sendResult.attachmentNames || []).join(', ') +
          '. Problem: ' + sendResult.missingAttachments.join(' ') +
          ' Run testAttachments() to inspect the Drive folder.');
      }));
    }

    try {
      appendTrackerRows_(tracker, group.wrappers.map(function(wrapper) {
        const source = wrapper.item['Email Source'] || 'Source Data';
        // Record which Source Data row was used and its key figures, so a later
        // dispute can be checked without guessing what the tab held at the time.
        return trackerRow_(now, wrapper.item, wrapper.context, group.email, 'LIVE', 'OK',
          'Automation sent' +
          (group.wrappers.length > 1 ? ' | BULK of ' + group.wrappers.length + ': ' + poList : '') +
          ' | email from: ' + source +
          ' | MB match: ' + (wrapper.matchMethod || 'unknown') +
          ' | rent ' + (wrapper.item['Monthly Rent'] === '' || wrapper.item['Monthly Rent'] == null
            ? 'blank' : wrapper.item['Monthly Rent']) +
          ' | SD ' + (wrapper.item['Security Deposit'] === '' || wrapper.item['Security Deposit'] == null
            ? 'blank' : wrapper.item['Security Deposit']));
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
      labels = applyAdminLabels_(sendResult.message.getThread(), admins);
    } catch (error) {
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('GMAIL_LABEL', wrapper.item, 'WARNING',
          'Email sent but Gmail label failed', String(error));
      }));
      logSender_('Gmail label', started, 'REVIEW', 'Email sent, but Gmail label failed: ' + error);
    }

    try {
      recordAutomationIntroEmails_(group.wrappers.map(function(wrapper) {
        return { po: wrapper.item['Reference Code'], admin: wrapper.admin, sentAt: now };
      }));
    } catch (error) {
      upsertWarnings_(group.wrappers.map(function(wrapper) {
        return warningEntry_('INTRO_EMAIL_CONTROL', wrapper.item, 'WARNING',
          'Email sent but external Intake Email control update failed', String(error));
      }));
      logSender_('Intake Email control', started, 'REVIEW', 'Email sent, but the external PO control update failed: ' + error);
    }

    // Every booking keeps its own thread reply - the team reads one thread at
    // a time - but on a bulk send each reply also lists the whole set, so
    // nobody hunts for an email that was never sent on its own.
    const everyone = group.wrappers.map(function(wrapper) {
      return {
        po: String(wrapper.item['Reference Code'] || '').trim(),
        bookingCode: String(wrapper.item['Record Code'] || '').trim(),
        unit: String(wrapper.item['Unit No'] || '').trim()
      };
    });
    group.wrappers.forEach(function(wrapper) {
      try {
        replyToOriginalBookingThread_(wrapper, false, group.wrappers.length > 1 ? everyone : null);
      } catch (error) {
        upsertWarnings_([warningEntry_('BOOKING_THREAD_REPLY', wrapper.item, 'WARNING',
          'Email sent but the original Slack thread reply failed', String(error))]);
        logSender_('Slack booking thread reply', started, 'REVIEW',
          'Email sent for ' + wrapper.item['Record Code'] + ', but the thread reply failed: ' + error);
      }
    });

    logSender_('Automation send', started, 'OK', 'To ' + group.email +
      (group.wrappers.length > 1 ? ' | BULK of ' + group.wrappers.length : '') +
      ' | POs: ' + poList +
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
          'Test candidate has no usable Email Contact',
          'Source Data matched, but neither Source Data nor the fallback sources returned a valid address.'));
        return false;
      }
      const context = contextForItem_(item, propertyMap);
      const admin = resolveAdmin_(booking.po, propertyMap, item['Full Address'], item.State);
      selected.push({ item: item, context: context, admin: admin, booking: booking });
      return selected.length >= 3;
    });

    upsertWarnings_(testWarnings);

    if (!selected.length) {
      logSender_('testFullCircuit', started, 'REVIEW',
        'No recent Slack booking has both a unique Source Data match and a usable Email Contact yet.');
      return;
    }

    selected.forEach(function(wrapper) {
      const displayName = String(wrapper.item['Display Name'] || wrapper.item['Property Name'] || '').trim();
      const templateLabel = wrapper.context.templateType === 'PRIVATE_OWNER' ? 'Private Owner' : wrapper.context.templateType;
      const subject = buildAutomatedReachOutSubject_(displayName, wrapper.item['Reference Code'], wrapper.context, templateLabel,
          wrapper.item['Full Address'], wrapper.item['Unit No']);
      const emailData = emailRows_([wrapper]);
      const htmlBody = buildHtmlBody(
        wrapper.context.templateType,
        emailData.items[0].rowValues,
        emailData.items,
        emailData.headerMap,
        displayName,
        wrapper.context
      );
      const internalRecipients = PIPELINE.TEST_RECIPIENTS.join(',');
      const sendResult = sendAutomatedReachOutMessage_(internalRecipients, subject, htmlBody, wrapper.context, true);
      applyAdminLabels_(sendResult.message.getThread(), wrapper.admin ? [wrapper.admin] : []);
      appendTrackerRows_(tracker, [
        trackerRow_(new Date(), wrapper.item, wrapper.context, internalRecipients, 'TEST', 'OK',
          'Test sent internally | email from: ' + (wrapper.item['Email Source'] || 'Source Data'))
      ]);
      slackWebhookPost_('TEST_NOTIF_WEBHOOK_URL', buildSlackNotification_([wrapper], true));
      logSender_('testFullCircuit', started, 'OK', wrapper.item['Reference Code'] + ' | ' + templateLabel +
        ' | ' + (wrapper.admin ? wrapper.admin.name : 'admin unresolved') +
        ' | email from: ' + (wrapper.item['Email Source'] || 'Source Data') +
        ' | attachments: ' + ((sendResult.attachmentNames || []).join(', ') || 'none') +
        (sendResult.missingAttachments.length ? ' | PROBLEM: ' + sendResult.missingAttachments.join(' ') : ''));
    });
  } catch (error) {
    logSender_('testFullCircuit', started, 'ERROR', String(error && error.stack ? error.stack : error));
  }
}

/* ===== DIAGNOSTIC TESTS ===== */

/**
 * Run once after replacing the files. It appends any missing operational
 * headers without deleting existing rows or changing the current column order.
 */
function prepareAutomatedReachOutSheets() {
  const started = new Date();
  withDocumentLock_(function() {
    const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
    let queue = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
    if (!queue) queue = spreadsheet.insertSheet(SLACK.QUEUE_TAB);
    const queueHeaders = ensureHeaders_(queue, SLACK_HEADERS);
    // The Slack ts must live in a plain-text column. As a number it loses its
    // last digit and Slack rejects the threaded reply with invalid_thread_ts.
    const tsIndex = headerMap_(queueHeaders)['Slack Thread TS'];
    if (tsIndex !== undefined) {
      queue.getRange(1, tsIndex + 1, queue.getMaxRows(), 1).setNumberFormat('@');
    }
    // Dropdown and colours for the manual hold column, and NO on any row that
    // is already in the queue without a value.
    ensureStopSentColumn_(queue, queueHeaders);
    const stopIndex = headerMap_(queueHeaders)[STOP_SENT.HEADER];
    if (stopIndex !== undefined && queue.getLastRow() >= 2) {
      const stopRange = queue.getRange(2, stopIndex + 1, queue.getLastRow() - 1, 1);
      const stopValues = stopRange.getValues();
      let filled = 0;
      for (let i = 0; i < stopValues.length; i++) {
        if (String(stopValues[i][0] || '').trim() === '') { stopValues[i][0] = STOP_SENT.NO; filled++; }
      }
      if (filled) stopRange.setValues(stopValues);
    }
    ensureTracker_(spreadsheet);
    let warnings = spreadsheet.getSheetByName('Warnings');
    if (!warnings) warnings = spreadsheet.insertSheet('Warnings');
    ensureHeaders_(warnings, WARNING_HEADERS);
  });
  logSender_('prepareAutomatedReachOutSheets', started, 'OK',
    'Queue, Delivery History and Warnings headers were checked. Existing data was preserved.');
}

/**
 * Read-only rollout check. It verifies tabs, required headers, Script
 * Properties, sender identity, attachments, PARTNER access, the Building Name
 * source, the email fallback sources and the external Intake Email control tab.
 * It does not send email or Slack messages.
 */
function validateAutomatedReachOutConfiguration() {
  const errors = [];
  const notes = [];
  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);

  function checkHeaders(sheetName, requiredHeaders) {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      errors.push('Missing tab: ' + sheetName);
      return;
    }
    const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getDisplayValues()[0]
      .map(function(header) { return String(header || '').trim(); });
    const missing = requiredHeaders.filter(function(header) { return headers.indexOf(header) === -1; });
    if (missing.length) errors.push(sheetName + ' is missing header(s): ' + missing.join(', '));
  }

  checkHeaders(SLACK.MB_TAB, ['Reference Code', 'Record Code', 'Email Contact']);
  checkHeaders(SLACK.PROPERTY_TAB, ['Property Code']);
  checkHeaders(SLACK.QUEUE_TAB, SLACK_HEADERS);
  checkHeaders(SLACK.TRACKER_TAB, TRACKER_HEADERS);
  checkHeaders('Warnings', WARNING_HEADERS);

  ['SLACK_BOT_TOKEN', 'TEST_NOTIF_WEBHOOK_URL', 'SOURCE_THREAD_WEBHOOK_URL'].forEach(function(name) {
    if (!getScriptProperty_(name, false)) errors.push('Missing Script Property: ' + name);
  });

  const identities = GmailApp.getAliases().concat([Session.getEffectiveUser().getEmail()])
    .map(function(value) { return String(value || '').toLowerCase(); });
  if (identities.indexOf(FROM_ALIAS.toLowerCase()) === -1) {
    errors.push('The executing account cannot send as ' + FROM_ALIAS + '.');
  }

  const attachmentPack = getPrivateAttachmentBlobs_();
  if (!attachmentPack.attachments.length) {
    errors.push('No Private Owner attachment could be loaded from the Drive folder. ' +
      attachmentPack.problems.join(' '));
  } else {
    notes.push('Private Owner attachments (' + attachmentPack.attachments.length + '): ' +
      attachmentPack.names.join(', ') + ' | ' + Math.round(attachmentPack.totalBytes / 1024) + ' KB');
    attachmentPack.problems.forEach(function(problem) { errors.push('Attachment folder: ' + problem); });
  }

  try {
    notes.push('PARTNER names available: ' + loadPartnerNames_().length);
  } catch (error) {
    errors.push('PARTNER source access failed: ' + error);
  }

  try {
    const buildingCount = Object.keys(loadBuildingNameIndex_()).length;
    notes.push('Building Name entries indexed: ' + buildingCount);
    if (!buildingCount) errors.push('Building Name source returned no rows.');
  } catch (error) {
    errors.push('Building Name source access failed: ' + error);
  }

  try {
    loadEmailFallbackIndex_().forEach(function(source) {
      if (source.error) {
        errors.push('Email fallback "' + source.label + '": ' + source.error);
      } else {
        notes.push('Email fallback "' + source.label + '" -> tab "' + source.resolvedSheet +
          '", columns [' + source.resolvedColumns.join(', ') + '], ' +
          Object.keys(source.map).length + ' PO(s) with a valid address.');
      }
    });
  } catch (error) {
    errors.push('Email fallback sources failed: ' + error);
  }

  try {
    const controlSpreadsheet = SpreadsheetApp.openById(INTRO_CONTROL.SPREADSHEET_ID);
    const controlSheet = resolveSheetByNames_(controlSpreadsheet, [INTRO_CONTROL.SHEET_NAME]);
    if (!controlSheet) throw new Error('Tab "' + INTRO_CONTROL.SHEET_NAME + '" not found.');
    const headers = controlSheet.getRange(1, 1, 1, controlSheet.getLastColumn()).getDisplayValues()[0]
      .map(function(header) { return String(header || '').trim(); });
    if (headers.indexOf(INTRO_CONTROL.REFERENCE_HEADER) === -1 || headers.indexOf(INTRO_CONTROL.INTRO_HEADER) === -1) {
      throw new Error('Required headers are PO and Intake Email.');
    }
    notes.push('Intake Email control tab resolved: "' + controlSheet.getName() + '".');
  } catch (error) {
    errors.push('External Intake Email control access failed: ' + error);
  }

  notes.push('PIPELINE.LIVE = ' + PIPELINE.LIVE +
    ' | capture lookback ' + PIPELINE.CAPTURE_LOOKBACK_HOURS + 'h' +
    ' | duplicate window ' + PIPELINE.SENT_LOOKBACK_DAYS + ' day(s)');

  const message = (errors.length ? 'ERRORS:\n- ' + errors.join('\n- ') : 'Configuration is ready.') +
    (notes.length ? '\nNOTES:\n- ' + notes.join('\n- ') : '');
  Logger.log(message);
  if (errors.length) throw new Error(message);
  return message;
}

/**
 * Confirms that all SIX files in the project are on the same version.
 * The files share one global scope, so a stale file shows up as a missing
 * constant or function only at run time. Run this right after pasting code.
 *
 * Covered files 1 to 4 only until 2026-09-16, while the project had grown to
 * six - a stale 5_FastPath.gs or 6_SFDirect_Import.gs passed the check.
 */
function checkDeployment() {
  const lines = [];
  const missing = [];

  function probe(label, present) {
    lines.push((present ? '[OK]      ' : '[MISSING] ') + label);
    if (!present) missing.push(label);
  }

  lines.push('--- 1_Sender.gs ---');
  probe('CC_RECIPIENT', typeof CC_RECIPIENT !== 'undefined');
  probe('PRIVATE_ATTACHMENTS_FOLDER_ID', typeof PRIVATE_ATTACHMENTS_FOLDER_ID !== 'undefined');
  probe('PRIVATE_ATTACHMENTS_FILE_IDS', typeof PRIVATE_ATTACHMENTS_FILE_IDS !== 'undefined');
  probe('BUILDING_NAME_SOURCE', typeof BUILDING_NAME_SOURCE !== 'undefined');
  probe('getPrivateAttachmentBlobs_()', typeof getPrivateAttachmentBlobs_ === 'function');
  probe('attachmentsForContext_()', typeof attachmentsForContext_ === 'function');
  probe('testAttachments()', typeof testAttachments === 'function');
  probe('resolveDisplayName_()', typeof resolveDisplayName_ === 'function');
  probe('buildingNameForPo_()', typeof buildingNameForPo_ === 'function');
  probe('firstValidEmail_()', typeof firstValidEmail_ === 'function');
  probe('poKey_()', typeof poKey_ === 'function');
  probe('zipFromAddressText_()', typeof zipFromAddressText_ === 'function');
  probe('resolveSheetByNames_()', typeof resolveSheetByNames_ === 'function');
  probe('resolveColumnIndex_()', typeof resolveColumnIndex_ === 'function');
  probe('getChunkedCache_()', typeof getChunkedCache_ === 'function');
  probe('isPurePrivateOwner_()', typeof isPurePrivateOwner_ === 'function');
  probe('isPrivateProviderValue_()', typeof isPrivateProviderValue_ === 'function');
  probe('PRIVATE_PROVIDER_PATTERN', typeof PRIVATE_PROVIDER_PATTERN !== 'undefined');
  probe('FLORIDA_CONTRACT_RULES', typeof FLORIDA_CONTRACT_RULES !== 'undefined');
  probe('FLORIDA_CONTRACT_FIELDS', typeof FLORIDA_CONTRACT_FIELDS !== 'undefined');
  probe('floridaContractSuffix_()', typeof floridaContractSuffix_ === 'function');
  probe('isFloridaState_()', typeof isFloridaState_ === 'function');
  probe('PARTNER_INBOX_RULES', typeof PARTNER_INBOX_RULES !== 'undefined');
  probe('PARTNER_INBOX_NAME_FIELDS', typeof PARTNER_INBOX_NAME_FIELDS !== 'undefined');
  probe('PARTNER_INBOX_NAME_EXCEPTIONS', typeof PARTNER_INBOX_NAME_EXCEPTIONS !== 'undefined');
  probe('partnerInboxNameIsException_()', typeof partnerInboxNameIsException_ === 'function');
  probe('partnerInboxWords_()', typeof partnerInboxWords_ === 'function');
  probe('partnerInboxFor_()', typeof partnerInboxFor_ === 'function');
  probe('partnerCompanyTokens_()', typeof partnerCompanyTokens_ === 'function');
  probe('partnerCompanyTokenScore_()', typeof partnerCompanyTokenScore_ === 'function');
  probe('PARTNER_GENERIC_WORDS', typeof PARTNER_GENERIC_WORDS !== 'undefined');
  probe('PARTNER_MATCH_RATIO', typeof PARTNER_MATCH_RATIO !== 'undefined');

  lines.push('--- 2_SlackPipeline.gs ---');
  probe('normalizeSlackTs_()', typeof normalizeSlackTs_ === 'function');
  probe('COD_SOURCE', typeof COD_SOURCE !== 'undefined');
  probe('PIPELINE.COD_WINDOW_MINUTES', typeof PIPELINE !== 'undefined' &&
    PIPELINE.COD_WINDOW_MINUTES !== undefined);
  probe('loadCodIndex_()', typeof loadCodIndex_ === 'function');
  probe('codColumnIndex_()', typeof codColumnIndex_ === 'function');
  probe('codDateText_()', typeof codDateText_ === 'function');
  probe('buildCodThreadReply_()', typeof buildCodThreadReply_ === 'function');
  probe('replyToCodThread_()', typeof replyToCodThread_ === 'function');
  probe('postToBookingThread_()', typeof postToBookingThread_ === 'function');
  probe('testCodList()', typeof testCodList === 'function');
  probe('testSfReportColumns()', typeof testSfReportColumns === 'function');
  probe('whyNotSent()', typeof whyNotSent === 'function');
  probe('sfDeclinedNoteFor_()', typeof sfDeclinedNoteFor_ === 'function');
  probe('STOP_SENT', typeof STOP_SENT !== 'undefined');
  probe('isSendStopped_()', typeof isSendStopped_ === 'function');
  probe('ensureStopSentColumn_()', typeof ensureStopSentColumn_ === 'function');
  probe('previewQueuedSends()', typeof previewQueuedSends === 'function');
  probe('resolveAssigneeValue_()', typeof resolveAssigneeValue_ === 'function');
  probe('lastFilledPoRow_()', typeof lastFilledPoRow_ === 'function');
  probe('clearWarningsWeekly()', typeof clearWarningsWeekly === 'function');
  probe('createWarningsCleanupTriggers()', typeof createWarningsCleanupTriggers === 'function');
  probe('diagnoseAccess()', typeof diagnoseAccess === 'function');
  probe('hoursSinceNotification_()', typeof hoursSinceNotification_ === 'function');
  probe('notificationWeekdayKey_()', typeof notificationWeekdayKey_ === 'function');
  probe('expireWindowHoursFor_()', typeof expireWindowHoursFor_ === 'function');
  probe('PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS_BY_WEEKDAY',
    typeof PIPELINE !== 'undefined' && PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS_BY_WEEKDAY !== undefined);
  probe('PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS',
    typeof PIPELINE !== 'undefined' && PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS !== undefined);
  // A stale 2_SlackPipeline.gs would still carry the old lease-start rule and
  // silently expire bookings on the wrong evidence, so its absence is checked.
  probe('the lease-start give-up rule is gone',
    typeof PIPELINE !== 'undefined' && PIPELINE.EXPIRE_AFTER_LEASE_START_DAYS === undefined);
  probe('PROPERTY_MAP_CACHE_KEY', typeof PROPERTY_MAP_CACHE_KEY !== 'undefined');
  probe('propertyMapFromCompact_()', typeof propertyMapFromCompact_ === 'function');
  probe('testFloridaContractRule()', typeof testFloridaContractRule === 'function');
  probe('testPrivateProviderRule()', typeof testPrivateProviderRule === 'function');
  probe('testPartnerMatching()', typeof testPartnerMatching === 'function');
  probe('findPartnerMatchDetail_()', typeof findPartnerMatchDetail_ === 'function');
  probe('senderIdentity_()', typeof senderIdentity_ === 'function');
  probe('testSendingAddress()', typeof testSendingAddress === 'function');
  probe('listAutomatedReachOutTriggers()', typeof listAutomatedReachOutTriggers === 'function');
  probe('findMisaddressedSends()', typeof findMisaddressedSends === 'function');
  probe('previewResendAutomatedReachOutForPo()', typeof previewResendAutomatedReachOutForPo === 'function');
  probe('resendAutomatedReachOutForPo()', typeof resendAutomatedReachOutForPo === 'function');

  lines.push('--- 3_Source Data_Import.gs ---');
  probe('importAutomatedReachOutMbData()', typeof importAutomatedReachOutMbData === 'function');

  lines.push('--- ReferenceDataImport.gs ---');
  probe('importPropertyOnDemandData()', typeof importPropertyOnDemandData === 'function');
  probe('combinePropertyCsvAttachments_()', typeof combinePropertyCsvAttachments_ === 'function');

  lines.push('--- 5_FastPath.gs ---');
  probe('FASTPATH', typeof FASTPATH !== 'undefined');
  probe('addressKeyFromText_()', typeof addressKeyFromText_ === 'function');
  probe('addressFallbackKeyFromText_()', typeof addressFallbackKeyFromText_ === 'function');
  probe('normalizeUnitToken_()', typeof normalizeUnitToken_ === 'function');
  probe('isSentinelUnitToken_()', typeof isSentinelUnitToken_ === 'function');
  probe('fastPathUnitAgrees_()', typeof fastPathUnitAgrees_ === 'function');
  probe('loadFastPathIndex_()', typeof loadFastPathIndex_ === 'function');
  probe('importAutomatedReachOutFastPathData()', typeof importAutomatedReachOutFastPathData === 'function');
  probe('providerFromPartner_()', typeof providerFromPartner_ === 'function');
  probe('PRIVATE_PARTNER_VALUES', typeof PRIVATE_PARTNER_VALUES !== 'undefined');

  lines.push('--- 6_SFDirect_Import.gs ---');
  probe('DIRECT_SOURCE', typeof DIRECT_SOURCE !== 'undefined');
  probe('DIRECT_SOURCE.EXCLUDED_STATUS_PATTERN',
    typeof DIRECT_SOURCE !== 'undefined' && DIRECT_SOURCE.EXCLUDED_STATUS_PATTERN !== undefined);
  probe('DIRECT_SOURCE.ALLOW_ZIP_STATE_FALLBACK',
    typeof DIRECT_SOURCE !== 'undefined' && DIRECT_SOURCE.ALLOW_ZIP_STATE_FALLBACK !== undefined);
  probe('sfZip5_()', typeof sfZip5_ === 'function');
  probe('sfAddressKeysFrom_()', typeof sfAddressKeysFrom_ === 'function');
  probe('sfAddressKeysFromText_()', typeof sfAddressKeysFromText_ === 'function');
  probe('sfStreetToken_()', typeof sfStreetToken_ === 'function');
  probe('sfPropertyNameFrom_()', typeof sfPropertyNameFrom_ === 'function');
  probe('loadDirectSourceIndex_()', typeof loadDirectSourceIndex_ === 'function');
  probe('findDirectSourceRow_()', typeof findDirectSourceRow_ === 'function');
  probe('sfPreferLive_()', typeof sfPreferLive_ === 'function');
  probe('sfNarrowBuildingPool_()', typeof sfNarrowBuildingPool_ === 'function');
  probe('sfPoolAgrees_()', typeof sfPoolAgrees_ === 'function');
  probe('DIRECT_SOURCE.SEND_ON_AMBIGUOUS_BUILDING',
    typeof DIRECT_SOURCE !== 'undefined' && DIRECT_SOURCE.SEND_ON_AMBIGUOUS_BUILDING !== undefined);
  probe('DIRECT_SOURCE.ALLOW_DECLINED_QUOTES', typeof DIRECT_SOURCE !== 'undefined' && DIRECT_SOURCE.ALLOW_DECLINED_QUOTES !== undefined);
  probe('importDirectSourceData()', typeof importDirectSourceData === 'function');

  // A constant existing is not proof it is the CURRENT version, so the two
  // rules most recently changed are exercised rather than merely probed.
  lines.push('--- behaviour spot-checks ---');
  try {
    probe('sfZip5_ pads a leading-zero postcode ("6810.0" -> "06810")',
      sfZip5_('6810.0') === '06810');
  } catch (error) { probe('sfZip5_ pads a leading-zero postcode - ' + error, false); }
  try {
    probe('isPrivateProviderValue_ catches the PRIVIATE_OWNER typo',
      isPrivateProviderValue_('PRIVIATE_OWNER') === true &&
      isPrivateProviderValue_('EXAMPLE_PARTNER') === false);
  } catch (error) { probe('isPrivateProviderValue_ typo check - ' + error, false); }
  try {
    probe('byZipState key is built without a house number',
      sfAddressKeysFrom_('Hilton Ave (approx)', 'AK', '99701').byZipState === '99701|AK');
  } catch (error) { probe('byZipState key - ' + error, false); }
  try {
    const examplePartner = partnerInboxFor_({ 'External Provider': 'EXAMPLE_PARTNER' });
    const sequoia = partnerInboxFor_({ 'External Provider': 'SEQ',
      'Building Name': 'Example Partner Village Apartment Homes' });
    const sequoiaNoProvider = partnerInboxFor_({ 'External Provider': '',
      'Property Name': 'Example Partner Village Apartment Homes, 6910 NE Ronler Way' });
    const unrelatedBuilding = partnerInboxFor_({ 'Building Name': '518 Example Avenue' });
    probe('Example Partner desk fires on the provider, not on a name owned by someone else',
      !!examplePartner && examplePartner.email === 'partner-app@example.net' &&
      sequoia === null && sequoiaNoProvider === null && unrelatedBuilding === null);
  } catch (error) { probe('Example Partner desk rule - ' + error, false); }
  try {
    const codText = buildCodThreadReply_({ 'Reference Code': 'USA-0000A' },
      { name: 'Coordinator E', slackId: 'YOUR_COORDINATOR_E_SLACK_ID' }, '2026-10-15');
    probe('COD thread reply names the date and tags the admin',
      codText.indexOf(':warning:') === 0 &&
      codText.indexOf('10/15/2026') !== -1 &&
      codText.indexOf('<@YOUR_COORDINATOR_E_SLACK_ID>') !== -1 &&
      codText.indexOf('send it manually') !== -1);
  } catch (error) { probe('COD thread reply - ' + error, false); }
  try {
    probe('codDateText_ treats the "n/a" placeholders as no date',
      codDateText_('n/a') === '' && codDateText_('N/A') === '' && codDateText_('') === '' &&
      codDateText_('2026-10-15') === '10/15/2026');
  } catch (error) { probe('codDateText_ - ' + error, false); }
  try {
    const live = { row: ['live'], declined: false, quoteNumber: '1' };
    const dead = { row: ['dead'], declined: true, quoteNumber: '2' };
    const mixed = sfPreferLive_([dead, live]);
    const onlyDead = sfPreferLive_([dead]);
    probe('a declined quote never beats a live one, but wins alone',
      mixed.length === 1 && mixed[0].quoteNumber === '1' &&
      onlyDead.length === 1 && onlyDead[0].quoteNumber === '2' &&
      sfMethodWithDeclined_('SFDIRECT_ZIP_STATE', dead) === 'SFDIRECT_ZIP_STATE_DECLINED' &&
      sfMethodWithDeclined_('SFDIRECT_ZIP_STATE', live) === 'SFDIRECT_ZIP_STATE');
  } catch (error) { probe('declined-quote ranking - ' + error, false); }
  try {
    probe('a five-digit house number is not read as a postcode',
      zipFromAddressText_('11011 West North Avenue, Wauwatosa, WI, USA #102') === '' &&
      zipFromAddressText_('32618 HP Johnson Street, Green, Texas 77451 #A') === '77451' &&
      zipFromAddressText_('14700 Washington Ave, San Leandro, CA 94578, USA') === '94578' &&
      zipFromAddressText_('50 Saw Mill Road, Danbury, CT 06810, USA #12-220') === '06810');
  } catch (error) { probe('house number vs postcode - ' + error, false); }
  try {
    probe('a Wisconsin address with no postcode is not routed as New York',
      stateFromAddress_('11011 West North Avenue, Wauwatosa, WI, USA #102') === 'WI' &&
      stateFromAddress_('32618 HP Johnson Street, Green, Texas 77451 #A') === 'TX');
  } catch (error) { probe('state from a numeric address - ' + error, false); }
  try {
    // A Friday notification must get the long window and a Thursday one the
    // base window, whatever timezone or locale the account runs in.
    const friday = { 'Slack Not Date': new Date(2026, 8, 25, 18, 0, 0) };
    const thursday = { 'Slack Not Date': new Date(2026, 8, 24, 18, 0, 0) };
    probe('Friday gets the longer give-up window, Thursday does not',
      notificationWeekdayKey_(friday) === 'FRI' &&
      notificationWeekdayKey_(thursday) === 'THU' &&
      expireWindowHoursFor_(friday) === PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS_BY_WEEKDAY.FRI &&
      expireWindowHoursFor_(thursday) === PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS &&
      expireWindowHoursFor_({}) === PIPELINE.EXPIRE_AFTER_NOTIFICATION_HOURS);
  } catch (error) { probe('Friday give-up window - ' + error, false); }
  try {
    // The real 11011 West North Ave pool from 2026-09-22.
    const pool = [
      { quoteNumber: '296913', unit: '332',   rent: '$2,015.00', leaseStart: '11/9/2026',  leaseEnd: '8/31/2027' },
      { quoteNumber: '297053', unit: 'MULTI', rent: '$2,240.00', leaseStart: '10/15/2026', leaseEnd: '8/31/2027' },
      { quoteNumber: '297061', unit: 'multi', rent: '$1,726.00', leaseStart: '10/14/2026', leaseEnd: '8/31/2027' }
    ];
    const booking = { 'Lease Start': '10/16/2026', 'Lease End Date': '8/31/2027' };
    const left = sfNarrowBuildingPool_(pool, booking, '102');
    // Unit 332 is dropped; the two whole-building quotes disagree on rent, so
    // the booking waits instead of being priced from the wrong one.
    const twin = [pool[1], { quoteNumber: '297099', unit: 'multi', rent: '2240',
      leaseStart: '10/15/2026', leaseEnd: '8/31/2027' }];
    probe('one building, several quotes: unit narrows, disagreement still waits',
      left.length === 2 && sfPoolAgrees_(twin) === true &&
      sfNarrowBuildingPool_(twin, booking, '102').length === 1);
  } catch (error) { probe('building pool narrowing - ' + error, false); }

  lines.push('');
  lines.push(missing.length
    ? 'RESULT: ' + missing.length + ' item(s) missing or wrong. The file that owns them is stale. Re-paste it and run this again.'
    : 'RESULT: all six files are on the same version.');

  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

/**
 * Checks every external document this project touches, one at a time, and says
 * which ones the EXECUTING account can actually open. Run this first whenever a
 * "You do not have permission to access the requested document" appears.
 * Read-only: opens nothing else, sends nothing.
 */
function diagnoseAccess() {
  const lines = [];
  const identity = senderIdentity_();
  lines.push('Executing as : ' + (identity.effectiveUser || '(could not be identified)'));
  lines.push('Must send as : ' + FROM_ALIAS);
  lines.push('Aliases here : ' + (identity.aliases.join(', ') || '(none)'));
  if (identity.isAliasAccount) {
    lines.push('VERDICT      : OK - this account IS the sending address.');
  } else if (identity.canSendAsAlias) {
    lines.push('VERDICT      : OK - the sending address is a configured alias here.');
  } else {
    lines.push('VERDICT      : *** WRONG ACCOUNT *** - this project cannot send as ' + FROM_ALIAS + '.');
    lines.push('               Every email is now refused rather than sent from the wrong');
    lines.push('               address. Re-authorise the project as ' + FROM_ALIAS + ', or add');
    lines.push('               that alias to this account, then run findMisaddressedSends().');
  }
  if (identity.error) lines.push('Identity check problem: ' + identity.error);
  lines.push('');

  const targets = [
    { kind: 'sheet', label: 'Main spreadsheet (queue/MB/tracker)', id: SLACK.MAIN_SS_ID, tab: SLACK.QUEUE_TAB },
    { kind: 'sheet', label: 'Central log', id: LOG_CONFIG.SPREADSHEET_ID, tab: LOG_CONFIG.SHEET_NAME },
    { kind: 'sheet', label: 'Intake Email control', id: INTRO_CONTROL.SPREADSHEET_ID, tab: INTRO_CONTROL.SHEET_NAME },
    { kind: 'sheet', label: 'PARTNER agreement grid', id: PARTNER_SOURCE.SPREADSHEET_ID, tab: PARTNER_SOURCE.SHEET_NAME },
    { kind: 'sheet', label: 'Building Name (US Rent Payments)', id: BUILDING_NAME_SOURCE.SPREADSHEET_ID, tab: BUILDING_NAME_SOURCE.SHEET_NAME },
    { kind: 'sheet', label: 'Email fallback (Department Y Move-Outs)', id: EMAIL_FALLBACK_SPREADSHEET_ID, tab: '' },
    { kind: 'sheet', label: 'COD list (Department Y Case Workflow Results)', id: COD_SOURCE.SPREADSHEET_ID, tab: COD_SOURCE.SHEET_NAMES[0] },
    { kind: 'folder', label: 'Private Owner attachment folder', id: PRIVATE_ATTACHMENTS_FOLDER_ID, tab: '' }
  ];

  targets.forEach(function(target) {
    if (!target.id) {
      lines.push('[SKIP] ' + target.label + ' - no ID configured yet');
      return;
    }
    try {
      if (target.kind === 'file') {
        const file = DriveApp.getFileById(target.id);
        lines.push('[OK]   ' + target.label + ' - "' + file.getName() + '"');
        return;
      }
      if (target.kind === 'folder') {
        const folder = DriveApp.getFolderById(target.id);
        const names = [];
        const files = folder.getFiles();
        while (files.hasNext()) names.push(files.next().getName());
        names.sort();
        lines.push('[OK]   ' + target.label + ' - "' + folder.getName() + '" | ' +
          names.length + ' file(s): ' + (names.join(', ') || '(empty)'));
        return;
      }
      const spreadsheet = SpreadsheetApp.openById(target.id);
      let detail = '"' + spreadsheet.getName() + '"';
      if (target.tab) {
        const sheet = resolveSheetByNames_(spreadsheet, [target.tab]);
        detail += sheet ? ' | tab "' + sheet.getName() + '" found' : ' | TAB "' + target.tab + '" NOT FOUND';
      }
      lines.push('[OK]   ' + target.label + ' - ' + detail);
    } catch (error) {
      lines.push('[FAIL] ' + target.label + ' (' + target.id + ') - ' + error);
    }
  });

  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

/**
 * Drops the cached lookup indexes so the next run reads the source sheets again.
 * Run this after editing the Building Name sheet or any fallback email tab.
 */
function clearAutomatedReachOutCaches() {
  const cache = CacheService.getScriptCache();
  cache.remove('AUTOMATED_REACHOUT_PARTNER_NAMES_V1');
  cache.remove('AUTOMATED_REACHOUT_BUILDING_NAMES_V1_COUNT');
  cache.remove('AUTOMATED_REACHOUT_EMAIL_FALLBACK_V1_COUNT');
  // Removing the _COUNT key is enough: getChunkedCache_ reads it first and
  // returns null without it, so the orphaned chunks simply expire.
  cache.remove(PROPERTY_MAP_CACHE_KEY + '_COUNT');
  __BUILDING_INDEX = null;
  __EMAIL_FALLBACK_INDEX = null;
  __PROPERTY_MAP = null;
  __COD_INDEX = null;
  Logger.log('Automated Reach-Out lookup caches cleared (PARTNER, Building Name, Email fallback, Reference Properties, COD list).');
}

/**
 * READ-ONLY. Shows exactly what the automation would send for everything that is
 * sitting in the queue right now: template, recipient, copy, subject and
 * attachments. Sends nothing and changes nothing. This is the safest way to
 * confirm a new deploy before the next 15-minute cycle fires.
 */
/**
 * Shows how the queue would be grouped into emails right now, and which rows
 * would be held back for a sibling. Sends nothing. Run this before trusting a
 * bulk send, and again whenever QUIET_MINUTES or MAX_HOLD_MINUTES change.
 */
function previewBulkGrouping() {
  const lines = [];
  lines.push('Bulk send  : ' + (PIPELINE.BULK.ENABLED ? 'ON' : 'OFF') +
    ' | group by address: ' + (PIPELINE.BULK.GROUP_BY_ADDRESS ? 'yes' : 'no') +
    ' | quiet ' + PIPELINE.BULK.QUIET_MINUTES + ' min | max hold ' + PIPELINE.BULK.MAX_HOLD_MINUTES + ' min');
  lines.push('');

  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  const queue = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
  if (!queue || queue.getLastRow() < 2) {
    lines.push('The queue is empty - nothing to group.');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const mbIndex = loadMbIndex_();
  const propertyMap = loadPropertyMap_();
  const headers = ensureHeaders_(queue, SLACK_HEADERS);
  const map = headerMap_(headers);
  const rows = queue.getRange(2, 1, queue.getLastRow() - 1, headers.length).getValues();

  const candidates = [];
  const pendingAddressKeys = {};
  rows.forEach(function(row) {
    const queueObject = rowObject_(row, map);
    if (!String(queueObject['Reference Code'] || '').trim()) return;
    if (isSendStopped_(queueObject)) return;

    const match = findMbMatch_(queueObject, mbIndex);
    if (!match) {
      const key = bulkAddressKey_(queueObject);
      if (key) pendingAddressKeys[key] = true;
      lines.push('[WAITING] ' + queueObject['Reference Code'] + ' - no MB/SF match yet, address key ' + (key || 'none'));
      return;
    }
    const item = buildEmailObject_(queueObject, match.row, mbIndex.headerMap, propertyMap);
    if (missingEmailData_(item).length || (PIPELINE.REQUIRE_MB_FINANCIALS && String(item['MB Missing Fields'] || '').trim())) {
      const key = bulkAddressKey_(item);
      if (key) pendingAddressKeys[key] = true;
      lines.push('[WAITING] ' + item['Reference Code'] + ' - data incomplete, address key ' + (key || 'none'));
      return;
    }
    candidates.push({ sheetRow: 0, item: item, context: contextForItem_(item, propertyMap), admin: null, matchMethod: match.method });
  });

  if (lines[lines.length - 1] !== '') lines.push('');
  const split = partitionBulkHolds_(candidates, pendingAddressKeys, Date.now());

  const groups = {};
  split.send.forEach(function(candidate) {
    const key = bulkGroupKey_(candidate);
    if (!groups[key]) groups[key] = [];
    groups[key].push(candidate);
  });

  const keys = Object.keys(groups);
  lines.push('WOULD SEND NOW - ' + keys.length + ' email(s) for ' + split.send.length + ' booking(s):');
  keys.forEach(function(key) {
    const group = groups[key];
    const first = group[0].item;
    const pos = group.map(function(candidate) { return candidate.item['Reference Code']; }).join(', ');
    const units = group.map(function(candidate) { return unitNumberText_(candidate.item['Unit No']) || '?'; }).join(', ');
    lines.push('  ' + (group.length > 1 ? 'BULK x' + group.length : 'single') +
      ' -> ' + first['Email Contact'] +
      '\n      POs   : ' + pos +
      '\n      Units : ' + units +
      '\n      Place : ' + first['Full Address'] +
      '\n      Key   : ' + key);
  });

  lines.push('');
  lines.push('HELD FOR A SIBLING - ' + split.held.length + ' group(s):');
  if (!split.held.length) lines.push('  (none)');
  split.held.forEach(function(hold) {
    lines.push('  ' + hold.candidates.map(function(candidate) { return candidate.item['Reference Code']; }).join(', ') +
      '\n      Reason : ' + hold.reason +
      '\n      Timing : quiet ' + hold.minutesQuiet + '/' + PIPELINE.BULK.QUIET_MINUTES +
      ' min, held ' + hold.minutesHeld + '/' + PIPELINE.BULK.MAX_HOLD_MINUTES + ' min');
  });

  const text = lines.join('\n');
  Logger.log(text);
  return text;
}

function previewQueuedSends() {
  const lines = [];
  const ccValue = (typeof CC_RECIPIENT === 'string') ? CC_RECIPIENT.trim() : '';
  lines.push('Copy on every real send : ' +
    (ccValue || 'NONE - CC_RECIPIENT is missing, paste 1_Sender.gs and run checkDeployment()'));
  lines.push('Running as              : ' + Session.getEffectiveUser().getEmail());
  lines.push('');

  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  const queue = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
  if (!queue || queue.getLastRow() < 2) {
    lines.push('The queue is empty - nothing is waiting to be sent.');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const mbIndex = loadMbIndex_();
  const propertyMap = loadPropertyMap_();
  const headers = ensureHeaders_(queue, SLACK_HEADERS);
  const map = headerMap_(headers);
  const rows = queue.getRange(2, 1, queue.getLastRow() - 1, headers.length).getValues();
  let ready = 0;
  let waiting = 0;
  let blocked = 0;
  let stopped = 0;
  let unstable = 0;
  let codBlocked = 0;
  let codWaiting = 0;
  let expiring = 0;

  // Read once, before the loop, so the preview says the same thing the queue
  // monitor would say on this cycle.
  const codIndex = loadCodIndex_();
  lines.push('COD list  : ' + (codIndex.error
    ? 'COULD NOT BE READ - ' + codIndex.error
    : codIndex.rows + ' PO(s) on tab "' + codIndex.sheetName + '"' +
      (codIndex.hasStartColumn ? '' : ' - WARNING: no "' + COD_SOURCE.NEW_START_HEADER + '" column found')));
  lines.push('COD window: ' + PIPELINE.COD_WINDOW_MINUTES + ' min after the Slack notification');
  lines.push('');

  rows.forEach(function(row) {
    const queueObject = rowObject_(row, map);
    const po = String(queueObject['Reference Code'] || '').trim();
    if (!po) return;

    if (isSendStopped_(queueObject)) {
      stopped++;
      lines.push('[STOPPED] ' + po + ' - held back manually, Stop Sent? = YES');
      return;
    }

    // Same order the queue monitor uses, so the preview never calls a row READY
    // that the next cycle would drop.
    const previewAgeHours = hoursSinceNotification_(queueObject);
    const previewExpireHours = expireWindowHoursFor_(queueObject);
    if (previewExpireHours > 0 && previewAgeHours !== null && previewAgeHours >= previewExpireHours) {
      expiring++;
      lines.push('[EXPIRED] ' + po + ' - notified ' + previewAgeHours + 'h ago on a ' +
        (notificationWeekdayKey_(queueObject) || '?') + ', past its ' + previewExpireHours +
        'h window. The next cycle drops it and records it as EXPIRED.');
      return;
    }

    const previewCod = codIndex.error ? null : codIndex.map[poKey_(po)];
    if (previewCod) {
      codBlocked++;
      lines.push('[COD] ' + po + ' - on the COD list' +
        (codDateText_(previewCod.newStart)
          ? ', new client start date ' + codDateText_(previewCod.newStart)
          : ', no new start date recorded') +
        '. No email would be sent; the Operations Team would be tagged in the booking thread.');
      return;
    }

    const previewNotifiedMs = bulkNotifiedAtMs_(queueObject);
    const previewWindow = Number(PIPELINE.COD_WINDOW_MINUTES || 0);
    if (previewWindow > 0 && previewNotifiedMs > 0) {
      const previewWaited = Math.floor((Date.now() - previewNotifiedMs) / 60000);
      if (previewWaited < previewWindow) {
        codWaiting++;
        lines.push('[COD WINDOW] ' + po + ' - notified ' + previewWaited + ' min ago, releases after ' +
          previewWindow + ' min (in ' + (previewWindow - previewWaited) + ' min)');
        return;
      }
    }

    const match = findMbMatch_(queueObject, mbIndex);
    if (!match) {
      waiting++;
      lines.push('[WAITING] ' + po + ' - no unique Source Data match yet (fee data has not landed)');
      return;
    }

    const item = buildEmailObject_(queueObject, match.row, mbIndex.headerMap, propertyMap);
    if (missingEmailData_(item).length) {
      blocked++;
      lines.push('[BLOCKED] ' + po + ' - no usable Email Contact in Source Data or in the fallback tabs');
      return;
    }
    const mbMissing = String(item['MB Missing Fields'] || '').trim();
    if (PIPELINE.REQUIRE_MB_FINANCIALS && mbMissing) {
      waiting++;
      lines.push('[WAITING] ' + po + ' - Source Data still has no ' + mbMissing);
      return;
    }
    if (PIPELINE.REQUIRE_MB_STABLE) {
      const drift = mbValueDrift_(po, match.row, mbIndex.headerMap);
      if (drift.length) {
        unstable++;
        lines.push('[UNSTABLE] ' + po + ' - changed between the last two imports: ' + drift.join(' ; '));
        return;
      }
    }

    const context = contextForItem_(item, propertyMap);
    const pack = attachmentsForContext_(context);
    const displayName = item['Display Name'] || item['Property Name'] || po;
    ready++;
    lines.push('[READY] ' + po +
      // Which rule found the data. There are six tiers now, and the weakest -
      // SFDIRECT_ZIP_STATE - matches on postcode and state alone, so it is
      // worth seeing before an email goes out on it.
      '\n   Matched by  : ' + match.method +
      '\n   Template    : ' + context.templateType +
      (context.partnerCompanyName ? ' (PARTNER matched: ' + context.partnerCompanyName + ')' : '') +
      '\n   Provider    : ' + (item['External Provider'] || '(blank)') +
      '\n   To          : ' + item['Email Contact'] +
      '   [source: ' + (item['Email Source'] || 'Source Data') + ']' +
      '\n   Cc          : ' + (ccValue || '(none)') +
      '\n   Subject     : ' + buildAutomatedReachOutSubject_(displayName, po, context, '', item['Full Address'], item['Unit No']) +
      '\n   Attachments : ' + (pack.names.length ? pack.names.join(', ') : 'none') +
      (pack.missing.length ? '\n   PROBLEM     : ' + pack.missing.join(' ') : ''));
  });

  lines.push('');
  lines.push('Ready to send: ' + ready + ' | In the COD window: ' + codWaiting +
    ' | Blocked by a COD: ' + codBlocked + ' | Waiting on BI platform: ' + waiting +
    ' | Blocked (no recipient): ' + blocked + ' | Unstable data: ' + unstable +
    ' | Stopped manually: ' + stopped + ' | Past the give-up window: ' + expiring);
  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

/**
 * READ-ONLY. Says, column by column, whether each field the automation wants
 * from the CRM report is actually present in the "Direct Source Data" tab.
 *
 * Written on 2026-09-23, when five columns were added to the reports. A column
 * whose header does not match the alias EXACTLY is read as absent and the fee
 * silently never reaches the email - which is the failure this answers.
 *
 * Opens nothing else, sends nothing.
 */
function testSfReportColumns() {
  const lines = ['Direct Source Data - column check'];
  let sheet;
  try {
    sheet = SpreadsheetApp.openById(DIRECT_SOURCE.MAIN_SS_ID).getSheetByName(DIRECT_SOURCE.TAB);
  } catch (error) {
    lines.push('  Could not open the tab: ' + error);
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }
  if (!sheet || sheet.getLastRow() < 1) {
    lines.push('  Tab "' + DIRECT_SOURCE.TAB + '" is empty - run importDirectSourceData() first.');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .map(function(header) { return String(header || '').trim(); });
  const present = {};
  headerRow.forEach(function(header) { if (header) present[header] = true; });

  const wanted = Object.keys(DIRECT_SOURCE.HEADER_ALIASES)
    .concat(['Quote Number', 'Status', 'Property: Account Name', 'Quote Name',
             'Ship To Street', 'Ship To State/Province', 'Ship To Zip/Postal Code',
             'Mailing Address', 'Unit Contact Email']);

  const found = [];
  const absent = [];
  wanted.forEach(function(header) {
    if (present[header]) found.push(header);
    else absent.push(header);
  });

  lines.push('  Tab has ' + headerRow.length + ' column(s), imported ' +
    Math.max(0, sheet.getLastRow() - 1) + ' quote row(s).');
  lines.push('');
  lines.push('  FOUND (' + found.length + '):');
  found.forEach(function(header) {
    lines.push('    [OK]      ' + header +
      (DIRECT_SOURCE.HEADER_ALIASES[header] ? '   -> ' + DIRECT_SOURCE.HEADER_ALIASES[header] : ''));
  });
  lines.push('');
  lines.push('  NOT IN THE TAB (' + absent.length + '):');
  if (!absent.length) lines.push('    (none - every column the automation reads is there)');
  absent.forEach(function(header) {
    lines.push('    [MISSING] ' + header +
      (DIRECT_SOURCE.HEADER_ALIASES[header] ? '   -> ' + DIRECT_SOURCE.HEADER_ALIASES[header] : '') +
      '   nothing will ever be read from it');
  });

  if (absent.length) {
    lines.push('');
    lines.push('  A missing column is either not in the CRM report, or its');
    lines.push('  header is spelled differently there. The names above are exact -');
    lines.push('  compare them against row 1 of the tab, which is printed below.');
    lines.push('');
    lines.push('  Row 1 as imported: ' + headerRow.join(' | '));
  }

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/**
 * READ-ONLY. Says whether the COD list can be read, which tab and columns it
 * resolved, and - if you pass a PO - exactly what would happen to that booking
 * and the Slack message it would produce.
 *
 * Nothing is sent. Nothing is posted to Slack. The reply text is only printed,
 * which is the point: it is how to check the wording before it goes to a
 * property team's thread.
 *
 *   testCodList()             -> the list itself, plus the first few POs on it
 *   testCodList('USA-4066A')  -> what that booking would do
 */
function testCodList(po) {
  __COD_INDEX = null;
  const index = loadCodIndex_();
  const lines = [];

  lines.push('COD list - "Department Y Case Workflow Results"');
  lines.push('  Spreadsheet : ' + COD_SOURCE.SPREADSHEET_ID);
  if (index.error) {
    lines.push('  STATUS      : COULD NOT BE READ');
    lines.push('  Error       : ' + index.error);
    lines.push('  Effect      : ' + (COD_SOURCE.BLOCK_WHEN_UNREADABLE
      ? 'nothing is being sent until this is fixed (BLOCK_WHEN_UNREADABLE is true).'
      : 'emails still go out and an ERROR warning is raised (BLOCK_WHEN_UNREADABLE is false).'));
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  lines.push('  Tab         : "' + index.sheetName + '"');
  lines.push('  PO column   : "' + COD_SOURCE.REFERENCE_HEADER + '" - resolved');
  lines.push('  Date column : "' + COD_SOURCE.NEW_START_HEADER + '" - ' +
    (index.hasStartColumn ? 'resolved' : 'NOT FOUND, the notice will say no date was recorded'));
  lines.push('  POs on list : ' + index.rows);
  lines.push('  COD window  : ' + PIPELINE.COD_WINDOW_MINUTES + ' min after the Slack notification');

  const target = String(po || '').trim();
  if (!target) {
    const sample = Object.keys(index.map).slice(0, 8);
    lines.push('');
    lines.push('First POs on the list: ' + (sample.join(', ') || '(none)'));
    lines.push('Pass a PO to see what it would do, e.g. testCodList("' + (sample[0] || 'USA-4066A') + '").');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const hit = index.map[poKey_(target)];
  lines.push('');
  lines.push('PO ' + target);
  if (!hit) {
    lines.push('  Not on the COD list. The email would go out normally, ' +
      PIPELINE.COD_WINDOW_MINUTES + ' min after the notification.');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const propertyMap = loadPropertyMap_();
  const property = propertyMap[poKey_(target)] || {};
  const item = {
    'Reference Code': target,
    'Record Code': '',
    'Full Address': property.fullAddress || '',
    'State': stateNameToCode_(property.state) || stateFromAddress_(property.fullAddress)
  };
  const admin = resolveAdmin_(target, propertyMap, item['Full Address'], item.State);

  lines.push('  ON THE COD LIST - no email would be sent.');
  lines.push('  New start   : ' + (codDateText_(hit.newStart) || '(not recorded)') +
    (hit.newStart ? '   [raw cell: "' + hit.newStart + '"]' : ''));
  lines.push('  Operations Team    : ' + (admin ? admin.name + ' (' + admin.state + ')' : 'could not be resolved from the address'));
  lines.push('  Tracker     : Mode SKIPPED, Status COD');
  lines.push('');
  lines.push('  --- the reply that would be posted in the booking thread ---');
  lines.push(buildCodThreadReply_(item, admin, hit.newStart).split('\n').map(function(line) {
    return '  ' + line;
  }).join('\n'));

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/** Reports exactly which tabs/columns the fallback resolved and how many POs it holds. */
function testEmailFallbackSources() {
  clearAutomatedReachOutCaches();
  const lines = [];
  loadEmailFallbackIndex_().forEach(function(source) {
    if (source.error) {
      lines.push('[FAIL] ' + source.label + ' -> ' + source.error);
    } else {
      lines.push('[OK]   ' + source.label + ' -> tab "' + source.resolvedSheet + '" | columns [' +
        source.resolvedColumns.join(', ') + '] | ' + Object.keys(source.map).length + ' PO(s) with a valid address');
    }
  });
  Logger.log(lines.join('\n'));
  return lines.join('\n');
}

/**
 * READ-ONLY. Answers "why has this booking not been sent yet?" for one PO,
 * reading the queue row itself. Sends nothing, changes nothing.
 *
 *   whyNotSent('USA-4081A')
 */
function whyNotSent(po) {
  const target = String(po || '').trim().toUpperCase();
  const lines = ['PO ' + (target || '(none given)')];
  if (!target) {
    lines.push('Pass a PO, e.g. whyNotSent("USA-4081A").');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  const queue = spreadsheet.getSheetByName(SLACK.QUEUE_TAB);
  if (!queue || queue.getLastRow() < 2) {
    lines.push('The queue is empty. Check Delivery History - it may already be sent, EXPIRED or COD.');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const headers = ensureHeaders_(queue, SLACK_HEADERS);
  const map = headerMap_(headers);
  const rows = queue.getRange(2, 1, queue.getLastRow() - 1, headers.length).getValues();
  let queueObject = null;
  rows.forEach(function(row) {
    const candidate = rowObject_(row, map);
    if (String(candidate['Reference Code'] || '').trim().toUpperCase() === target) queueObject = candidate;
  });
  if (!queueObject) {
    lines.push('Not in the queue. Check Delivery History - it may already be sent, EXPIRED or COD.');
    Logger.log(lines.join('\n'));
    return lines.join('\n');
  }

  const ageHours = hoursSinceNotification_(queueObject);
  lines.push('  Notified    : ' + (queueObject['Slack Not Date'] || '(no timestamp)') +
    (ageHours === null ? '  [unreadable]' : '  [' + ageHours + 'h ago, ' +
      (notificationWeekdayKey_(queueObject) || '?') + ']'));
  lines.push('  Gives up at : ' + expireWindowHoursFor_(queueObject) + 'h' +
    (ageHours === null ? '' : '   (' + Math.max(0, expireWindowHoursFor_(queueObject) - ageHours) +
      'h left)'));
  lines.push('  Address     : ' + (queueObject['Full Address'] || '(blank)'));
  lines.push('  Stop Sent?  : ' + (queueObject[STOP_SENT.HEADER] || '(blank)'));

  const codIndex = loadCodIndex_();
  const codHit = codIndex.error ? null : codIndex.map[poKey_(target)];
  lines.push('  COD list    : ' + (codIndex.error
    ? 'could not be read - ' + codIndex.error
    : (codHit ? 'ON THE LIST, new start ' + (codDateText_(codHit.newStart) || '(not recorded)')
              : 'not on the list')));

  const mbIndex = loadMbIndex_();
  const match = findMbMatch_(queueObject, mbIndex);
  if (match) {
    lines.push('  Quote       : matched by ' + match.method);
    const item = buildEmailObject_(queueObject, match.row, mbIndex.headerMap, loadPropertyMap_());
    const missingContact = missingEmailData_(item);
    lines.push('  Recipient   : ' + (item['Email Contact'] || 'NONE - ' + missingContact.join(', ')));
    lines.push('  MB missing  : ' + (String(item['MB Missing Fields'] || '').trim() || 'nothing'));
  } else {
    lines.push('  Quote       : NO MATCH');
    lines.push('  Why         : ' + describeMbMiss_(queueObject, mbIndex));
  }

  Logger.log(lines.join('\n'));
  return lines.join('\n');
}
/** Shows what the automation would use for a given PO, without sending anything. */
function testResolveForPo(po) {
  const target = po || 'REF-1002A';
  const propertyMap = loadPropertyMap_();
  const property = propertyMap[String(target || '').trim().toUpperCase()] || {};
  const onDemandName = String(property.buildingName || '').trim();
  const rentPaymentsName = buildingNameForPo_(target);
  const resolution = resolveEmailContact_(target, '');
  const chosen = resolveDisplayName_(target, '(Source Data Property Name)', onDemandName);

  const message = 'PO ' + target +
    '\n  --- name used in the greeting, subject and table ---' +
    '\n  1. Reference Properties > Building Name : ' + (onDemandName || '(empty)') +
    '\n  2. US Rent Payments > Building Name   : ' + (rentPaymentsName || '(not listed)') +
    '\n  3. Source Data > Property Name            : used only if 1 and 2 are empty' +
    '\n  => CHOSEN                             : ' + chosen +
    '\n  --- recipient ---' +
    '\n  Email Contact : ' + (resolution.email || '(none found)') +
    '\n  Email Source  : ' + (resolution.source || '(none)') +
    '\n  --- other Reference Properties data ---' +
    '\n  Address Full  : ' + (property.fullAddress || '(empty)') +
    '\n  Address State : ' + (property.state || '(empty)');
  Logger.log(message);
  return message;
}

/**
 * READ-ONLY. Replays the PARTNER matching over past sends and shows what the
 * widened rule changes. Sends nothing, writes nothing.
 *
 * Widening the PARTNER search is the highest-variance change of 2026-09-16: a new
 * PARTNER match flips brandRestricted, which turns the signature from "Travelers
 * Haven by Example Company" into "Example Housing Company". This is how to see the blast
 * radius before trusting it.
 *
 * Lines marked NEW would NOT have matched under the old containment-only rule.
 * Optional argument: how many tracker rows to replay, newest first (default 40).
 */
function testPartnerMatching(limit) {
  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  const tracker = ensureTracker_(spreadsheet);
  if (tracker.getLastRow() < 2) return 'Delivery History is empty; nothing to replay.';

  const propertyMap = loadPropertyMap_();
  const data = tracker.getDataRange().getValues();
  const map = headerMap_(data[0]);
  const rows = data.slice(1).filter(function(row) {
    return String(valueFrom_(row, map, 'Reference Code') || '').trim() !== '';
  });
  const take = Math.max(1, Number(limit || 40));
  const slice = rows.slice(Math.max(0, rows.length - take));

  const lines = [];
  let changed = 0;
  let unchanged = 0;
  let none = 0;
  slice.forEach(function(row) {
    const po = String(valueFrom_(row, map, 'Reference Code') || '').trim();
    const property = propertyMap[po.toUpperCase()] || {};
    const detail = findPartnerMatchDetail_([
      valueFrom_(row, map, 'Full Address'),
      valueFrom_(row, map, 'Property Name'),
      property.buildingName,
      property.landlordName,
      valueFrom_(row, map, 'External Provider')
    ]);
    if (!detail.display) {
      none++;
      return;
    }
    if (detail.how === 'words') {
      changed++;
      lines.push('[NEW]  ' + po + ' -> "' + detail.display + '"' +
        '   (' + Math.round(detail.score * 100) + '% of the PARTNER words, matched on "' +
        detail.matchedOn + '")' +
        '\n         signature would become "Example Housing Company"');
    } else {
      unchanged++;
      lines.push('[same] ' + po + ' -> "' + detail.display + '"');
    }
  });

  const message = 'PARTNER matching replay over the last ' + slice.length + ' tracked send(s)\n' +
    '  new matches (word overlap) : ' + changed + '\n' +
    '  already matched before     : ' + unchanged + '\n' +
    '  no PARTNER                     : ' + none + '\n\n' +
    (lines.length ? lines.join('\n') : '  (nothing matched a PARTNER)') +
    '\n\nOnly the [NEW] lines are a behaviour change. If any of them looks wrong, ' +
    'raise PARTNER_MATCH_RATIO in 1_Sender.gs (currently ' + PARTNER_MATCH_RATIO + ').';
  Logger.log(message);
  return message;
}

/**
 * READ-ONLY. Runs the Florida contract rule against known cases and says which
 * ones behave as expected. Touches no sheet, sends nothing.
 *
 * The cases are built from real rows in the Reference Properties export, so a
 * failure here means the rule would misbehave in production, not that the test
 * data is artificial.
 */
function testFloridaContractRule() {
  const map = headerMap_(EMAIL_HEADERS);
  function suffixFor(values) {
    const row = EMAIL_HEADERS.map(function(header) {
      return values[header] !== undefined ? values[header] : '';
    });
    return floridaContractSuffix_(row, map);
  }

  const cases = [
    ['Example Partner, FL, named in Building Name',
      { 'State': 'FL', 'Building Name': 'Example Partner Bayport', 'Property Name': 'Example Partner Bayport' },
      '(7/90/60 partnership)'],
    ['Example Partner, FL, only in External Provider',
      { 'State': 'FL', 'External Provider': 'EXAMPLE_PARTNER', 'Property Name': 'Bayport' },
      '(7/90/60 partnership)'],
    ['Example Partner, state written out as Florida',
      { 'State': 'Florida', 'External Provider': 'EXAMPLE_PARTNER' },
      '(7/90/60 partnership)'],
    ['Example Partner OUTSIDE Florida - rule must not fire',
      { 'State': 'GA', 'Building Name': 'Example Partner Peachtree', 'External Provider': 'EXAMPLE_PARTNER' },
      ''],
    ['Fort Family, FL - building named "Fusion", brand only in the provider',
      { 'State': 'FL', 'External Provider': 'FORT_FAMILY', 'Property Name': 'Fusion' },
      '(12/90/60 agreement)'],
    ['Fort Family spelled FORT_FAMILY_COMMUNITIES',
      { 'State': 'FL', 'External Provider': 'FORT_FAMILY_COMMUNITIES', 'Property Name': 'Pinnacle' },
      '(12/90/60 agreement)'],
    ['Fort Family spelled FORT_FAMILY_INVESTMENTS_PERIMETER_REALTY_INC',
      { 'State': 'FL', 'External Provider': 'FORT_FAMILY_INVESTMENTS_PERIMETER_REALTY_INC' },
      '(12/90/60 agreement)'],
    ['Priderock, FL - building named "The Dakota at Abacoa"',
      { 'State': 'FL', 'External Provider': 'PRIDEROCK_CAPITAL', 'Property Name': 'The Dakota at Abacoa' },
      '(7/90/60 agreement)'],
    ['State blank, but the address says FL',
      { 'State': '', 'Full Address': '8283 Baymeadows Rd E, Jacksonville, FL 32256, USA',
        'External Provider': 'FORT_FAMILY' },
      '(12/90/60 agreement)'],
    ['State unknown and no FL anywhere - must fail closed',
      { 'State': '', 'Full Address': '8283 Baymeadows Rd E', 'External Provider': 'FORT_FAMILY' },
      ''],
    ['Ordinary Florida property - no rule applies',
      { 'State': 'FL', 'Property Name': 'Crosswind Apartments', 'External Provider': 'APP_ENGINE' },
      ''],
    ['Landlord Name carries the brand',
      { 'State': 'FL', 'Landlord Name': 'Priderock Capital Partners' },
      '(7/90/60 agreement)']
  ];

  const lines = [];
  let failures = 0;
  cases.forEach(function(entry) {
    const actual = suffixFor(entry[1]);
    const ok = actual === entry[2];
    if (!ok) failures++;
    lines.push((ok ? '[OK]   ' : '[FAIL] ') + entry[0] +
      '\n         expected: ' + (entry[2] || '(no suffix)') +
      '\n         actual  : ' + (actual || '(no suffix)'));
  });

  const message = 'Florida contract rule - ' + (cases.length - failures) + '/' + cases.length +
    ' case(s) correct.\n\n' + lines.join('\n') +
    '\n\nExample of the line the owner sees:\n  09/22/2026 - 12/31/2026 ' +
    (suffixFor({ 'State': 'FL', 'External Provider': 'FORT_FAMILY' }) || '');
  Logger.log(message);
  return message;
}

/**
 * READ-ONLY. Runs the central-partner-desk rule against real rows from the
 * property export and says which ones behave as expected. Touches no sheet,
 * sends nothing, opens nothing.
 *
 * Every case below is a real row, including the ones that must NOT fire. Those
 * are the point of the test: this rule changes who receives an owner's figures,
 * so over-reaching is worse than not firing at all.
 */
function testPartnerInboxRule() {
  function inboxFor(values) {
    const rule = partnerInboxFor_(values);
    return rule ? rule.email : '';
  }

  const EXAMPLE_PARTNER = 'partner-app@example.net';
  const cases = [
    ['Provider EXAMPLE_PARTNER - the ordinary case',
      { 'External Provider': 'EXAMPLE_PARTNER', 'Building Name': 'Example Partner Bayport' }, EXAMPLE_PARTNER],
    ['Provider EXAMPLE_PARTNER on a building named after someone else (Camden Clearwater)',
      { 'External Provider': 'EXAMPLE_PARTNER', 'Building Name': 'Camden Clearwater' }, EXAMPLE_PARTNER],
    ['Provider EXAMPLE_PARTNER_PROPERTIES_INC - same company, other spelling',
      { 'External Provider': 'EXAMPLE_PARTNER_PROPERTIES_INC', 'Building Name': 'Example Partner Ridglea' }, EXAMPLE_PARTNER],
    ['Provider EXAMPLE_PARTNER_DULUTH - site-level spelling',
      { 'External Provider': 'EXAMPLE_PARTNER_DULUTH', 'Building Name': 'Example Partner Duluth' }, EXAMPLE_PARTNER],
    ['Outside Florida - the desk is national, so it still fires',
      { 'External Provider': 'EXAMPLE_PARTNER', 'Building Name': 'Example Partner Peachtree Battle' }, EXAMPLE_PARTNER],
    ['Provider blank, Building Name says Example Partner - names speak only here',
      { 'External Provider': '', 'Building Name': 'Example Partner Mount Vernon' }, EXAMPLE_PARTNER],
    ['SEQ - "Example Partner Village Apartment Homes" is a Sequoia community (130 POs)',
      { 'External Provider': 'SEQ', 'Building Name': 'Example Partner Village Apartment Homes',
        'Property Name': 'Example Partner Village Apartment Homes, 6910 NE Ronler Way' }, ''],
    ['The same Sequoia community with the provider column EMPTY - exception list',
      { 'External Provider': '', 'Building Name': 'Example Partner Village Apartment Homes',
        'Property Name': 'Example Partner Village Apartment Homes, 6910 NE Ronler Way' }, ''],
    ['APP_VICINITI_CORPORATE_HOUSING inside a Example Partner building - pays the aggregator',
      { 'External Provider': 'APP_VICINITI_CORPORATE_HOUSING',
        'Building Name': 'APP-Example Partner Bluff Springs' }, ''],
    ['APP_CORPORATE_LIVING_SOLUTIONS at Example Partner Pentagon City',
      { 'External Provider': 'APP_CORPORATE_LIVING_SOLUTIONS',
        'Building Name': 'Example Partner Pentagon City' }, ''],
    ['DITTMAR at Example Partner on Coyote Ridge',
      { 'External Provider': 'DITTMAR', 'Building Name': 'Example Partner on Coyote Ridge' }, ''],
    ['PRIVATE_OWNER - the "EXAMPLE_PARTNER - TEST - DO NOT USE" record',
      { 'External Provider': 'PRIVATE_OWNER', 'Building Name': 'EXAMPLE_PARTNER - TEST - DO NOT USE' }, ''],
    ['EXAMPLE_PARTNERT is a different word - 518 Example Partnert Avenue, New York',
      { 'External Provider': 'evolve', 'Building Name': '518 Example Partnert Avenue' }, ''],
    ['EXAMPLE_PARTNERT with no provider at all - still must not fire',
      { 'External Provider': '', 'Building Name': '518 Example Partnert Avenue' }, ''],
    ['A street called Example Partner is never read - Full Address is not a field here',
      { 'External Provider': '', 'Full Address': '1200 Example Partner Ave, Denver, CO 80206' }, ''],
    ['An ordinary property',
      { 'External Provider': 'GREYSTAR', 'Building Name': 'The Ashton' }, ''],
    ['Nothing on file at all',
      {}, '']
  ];

  const lines = [];
  let failures = 0;
  cases.forEach(function(entry) {
    const actual = inboxFor(entry[1]);
    const ok = actual === entry[2];
    if (!ok) failures++;
    lines.push((ok ? '[OK]   ' : '[FAIL] ') + entry[0] +
      '\n         expected: ' + (entry[2] || '(property contact, unchanged)') +
      '\n         actual  : ' + (actual || '(property contact, unchanged)'));
  });

  const message = 'Central partner desk rule - ' + (cases.length - failures) + '/' + cases.length +
    ' case(s) correct.\n\n' + lines.join('\n') +
    '\n\nWhen it fires, Email Contact becomes the desk and Email Source records ' +
    'the address it replaced, so the tracker still shows the property contact.';
  Logger.log(message);
  return message;
}

/**
 * READ-ONLY. Shows which External Provider values get the Private Owner
 * template. The private list is every spelling found in the Reference Properties
 * export on 2026-09-15; the others are there to prove the rule does not
 * over-reach.
 */
function testPrivateProviderRule() {
  const shouldBePrivate = [
    'PRIVATE_OWNER', 'INDEPENDENT_OWNER', 'PRIVATE_MANAGEMENT_GROUP',
    'PRIVIATE_OWNER', 'PRIVATELY_HELD_COMPANY', 'PRIVATE_RENTAL',
    'PRIVATELY_MANAGED', 'PRIVATE_INDIVDIUAL'
  ];
  const shouldNotBePrivate = [
    'EXAMPLE_PARTNER', 'FORT_FAMILY', 'PRIDEROCK_CAPITAL', 'GREYSTAR', 'AVB_B2C',
    'MARIJANA55', 'APP_MARINA_HAWAII_VACATIONS', 'PROPERTY_MANAGER',
    'PRG_REAL_ESTATE_MANAGEMENT', 'PRESTIGE_REAL_ESTATE_MANAGEMENT',
    'PRIME_GROUP_RESIDENTIAL', 'PRE_3_MULTIFAMILY', ''
  ];

  const lines = [];
  let failures = 0;
  shouldBePrivate.forEach(function(value) {
    const actual = isPrivateProviderValue_(value);
    if (!actual) failures++;
    lines.push((actual ? '[OK]   ' : '[FAIL] ') + 'PRIVATE_OWNER expected -> ' +
      (actual ? 'Private Owner' : 'GENERAL') + '   "' + value + '"');
  });
  shouldNotBePrivate.forEach(function(value) {
    const actual = isPrivateProviderValue_(value);
    if (actual) failures++;
    lines.push((actual ? '[FAIL] ' : '[OK]   ') + 'not private expected -> ' +
      (actual ? 'Private Owner' : 'GENERAL') + '   "' + (value || '(blank)') + '"');
  });

  const total = shouldBePrivate.length + shouldNotBePrivate.length;
  const message = 'Private Owner provider rule - ' + (total - failures) + '/' + total +
    ' case(s) correct.\n' +
    'Rule: exact match in PRIVATE_PROVIDERS, otherwise the letters contain "PRIV".\n\n' +
    lines.join('\n');
  Logger.log(message);
  return message;
}

/* ===== WRONG-SENDER RECOVERY (2026-09-17) ===== */

/**
 * PO used by previewResendAutomatedReachOutForPo() and resendAutomatedReachOutForPo() when they are
 * started from the editor Run button, which cannot pass arguments.
 * Set it, save, then Run. Leave it empty to force passing the PO explicitly.
 */
const RESEND_DEFAULT_PO = '';

/**
 * READ-ONLY. Finds Automated Reach-Out emails in the Sent mailbox that did NOT leave from
 * FROM_ALIAS, and says which account this project is actually running as.
 *
 * Run this first after any suspicion about the sender. It reads the mailbox of
 * whichever account the project runs as, so if that account is the wrong one,
 * the wrongly-sent copies are exactly the ones it can see.
 *
 * Optional argument: how many days back to look (default 7).
 */
function findMisaddressedSends(days) {
  const windowDays = Math.max(1, Number(days || 7));
  const identity = senderIdentity_();
  const wanted = String(FROM_ALIAS || '').toLowerCase();

  const lines = [];
  lines.push('Project runs as   : ' + (identity.effectiveUser || '(could not be identified)'));
  lines.push('Emails must be from: ' + FROM_ALIAS);
  lines.push('Can it send as that: ' + (identity.canSendAsAlias
    ? (identity.isAliasAccount ? 'yes - it IS that account' : 'yes - as a configured alias')
    : 'NO'));
  lines.push('Aliases on this account: ' + (identity.aliases.join(', ') || '(none)'));
  if (identity.error) lines.push('Identity check problem : ' + identity.error);
  lines.push('');

  let threads = [];
  try {
    threads = GmailApp.search('in:sent newer_than:' + windowDays + 'd {subject:"move in" subject:"move-in"}', 0, 500);
  } catch (error) {
    lines.push('Sent mailbox could not be searched: ' + error);
    const failed = lines.join('\n');
    Logger.log(failed);
    return failed;
  }

  const wrong = [];
  let correct = 0;
  let skipped = 0;
  threads.forEach(function(thread) {
    thread.getMessages().forEach(function(message) {
      const subject = String(message.getSubject() || '');
      if (!/move[\s-]*in/i.test(subject)) return;
      if (/\btest\b/i.test(subject)) { skipped++; return; }
      const from = String(message.getFrom() || '');
      if (from.toLowerCase().indexOf(wanted) !== -1) { correct++; return; }
      wrong.push({
        when: Utilities.formatDate(message.getDate(), PIPELINE.TIME_ZONE, 'yyyy-MM-dd HH:mm'),
        from: from,
        to: String(message.getTo() || ''),
        subject: subject
      });
    });
  });

  wrong.sort(function(a, b) { return a.when < b.when ? -1 : 1; });
  lines.push('Window            : last ' + windowDays + ' day(s)');
  lines.push('Sent from ' + FROM_ALIAS + ': ' + correct);
  lines.push('Sent from SOMETHING ELSE   : ' + wrong.length);
  lines.push('Test emails ignored        : ' + skipped);
  lines.push('');
  if (!wrong.length) {
    lines.push('Every Automated Reach-Out email in this mailbox left from the right address.');
    lines.push('If one is known to be wrong, it is in ANOTHER account\'s Sent folder -');
    lines.push('run this again from the account named at the top of diagnoseAccess().');
  } else {
    lines.push('WRONG SENDER:');
    wrong.forEach(function(entry) {
      lines.push('  ' + entry.when + '  from ' + entry.from +
        '\n      to      : ' + entry.to +
        '\n      subject : ' + entry.subject);
    });
    lines.push('');
    lines.push('Reply-To was set to ' + FROM_ALIAS + ' on every one of these, so any reply');
    lines.push('from the owner still arrives in the right inbox. Only the visible sender is wrong.');
    lines.push('To send a corrected copy: previewResendAutomatedReachOutForPo("PO"), then resendAutomatedReachOutForPo("PO").');
  }

  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

/**
 * Shared engine for the two entry points below. Rebuilds the exact same email
 * for one PO and, when `send` is true, sends it once from FROM_ALIAS.
 *
 * Deliberately NOT wired into the queue. The booking is already finalized in
 * Delivery History, and re-opening the queue path would fight every duplicate
 * guard in the pipeline - which is correct behaviour that should stay correct.
 * This is a separate, manual, one-PO-at-a-time operation.
 *
 * It does not reply in the Slack thread, re-apply Gmail labels or touch Operations Team
 * Main: all three already happened on the original send, and repeating them
 * would only add noise.
 */
function runResendAutomatedReachOut_(po, send) {
  const target = String(po || RESEND_DEFAULT_PO || '').trim();
  if (!target) {
    throw new Error('No PO given. Call resendAutomatedReachOutForPo("USA-4066A"), or set ' +
      'RESEND_DEFAULT_PO at the top of 2_SlackPipeline.gs and press Run.');
  }

  const identity = senderIdentity_();
  if (send && !identity.canSendAsAlias) {
    throw new Error('Refusing to resend: this project is running as "' +
      (identity.effectiveUser || 'an unidentified account') + '", which cannot send as ' +
      FROM_ALIAS + '. Fix the account first, otherwise the corrected copy goes out ' +
      'with the same wrong sender. Run diagnoseAccess().');
  }

  const spreadsheet = SpreadsheetApp.openById(SLACK.MAIN_SS_ID);
  const tracker = ensureTracker_(spreadsheet);
  if (tracker.getLastRow() < 2) throw new Error('Delivery History is empty.');

  // The original send is the source of truth for what was sent and to whom.
  const data = tracker.getDataRange().getValues();
  const map = headerMap_(data[0]);
  let original = null;
  for (let row = 1; row < data.length; row++) {
    if (poKey_(valueFrom_(data[row], map, 'Reference Code')) !== poKey_(target)) continue;
    const mode = String(valueFrom_(data[row], map, 'Mode') || '').trim().toUpperCase();
    const status = String(valueFrom_(data[row], map, 'Status') || '').trim().toUpperCase();
    if (mode !== 'LIVE' || status !== 'OK') continue;
    original = data[row];
  }
  if (!original) {
    throw new Error('No successful automated send found in Delivery History for ' + target +
      '. Nothing to resend - if this booking never went out, leave it to the queue.');
  }

  // Rebuild the row exactly as the queue would have handed it over.
  const queueObject = {
    'Record Code': valueFrom_(original, map, 'Record Code'),
    'Reference Code': target,
    'Full Address': valueFrom_(original, map, 'Full Address'),
    'Property Name': valueFrom_(original, map, 'Property Name'),
    'State': valueFrom_(original, map, 'State'),
    'Lease Start': valueFrom_(original, map, 'Lease Start'),
    'Lease End Date': valueFrom_(original, map, 'Lease End Date')
  };

  const mbIndex = loadMbIndex_();
  const propertyMap = loadPropertyMap_();
  const match = findMbMatch_(queueObject, mbIndex);
  if (!match) {
    throw new Error('The fee data for ' + target + ' can no longer be matched: ' +
      describeMbMiss_(queueObject, mbIndex) +
      ' Resending would produce a different email from the one already sent, so it was refused.');
  }

  const item = buildEmailObject_(queueObject, match.row, mbIndex.headerMap, propertyMap);
  if (missingEmailData_(item).length) {
    throw new Error('No usable Email Contact for ' + target + ' right now; refusing to resend.');
  }
  // THE FIGURES MUST STILL BE THE ONES THAT WENT OUT.
  //
  // Source Data is rewritten on every import, so the row behind this PO may have
  // moved since the original send. A "corrected copy" carrying different money
  // or different dates is not a corrected copy - it is a second, contradictory
  // quote in the owner's inbox, which is worse than the wrong sender it was
  // meant to fix. Refuse and let a person decide.
  const drift = [];
  const originalRent = valueFrom_(original, map, 'Monthly Rent');
  const originalStart = valueFrom_(original, map, 'Lease Start');
  const originalEnd = valueFrom_(original, map, 'Lease End Date');
  const originalTo = String(valueFrom_(original, map, 'Recipient') || '').trim().toLowerCase();
  if (moneyAmount_(originalRent) !== moneyAmount_(item['Monthly Rent'])) {
    drift.push('Monthly Rent: sent ' + originalRent + ', would now send ' + item['Monthly Rent']);
  }
  if (fmtDateOnly(originalStart) !== fmtDateOnly(item['Lease Start'])) {
    drift.push('Lease Start: sent ' + fmtDateOnly(originalStart) + ', would now send ' + fmtDateOnly(item['Lease Start']));
  }
  if (fmtDateOnly(originalEnd) !== fmtDateOnly(item['Lease End Date'])) {
    drift.push('Lease End: sent ' + fmtDateOnly(originalEnd) + ', would now send ' + fmtDateOnly(item['Lease End Date']));
  }
  if (originalTo && originalTo.indexOf(String(item['Email Contact'] || '').toLowerCase()) === -1) {
    drift.push('Recipient: sent to ' + originalTo + ', would now send to ' + item['Email Contact']);
  }
  if (drift.length && send) {
    throw new Error('Refusing to resend ' + target + ': the data behind it has changed since the ' +
      'original email, so this would not be the same message.\n  ' + drift.join('\n  ') +
      '\nRun previewResendAutomatedReachOutForPo("' + target + '") to see it, and send by hand if the new ' +
      'figures are the ones the owner should have.');
  }

  const context = contextForItem_(item, propertyMap);
  const displayName = String(item['Display Name'] || item['Property Name'] || target).trim();
  const subject = buildAutomatedReachOutSubject_(displayName, target, context, '',
    item['Full Address'], item['Unit No']);
  const emailData = emailRows_([{ item: item }]);
  const htmlBody = buildHtmlBody(context.templateType, emailData.items[0].rowValues,
    emailData.items, emailData.headerMap, displayName, context);
  const pack = attachmentsForContext_(context);

  const header = [
    'PO              : ' + target,
    'Booking         : ' + (queueObject['Record Code'] || '(none)'),
    'Originally sent : ' + fmtDateOnly(valueFrom_(original, map, 'Sent Timestamp')) +
      ' from ' + (valueFrom_(original, map, 'Recipient') ? 'the automation' : 'the automation'),
    'Original recipient: ' + valueFrom_(original, map, 'Recipient'),
    '',
    'THE CORRECTED COPY WOULD BE:',
    '  From        : ' + FROM_ALIAS + (identity.isAliasAccount
      ? ' (this account)' : ' (alias on ' + identity.effectiveUser + ')'),
    '  To          : ' + item['Email Contact'],
    '  Cc          : ' + ((typeof CC_RECIPIENT === 'string' && CC_RECIPIENT.trim()) || '(none)'),
    '  Reply-To    : ' + FROM_ALIAS,
    '  Template    : ' + context.templateType +
      (context.partnerCompanyName ? ' (PARTNER: ' + context.partnerCompanyName + ')' : ''),
    '  Matched by  : ' + match.method,
    '  Subject     : ' + subject,
    '  Attachments : ' + (pack.names.length ? pack.names.join(', ') : 'none'),
    '  Monthly Rent: ' + (item['Monthly Rent'] === '' || item['Monthly Rent'] == null
      ? 'blank' : item['Monthly Rent']),
    '  Lease Start : ' + fmtDateOnly(item['Lease Start'])
  ];

  if (drift.length) {
    header.push('');
    header.push('*** THE DATA HAS CHANGED SINCE THE ORIGINAL EMAIL ***');
    drift.forEach(function(entry) { header.push('  ' + entry); });
    header.push('  resendAutomatedReachOutForPo() will refuse while this is true.');
  }

  if (!send) {
    const preview = 'PREVIEW ONLY - nothing was sent.\n\n' + header.join('\n') +
      '\n\nThe owner already has one copy of this email. Sending again gives them a ' +
      'second, identical one from the right address. If the only problem was the ' +
      'visible sender, weigh that against the duplicate: Reply-To was already correct.' +
      '\n\nTo send it: resendAutomatedReachOutForPo("' + target + '")';
    Logger.log(preview);
    return preview;
  }

  const started = new Date();
  const sendResult = sendAutomatedReachOutMessage_(item['Email Contact'], subject, htmlBody, context);
  const now = new Date();
  // Mode RESEND, not LIVE. The booking was already counted as sent by the
  // original row, and a second LIVE row would double it in any count of how
  // many emails the automation sends. RESEND still counts as finalized, so the
  // queue will not pick the booking up again.
  appendTrackerRows_(tracker, [trackerRow_(now, item, context, item['Email Contact'], 'RESEND', 'OK',
    'Manual resend from ' + FROM_ALIAS + ' | the earlier copy went out with the wrong sender' +
    ' | MB match: ' + match.method +
    ' | rent ' + (item['Monthly Rent'] === '' || item['Monthly Rent'] == null ? 'blank' : item['Monthly Rent']))]);
  logSender_('resendAutomatedReachOutForPo', started, 'OK',
    target + ' resent to ' + item['Email Contact'] + ' from ' + FROM_ALIAS +
    (sendResult.aliasFallback ? ' | alias fallback was used: ' + sendResult.aliasFallback : ''));

  const done = 'SENT.\n\n' + header.join('\n') +
    '\n\nRecorded in Delivery History as a manual resend. No Slack reply, no label and no ' +
    'Operations Team Main change were made - those already happened on the original send.';
  Logger.log(done);
  return done;
}

/** READ-ONLY. Shows the corrected copy for one PO without sending it. */
function previewResendAutomatedReachOutForPo(po) {
  return runResendAutomatedReachOut_(po, false);
}

/** Sends one corrected copy for one PO, from FROM_ALIAS. Run the preview first. */
function resendAutomatedReachOutForPo(po) {
  return runResendAutomatedReachOut_(po, true);
}

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
    'Property Name': 'Test Property', 'Display Name': 'Test Property',
    'Full Address': '400 Placeholder Lane, Demo City, FL 32003'
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
      'TEST reply posted to booking ' + booking.bookingCode + ' / PO ' + booking.po + ' / thread ' + threadTs + '. No email was sent.');
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
  const messages = loadRecentSentAutomatedReachOutMessages_();
  Logger.log('Sent Automated Reach-Out emails inside the last ' + PIPELINE.SENT_LOOKBACK_DAYS + ' day(s): ' + messages.length +
    '\n' + messages.map(function(item) { return item.subject; }).join('\n'));
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
    // WHO RAN THIS. Added 2026-09-17.
    //
    // A time trigger runs as the account that installed it, not as whoever has
    // the editor open, and the Triggers page only lists the triggers you own
    // yourself. So a second set of triggers installed by another account is
    // invisible from the editor and silently runs the whole pipeline under a
    // different mailbox - which is how an intro email left from
    // realestate-admin@ while a manual diagnoseAccess() reported everything fine.
    //
    // The Note column was always empty. Now every row says which account
    // produced it, so one look at the Central Log after an automatic cycle
    // settles the question with evidence instead of inference.
    let ranAs = '';
    try { ranAs = String(Session.getEffectiveUser().getEmail() || ''); } catch (error) { ranAs = 'unknown'; }
    sheet.appendRow([functionName, startedDate, status, duration, comment || '', 'ran as: ' + ranAs]);
  } catch (error) {
    Logger.log('Sender log failed: ' + error);
  }
}

/* ===== ORCHESTRATOR AND TRIGGERS ===== */

function runAutomatedReachOutPipeline() {
  captureSlackBookings();
  monitorAutomatedReachOutQueue();
}

// Compatibility hook used by the import files after a fresh CSV import.
function reEnrichSlackRows_() {
  monitorAutomatedReachOutQueue();
}

function createPipelineTriggers() {
  const managedFunctions = ['captureSlackBookings', 'monitorAutomatedReachOutQueue', 'runAutomatedReachOutPipeline',
    'clearWarningsDaily', 'clearWarningsWeekly'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (managedFunctions.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('captureSlackBookings').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('monitorAutomatedReachOutQueue').timeBased().everyMinutes(15).create();
  createWarningsCleanupTriggers();
}

/**
 * Installs only the two Warnings cleanups, without touching the capture or the
 * sending trigger. Safe to run on its own.
 *   clearWarningsDaily  - every day at 22h, removes resolved rows only
 *   clearWarningsWeekly - Mondays at 7h, full reset
 */
function createWarningsCleanupTriggers() {
  const cleanupFunctions = ['clearWarningsDaily', 'clearWarningsWeekly'];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (cleanupFunctions.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('clearWarningsDaily').timeBased().atHour(22).nearMinute(0).everyDays(1).create();
  ScriptApp.newTrigger('clearWarningsWeekly').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).nearMinute(0).create();
  logSender_('createWarningsCleanupTriggers', new Date(), 'OK',
    'Daily resolved-only cleanup at 22h and full weekly reset on Mondays at 7h installed.');
}

/**
 * READ-ONLY. Lists the triggers THIS account owns, and explains what it cannot
 * see. Run it from every account that might have touched the project.
 *
 * Apps Script has no way to list another account's triggers, so a second set
 * installed elsewhere is invisible here. Two symptoms give it away:
 *
 *   - the pipeline executes far more often than the intervals below
 *   - the Central Log "Note" column names an account other than this one
 */
function listAutomatedReachOutTriggers() {
  const identity = senderIdentity_();
  const lines = [];
  lines.push('Signed in as : ' + (identity.effectiveUser || '(unknown)'));
  lines.push('Sending alias: ' + FROM_ALIAS +
    (identity.canSendAsAlias ? ' - can send as it' : ' - CANNOT send as it'));
  lines.push('');

  const managed = ['captureSlackBookings', 'monitorAutomatedReachOutQueue', 'runAutomatedReachOutPipeline',
    'clearWarningsDaily', 'clearWarningsWeekly', 'importAutomatedReachOutMbData',
    'importPropertyOnDemandData', 'importAutomatedReachOutFastPathData', 'importDirectSourceData'];

  const mine = {};
  let total = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    const handler = trigger.getHandlerFunction();
    if (!mine[handler]) mine[handler] = 0;
    mine[handler]++;
    total++;
  });

  lines.push('TRIGGERS OWNED BY THIS ACCOUNT (' + total + '):');
  if (!total) {
    lines.push('  (none - every trigger running this project belongs to someone else)');
  } else {
    Object.keys(mine).sort().forEach(function(handler) {
      lines.push('  ' + mine[handler] + ' x ' + handler +
        (mine[handler] > 1 ? '   <<< DUPLICATED, one is enough' : ''));
    });
  }

  const missing = managed.filter(function(handler) { return !mine[handler]; });
  lines.push('');
  lines.push('EXPECTED BUT NOT OWNED HERE:');
  if (!missing.length) {
    lines.push('  (none)');
  } else {
    missing.forEach(function(handler) { lines.push('  ' + handler); });
    lines.push('');
    lines.push('  Each of these is either not installed at all, or installed by another');
    lines.push('  account - and in that case it RUNS AS that account. That is what puts a');
    lines.push('  different address in the From line of a sent email.');
  }

  lines.push('');
  lines.push('HOW TO CONFIRM:');
  lines.push('  1. Open the Central Log, tab "' + LOG_CONFIG.SHEET_NAME + '".');
  lines.push('  2. Wait for one automatic cycle, then read the Note column.');
  lines.push('  3. Any row saying "ran as:" something other than ' + FROM_ALIAS);
  lines.push('     is a trigger owned by that account.');
  lines.push('  4. Sign in as that account and run disableAutomatedReachOutAutomationTriggers()');
  lines.push('     there - only the owner can delete its own triggers.');

  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

/** Installs ONLY the capture trigger, so the queue can be reviewed before any send. */
function createCaptureTriggerOnly() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'captureSlackBookings') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('captureSlackBookings').timeBased().everyMinutes(10).create();
  logSender_('createCaptureTriggerOnly', new Date(), 'OK', 'Capture trigger installed. No sending trigger was created.');
}

function createPipelineTrigger() {
  createPipelineTriggers();
}

/** Emergency stop / rollback: removes every trigger managed by this Automated Reach-Out project. */
function disableAutomatedReachOutAutomationTriggers() {
  const managedFunctions = [
    'captureSlackBookings',
    'monitorAutomatedReachOutQueue',
    'runAutomatedReachOutPipeline',
    'clearWarningsDaily',
    'clearWarningsWeekly',
    'importAutomatedReachOutMbData',
    'importPropertyOnDemandData'
  ];
  let removed = 0;
  const survivors = [];
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (managedFunctions.indexOf(trigger.getHandlerFunction()) === -1) return;
    try {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    } catch (error) {
      // Apps Script only lets an account delete the triggers it owns.
      survivors.push(trigger.getHandlerFunction());
    }
  });
  const note = removed + ' managed trigger(s) removed.' +
    (survivors.length
      ? ' STILL RUNNING (owned by another account, that account must delete them): ' +
        uniqueValues_(survivors).join(', ')
      : '');
  logSender_('disableAutomatedReachOutAutomationTriggers', new Date(), survivors.length ? 'REVIEW' : 'OK', note);
  Logger.log(note);
}
