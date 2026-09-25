/**
 * DIRECT SOURCE — import of the CRM report emails into the "Direct Source Data" tab.
 *
 * WHY THIS EXISTS
 *   Everything else in this pipeline reads CRM through data warehouse, and
 *   that hop loads once a day (~01:50 UTC). Measured on 2026-08-30: a quote
 *   accepted at 14:00 was not queryable until the next morning. The CRM
 *   reports skip data warehouse entirely, so the data is available minutes after
 *   Sales accepts the quote.
 *
 * WHAT IT READS
 *   Gmail messages carrying the label "CRM Automation", sent to
 *   finance-operations@example.com. Subjects vary by schedule slot:
 *     "Accepted New Quotes - Weekly 7 AM"
 *     "Accepted New Quotes - Weekly 9 AM"   ... and so on.
 *
 *   Matching is by LABEL, not by exact subject, precisely because the subject
 *   changes with every slot. Adding a sixth report needs no code change.
 *
 *   Each report carries the last 7 days, so the newest message alone is enough
 *   and the tab is rewritten from it. Older messages are not merged in.
 *
 * THE FILE IS EXCEL, NOT CSV
 *   Apps Script cannot parse .xlsx. The attachment is uploaded to Drive with
 *   conversion to a Google Sheet, read, and the temporary file is deleted in a
 *   finally block. A .csv attachment is parsed directly, so switching the
 *   subscription format later needs no code change.
 *
 *   REQUIRES the Drive advanced service: Apps Script editor > Services > + >
 *   Drive > Add. Handles both v2 (Files.insert) and v3 (Files.create).
 *
 * THE EXPORT IS NOT A CLEAN TABLE
 *   A CRM formatted export looks like this:
 *       row 2   Accepted New Quotes - Weekly
 *       row 3   As of 2026-09-04 15:17:30 Mountain Standard Time ...
 *       row 6   Filtered By
 *       row 9   Status equals Accepted
 *       row 11  Quote Number | Property: Account Name | Status | ...   <- header
 *       row 12  ...data
 *       row 23  Total | Sum | 31381.0 | ...                            <- not data
 *       row 24  Count | 11.0                                           <- not data
 *       row 27  Confidential Information - Do Not Distribute
 *   So the header row is FOUND, not assumed to be row 1, and any row without a
 *   value in one of DIRECT_SOURCE.ANCHOR_HEADERS is dropped. Exporting as
 *   "Details Only" removes most of this, but the import does not rely on it.
 *
 * LOGS
 *   Central Log spreadsheet, tab "CRM Data", same six columns the other
 *   importers use: Function, Timestamp, Status, Duration (sec), Comment, Note.
 *
 * WHAT IT DOES NOT DO
 *   It only fills the tab. Nothing reads "Direct Source Data" yet - wiring it into
 *   findMbMatch_ needs a header alias layer, because CRM says
 *   "TH Monthly Rent" where Source Data says "Monthly Rent". That is the next step.
 */

const DIRECT_SOURCE = {
  MAIN_SS_ID: 'YOUR_MAIN_SPREADSHEET_ID',
  TAB: 'Direct Source Data',

  LOG_SS_ID: 'YOUR_LOG_SPREADSHEET_ID',
  LOG_TAB: 'CRM Data',

  /** Matching is by label. The subject differs per schedule slot. */
  GMAIL_LABEL: 'CRM Automation',
  /** Fallback only, used when the label search comes back empty. */
  SUBJECT_PREFIX: 'Accepted New Quotes',
  SEARCH_DAYS: 3,
  SEARCH_LIMIT: 50,
  /** Above this the source is flagged stale in the log, but still imported. */
  MAX_AGE_HOURS: 12,

  LAST_MESSAGE_PROPERTY: 'SFDIRECT_LAST_MSG_ID',

  /**
   * The header row is the first row carrying at least MIN_HEADER_HITS of these.
   * Deliberately a superset - the report can drop columns without breaking it.
   */
  KNOWN_HEADERS: ['Quote Number', 'Quote Name', 'Status', 'Accepted On', 'Unit Contact Email',
    'Mailing Address', 'Ship To Street', 'Ship To City', 'Ship To State/Province',
    'Ship To Zip/Postal Code', 'TH Start Date', 'TH End Date', 'TH Monthly Rent',
    'TH Security Deposit', 'Property: Account Name'],
  MIN_HEADER_HITS: 3,

  /** A row is data only when at least one of these columns is filled. */
  ANCHOR_HEADERS: ['Quote Number', 'Status', 'Accepted On'],

  /**
   * Quote statuses that must never be used to price an email.
   *
   * The report is titled "Accepted New Quotes" but carries every status, and
   * loadDirectSourceIndex_ was indexing all of them. That is precisely the defect
   * behind the 2026-08-27 incident, where Source Data read a declined quote and an
   * owner received another property's figures.
   *
   * Measured over 180 days (2026-09-16), the statuses in use are:
   *
   *   declined 2766 | sent 1156 | am_declined 704 | Accepted 401
   *   unit_declined 211 | needs_review 62 | unit_confirmed 20
   *   background_pending 9 | created 6
   *
   * All three declined variants contain "declin", so one pattern covers them -
   * 3,681 of 5,335 quotes, 69%.
   *
   * Everything else is kept rather than allow-listing Accepted, because
   * Accepted-only was tested and is also wrong: USA-3902A's real terms sit on a
   * needs_review quote while its only Accepted quotes are from 2024 with a
   * different rent. This matches the rule already agreed for
   * Source Data_REPLACEMENT.sql.
   */
  EXCLUDED_STATUS_PATTERN: /declin/i,

  /**
   * SEND ON A DECLINED QUOTE WHEN IT IS THE ONLY ONE.
   *
   * Turned on 2026-09-22 at Maintainer's request: "se tiver nas notificacoes e
   * tiver no SF data ENVIA mesmo declined".
   *
   * WHAT CHANGED. Declined quotes used to be thrown away before indexing.
   * They are now indexed and flagged, and a declined quote is only ever used
   * when NO live quote matches the same booking.
   *
   * WHY IT IS RANKED AND NOT SIMPLY ALLOWED. The 2026-08-27 incident was not
   * "a declined quote was used". It was "a declined quote BEAT an accepted one
   * on the same property": 00296278 unit_declined won over 00296338 Accepted,
   * and an owner received another property's figures. Ranking keeps that from
   * ever happening again while still sending the case Maintainer actually hit -
   * USA-4081A, where quote 296480 (unit_declined) is the only quote that
   * exists for 32618 HP Johnson.
   *
   * WHAT IT COSTS. A declined quote can carry figures that were never agreed.
   * Every send that lands on one is recorded in Delivery History with a method
   * ending in _DECLINED, so they can be reviewed as a group.
   *
   * Set to false to go back to refusing them outright.
   */
  ALLOW_DECLINED_QUOTES: true,

  /**
   * SEVERAL QUOTES AT ONE BUILDING, AND THEY DISAGREE.
   *
   * false (default): the booking waits. true: the newest quote is used.
   *
   * Measured over 120 days of non-declined quotes, grouped by house number and
   * state inside the week the report covers (2026-09-22):
   *
   *   270 keys (95.7%)  one quote - no ambiguity, sends either way
   *     3 keys (1.1%)   several quotes, SAME rent - already sent, agreement
   *     9 keys (3.2%)   several quotes, DIFFERENT rent - a guess is a certificaten flip
   *
   * The 3.2% is why this is off. Largest disagreement found: $514/month, which
   * is 11011 West North Ave in Wauwatosa on 2026-09-22 - two whole-building
   * quotes, $2,240 and $1,726, six bookings between them and nothing in the
   * data saying which booking takes which. Picking the newest would have put
   * the wrong rent in front of the owner on four of the six.
   *
   * That is roughly one key every thirteen days. Turning this on trades "the
   * booking waits for a person" for "one wrong rent a fortnight".
   */
  SEND_ON_AMBIGUOUS_BUILDING: false,

  /**
   * Last-resort matching on postcode + state when the street address in
   * CRM does not agree with the booking's. Added 2026-09-16 at Maintainer's
   * request, after USA-4066A stayed stuck behind a quote whose street was
   * recorded as "(approx)" on a different road.
   *
   * Only used when the house-number keys matched nothing, and only when it
   * resolves to exactly one quote - by itself, or after an exact lease-date
   * match breaks the tie. See findDirectSourceRow_ for the measured numbers.
   *
   * Set to false to go back to street-number matching only.
   */
  ALLOW_ZIP_STATE_FALLBACK: true,

  /**
   * CRM column -> Source Data column. The report cannot rename its own
   * columns, so the translation lives here. Everything downstream then reads
   * the names it already knows.
   */
  HEADER_ALIASES: {
    'Quote Number': 'Source Quote Number',
    'Ship To Street': 'Full Address',
    'Ship To State/Province': 'State',
    'TH Start Date': 'Lease Start',
    'TH End Date': 'Lease End Date',
    'TH Monthly Rent': 'Monthly Rent',
    'TH Security Deposit': 'Security Deposit',
    'TH Cleaning Fee': 'Prop Cleaning Fee',
    'TH Admin Fee': 'Admin',
    'TH App Fee': 'Application',
    'TH Pet Fee': 'Prop Pet Fee One-Time',
    'TH Monthly Pet Rent': 'Prop Pet Fee Monthly',
    'TH Monthly Parking': 'Parking Fee',
    'TH Monthly Prop Tax Amount': 'Prop Tax Amount',
    // "PROP Utilities" - the utility line the PROPERTY charges, not the utilities
    // Example Housing Company budgets. The two are different fields and different sizes:
    // measured over 180 days, TH_MONTHLY_PROP_UTILITIES runs $25-$95 while
    // TH_MONTHLY_UTILITIES runs $229-$484. Added 2026-09-23 after a property
    // manager reported the fee missing from the intro email.
    'TH Monthly Prop Utilities': 'Prop Utilities',
    'TH Monthly Other': 'Monthly Other',
    'TH Monthly Other Desc': 'Monthly Other Desc',
    'TH Pet Deposit': 'Pet Deposit',
    /**
     * ONE-TIME PROPERTY CHARGES. The twin of Monthly Other, and the largest
     * gap found on 2026-09-23: 247 non-declined quotes in 180 days carry one,
     * median $150, and 226 of them - 91% - name a PROP item.
     *
     * What lands here: PROP BG, PROP Amenity Fee, PROP Move Out Fee, PROP
     * Reservation Fee, PROP Key Fee, PROP Account Set Up, PROP Automated Reach-Out Fee.
     * The dedicated TH_BACKGROUND_FEE column is filled on ZERO quotes, so the
     * team writes background checks in here as "PROP BG" instead.
     *
     * buildPerPOTable only prints it when the description starts with PROP, so
     * a Example Housing Company charge written in the same box still never reaches the
     * owner.
     */
    'TH Other Fee': 'Other Fee',
    'TH Other Fee Desc': 'Other Fee Desc',
    // The deposit twin. One quote in 180 days, but it costs a line to carry.
    'TH Other Deposit': 'Other Deposit',
    'TH Other Deposit Desc': 'Other Deposit Desc',
  },

  /**
   * Recipient. "Unit Contact Email" is the correct field - measured 86 of 87
   * filled. "Property: Email" is the Account's own address and was filled on
   * 1 of 11 rows, so it is only a fallback. Both are read, in this order.
   */
  EMAIL_HEADERS_IN_ORDER: ['Unit Contact Email', 'Property: Email'],

  /**
   * Require the street NAME to agree, on top of house number + postcode.
   *
   * Same number and same 5-digit postcode on two different streets is possible
   * ("221 Main St" and "221 Oak Ave" in one zip), and this feed is now the
   * primary matcher rather than a backstop, so the extra signal is worth it.
   *
   * Measured over 78 pairs where number and postcode already agreed: the raw
   * street name disagreed on 14, and ALL 14 were the same address abbreviated
   * differently - "S 54th St" against "South 54th Street", "SE Division St"
   * against "Southeast Division Street", "Sunridge Rd" against "Sun Ridge
   * Road". After normalisation 12 of those 14 agree. The remaining 2 are
   * genuinely different names for one road ("State Hwy 11b" / "New York 11B")
   * and are refused, which costs a delay and never a wrong figure.
   *
   * Set to false to match on number + postcode alone.
   */
  REQUIRE_STREET_MATCH: true,

  /** Master switch. false makes the import a no-op that still logs. */
  ENABLED: true
};

/* ===== NAME RESOLUTION ===== */

/**
 * The property name for the email greeting and subject.
 *
 * "Property: Account Name" is the right source but is EMPTY on about 5% of
 * quotes, and those are disproportionately buildings rather than private
 * owners - Seasons at Elgin, Mayfair Reserve, Flats on Chapel, Forge on
 * Brighton, Windscape Apartments Homes. Without a fallback those emails go out
 * with no name at all.
 *
 * "Quote Name" is never empty and always ends in " - <order number>", so
 * stripping that suffix yields the property name. Measured over 173 accepted
 * quotes in 60 days:
 *
 *   Property: Account Name empty ........ 9
 *   Quote Name empty .................... 0
 *   Quote Name matching " - NNNNNN" ..... 173 of 173
 *   Both present and equal after strip .. 161 of 164
 *
 * The account name WINS whenever it exists, because in the 3 rows where they
 * differ it is the fuller version: "Nick B. & Alexis" against "Nick B.",
 * "Crosswind Apartments - Corporate Accommodations of Northwest Florida, Inc."
 * against "Crosswind Apartments".
 *
 * Not called by the import itself, which stores both columns untouched. This is
 * for the layer that maps the CRM headers onto the Source Data ones.
 */
function sfPropertyNameFrom_(accountName, quoteName) {
  const account = String(accountName || '').trim();
  if (account) return account;
  return String(quoteName || '').trim().replace(/\s*-\s*\d+\s*$/, '').trim();
}

/* ===== ADDRESS KEYS ===== */

/**
 * The significant part of a street name, for confirming two addresses are the
 * same road. Strips, in order:
 *
 *   "APPROX:" ......... the quote sometimes leads with it
 *   the house number .. including forms like "822 1/2" and "44-030"
 *   directionals ...... N / S / E / W / NE / NW / SE / SW and their long forms
 *   street types ...... ST STREET AVE AVENUE RD ROAD DR DRIVE LN LANE CT COURT
 *                       CIR CIRCLE BLVD HWY PL PLACE WAY TER TRL PKWY LOOP
 *   everything non-alphanumeric
 *
 * The directional strip is the one that matters: measured over 78 addresses
 * whose number and postcode already agreed, 14 street names disagreed and 12
 * of those were only an abbreviated directional.
 *
 *   "5915 SE Division St"          -> DIVISION
 *   "5915 Southeast Division Street" -> DIVISION
 *   "6212 Sunridge Rd"             -> SUNRIDGE
 *   "6212 Sun Ridge Road"          -> SUNRIDGE
 *
 * Returns '' when nothing significant survives, and callers must treat that as
 * "cannot confirm" rather than as a mismatch.
 */
function sfStreetToken_(street) {
  let value = String(street || '').toUpperCase();
  value = value.replace(/^\s*APPROX\.?:?\s*/, '');
  value = value.replace(/^\s*[0-9]+(?:[-\/][0-9]+)*\s*/, '');
  value = value.replace(/[^A-Z0-9\s]/g, ' ');

  const drop = ['NORTH', 'SOUTH', 'EAST', 'WEST', 'NORTHEAST', 'NORTHWEST',
    'SOUTHEAST', 'SOUTHWEST', 'N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW',
    'ST', 'STREET', 'AVE', 'AVENUE', 'AV', 'RD', 'ROAD', 'DR', 'DRIVE',
    'LN', 'LANE', 'CT', 'COURT', 'CIR', 'CIRCLE', 'BLVD', 'BOULEVARD',
    'HWY', 'HIGHWAY', 'PL', 'PLACE', 'WAY', 'TER', 'TERRACE', 'TRL', 'TRAIL',
    'PKWY', 'PARKWAY', 'LOOP', 'SQ', 'SQUARE', 'UNIT', 'APT', 'STE', 'SUITE'];

  return value.split(/\s+/).filter(function(word) {
    return word !== '' && drop.indexOf(word) === -1;
  }).join('');
}

/**
 * The keys a CRM row is indexed under, and the token used to confirm a
 * candidate. Same shape is built from the Slack address at match time, so the
 * two sides are always normalised by identical code.
 *
 *   byZipState "28570|NC" postcode + state, no house number. Last resort, for
 *                         the rows where CRM recorded the wrong street.
 *   byZip   "221|28570"   house number + postcode. The primary key.
 *   byState "221|NC"      house number + state. Only used when there is no
 *                         postcode, which happens on some Slack addresses
 *                         ("962 Birchfield drive", "1747 Wickersham Dr,
 *                         Anchorage, AK, USA").
 *   token   "GALESSHORE"  the street name, for confirmation.
 */
/**
 * Five-digit postcode out of the Ship To column.
 *
 * The column arrives through a spreadsheet, so a New England postcode loses its
 * leading zero on the way: Danbury CT is stored as the number 6810 and shows up
 * as "6810.0". A plain \d{5} never matches it, which silently kept every
 * property in CT, MA, NJ, NH, RI, ME, VT and PR out of the postcode index.
 */
function sfZip5_(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const five = text.match(/\b(\d{5})\b/);
  if (five) return five[1];
  const short = text.match(/^0*(\d{3,4})(?:\.0+)?$/);
  return short ? ('00000' + short[1]).slice(-5) : '';
}

function sfAddressKeysFrom_(street, state, zip) {
  const value = String(street || '').trim();
  const result = { byZip: '', byState: '', byZipState: '', token: sfStreetToken_(value) };

  const zip5 = sfZip5_(zip);
  const stateCode = String(state || '').trim().toUpperCase();

  // POSTCODE + STATE. Deliberately independent of the house number, because it
  // exists precisely for the rows where the street is unusable - CRM
  // records approximate and plainly wrong street addresses, and the quote for
  // USA-4066A said "1564 Hilton Ave (approx)" for a booking at 1422 Lathrop St.
  // Weak on its own, so findDirectSourceRow_ only uses it as a last resort and only
  // when it resolves to exactly one quote.
  if (zip5 && stateCode.length === 2) result.byZipState = zip5 + '|' + stateCode;

  const numberMatch = value.replace(/^\s*APPROX\.?:?\s*/i, '').match(/^([0-9][0-9-]*)/);
  if (!numberMatch) return result;

  const number = String(numberMatch[1]).replace(/-+$/, '');
  if (!number) return result;

  if (zip5) result.byZip = number + '|' + zip5;
  if (stateCode.length === 2) result.byState = number + '|' + stateCode;

  return result;
}

/** Same three keys, built from a free-text address plus the queue's State column. */
function sfAddressKeysFromText_(text, stateHint) {
  const value = String(text || '').trim();
  // The house number is not the postcode. A five-digit one used to be read as
  // the zip, which built keys that matched nothing and, through stateHint,
  // could even name the wrong state. See zipFromAddressText_ in 1_Sender.gs.
  const zip = typeof zipFromAddressText_ === 'function' ? zipFromAddressText_(value) : '';

  let state = String(stateHint || '').trim().toUpperCase();
  if (state.length !== 2 && state && typeof stateNameToCode_ === 'function') {
    state = String(stateNameToCode_(stateHint) || '').trim().toUpperCase();
  }
  if (state.length !== 2) {
    const fromAddress = value.match(/\b([A-Z]{2})\b(?=[\s,]*(?:USA)?\s*$)/);
    state = fromAddress ? fromAddress[1] : '';
  }
  return sfAddressKeysFrom_(value, state, zip);
}

/**
 * A cell that may hold a Date or a date written as text, as a Date or null.
 * The tab is read with getValues(), so both shapes occur depending on how the
 * report was converted.
 */
function sfToDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** True when the quote's lease period contains the booking's start date. */
function sfCoversDate_(entry, wanted) {
  const target = sfToDate_(wanted);
  const from = sfToDate_(entry.leaseStart);
  const to = sfToDate_(entry.leaseEnd);
  if (!target || !from || !to) return false;
  return from.getTime() <= target.getTime() && target.getTime() <= to.getTime();
}

/**
 * Narrows a candidate pool by one test.
 *
 * An EMPTY result means the test could not decide - not that every candidate
 * failed - so the pool is returned untouched and the next test gets its turn.
 * Without this a single unhelpful test would throw away candidates that a later,
 * better test could have separated.
 */
function sfNarrow_(pool, predicate) {
  const next = pool.filter(predicate);
  return next.length ? next : pool;
}

/**
 * True when two street tokens do not contradict each other. An empty token on
 * either side means "cannot confirm", which is not the same as a mismatch.
 */
function sfStreetAgrees_(tokenA, tokenB) {
  if (!DIRECT_SOURCE.REQUIRE_STREET_MATCH) return true;
  const a = String(tokenA || '');
  const b = String(tokenB || '');
  if (!a || !b) return true;
  return a === b;
}

/* ===== INDEX ===== */

/**
 * Reads the "Direct Source Data" tab and returns
 *   { byZip: { key: [ {row, token, unit, leaseStart, leaseEnd, quoteNumber} ] },
 *     byState: { ... }, byZipState: { ... }, rowCount }
 * where each row is laid out to match Source Data's own header map, so
 * buildEmailObject_ and everything downstream work unchanged.
 *
 * Three values are derived rather than copied:
 *   Property Name  account name, else Quote Name without its " - NNNNNN"
 *   Unit No        the "unit" key inside the Mailing Address JSON, with
 *                  placeholders such as n/a and TBD blanked out
 *   Email Contact  Unit Contact Email, else Property: Email
 *
 * Never throws. A missing tab or any read error yields an empty index, so the
 * pipeline degrades to exactly its previous behaviour.
 */
function loadDirectSourceIndex_(mbHeaderMap) {
  const empty = { byZip: {}, byState: {}, byZipState: {}, rowCount: 0, excluded: {} };
  if (!DIRECT_SOURCE.ENABLED) return empty;
  if (!mbHeaderMap || !Object.keys(mbHeaderMap).length) return empty;

  let data;
  try {
    const sheet = SpreadsheetApp.openById(DIRECT_SOURCE.MAIN_SS_ID).getSheetByName(DIRECT_SOURCE.TAB);
    if (!sheet || sheet.getLastRow() < 2) return empty;
    data = sheet.getDataRange().getValues();
  } catch (error) {
    Logger.log('Direct Source index skipped: ' + error);
    return empty;
  }

  const sfMap = headerMap_(data[0]);

  let width = 0;
  Object.keys(mbHeaderMap).forEach(function(header) {
    if (mbHeaderMap[header] + 1 > width) width = mbHeaderMap[header] + 1;
  });
  if (!width) return empty;

  function directSourceCell_(source, header) {
    return sfMap[header] === undefined ? '' : source[sfMap[header]];
  }
  function put(shaped, mbHeader, value) {
    if (mbHeaderMap[mbHeader] !== undefined) shaped[mbHeaderMap[mbHeader]] = value;
  }

  const byZip = {};
  const byState = {};
  const byZipState = {};
  let rowCount = 0;

  let declinedSkipped = 0;
  // Declined quotes are kept in a side index, keyed the same way, ONLY so the
  // warning can say "there is a quote for this address but it is declined"
  // instead of "nothing was found". Nothing reads this for matching.
  const excluded = {};

  for (let row = 1; row < data.length; row++) {
    const source = data[row];

    // A declined quote is indexed but FLAGGED. findDirectSourceRow_ drops the
    // flagged ones whenever a live quote is in the same pool, so a declined
    // quote can only ever win when it is the only candidate there is.
    //
    // With ALLOW_DECLINED_QUOTES off, they are not indexed at all and go to the
    // side list that only the warning text reads.
    const status = String(directSourceCell_(source, 'Status') || '').trim();
    const isDeclined = DIRECT_SOURCE.EXCLUDED_STATUS_PATTERN.test(status);
    if (isDeclined) {
      declinedSkipped++;
      const outKeys = sfAddressKeysFrom_(
        String(directSourceCell_(source, 'Ship To Street') || '').trim(),
        String(directSourceCell_(source, 'Ship To State/Province') || '').trim(),
        String(directSourceCell_(source, 'Ship To Zip/Postal Code') || '').trim());
      if (outKeys.byZipState) {
        if (!excluded[outKeys.byZipState]) excluded[outKeys.byZipState] = [];
        excluded[outKeys.byZipState].push({
          quoteNumber: String(directSourceCell_(source, 'Quote Number') || '').trim(),
      rent: directSourceCell_(source, 'TH Monthly Rent'),
          status: status,
          street: String(directSourceCell_(source, 'Ship To Street') || '').trim(),
          leaseStart: directSourceCell_(source, 'TH Start Date')
        });
      }
      if (!DIRECT_SOURCE.ALLOW_DECLINED_QUOTES) continue;
    }

    const street = String(directSourceCell_(source, 'Ship To Street') || '').trim();
    const state = String(directSourceCell_(source, 'Ship To State/Province') || '').trim();
    const zip = String(directSourceCell_(source, 'Ship To Zip/Postal Code') || '').trim();
    const keys = sfAddressKeysFrom_(street, state, zip);
    // byZipState is now enough to index a row. A quote whose street has no
    // house number at all used to be dropped here and became invisible.
    if (!keys.byZip && !keys.byState && !keys.byZipState) continue;

    const shaped = [];
    for (let column = 0; column < width; column++) shaped.push('');

    // Straight aliases.
    Object.keys(DIRECT_SOURCE.HEADER_ALIASES).forEach(function(sfHeader) {
      if (sfMap[sfHeader] === undefined) return;
      put(shaped, DIRECT_SOURCE.HEADER_ALIASES[sfHeader], source[sfMap[sfHeader]]);
    });

    // Property name: account name wins, Quote Name without the order number is
    // the fallback. Measured: the account name is empty on 5% of quotes, and
    // those are disproportionately buildings.
    put(shaped, 'Property Name',
      sfPropertyNameFrom_(directSourceCell_(source, 'Property: Account Name'), directSourceCell_(source, 'Quote Name')));

    // Unit lives only inside the Mailing Address JSON.
    let unit = '';
    try {
      const parsed = JSON.parse(String(directSourceCell_(source, 'Mailing Address') || '{}'));
      unit = String(parsed.unit || '').trim();
    } catch (error) {
      unit = '';
    }
    if (typeof isSentinelUnitToken_ === 'function' && isSentinelUnitToken_(unit)) unit = '';
    put(shaped, 'Unit No', unit);

    // Recipient.
    let email = '';
    for (let i = 0; i < DIRECT_SOURCE.EMAIL_HEADERS_IN_ORDER.length && !email; i++) {
      email = String(directSourceCell_(source, DIRECT_SOURCE.EMAIL_HEADERS_IN_ORDER[i]) || '').trim();
    }
    put(shaped, 'Email Contact', email);

    // The lease dates travel on the entry so the postcode tier can use them to
    // break a tie without needing the MB header map at match time.
    const entry = {
      row: shaped,
      token: keys.token,
      unit: unit,
      leaseStart: directSourceCell_(source, 'TH Start Date'),
      leaseEnd: directSourceCell_(source, 'TH End Date'),
      quoteNumber: String(directSourceCell_(source, 'Quote Number') || '').trim(),
      rent: directSourceCell_(source, 'TH Monthly Rent'),
      status: status,
      declined: isDeclined
    };
    if (keys.byZip) {
      if (!byZip[keys.byZip]) byZip[keys.byZip] = [];
      byZip[keys.byZip].push(entry);
    }
    if (keys.byState) {
      if (!byState[keys.byState]) byState[keys.byState] = [];
      byState[keys.byState].push(entry);
    }
    if (keys.byZipState) {
      if (!byZipState[keys.byZipState]) byZipState[keys.byZipState] = [];
      byZipState[keys.byZipState].push(entry);
    }
    rowCount++;
  }

  if (declinedSkipped) {
    Logger.log('Direct Source index: ' + declinedSkipped + ' declined quote(s) ' +
      (DIRECT_SOURCE.ALLOW_DECLINED_QUOTES
        ? 'indexed as last-resort candidates, '
        : 'excluded, ') + rowCount + ' row(s) indexed in total.');
  }
  return {
    byZip: byZip, byState: byState, byZipState: byZipState,
    rowCount: rowCount, declinedSkipped: declinedSkipped, excluded: excluded
  };
}

/**
 * Resolves a queue row against the Direct Source index.
 * Returns the shaped row, or null when nothing matches unambiguously.
 *
 * Requires all of:
 *   - a usable address key from the Slack address
 *   - exactly ONE candidate under that key
 *   - the street name not contradicting
 *   - the unit not contradicting, by the same rule the fast path uses

/**
 * A sentence naming the declined quote that sits at this booking's address, or
 * '' when there is none.
 *
 * Written on 2026-09-22 after USA-4081A. The only quote in CRM for
 * 32618 HP Johnson was 296480, status unit_declined, so the matcher correctly
 * refused it - and the warning then said "not found in Source Data", which sent
 * Maintainer looking in the wrong file for forty minutes. The automation was not
 * slow; it was refusing, and it should say so.
 *
 * Reads the side index only. Nothing here can make a declined quote usable.
 */
function sfDeclinedNoteFor_(queueObject) {
  if (typeof loadDirectSourceIndex_ !== 'function' || typeof loadMbIndex_ !== 'function') return '';
  let index;
  try {
    index = loadDirectSourceIndex_(loadMbIndex_().headerMap);
  } catch (error) {
    return '';
  }
  if (!index || !index.excluded) return '';
  // With ALLOW_DECLINED_QUOTES on, a declined quote is a candidate like any
  // other, so its presence is no longer the reason a booking is stuck. Saying
  // so would send the reader down the wrong path again.
  if (DIRECT_SOURCE.ALLOW_DECLINED_QUOTES) return '';

  const address = String(queueObject['Full Address'] || '').trim();
  const keys = typeof sfAddressKeysFromText_ === 'function'
    ? sfAddressKeysFromText_(address, queueObject['State'])
    : null;
  const hits = keys && keys.byZipState ? index.excluded[keys.byZipState] : null;
  if (!hits || !hits.length) return '';

  const listed = hits.slice(0, 3).map(function(hit) {
    return 'quote ' + (hit.quoteNumber || '(no number)') + ' (' + hit.status + ')';
  }).join(', ');

  return ' CRM DOES HAVE A QUOTE AT THIS ADDRESS, AND IT WAS DELIBERATELY SKIPPED: ' +
    listed + (hits.length > 3 ? ' and ' + (hits.length - 3) + ' more' : '') +
    '. A declined quote must never price an intro email - that is the rule added after ' +
    '2026-08-27, when a declined quote sent an owner another property\'s figures. Nothing ' +
    'will send for this booking until CRM carries a quote for it that is not declined. ' +
    'If the booking is real, ask Sales to re-issue the quote; if it is not, leave it and the ' +
    'give-up rule will drop it.';
}

/**
 * Drops the declined quotes from a pool WHEN a live one is present.
 *
 * This is the whole safety of ALLOW_DECLINED_QUOTES. The 2026-08-27 incident
 * was a declined quote beating an accepted one on the same property, and this
 * is what makes that impossible: a declined quote only survives when it is the
 * only thing in the pool.
 *
 * A pool of declined quotes alone comes back untouched, which is the case
 * Maintainer asked for.
 */
function sfPreferLive_(pool) {
  if (!pool || pool.length < 2) return pool || [];
  const live = pool.filter(function(entry) { return !entry.declined; });
  return live.length ? live : pool;
}

/** True when the quote that won is a declined one, for the method label. */
function sfMethodWithDeclined_(method, entry) {
  return entry && entry.declined ? method + '_DECLINED' : method;
}


/**
 * Two money values that mean the same amount.
 * "$2,240.00", "2240" and 2240 all have to compare equal.
 */
function sfSameMoney_(left, right) {
  if (typeof moneyAmount_ !== 'function') return String(left) === String(right);
  return moneyAmount_(left) === moneyAmount_(right);
}

/** True when every quote in the pool carries the same rent and the same term. */
function sfPoolAgrees_(pool) {
  if (!pool || pool.length < 2) return true;
  const first = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (!sfSameMoney_(first.rent, pool[i].rent)) return false;
    if (typeof sameDateValue_ === 'function') {
      if (!sameDateValue_(first.leaseStart, pool[i].leaseStart)) return false;
      if (!sameDateValue_(first.leaseEnd, pool[i].leaseEnd)) return false;
    }
  }
  return true;
}

/** The highest quote number in the pool. Quote numbers are sequential. */
function sfNewestOf_(pool) {
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (Number(pool[i].quoteNumber || 0) > Number(best.quoteNumber || 0)) best = pool[i];
  }
  return best;
}

/**
 * SEVERAL QUOTES AT ONE BUILDING.
 *
 * Reached when the house-number key finds more than one quote, which is the
 * ordinary shape of a bulk: one building, several bookings, and one or more
 * whole-building quotes. Refusing outright meant a booking could sit in the
 * queue for ever, so the pool is narrowed by evidence first, in this order:
 *
 *   1. THE UNIT. A quote written for a named unit belongs to that unit alone.
 *      A quote written MULTI (or TBD, NA, HOUSE...) covers the building and
 *      survives every unit. This is what separates "unit 332" from the two
 *      whole-building quotes at 11011 West North Ave.
 *   2. EXACT LEASE DATES, both ends.
 *   3. AGREEMENT. Several quotes that say the same rent and the same term are
 *      not an ambiguity at all - whichever one is used produces an identical
 *      email - so one of them is taken.
 *
 * Only after all three does a genuine disagreement remain, and that is where
 * SEND_ON_AMBIGUOUS_BUILDING decides. The default is to wait: the email would
 * otherwise carry a rent that belongs to another unit.
 *
 * sfNarrow_ is used throughout, so a test that eliminates everything means
 * "could not decide" and hands the pool on untouched.
 */
function sfNarrowBuildingPool_(pool, queueObject, queueUnit) {
  let narrowed = pool;

  if (queueUnit && typeof fastPathUnitAgrees_ === 'function') {
    narrowed = sfNarrow_(narrowed, function(entry) {
      return fastPathUnitAgrees_(queueUnit, entry.unit);
    });
  }
  if (narrowed.length <= 1) return narrowed;

  if (typeof sameDateValue_ === 'function') {
    narrowed = sfNarrow_(narrowed, function(entry) {
      return sameDateValue_(queueObject['Lease Start'], entry.leaseStart) &&
        sameDateValue_(queueObject['Lease End Date'], entry.leaseEnd);
    });
  }
  if (narrowed.length <= 1) return narrowed;

  if (sfPoolAgrees_(narrowed)) return [narrowed[0]];

  if (DIRECT_SOURCE.SEND_ON_AMBIGUOUS_BUILDING) return [sfNewestOf_(narrowed)];
  return narrowed;
}

function findDirectSourceRow_(queueObject, index) {
  if (!index) return null;
  const keys = sfAddressKeysFromText_(queueObject['Full Address'], queueObject.State);

  let candidates = [];
  let how = '';
  if (keys.byZip && (index.byZip || {})[keys.byZip]) {
    candidates = index.byZip[keys.byZip];
    how = 'SFDIRECT_ADDRESS';
  } else if (!keys.byZip && keys.byState && (index.byState || {})[keys.byState]) {
    // Only when the postcode key could not be built at all - never as a second
    // chance after a postcode miss.
    candidates = index.byState[keys.byState];
    how = 'SFDIRECT_ADDRESS_STATE';
  }
  const queueUnit = typeof extractUnitNoFromAddress_ === 'function'
    ? extractUnitNoFromAddress_(queueObject['Full Address'])
    : '';

  // A live quote always beats a declined one under the same key, so a pool
  // that mixes them stops being ambiguous. Applied before the ambiguity test
  // on purpose: that is exactly the 2026-08-27 shape.
  candidates = sfPreferLive_(candidates);

  // ONE BUILDING, SEVERAL QUOTES - the ordinary shape of a bulk. Narrowed by
  // unit, then by lease dates, then by agreement. Whatever survives is still
  // refused when it is more than one, unless SEND_ON_AMBIGUOUS_BUILDING says
  // otherwise. See sfNarrowBuildingPool_.
  if (candidates.length > 1) {
    candidates = sfNarrowBuildingPool_(candidates, queueObject, queueUnit);
    if (candidates.length === 1) how = how + '_BUILDING';
  }
  if (candidates.length > 1) return null;

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (!sfStreetAgrees_(keys.token, candidate.token)) return null;
    if (typeof fastPathUnitAgrees_ === 'function' && !fastPathUnitAgrees_(queueUnit, candidate.unit)) return null;
    return { row: candidate.row, method: sfMethodWithDeclined_(how, candidate) };
  }

  // ---- POSTCODE + STATE, LAST RESORT ---------------------------------------
  //
  // Reached only when the house-number keys found nothing at all. It exists
  // because CRM records street addresses that are simply wrong: quote
  // 296817 for USA-4066A says "1564 Hilton Ave (approx)" while the booking is
  // at 1422 Lathrop St. Same postcode, same state, same lease dates - the same
  // deal - but the house numbers never collide, so the booking sat in the queue
  // with nothing to match against.
  //
  // HOW SAFE IS IT. Measured over 90 days of non-declined quotes, bucketed by
  // the week the report covers (2026-09-16): 755 postcode+state keys, of which
  // 650 hold exactly one quote and 105 hold more. So the key alone identifies
  // the quote 86% of the time, and 64 of the 105 collisions are across
  // DIFFERENT streets - different buildings, not units of one. It is therefore
  // never trusted when it is ambiguous.
  //
  // THE TIE-BREAK. Of those 105 ambiguous keys, 44 have a distinct lease
  // start+end per quote and 53 have every quote on identical dates. Requiring
  // an exact match on both dates recovers the 44 and refuses the 53, taking
  // total coverage to about 92% of keys with the rest left blank.
  //
  // What is deliberately NOT checked here is the street name: it is the field
  // known to be wrong, and checking it would defeat the whole tier.
  if (!DIRECT_SOURCE.ALLOW_ZIP_STATE_FALLBACK) return null;
  if (!keys.byZipState) return null;
  const zipStatePool = (index.byZipState || {})[keys.byZipState] || [];
  if (!zipStatePool.length) return null;

  // THE TIE-BREAK CHAIN.
  //
  // Three tests, strongest first, each applied only while the pool is still
  // ambiguous. Measured on 2026-09-18 over 45 days of DEPARTMENT_Y bookings:
  // 47 resolved to one quote outright, 17 were ambiguous, and 11 of those 17
  // had candidates on DIFFERENT STREETS - different buildings sharing a
  // postcode, not units of one building.
  //
  // So the pool is narrowed by evidence and never by preference. Picking "the
  // newest quote" would decide those 11 by certificaten flip, which is how an owner
  // receives another property's fees - the 2026-08-27 incident, made routine.
  //
  // Order matters:
  //   1. exact lease dates   both ends identical. Strongest.
  //   2. street name         a real identifier; ignored as a GATE on this tier
  //                          because CRM records wrong streets, but
  //                          perfectly good as a TIE-BREAK between candidates.
  //   3. date containment    the quote's lease period covers the booking start.
  //                          Weakest - a long lease covers many dates - so last.
  //
  // Still ambiguous after all three: refuse, and the booking waits for Source Data
  // or for the house-number key. Blank beats wrong.

  // Same rule as the strong key: a live quote removes the declined ones from
  // contention before any tie-break runs.
  let pool = sfPreferLive_(zipStatePool);
  let method = 'SFDIRECT_ZIP_STATE';

  if (pool.length > 1 && typeof sameDateValue_ === 'function') {
    const before = pool.length;
    pool = sfNarrow_(pool, function(entry) {
      return sameDateValue_(queueObject['Lease Start'], entry.leaseStart) &&
        sameDateValue_(queueObject['Lease End Date'], entry.leaseEnd);
    });
    if (pool.length < before) method = 'SFDIRECT_ZIP_STATE_DATES';
  }

  if (pool.length > 1 && keys.token) {
    const before = pool.length;
    pool = sfNarrow_(pool, function(entry) {
      return entry.token && entry.token === keys.token;
    });
    if (pool.length < before) method = 'SFDIRECT_ZIP_STATE_STREET';
  }

  if (pool.length > 1) {
    const before = pool.length;
    pool = sfNarrow_(pool, function(entry) {
      return sfCoversDate_(entry, queueObject['Lease Start']);
    });
    if (pool.length < before) method = 'SFDIRECT_ZIP_STATE_COVERS';
  }

  if (pool.length !== 1) return null;

  const only = pool[0];
  if (typeof fastPathUnitAgrees_ === 'function' && !fastPathUnitAgrees_(queueUnit, only.unit)) return null;
  return { row: only.row, method: sfMethodWithDeclined_(method, only) };
}

/* ===== IMPORT ===== */

/**
 * Finds the newest Gmail message carrying an eligible attachment.
 *
 * BOTH searches always run and their results are merged, deduplicated by
 * message id. An earlier version stopped at the first search that returned
 * anything, which had a quiet failure mode: with five reports on five different
 * subjects, one missing the label made that report invisible even when it was
 * the newest. Running both costs one extra Gmail search per cycle.
 *
 * Each report carries the last 7 days, so missing one slot only means using a
 * slightly older snapshot - never lost data. But it does throw away the latency
 * that slot exists for.
 */
function findLatestDirectSourceFile_() {
  const searches = [
    { how: 'label', query: 'label:"' + DIRECT_SOURCE.GMAIL_LABEL + '" has:attachment newer_than:' + DIRECT_SOURCE.SEARCH_DAYS + 'd' },
    { how: 'subject', query: 'subject:"' + DIRECT_SOURCE.SUBJECT_PREFIX + '" has:attachment newer_than:' + DIRECT_SOURCE.SEARCH_DAYS + 'd' }
  ];

  const seen = {};
  const subjects = {};
  let latest = null;
  let eligibleCount = 0;
  const foundBy = [];

  searches.forEach(function(search) {
    let threads = [];
    try {
      threads = GmailApp.search(search.query, 0, DIRECT_SOURCE.SEARCH_LIMIT);
    } catch (error) {
      Logger.log('Gmail search failed for "' + search.query + '": ' + error);
      return;
    }
    let hits = 0;

    threads.forEach(function(thread) {
      thread.getMessages().forEach(function(message) {
        const messageId = message.getId();
        if (seen[messageId]) return;

        const attachments = message.getAttachments().filter(function(attachment) {
          return /\.(xlsx|xls|csv)$/i.test(String(attachment.getName() || '').trim());
        });
        if (!attachments.length) return;

        seen[messageId] = true;
        hits++;
        eligibleCount++;

        const subject = String(message.getSubject() || '').trim();
        subjects[subject] = (subjects[subject] || 0) + 1;

        const messageDate = message.getDate();
        if (!latest || messageDate.getTime() > latest.messageDate.getTime()) {
          latest = {
            messageId: messageId,
            threadId: thread.getId(),
            messageDate: messageDate,
            subject: subject,
            attachment: attachments[0],
            attachmentName: String(attachments[0].getName() || '').trim(),
            matchedBy: search.how
          };
        }
      });
    });

    if (hits) foundBy.push(search.how + ' (' + hits + ')');
  });

  if (latest) {
    latest.eligibleCount = eligibleCount;
    latest.foundBy = foundBy.join(', ');
    // Which distinct subjects turned up. With five reports scheduled, seeing
    // fewer than five here over a full day means a slot is not arriving.
    latest.distinctSubjects = Object.keys(subjects).sort();
  }
  return latest;
}

/**
 * Uploads a spreadsheet blob to Drive asking for conversion to Google Sheets,
 * and returns the new file id. Supports both versions of the advanced service,
 * because which one a project has depends on when it was enabled.
 */
function convertToGoogleSheet_(blob, name) {
  if (typeof Drive === 'undefined') {
    throw new Error('The Drive advanced service is not enabled. In the Apps Script editor: ' +
      'Services > + > Drive > Add, then run this again.');
  }
  if (Drive.Files && typeof Drive.Files.create === 'function') {
    return Drive.Files.create({ name: name, mimeType: MimeType.GOOGLE_SHEETS }, blob).id;
  }
  if (Drive.Files && typeof Drive.Files.insert === 'function') {
    return Drive.Files.insert({ title: name, mimeType: MimeType.GOOGLE_SHEETS }, blob).id;
  }
  throw new Error('The Drive advanced service is enabled but exposes neither Files.create nor Files.insert.');
}

/** Reads every cell of the first sheet of a spreadsheet id, as a 2D array. */
function readConvertedSheet_(fileId) {
  const sheet = SpreadsheetApp.openById(fileId).getSheets()[0];
  if (!sheet || sheet.getLastRow() === 0) return [];
  return sheet.getDataRange().getDisplayValues();
}

/**
 * Turns the raw grid of a CRM export into { headers, rows }.
 *
 * Finds the header row instead of assuming row 1, drops every row that carries
 * no value in an anchor column (which removes Total, Count and the footer), and
 * trims columns whose header is empty (the export leaves a blank column A).
 */
function shapeDirectSourceGrid_(grid) {
  const result = { headers: [], rows: [], headerRowIndex: -1, dropped: 0 };
  if (!grid || !grid.length) return result;

  for (let r = 0; r < grid.length; r++) {
    const cells = grid[r].map(function(cell) { return String(cell || '').trim(); });
    let hits = 0;
    DIRECT_SOURCE.KNOWN_HEADERS.forEach(function(known) {
      if (cells.indexOf(known) !== -1) hits++;
    });
    if (hits >= DIRECT_SOURCE.MIN_HEADER_HITS) { result.headerRowIndex = r; break; }
  }
  if (result.headerRowIndex === -1) return result;

  // Keep only the columns that actually carry a header.
  const rawHeaders = grid[result.headerRowIndex].map(function(cell) { return String(cell || '').trim(); });
  const keep = [];
  rawHeaders.forEach(function(header, index) { if (header !== '') keep.push(index); });
  if (!keep.length) return result;

  result.headers = keep.map(function(index) { return rawHeaders[index]; });

  const anchorPositions = [];
  DIRECT_SOURCE.ANCHOR_HEADERS.forEach(function(anchor) {
    const position = result.headers.indexOf(anchor);
    if (position !== -1) anchorPositions.push(position);
  });

  for (let r = result.headerRowIndex + 1; r < grid.length; r++) {
    const row = keep.map(function(index) {
      return grid[r][index] === undefined ? '' : grid[r][index];
    });
    if (row.join('').trim() === '') continue;

    // Total, Count and the copyright footer carry no anchor value.
    const isData = anchorPositions.length
      ? anchorPositions.some(function(position) { return String(row[position] || '').trim() !== ''; })
      : true;
    if (!isData) { result.dropped++; continue; }

    result.rows.push(row);
  }
  return result;
}

/**
 * Imports the newest CRM report into the "Direct Source Data" tab.
 * Safe to run by hand at any time; the tab is rewritten from the newest message.
 */
function importDirectSourceData() {
  const started = new Date();
  const functionName = 'importDirectSourceData';

  if (!DIRECT_SOURCE.ENABLED) {
    logDirectSource_(functionName, started, 'REVIEW', 'DIRECT_SOURCE.ENABLED is false; nothing was imported.');
    return;
  }

  let tempFileId = '';
  try {
    const properties = PropertiesService.getScriptProperties();
    const source = findLatestDirectSourceFile_();

    if (!source) {
      logDirectSource_(functionName, started, 'ERROR',
        'No message with an .xlsx/.xls/.csv attachment was found under label "' +
        DIRECT_SOURCE.GMAIL_LABEL + '" in the last ' + DIRECT_SOURCE.SEARCH_DAYS + ' day(s). ' +
        'Confirm the label is applied and that this script runs as the mailbox that receives the reports.');
      return;
    }

    const ageHours = Math.max(0, (started.getTime() - source.messageDate.getTime()) / 3600000);
    const stale = ageHours > DIRECT_SOURCE.MAX_AGE_HOURS;
    const stamp = Utilities.formatDate(source.messageDate,
      Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    const details = 'File "' + source.attachmentName + '" | subject "' + source.subject +
      '" | sent ' + stamp + ' (' + ageHours.toFixed(1) + 'h ago) | matched by ' + source.matchedBy +
      ' | ' + source.eligibleCount + ' eligible message(s) in the last ' + DIRECT_SOURCE.SEARCH_DAYS +
      ' day(s), found by ' + source.foundBy +
      ' | slots seen: ' + source.distinctSubjects.length + ' (' + source.distinctSubjects.join('; ') + ')';

    const lastMessageId = properties.getProperty(DIRECT_SOURCE.LAST_MESSAGE_PROPERTY) || '';
    const isNewMessage = source.messageId !== lastMessageId;

    const spreadsheet = SpreadsheetApp.openById(DIRECT_SOURCE.MAIN_SS_ID);
    let sheet = spreadsheet.getSheetByName(DIRECT_SOURCE.TAB);
    if (!sheet) sheet = spreadsheet.insertSheet(DIRECT_SOURCE.TAB);
    const destinationIsEmpty = sheet.getLastRow() < 2;

    if (!isNewMessage && !destinationIsEmpty) {
      logDirectSource_(functionName, started, 'OK',
        'No new report since the last run; the tab was not rewritten. ' + details);
      return;
    }

    // Excel goes through Drive; CSV is parsed directly.
    let grid;
    const blob = source.attachment.copyBlob();
    if (/\.csv$/i.test(source.attachmentName)) {
      const text = source.attachment.getDataAsString('UTF-8').replace(/^﻿/, '');
      grid = Utilities.parseCsv(text);
    } else {
      tempFileId = convertToGoogleSheet_(blob, 'TEMP Direct Source ' + started.getTime());
      grid = readConvertedSheet_(tempFileId);
    }

    if (!grid || !grid.length) {
      logDirectSource_(functionName, started, 'ERROR', 'The attachment produced no rows. ' + details);
      return;
    }

    const shaped = shapeDirectSourceGrid_(grid);
    if (shaped.headerRowIndex === -1) {
      logDirectSource_(functionName, started, 'ERROR',
        'No header row was recognised. Expected at least ' + DIRECT_SOURCE.MIN_HEADER_HITS +
        ' of the known column names. ' + details);
      return;
    }
    if (!shaped.rows.length) {
      logDirectSource_(functionName, started, 'REVIEW',
        'The report carried a header but no data rows. ' + details);
      return;
    }

    const output = [shaped.headers].concat(shaped.rows);
    replaceMbSheetData_(sheet, output, shaped.headers.length);
    properties.setProperty(DIRECT_SOURCE.LAST_MESSAGE_PROPERTY, source.messageId);

    const missingHeaders = DIRECT_SOURCE.KNOWN_HEADERS.filter(function(known) {
      return shaped.headers.indexOf(known) === -1;
    });

    logDirectSource_(functionName, started, stale ? 'REVIEW' : 'OK',
      'Imported ' + shaped.rows.length + ' row(s) into "' + DIRECT_SOURCE.TAB + '". ' + details +
      ' | header on grid row ' + (shaped.headerRowIndex + 1) +
      ' | ' + shaped.headers.length + ' column(s)' +
      (shaped.dropped ? ' | dropped ' + shaped.dropped + ' non-data row(s) (Total/Count/footer)' : '') +
      (missingHeaders.length ? ' | NOT in this report: ' + missingHeaders.join(', ') : '') +
      (stale ? ' | WARNING: newest report is over ' + DIRECT_SOURCE.MAX_AGE_HOURS + 'h old' : ''));

  } catch (error) {
    logDirectSource_(functionName, started, 'ERROR', String(error && error.stack ? error.stack : error));
  } finally {
    if (tempFileId) {
      try { DriveApp.getFileById(tempFileId).setTrashed(true); }
      catch (cleanupError) { Logger.log('Temp file ' + tempFileId + ' could not be trashed: ' + cleanupError); }
    }
  }
}

/* ===== LOG ===== */

/** Central Log > "CRM Data". Same six columns as the other importers. */
function logDirectSource_(functionName, startedDate, status, comment) {
  try {
    const duration = Number(((Date.now() - startedDate.getTime()) / 1000).toFixed(1));
    const spreadsheet = SpreadsheetApp.openById(DIRECT_SOURCE.LOG_SS_ID);
    let sheet = spreadsheet.getSheetByName(DIRECT_SOURCE.LOG_TAB);
    if (!sheet) sheet = spreadsheet.insertSheet(DIRECT_SOURCE.LOG_TAB);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Function', 'Timestamp', 'Status', 'Duration (sec)', 'Comment', 'Note']);
    }
    sheet.appendRow([functionName, startedDate, status, duration, comment || '', '']);
  } catch (error) {
    Logger.log('logDirectSource_ failed: ' + error);
  }
}

/* ===== TRIGGER ===== */

/**
 * Every 15 minutes, matching monitorAutomatedReachOutQueue. The reports land at five fixed
 * times, so most runs find nothing new and stop after one Gmail search.
 * Run this once to install it.
 */
function createDirectSourceImportTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'importDirectSourceData') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('importDirectSourceData').timeBased().everyMinutes(15).create();
}

/* ===== DIAGNOSTICS ===== */

/**
 * Shows what the newest report would produce, without writing to the tab and
 * without marking the message as processed. Run this first.
 */
function previewDirectSourceImport() {
  const lines = [];
  lines.push('Label            : ' + DIRECT_SOURCE.GMAIL_LABEL);
  lines.push('Destination      : "' + DIRECT_SOURCE.TAB + '"');
  lines.push('Running as       : ' + Session.getEffectiveUser().getEmail());
  lines.push('Drive service    : ' + (typeof Drive === 'undefined' ? 'NOT ENABLED - .xlsx cannot be read' : 'enabled'));
  lines.push('');

  let tempFileId = '';
  try {
    const source = findLatestDirectSourceFile_();
    if (!source) {
      lines.push('No eligible message found in the last ' + DIRECT_SOURCE.SEARCH_DAYS + ' day(s).');
      const text = lines.join('\n');
      Logger.log(text);
      return text;
    }

    lines.push('Newest message   : ' + source.subject);
    lines.push('Attachment       : ' + source.attachmentName);
    lines.push('Sent             : ' + Utilities.formatDate(source.messageDate, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
    lines.push('Matched by       : ' + source.matchedBy + ' | searches that hit: ' + source.foundBy);
    lines.push('Eligible in window: ' + source.eligibleCount);
    lines.push('');
    lines.push('Distinct subjects seen in the last ' + DIRECT_SOURCE.SEARCH_DAYS + ' day(s) (' +
      source.distinctSubjects.length + '):');
    source.distinctSubjects.forEach(function(subject) { lines.push('  - ' + subject); });
    lines.push('  Five slots are scheduled. Fewer than five over a full day means a');
    lines.push('  report is not arriving, or is not being labelled.');
    lines.push('');

    let grid;
    if (/\.csv$/i.test(source.attachmentName)) {
      grid = Utilities.parseCsv(source.attachment.getDataAsString('UTF-8').replace(/^﻿/, ''));
    } else {
      tempFileId = convertToGoogleSheet_(source.attachment.copyBlob(), 'TEMP Direct Source preview ' + Date.now());
      grid = readConvertedSheet_(tempFileId);
    }

    const shaped = shapeDirectSourceGrid_(grid);
    lines.push('Grid             : ' + grid.length + ' row(s)');
    lines.push('Header found on  : row ' + (shaped.headerRowIndex + 1));
    lines.push('Data rows        : ' + shaped.rows.length);
    lines.push('Dropped rows     : ' + shaped.dropped + ' (Total/Count/footer)');
    lines.push('');
    lines.push('Columns (' + shaped.headers.length + '):');
    shaped.headers.forEach(function(header, index) { lines.push('  ' + (index + 1) + '. ' + header); });

    const missing = DIRECT_SOURCE.KNOWN_HEADERS.filter(function(known) {
      return shaped.headers.indexOf(known) === -1;
    });
    if (missing.length) {
      lines.push('');
      lines.push('Expected but NOT in this report:');
      missing.forEach(function(header) { lines.push('  - ' + header); });
    }

    if (shaped.rows.length) {
      lines.push('');
      lines.push('First data row:');
      shaped.headers.forEach(function(header, index) {
        const value = String(shaped.rows[0][index] || '').trim();
        if (value) lines.push('  ' + header + ' = ' + value);
      });
    }
  } catch (error) {
    lines.push('FAILED: ' + error);
  } finally {
    if (tempFileId) {
      try { DriveApp.getFileById(tempFileId).setTrashed(true); } catch (cleanupError) {}
    }
  }

  const text = lines.join('\n');
  Logger.log(text);
  return text;
}
