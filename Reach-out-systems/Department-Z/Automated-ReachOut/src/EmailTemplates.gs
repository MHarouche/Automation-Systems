/**
 * Sender - builds the Automated Reach-Out intro email bodies, resolves PARTNER branding,
 * resolves the display (building) name, validates recipients and provides
 * manual preview functions.
 *
 * The queue, Gmail checks, sending, tracking, Slack notifications and triggers
 * live in SlackPipeline.gs.
 */

/**
 * Private Owner attachments.
 *
 * EVERY file inside this Drive folder is attached to every Private Owner email.
 * To add, replace or remove an attachment, just change the folder contents -
 * no code change and no redeploy needed.
 *
 * Attachments are sent in file-name order. To force a specific order, rename the
 * files with a numeric prefix ("1 - TH Automated Reach-Out.pdf", "2 - External Property FAQs.pdf").
 *
 * The account that runs this script must have at least view access to the folder.
 */
const PRIVATE_ATTACHMENTS_FOLDER_ID = 'YOUR_GENERAL_ATTACHMENT_FILE_ID';

/**
 * Fallback used only when the folder itself cannot be opened (for example when
 * the folder was shared but the sharing has not propagated yet). These are the
 * individual files that live in the folder, in the order they should be sent.
 * Leave the list empty to rely on the folder alone.
 */
const PRIVATE_ATTACHMENTS_FILE_IDS = [
  'YOUR_PRIVATE_ATTACHMENT_FILE_ID',  // TH Automated Reach-Out.pdf
  'YOUR_PARTNER_ATTACHMENT_FILE_ID'   // External Property FAQs.pdf
];

// Gmail rejects messages over ~25 MB. Stay below that with room for the body.
const PRIVATE_ATTACHMENTS_MAX_BYTES = 20 * 1024 * 1024;

const SAMPLE_RECIPIENT = 'maintainer@example.com';

const BLUE = '#5B6BE1';
const DARK_GRAY = '#333333';
const LIGHT_GRAY = '#F5F6FA';

const FROM_ALIAS = 'operations-queue@example.com';

// Copied on every Automated Reach-Out email that goes to an external contact, in every
// template. Internal test sends and the manual previews do NOT copy it.
const CC_RECIPIENT = 'central-operations@example.com';

const MAX_SUBJECT_LENGTH = 200;
const GENERAL_FORM_URL = 'https://example.com/general-intake-form';
const PRIVATE_FORM_URL = 'https://example.com/private-owner-form';

// Every provider in this list receives the Private Owner template.
const PRIVATE_PROVIDERS = [
  'PRIVATE_OWNER',
  'INDEPENDENT_OWNER',
  'PRIVATE_MANAGEMENT_GROUP'
];

/**
 * External Provider is free text in SMT_PROPERTY, not an enumeration, so the
 * same idea is spelled several ways and two of the spellings are typos.
 * Measured over the whole Reference Properties export on 2026-09-15, the
 * on-demand properties (PO ending in A) carried:
 *
 *   PRIVATE_OWNER        610      PRIVIATE_OWNER            34   <- typo
 *   INDEPENDENT_OWNER    21      PRIVATELY_HELD_COMPANY     9
 *   PRIVATE_MANAGEMENT_GROUP    1      PRIVATE_RENTAL             1
 *                                      PRIVATELY_MANAGED          1
 *                                      PRIVATE_INDIVDIUAL         1   <- typo
 *
 * The list above only covered the first column, so 46 of 678 private
 * properties were getting the GENERAL template: no ACH/Wire form, no W-9
 * request, no attachments and the wrong signature.
 *
 * Maintainer's ruling on 2026-09-16: anything whose provider type says private
 * gets the Private Owner template. Testing for "PRIVATE" would still miss
 * PRIVIATE_OWNER, which is the largest of the five missed groups, so the test
 * is on "PRIV". Every provider value in the export containing PRIV is private -
 * checked one by one - and any new spelling of the same idea is caught
 * automatically.
 */
const PRIVATE_PROVIDER_PATTERN = /PRIV/;

/**
 * True when this External Provider value means the owner is a private party.
 * The explicit list is consulted first so the three known values keep their
 * exact previous behaviour; the pattern only widens the net.
 */
function isPrivateProviderValue_(provider) {
  const key = String(provider == null ? '' : provider).trim().toUpperCase();
  if (!key) return false;
  if (PRIVATE_PROVIDERS.indexOf(key) !== -1) return true;
  return PRIVATE_PROVIDER_PATTERN.test(key.replace(/[^A-Z]/g, ''));
}

/**
 * FLORIDA CONTRACT RULE (requested by Reviewer, 2026-09-16).
 *
 * Three partners have a special contracting arrangement in Florida, and the
 * lease term line of the fee table has to carry it so the owner sees which
 * agreement applies. The suffix goes straight after the dates:
 *
 *   09/22/2026 - 12/31/2026 (12/90/60 agreement)
 *
 * WHICH FIELD IDENTIFIES THE PARTNER. The request named Property: Account
 * Name, Quote Name, Property Name, Landlord Name and Building Name. Checked
 * against the real data, those five catch Example Partner and almost nothing else:
 * Fort Family's buildings are named "Fusion", "Pinnacle" and "Cabana Club",
 * and Priderock's is "The Dakota at Abacoa" - the brand appears in no name
 * field at all. Both are only identifiable through External Provider, so that
 * is searched as well.
 *
 *   Example Partner                 569 on-demand POs, 135 in FL, brand in the name
 *   Fort Family Investments   10 on-demand POs, all 10 in FL, name-invisible
 *   Priderock Capital         24 on-demand POs, all 24 in FL, name-invisible
 *
 * Quote Name and Property: Account Name are deliberately not separate fields
 * here: sfPropertyNameFrom_ in 6_SFDirect_Import.gs already folds them into
 * Property Name before the row reaches the templates.
 *
 * tokens are matched against the letters-only uppercase form of each candidate,
 * so FORT_FAMILY, "Fort Family Communities" and "fort-family" all hit
 * FORTFAMILY.
 */
const FLORIDA_CONTRACT_RULES = [
  { label: 'Example Partner',                suffix: '(7/90/60 partnership)', tokens: ['EXAMPLE_PARTNER'] },
  { label: 'Fort Family Investments', suffix: '(12/90/60 agreement)',  tokens: ['FORTFAMILY'] },
  { label: 'Priderock Capital',       suffix: '(7/90/60 agreement)',   tokens: ['PRIDEROCK'] }
];

/**
 * Headers searched for the partner name.
 *
 * Full Address is deliberately NOT here. A street called "Example Partner Avenue" in
 * Florida would tag an unrelated property with a partnership it does not have,
 * and the address adds nothing: every Example Partner property in the export already
 * carries the brand in Building Name and in External Provider.
 */
const FLORIDA_CONTRACT_FIELDS = [
  'External Provider', 'Property Name', 'Display Name',
  'Building Name', 'Landlord Name'
];

const PARTNER_SOURCE = {
  SPREADSHEET_ID: 'YOUR_PARTNER_DIRECTORY_SPREADSHEET_ID',
  SHEET_NAME: 'PARTNER AGREEMENT GRID',
  HEADER: 'PARTNER',
  CACHE_SECONDS: 1800
};

/**
 * Building Name source - spreadsheet "US Rent Payments".
 * When the PO matches Property Code, Building Name becomes the name used in the
 * greeting, the subject line and the lease table heading.
 */
const BUILDING_NAME_SOURCE = {
  SPREADSHEET_ID: 'YOUR_PAYMENT_SOURCE_SPREADSHEET_ID',
  SHEET_NAME: 'Data',
  REFERENCE_HEADERS: ['Property Code'],
  NAME_HEADERS: ['Building Name'],
  CACHE_SECONDS: 21600
};

// Per-execution memo so a single run never reads the same large sheet twice.
var __BUILDING_INDEX = null;

/* ===== EMAIL VALIDATION ===== */

const EMAIL_PATTERN = /^[^\s@,;<>()\[\]]+@[^\s@,;<>()\[\]]+\.[A-Za-z]{2,}$/;

// Addresses that are syntactically valid but are placeholders. Never send to these.
const EMAIL_BLOCKLIST_PATTERNS = [
  /^tbd@/i,
  /@tbd\./i,
  /^t\.?b\.?d@/i,
  /^test@/i,
  /@test\./i,
  /^none@/i,
  /^n\/?a@/i,
  /@example\./i,
  /@domain\./i,
  /placeholder/i,
  /^noemail/i,
  /^no-?reply@/i,
  /^donotreply@/i,
  /^xxx/i,
  /^abc@abc/i
];

/**
 * A recipient is only acceptable when it parses as a real address AND is not a
 * known placeholder. Anything else must fall back to another source.
 */
function isValidEmail(email) {
  const text = String(email == null ? '' : email).trim();
  if (!text) return false;
  if (!EMAIL_PATTERN.test(text)) return false;
  for (let i = 0; i < EMAIL_BLOCKLIST_PATTERNS.length; i++) {
    if (EMAIL_BLOCKLIST_PATTERNS[i].test(text)) return false;
  }
  return true;
}

/** Source cells often hold several addresses separated by ; , or whitespace. */
function splitEmailCandidates_(value) {
  return String(value == null ? '' : value)
    .split(/[;,\s]+/)
    .map(function(part) { return part.trim().replace(/^<|>$/g, ''); })
    .filter(Boolean);
}

/** Returns the first acceptable address inside a cell, or '' when there is none. */
function firstValidEmail_(value) {
  const candidates = splitEmailCandidates_(value);
  for (let i = 0; i < candidates.length; i++) {
    if (isValidEmail(candidates[i])) return candidates[i];
  }
  return '';
}

/* ===== GENERIC HELPERS ===== */

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeLookupText_(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * The 5-digit postcode inside a free-text address, or '' when there is none.
 *
 * WHY THIS IS NOT SIMPLY /\d{5}/. A house number can itself be five digits, and
 * reading it as the postcode is how a booking silently stops matching:
 *
 *   "11011 West North Avenue, Wauwatosa, WI, USA #102"
 *        postcode read as 11011 - there is no postcode in that address at all
 *   "32618 HP Johnson Street, Green, Texas 77451 #A"
 *        postcode read as 32618 instead of 77451
 *
 * Both are real bookings from 2026-09-22 that never matched their quote. The
 * damage is worse than a miss: zipToState_ turned "11011" into NY, so a
 * Wisconsin booking was routed as a New York one.
 *
 * Measured the same day over the property export: 10,765 of 70,882 on-demand
 * properties - 15% - carry a house number of five digits or more. One booking
 * in seven was building its keys from a number that is not a postcode.
 *
 * So the leading house number is removed first, and a "#1234" unit is blanked
 * out, before the postcode is looked for.
 */
function zipFromAddressText_(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const withoutHouseNumber = value.replace(/^\s*(?:APPROX\.?:?\s*)?[0-9][0-9-]*(?=\s)/i, ' ');
  const withoutUnit = withoutHouseNumber.replace(/#\s*[A-Za-z0-9-]+/g, ' ');
  const match = withoutUnit.match(/\b(\d{5})(?:-\d{4})?\b/);
  return match ? match[1] : '';
}

/** Canonical key used to match a PO across every spreadsheet. */
function poKey_(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function extractDriveId(url) {
  const value = String(url || '');
  let match = value.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  match = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  match = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Reads every file in the Private Owner attachment folder.
 * Returns the blobs in file-name order plus a list of problems. A file that
 * cannot be read is reported but never stops the other attachments.
 */
function getPrivateAttachmentBlobs_() {
  const result = { attachments: [], names: [], problems: [], totalBytes: 0, source: '' };
  let runningAs = 'unknown account';
  try { runningAs = Session.getEffectiveUser().getEmail(); } catch (error) {}

  const entries = [];
  try {
    const folder = DriveApp.getFolderById(PRIVATE_ATTACHMENTS_FOLDER_ID);
    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      entries.push({ name: String(file.getName() || ''), file: file });
    }
    entries.sort(function(a, b) { return a.name.localeCompare(b.name); });
    result.source = 'folder';
  } catch (error) {
    result.problems.push('The attachment folder ' + PRIVATE_ATTACHMENTS_FOLDER_ID +
      ' could not be opened while running as ' + runningAs + ': ' + error);
  }

  // Folder unreachable: fall back to the individual files, which may have been
  // shared directly even when the folder was not.
  if (!entries.length && PRIVATE_ATTACHMENTS_FILE_IDS.length) {
    PRIVATE_ATTACHMENTS_FILE_IDS.forEach(function(fileId) {
      try {
        const file = DriveApp.getFileById(fileId);
        entries.push({ name: String(file.getName() || ''), file: file });
      } catch (error) {
        result.problems.push('File ' + fileId + ' could not be opened while running as ' +
          runningAs + ': ' + error);
      }
    });
    if (entries.length) result.source = 'file id list';
  }

  if (!entries.length) {
    result.problems.push('No Private Owner attachment is reachable. Share the folder ' +
      'AND the files inside it with ' + runningAs + ', then run testAttachments().');
    return result;
  }

  entries.forEach(function(entry) {
    try {
      const blob = entry.file.getBlob();
      const size = blob.getBytes().length;
      if (result.totalBytes + size > PRIVATE_ATTACHMENTS_MAX_BYTES) {
        result.problems.push('"' + entry.name + '" was skipped: the total attachment size would exceed the Gmail limit.');
        return;
      }
      result.totalBytes += size;
      result.attachments.push(blob);
      result.names.push(entry.name);
    } catch (error) {
      result.problems.push('"' + entry.name + '" could not be read: ' + error);
    }
  });

  return result;
}

function fmtDateOnly(value) {
  if (value === '' || value == null) return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'MM/dd/yyyy');
  }

  // BI platform CSV dates arrive as text. Parsing a date-only ISO value with
  // new Date() treats it as UTC and can display the previous day in Brazil.
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (iso) {
    return String(iso[2]).padStart(2, '0') + '/' +
      String(iso[3]).padStart(2, '0') + '/' + iso[1];
  }
  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+.*)?$/);
  if (us) {
    return String(us[1]).padStart(2, '0') + '/' +
      String(us[2]).padStart(2, '0') + '/' + us[3];
  }
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'MM/dd/yyyy');
  }
  return String(value);
}

function moneyAmount_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  let text = String(value == null ? '' : value).trim();
  if (!text) return 0;
  if (/^\(.*\)$/.test(text)) text = '-' + text.slice(1, -1);
  text = text.replace(/[^\d,.-]/g, '');
  if (text.indexOf(',') > -1 && text.indexOf('.') === -1) text = text.replace(',', '.');
  else text = text.replace(/,/g, '');
  const number = parseFloat(text);
  return isFinite(number) ? number : 0;
}

function fmtMoney(value) {
  return '$ ' + moneyAmount_(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function getCellValue_(row, headerMap, header) {
  const index = headerMap[header];
  return index === undefined ? '' : row[index];
}

function unitNumberText_(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/^\s*(?:unit\s*)?#?\s*/i, '');
}

/**
 * Unit text for the subject line. Takes a single unit or a comma-separated
 * list, and returns them already prefixed: "#12-220, #12-103, #9-322".
 * Returns '' when nothing usable is left, so the caller can drop the segment.
 */
function unitListText_(value) {
  return String(value || '').split(',')
    .map(function(part) { return unitNumberText_(part); })
    .filter(Boolean)
    .map(function(unit) { return '#' + unit; })
    .join(', ');
}

function unitReference_(items, headerMap) {
  const units = items
    .map(function(item) { return unitNumberText_(getCellValue_(item.rowValues, headerMap, 'Unit No')); })
    .filter(Boolean);
  if (!units.length) return 'the unit';
  if (units.length === 1) return 'unit #' + units[0];
  return 'units ' + units.map(function(unit) { return '#' + unit; }).join(', ');
}

/* ===== CHUNKED SCRIPT CACHE ===== */

/**
 * The lookup sources are large. A serialized index can exceed the 100 KB limit
 * of a single cache entry, so it is stored across numbered chunks.
 */
function putChunkedCache_(baseKey, text, seconds) {
  try {
    const cache = CacheService.getScriptCache();
    const size = 90000;
    const total = Math.ceil(text.length / size);
    if (total > 20) return false;
    const payload = {};
    for (let i = 0; i < total; i++) {
      payload[baseKey + '_' + i] = text.substring(i * size, (i + 1) * size);
    }
    payload[baseKey + '_COUNT'] = String(total);
    cache.putAll(payload, seconds);
    return true;
  } catch (error) {
    Logger.log('putChunkedCache_ failed for ' + baseKey + ': ' + error);
    return false;
  }
}

function getChunkedCache_(baseKey) {
  try {
    const cache = CacheService.getScriptCache();
    const countText = cache.get(baseKey + '_COUNT');
    if (!countText) return null;
    const total = Number(countText);
    if (!isFinite(total) || total <= 0) return null;
    const keys = [];
    for (let i = 0; i < total; i++) keys.push(baseKey + '_' + i);
    const parts = cache.getAll(keys);
    let text = '';
    for (let i = 0; i < total; i++) {
      const part = parts[baseKey + '_' + i];
      if (part === undefined || part === null) return null;
      text += part;
    }
    return text;
  } catch (error) {
    Logger.log('getChunkedCache_ failed for ' + baseKey + ': ' + error);
    return null;
  }
}

/* ===== SHEET COLUMN RESOLUTION ===== */

/**
 * Finds a column by trying each candidate header, first exactly and then by
 * normalized comparison, so a small wording difference does not break the lookup.
 */
function resolveColumnIndex_(headerRow, candidates) {
  const trimmed = headerRow.map(function(header) { return String(header || '').trim(); });
  for (let i = 0; i < candidates.length; i++) {
    const exact = trimmed.indexOf(candidates[i]);
    if (exact !== -1) return exact;
  }
  const normalized = trimmed.map(normalizeLookupText_);
  for (let i = 0; i < candidates.length; i++) {
    const wanted = normalizeLookupText_(candidates[i]);
    const found = normalized.indexOf(wanted);
    if (found !== -1) return found;
  }
  for (let i = 0; i < candidates.length; i++) {
    const wanted = normalizeLookupText_(candidates[i]);
    for (let column = 0; column < normalized.length; column++) {
      if (normalized[column] && wanted &&
          (normalized[column].indexOf(wanted) !== -1 || wanted.indexOf(normalized[column]) !== -1)) {
        return column;
      }
    }
  }
  return -1;
}

/** Finds a tab by exact name, then by normalized name, then by partial match. */
function resolveSheetByNames_(spreadsheet, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const direct = spreadsheet.getSheetByName(candidates[i]);
    if (direct) return direct;
  }
  const sheets = spreadsheet.getSheets();
  const names = sheets.map(function(sheet) { return normalizeLookupText_(sheet.getName()); });
  for (let i = 0; i < candidates.length; i++) {
    const wanted = normalizeLookupText_(candidates[i]);
    const found = names.indexOf(wanted);
    if (found !== -1) return sheets[found];
  }
  for (let i = 0; i < candidates.length; i++) {
    const wanted = normalizeLookupText_(candidates[i]);
    for (let s = 0; s < names.length; s++) {
      if (names[s] && wanted && names[s].indexOf(wanted) !== -1) return sheets[s];
    }
  }
  return null;
}

/* ===== BUILDING NAME LOOKUP ===== */

function loadBuildingNameIndex_() {
  if (__BUILDING_INDEX) return __BUILDING_INDEX;

  const cached = getChunkedCache_('AUTOMATED_REACHOUT_BUILDING_NAMES_V1');
  if (cached) {
    try {
      __BUILDING_INDEX = JSON.parse(cached);
      return __BUILDING_INDEX;
    } catch (error) {
      Logger.log('Building name cache could not be parsed: ' + error);
    }
  }

  const index = {};
  const spreadsheet = SpreadsheetApp.openById(BUILDING_NAME_SOURCE.SPREADSHEET_ID);
  const sheet = resolveSheetByNames_(spreadsheet, [BUILDING_NAME_SOURCE.SHEET_NAME]);
  if (!sheet) throw new Error('Building Name tab not found: ' + BUILDING_NAME_SOURCE.SHEET_NAME);
  if (sheet.getLastRow() >= 2 && sheet.getLastColumn() >= 1) {
    const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const poIndex = resolveColumnIndex_(headerRow, BUILDING_NAME_SOURCE.REFERENCE_HEADERS);
    const nameIndex = resolveColumnIndex_(headerRow, BUILDING_NAME_SOURCE.NAME_HEADERS);
    if (poIndex === -1 || nameIndex === -1) {
      throw new Error('Building Name source is missing the Property Code or Building Name column.');
    }
    // Read each column on its own. The two columns can sit far apart in a very
    // wide sheet, and a contiguous block read would pull tens of thousands of
    // unused cells into memory.
    const rowCount = sheet.getLastRow() - 1;
    const poValues = sheet.getRange(2, poIndex + 1, rowCount, 1).getDisplayValues();
    const nameValues = sheet.getRange(2, nameIndex + 1, rowCount, 1).getDisplayValues();
    for (let row = 0; row < rowCount; row++) {
      const po = poKey_(poValues[row][0]);
      const name = String(nameValues[row][0] || '').trim();
      if (!po || !name || index[po]) continue;
      index[po] = name;
    }
  }

  putChunkedCache_('AUTOMATED_REACHOUT_BUILDING_NAMES_V1', JSON.stringify(index), BUILDING_NAME_SOURCE.CACHE_SECONDS);
  __BUILDING_INDEX = index;
  return index;
}

/**
 * Building Name for a PO, or '' when the PO is not listed. Never throws.
 * If the source is unreachable (no permission, deleted, renamed tab) the failure
 * is memoized for the rest of the execution: the email still goes out with the
 * BI platform Property Name, and the sheet is not hammered once per booking.
 */
function buildingNameForPo_(po) {
  const key = poKey_(po);
  if (!key) return '';
  try {
    const index = loadBuildingNameIndex_();
    return index[key] || '';
  } catch (error) {
    if (!__BUILDING_INDEX) {
      __BUILDING_INDEX = {};
      Logger.log('Building Name source unavailable, falling back to the BI platform ' +
        'Property Name for the rest of this run: ' + error);
    }
    return '';
  }
}

/**
 * Name shown to the recipient, used in the greeting, the subject line and the
 * lease table heading. Resolved in this order:
 *   1. Building Name from the Reference Properties tab, matched PO = Property Code
 *   2. Building Name from the US Rent Payments sheet, matched PO = Property Code
 *   3. Property Name from Source Data, so the email is never left without a name
 */
function resolveDisplayName_(po, fallbackName, propertyOnDemandBuildingName) {
  const onDemand = String(propertyOnDemandBuildingName || '').trim();
  if (onDemand) return onDemand;
  const rentPayments = buildingNameForPo_(po);
  if (rentPayments) return rentPayments;
  return String(fallbackName || '').trim();
}

/* ===== FLORIDA CONTRACT RULE ===== */

/** Letters only, uppercase, so FORT_FAMILY and "Fort Family" are one thing. */
function floridaContractKey_(value) {
  return String(value == null ? '' : value).toUpperCase().replace(/[^A-Z]/g, '');
}

/** Accepts FL, Florida, or anything stateNameToCode_ resolves to FL. */
function isFloridaState_(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return false;
  if (text.toUpperCase() === 'FL') return true;
  if (typeof stateNameToCode_ === 'function') {
    return String(stateNameToCode_(text) || '').toUpperCase() === 'FL';
  }
  return text.toLowerCase() === 'florida';
}

/**
 * The "(7/90/60 partnership)" style suffix for this row's lease term, or ''
 * when no rule applies.
 *
 * Fails closed on purpose. If the state cannot be established the suffix is
 * left off: a lease term with no contract label is merely incomplete, while a
 * lease term carrying the wrong partner's agreement is a factual error in a
 * document the owner may sign against.
 */
function floridaContractSuffix_(row, headerMap) {
  const state = getCellValue_(row, headerMap, 'State');
  const address = getCellValue_(row, headerMap, 'Full Address');
  const inFlorida = isFloridaState_(state) ||
    (typeof stateFromAddress_ === 'function' && stateFromAddress_(address) === 'FL');
  if (!inFlorida) return '';

  const haystack = FLORIDA_CONTRACT_FIELDS
    .map(function(header) { return floridaContractKey_(getCellValue_(row, headerMap, header)); })
    .filter(Boolean);
  if (!haystack.length) return '';

  for (let i = 0; i < FLORIDA_CONTRACT_RULES.length; i++) {
    const rule = FLORIDA_CONTRACT_RULES[i];
    for (let t = 0; t < rule.tokens.length; t++) {
      for (let h = 0; h < haystack.length; h++) {
        if (haystack[h].indexOf(rule.tokens[t]) !== -1) return rule.suffix;
      }
    }
  }
  return '';
}

/* ===== PARTNER INBOX RULE ===== */

/**
 * Partners whose intro email goes to one central mailbox, whatever contact the
 * quote or the fallback tabs hold for the individual building.
 *
 * Added 2026-09-18 at Maintainer's request: Example Partner always to their applications
 * desk. NOT limited to Florida. The Florida rule above labels the contract;
 * this one addresses the envelope, and the desk handles every Example Partner PO.
 */
const PARTNER_INBOX_RULES = [
  { label: 'Example Partner', token: 'EXAMPLE_PARTNER', email: 'partner-app@example.net' }
];

/**
 * EXTERNAL PROVIDER DECIDES. The name fields only speak when it is silent.
 *
 * Deliberately stricter than the Florida rule: that one adds a label to a lease
 * term, this one changes who receives the owner's figures.
 *
 * Measured on the property export, 2026-09-18. 637 on-demand POs carry
 * External Provider = EXAMPLE_PARTNER. Another 147 carry "Example Partner" in a NAME field
 * while External Provider names somebody else, and in every case checked that
 * somebody else is the real counterparty:
 *
 *   SEQ (Sequoia)      130  "Example Partner Village Apartment Homes", Hillsboro OR.
 *                           A Sequoia community that happens to be called
 *                           Example Partner. Nothing to do with Example Partner the PARTNER.
 *   APP_VICINITI         7  corporate-housing aggregators holding units inside
 *   APP_LUXE             1  a Example Partner building. Example Company pays the
 *   APP_CORP_LIVING      1  aggregator; Example Partner never sees the booking.
 *   TIM                  3
 *   PAP_AR_NATIONAL      2
 *   DITTMAR              1
 *   WEATHERBY_LOCUMS     1
 *   PRIVATE_OWNER   1  the "EXAMPLE_PARTNER - TEST - DO NOT USE" record
 *
 * Matching on names alone would have redirected all 147 to Example Partner's desk.
 *
 * Full Address is read by neither rule. "518 Example Partnert Avenue" in New York is
 * an evolve property, and a street called Example Partner Avenue would be enough on
 * its own to send another company's fees to Example Partner.
 */
const PARTNER_INBOX_PROVIDER_FIELD = 'External Provider';
const PARTNER_INBOX_NAME_FIELDS = [
  'Property Name', 'Display Name', 'Building Name', 'Landlord Name'
];

/**
 * Names that carry a partner's token but are not that partner, checked only on
 * the blank-provider path.
 *
 * "Example Partner Village Apartment Homes" in Hillsboro, Oregon is a Sequoia (SEQ)
 * community - 130 on-demand POs, the single largest concentration of the name
 * in the whole export, and no connection to Example Partner the PARTNER. Its provider is
 * recorded today, so the provider gate already excludes it; this list is what
 * stops it from slipping through on a day the provider column arrives empty.
 *
 * Matched by containment on the letters-only form, so spacing, punctuation and
 * the street that Property Name tacks on the end all stop mattering:
 * "Example Partner Village Apartment Homes, 6910 NE Ronler Way" still hits.
 */
const PARTNER_INBOX_NAME_EXCEPTIONS = [
  'EXAMPLE_PARTNERVILLAGE'
];

/** True when any name field on this row is a known collision. */
function partnerInboxNameIsException_(values) {
  for (let i = 0; i < values.length; i++) {
    const key = floridaContractKey_(values[i]);
    if (!key) continue;
    for (let e = 0; e < PARTNER_INBOX_NAME_EXCEPTIONS.length; e++) {
      if (key.indexOf(PARTNER_INBOX_NAME_EXCEPTIONS[e]) !== -1) return true;
    }
  }
  return false;
}

/**
 * Whole words, uppercase. Unlike floridaContractKey_ this does NOT collapse the
 * text down to bare letters, because here the word boundary is the whole point:
 * "Example Partnert Avenue" must not read as Example Partner. Separators are dropped, so
 * EXAMPLE_PARTNER_PROPERTIES_INC still yields EXAMPLE_PARTNER.
 */
function partnerInboxWords_(value) {
  return String(value == null ? '' : value).toUpperCase().split(/[^A-Z]+/).filter(Boolean);
}

/** The rule whose token appears as a whole word in this one value, or null. */
function partnerInboxRuleFor_(value) {
  const words = partnerInboxWords_(value);
  if (!words.length) return null;
  for (let i = 0; i < PARTNER_INBOX_RULES.length; i++) {
    if (words.indexOf(PARTNER_INBOX_RULES[i].token) !== -1) return PARTNER_INBOX_RULES[i];
  }
  return null;
}

/**
 * The mailbox this row must go to, or null when no partner rule applies.
 *
 * Accepts either shape: (row, headerMap) like floridaContractSuffix_, or a
 * plain object keyed by header name, which is what buildEmailObject_ has on
 * hand while it is still assembling the row.
 */
function partnerInboxFor_(row, headerMap) {
  if (!row) return null;
  function cell(header) {
    if (headerMap) return getCellValue_(row, headerMap, header);
    return row[header] === undefined ? '' : row[header];
  }

  const provider = String(cell(PARTNER_INBOX_PROVIDER_FIELD) || '').trim();
  if (provider) return partnerInboxRuleFor_(provider);

  // No provider recorded at all. Only here do the names get to speak, because
  // this is the one case where no other counterparty can contradict them.
  //
  // The whole row is screened for a known collision FIRST. Checking field by
  // field would not do: Property Name reads "Example Partner Village Apartment Homes,
  // 6910 NE Ronler Way" and is consulted before Building Name, so a per-field
  // check would already have returned the wrong desk by the time the plain name
  // came up.
  const names = PARTNER_INBOX_NAME_FIELDS.map(function(header) { return cell(header); });
  if (partnerInboxNameIsException_(names)) return null;
  for (let i = 0; i < names.length; i++) {
    const rule = partnerInboxRuleFor_(names[i]);
    if (rule) return rule;
  }
  return null;
}

/* ===== PARTNER MATCHING AND TEMPLATE RESOLUTION ===== */

/**
 * Words that carry no identity. A PARTNER name is compared on what survives their
 * removal, so "Pillar Properties" and "Summit Properties" share nothing, while
 * "Fort Family Investments" and "Fort Family Communities" still share two of
 * three words.
 */
const PARTNER_GENERIC_WORDS = {
  'llc': true, 'llp': true, 'inc': true, 'incorporated': true, 'corp': true,
  'corporation': true, 'co': true, 'company': true, 'companies': true,
  'group': true, 'holdings': true, 'partners': true, 'partnership': true,
  'management': true, 'managment': true, 'managed': true, 'mgmt': true,
  'property': true, 'properties': true, 'real': true, 'estate': true,
  'realty': true, 'residential': true, 'apartments': true, 'apartment': true,
  'homes': true, 'housing': true, 'living': true, 'communities': true,
  'community': true, 'the': true, 'and': true, 'of': true, 'at': true,
  'services': true, 'service': true, 'usa': true, 'us': true, 'national': true
};

// Share of the PARTNER's significant words that must appear in the candidate.
const PARTNER_MATCH_RATIO = 0.6;

/** Significant words of a name: generic terms and 1-2 letter words dropped. */
function partnerCompanyTokens_(value) {
  return normalizeLookupText_(value).split(' ').filter(function(word) {
    return word.length >= 3 && !PARTNER_GENERIC_WORDS[word];
  });
}

/**
 * Share of the PARTNER's significant words present in the candidate, 0 to 1.
 *
 * A single-word PARTNER name gets no partial credit: it either appears whole or it
 * does not, and a short one is too weak to decide branding on. Six characters
 * is the floor - "Example Partner" and "Pillar" qualify, "AMC" and "CWS" do not.
 */
function partnerCompanyTokenScore_(partnerCompanyTokens, candidateTokens) {
  if (!partnerCompanyTokens.length || !candidateTokens.length) return 0;
  let hits = 0;
  for (let i = 0; i < partnerCompanyTokens.length; i++) {
    if (candidateTokens.indexOf(partnerCompanyTokens[i]) !== -1) hits++;
  }
  if (partnerCompanyTokens.length === 1) {
    return (hits === 1 && partnerCompanyTokens[0].length >= 6) ? 1 : 0;
  }
  return hits / partnerCompanyTokens.length;
}

function loadPartnerNames_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'AUTOMATED_REACHOUT_PARTNER_NAMES_V1';
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sheet = SpreadsheetApp.openById(PARTNER_SOURCE.SPREADSHEET_ID).getSheetByName(PARTNER_SOURCE.SHEET_NAME);
  if (!sheet) throw new Error('PARTNER sheet not found: ' + PARTNER_SOURCE.SHEET_NAME);
  if (sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const headerMap = {};
  headerRow.forEach(function(header, index) {
    const key = String(header || '').trim();
    if (key) headerMap[key] = index;
  });
  const partnerCompanyIndex = headerMap[PARTNER_SOURCE.HEADER];
  if (partnerCompanyIndex === undefined) throw new Error('PARTNER column not found: ' + PARTNER_SOURCE.HEADER);

  const values = sheet.getRange(2, partnerCompanyIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  const genericNames = {
    'llc': true, 'inc': true, 'company': true, 'management': true,
    'property management': true, 'properties': true, 'real estate': true
  };

  const seen = {};
  const names = [];
  for (let row = 0; row < values.length; row++) {
    const display = String(values[row][0] || '').trim();
    const normalized = normalizeLookupText_(display);
    if (!display || normalized.length < 4 || genericNames[normalized] || seen[normalized]) continue;
    seen[normalized] = true;
    names.push({ display: display, normalized: normalized });
  }
  names.sort(function(a, b) { return b.normalized.length - a.normalized.length; });
  const serialized = JSON.stringify(names);
  if (serialized.length < 90000) cache.put(cacheKey, serialized, PARTNER_SOURCE.CACHE_SECONDS);
  return names;
}

/**
 * The PARTNER behind a booking, or '' when none is recognised.
 *
 * Two passes, in this order:
 *
 *   1. CONTAINMENT - the original rule, unchanged. One name sits whole inside
 *      the other. Everything that matched before still matches, and matches
 *      first, so this change cannot alter an existing result.
 *
 *   2. WORD OVERLAP - added 2026-09-16 at Reviewer's request. At least
 *      PARTNER_MATCH_RATIO of the PARTNER's significant words appear in the candidate.
 *      This is what catches a partner whose registered name and whose provider
 *      code disagree: "Fort Family Investments" against FORT_FAMILY_COMMUNITIES
 *      is two words of three, 67%.
 *
 * Pass 2 takes the BEST score rather than the first one over the line, because
 * the candidates are searched against every PARTNER and a weak 60% match must not
 * beat a strong 100% one that appears later in the list.
 */
function findPartnerMatchDetail_(candidateValues) {
  const none = { display: '', how: 'none', score: 0, matchedOn: '' };
  const values = (candidateValues || [])
    .map(function(value) { return String(value == null ? '' : value); })
    .filter(function(value) { return value.trim() !== ''; });
  const candidates = values
    .map(normalizeLookupText_)
    .filter(function(value) { return value.length >= 3; });
  if (!candidates.length) return none;

  const partnerCompanys = loadPartnerNames_();

  for (let i = 0; i < partnerCompanys.length; i++) {
    const partnerCompany = partnerCompanys[i];
    for (let j = 0; j < candidates.length; j++) {
      const candidate = candidates[j];
      const paddedCandidate = ' ' + candidate + ' ';
      const paddedPartner = ' ' + partnerCompany.normalized + ' ';
      if (paddedCandidate.indexOf(paddedPartner) !== -1 ||
          (candidate.length >= 5 && paddedPartner.indexOf(paddedCandidate) !== -1)) {
        return { display: partnerCompany.display, how: 'containment', score: 1, matchedOn: candidate };
      }
    }
  }

  const candidateTokens = candidates.map(partnerCompanyTokens_);
  const best = { display: '', how: 'none', score: 0, matchedOn: '' };
  let bestTokens = 0;
  for (let i = 0; i < partnerCompanys.length; i++) {
    const tokens = partnerCompanyTokens_(partnerCompanys[i].normalized);
    if (!tokens.length) continue;
    for (let j = 0; j < candidateTokens.length; j++) {
      const score = partnerCompanyTokenScore_(tokens, candidateTokens[j]);
      if (score < PARTNER_MATCH_RATIO) continue;
      // Ties go to the more specific name, so a two-word PARTNER beats a one-word
      // one that scored the same.
      if (score > best.score || (score === best.score && tokens.length > bestTokens)) {
        best.display = partnerCompanys[i].display;
        best.how = 'words';
        best.score = score;
        best.matchedOn = candidates[j];
        bestTokens = tokens.length;
      }
    }
  }
  return best.display ? best : none;
}

function findPartnerMatch_(candidateValues) {
  return findPartnerMatchDetail_(candidateValues).display;
}

function resolveEmailContext_(provider, partnerCompanyName) {
  const isPrivate = isPrivateProviderValue_(provider);
  const isPartner = Boolean(String(partnerCompanyName || '').trim());
  return {
    templateType: isPrivate ? 'PRIVATE_OWNER' : (isPartner ? 'PARTNER' : 'GENERAL'),
    partnerCompanyName: String(partnerCompanyName || '').trim(),
    brandRestricted: isPartner,
    companyName: isPartner ? 'Example Housing Company' : 'Example Housing Company'
  };
}

/** True for a Private Owner email that did NOT come from the PARTNER fallback. */
function isPurePrivateOwner_(context) {
  return Boolean(context) && context.templateType === 'PRIVATE_OWNER' && !context.brandRestricted;
}

/**
 * Builds the email subject.
 *
 *   New Automated Reach-Out {name} | {address} | #{unit} | {company} | {PO}
 *
 * address and unitNo are optional, so the older call sites that do not pass them
 * still produce the previous shape.
 *
 * TRUNCATION. The subject is only shortened when it actually exceeds
 * MAX_SUBJECT_LENGTH, and never by cutting the end - that is where the PO lives,
 * which is the one part that must always survive. Pieces are given up in this
 * order instead:
 *
 *   1. the full subject
 *   2. a shortened address
 *   3. no address at all
 *   4. no unit list either
 *   5. a shortened property name
 *   6. last resort, when the PO list alone is longer than the limit
 *
 * The company name is never dropped: it carries the PARTNER branding rule, where a
 * PARTNER email must read "Example Housing Company" and not "Example Housing Company".
 */
function buildAutomatedReachOutSubject_(propertyName, poList, context, testTemplateLabel, address, unitNo) {
  const company = context && context.companyName ? context.companyName : 'Example Housing Company';
  const pos = String(poList || '').trim();
  const name = String(propertyName || '').trim();

  // The caller decides what is safe to show. On a bulk send it passes the one
  // address that every PO shares plus the whole list of units; when the
  // addresses differ it passes an empty address instead. Naming one address out
  // of several would be misleading, and only the caller can tell them apart.
  const fullAddress = String(address || '').trim();
  let unit = unitListText_(unitNo);

  // Empty pieces disappear instead of leaving an empty " |  | " gap.
  function assemble(nameText, addressText) {
    const middle = [nameText, addressText, unit].filter(function(part) {
      return String(part || '').trim() !== '';
    });
    const head = 'New Automated Reach-Out' + (middle.length ? ' ' + middle.join(' | ') : '');
    return [head, company, pos].join(' | ');
  }

  function withTest(text) {
    return testTemplateLabel ? 'TEST ' + text + ' | ' + testTemplateLabel : text;
  }

  let subject = withTest(assemble(name, fullAddress));

  if (subject.length > MAX_SUBJECT_LENGTH && fullAddress) {
    const roomForAddress = MAX_SUBJECT_LENGTH - withTest(assemble(name, '')).length - 3;
    subject = roomForAddress >= 12
      ? withTest(assemble(name, fullAddress.substring(0, roomForAddress - 1).trimEnd() + '.'))
      : withTest(assemble(name, ''));
  }

  // A bulk send over a whole building can overflow on the unit list alone.
  // Dropped BEFORE the name is shortened: doing it the other way round would
  // reassemble with the full name and could end up longer again, leaving only
  // the blind cut to fix it - and that cut eats the PO.
  if (subject.length > MAX_SUBJECT_LENGTH && unit) {
    unit = '';
    subject = withTest(assemble(name, ''));
  }

  if (subject.length > MAX_SUBJECT_LENGTH && name) {
    const roomForName = MAX_SUBJECT_LENGTH - withTest(assemble('', '')).length - 3;
    subject = roomForName >= 8
      ? withTest(assemble(name.substring(0, roomForName - 1).trimEnd() + '.', ''))
      : withTest(assemble('', ''));
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    subject = subject.substring(0, MAX_SUBJECT_LENGTH - 1).trimEnd() + '.';
  }

  return subject;
}

/* ===== COMPACT LEASE/FEE TABLE ===== */

function compactTableRow_(label, value, emphasize) {
  if (value === '' || value == null) return '';
  return '<tr>' +
    '<td style="width:42%;padding:6px 8px;border:1px solid #DADCE0;background:' + LIGHT_GRAY + ';color:' + DARK_GRAY + ';font-weight:700;vertical-align:top;">' + escapeHtml(label) + '</td>' +
    '<td style="padding:6px 8px;border:1px solid #DADCE0;color:#111827;' + (emphasize ? 'font-weight:700;' : '') + '">' + escapeHtml(value) + '</td>' +
    '</tr>';
}

/**
 * Turns a Monthly Other description into the label shown in the email.
 *
 * CRM writes these as a comma-separated list where each item carries the
 * PROP marker, in whatever casing and punctuation the person used:
 *
 *   "Prop: Propane"                 -> "Propane"
 *   "PROP Lawn Care"                -> "Lawn Care"
 *   "PROP Pest, PROP Concierge"     -> "Pest, Concierge"
 *   "prop : gardener"               -> "Gardener"
 *   "PROP: GET 4.712%"              -> "GET 4.712%"
 *   "Prop WST, Prop STP"            -> "WST, STP"
 *
 * The prefix is stripped from EVERY item, not just the first, so a multi-item
 * description does not keep a stray "PROP" in the middle. \b stops a word like
 * "Propane" from being treated as the prefix on its own.
 *
 * Returns '' when nothing survives, and the caller falls back to its own label.
 */
function stripPropPrefix_(description) {
  return String(description || '').split(',').map(function(part) {
    const cleaned = part.replace(/^\s*prop\b\s*:?\s*/i, '').trim();
    return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : '';
  }).filter(Boolean).join(', ');
}

function buildPerPOTable(items, headerMap) {
  return items.map(function(item) {
    const row = item.rowValues;
    const po = String(getCellValue_(row, headerMap, 'Reference Code') || '').trim();
    const displayName = String(getCellValue_(row, headerMap, 'Display Name') ||
      getCellValue_(row, headerMap, 'Property Name') || '').trim();
    const unitNo = unitNumberText_(getCellValue_(row, headerMap, 'Unit No'));
    const address = String(getCellValue_(row, headerMap, 'Full Address') || '').trim();
    const leaseStart = fmtDateOnly(getCellValue_(row, headerMap, 'Lease Start'));
    const leaseEnd = fmtDateOnly(getCellValue_(row, headerMap, 'Lease End Date'));

    // Label, Source Data header, and optionally a header holding a description that
    // becomes the label. Trimmed on 2026-08-31 to the charges the property
    // actually makes: monthly utilities, furniture, furniture delivery, utility
    // connection, other fee and both shortages are Example Housing Company side and were
    // removed from the feed. TH_FEE (flat 199) was never here.
    const moneyFields = [
      ['Base Rent', 'Monthly Rent'],
      ['Monthly Pet Fee', 'Prop Pet Fee Monthly'],
      ['Monthly Parking Fee', 'Parking Fee'],
      ['Monthly Property Tax', 'Prop Tax Amount'],
      ['Monthly Property Utilities', 'Prop Utilities'],
      ['Monthly Other', 'Monthly Other', 'Monthly Other Desc'],
      ['Security Deposit', 'Security Deposit'],
      ['Pet Deposit', 'Pet Deposit'],
      ['Other Deposit', 'Other Deposit', 'Other Deposit Desc'],
      ['Cleaning Fee', 'Prop Cleaning Fee'],
      ['Administrative Fee', 'Admin'],
      ['Application Fee', 'Application'],
      ['One-Time Pet Fee', 'Prop Pet Fee One-Time'],
      // One-time property charges - PROP BG, PROP Amenity, PROP Move Out and
      // the rest. Same free-text rule: printed only when the description
      // starts with PROP, and labelled with the description itself.
      ['Other Property Fee', 'Other Fee', 'Other Fee Desc']
    ];

    let rows = compactTableRow_('Internal No.', po, true);
    if (unitNo) rows += compactTableRow_('Unit No.', '#' + unitNo, true);
    if (address) rows += compactTableRow_('Full Address', address, false);
    if (leaseStart || leaseEnd) {
      // Florida partners carry their contract model next to the dates:
      //   09/22/2026 - 12/31/2026 (12/90/60 agreement)
      // floridaContractSuffix_ returns '' for everything else, so every other
      // email keeps exactly the line it had before.
      const term = (leaseStart || 'TBD') + ' - ' + (leaseEnd || 'TBD');
      const contract = floridaContractSuffix_(row, headerMap);
      rows += compactTableRow_('Lease Term', contract ? term + ' ' + contract : term, false);
    }

    moneyFields.forEach(function(field) {
      const value = getCellValue_(row, headerMap, field[1]);
      if (moneyAmount_(value) === 0) return;
      let label = field[0];
      if (field[2]) {
        // Free-text bucket. CRM marks a charge that belongs to the
        // PROPERTY by prefixing the description with PROP. Without that prefix
        // it is a Example Housing Company charge and must never reach the owner - the
        // worst seen is "LB FEE" at 4066, a lease-break fee.
        const description = String(getCellValue_(row, headerMap, field[2]) || '').trim();
        if (!/^prop\b/i.test(description)) return;
        label = stripPropPrefix_(description) || field[0];
      }
      rows += compactTableRow_(label, fmtMoney(value), false);
    });

    const heading = [displayName, unitNo ? 'Unit #' + unitNo : ''].filter(Boolean).join(' - ') || 'Lease details';
    return '<table role="presentation" style="border-collapse:collapse;width:100%;max-width:560px;margin:10px 0 14px 0;font-family:Arial,sans-serif;font-size:13px;">' +
      '<tr><th colspan="2" style="padding:8px;border:1px solid ' + BLUE + ';background:' + BLUE + ';color:#FFFFFF;text-align:left;">' + escapeHtml(heading) + '</th></tr>' +
      rows + '</table>';
  }).join('');
}

function buildResidentPortalRows_(items, headerMap) {
  const lines = items.map(function(item) {
    const row = item.rowValues;
    const po = String(getCellValue_(row, headerMap, 'Reference Code') || '').trim();
    const unitNo = unitNumberText_(getCellValue_(row, headerMap, 'Unit No'));
    let email = String(getCellValue_(row, headerMap, 'Unit Email') || '').trim();
    if (!email && po) email = po.toLowerCase() + '@units.example.com';
    const label = [po, unitNo ? 'Unit #' + unitNo : ''].filter(Boolean).join(' - ');
    return '<div style="margin:5px 0;"><strong style="color:' + DARK_GRAY + ';">' + escapeHtml(label) + ':</strong> ' + escapeHtml(email) + '</div>';
  });
  return lines.join('');
}

/* ===== EMAIL TEMPLATES ===== */

function emailShell_(body, context) {
  const signatureCompany = context && context.brandRestricted ? 'Example Housing Company' : 'Example Housing Company';
  return '<div style="max-width:680px;font-family:Arial,sans-serif;font-size:14px;line-height:1.48;color:#111827;">' +
    body +
    '<p style="margin:18px 0 0 0;color:' + BLUE + ';font-weight:700;">Thank you!</p>' +
    '<p style="margin:8px 0 0 0;color:' + DARK_GRAY + ';"><strong>Real Estate Admin Team</strong><br>' + escapeHtml(signatureCompany) + '</p>' +
    '</div>';
}

function numberedItem_(title, body) {
  return '<li style="margin:0 0 14px 0;"><strong style="color:' + BLUE + ';">' + title + '</strong>' + (body ? '<div>' + body + '</div>' : '') + '</li>';
}

function buildGeneralBody_(items, headerMap, propertyName, context) {
  const property = escapeHtml(propertyName);
  const unitRef = escapeHtml(unitReference_(items, headerMap));
  const table = buildPerPOTable(items, headerMap);
  const portalRows = buildResidentPortalRows_(items, headerMap);
  let list = '';
  list += numberedItem_('<em>Do you require a corporate application to be completed for the company?</em>', '<em>Please share any requirements or instructions so we can proceed ASAP.</em>');
  list += numberedItem_('Unit secured:', 'Please clarify if the unit is reserved for us. If we need to take any actions, please let us know <strong>within 24 hours.</strong> We perform background checks on all Example Company guests; please let us know if you would like a copy.');
  list += numberedItem_('Please send us the exact full unit address.', '');
  list += numberedItem_('Lease agreement:', 'Please send us the lease agreement and any other documents we need to sign.' + table + '<strong>Please confirm the fees above so we can ensure they are all correctly included in our lease agreement.</strong>');
  list += numberedItem_('Move-in Funds', 'Please send us a breakdown of the move-in funds total and let us know if we can pay online through the portal or via ACH/Wire transfer.');
  list += numberedItem_('Resident Portal:', 'If your building has a resident portal for payments, maintenance, or lease signing, please use the following email address for each unit:' + portalRows + '<div>If your payment portal provider is the payment platform, please use <strong>payments@example.com</strong>.</div>');
  list += numberedItem_('Please provide the details of any required utility providers.', 'Please include water/sewer, gas, electricity, internet, and telecom services that need to be set up under our name.');
  list += numberedItem_('Additional information needed prior to moving in:', 'Please fill in this <a href="' + GENERAL_FORM_URL + '"><strong>form</strong></a>. <em>This form helps reduce unnecessary back-and-forth, phone calls, and miscommunications. If you prefer to share these details over the phone, please let us know a convenient time to call.</em>');
  list += numberedItem_('Insurance:', 'We will send our Certificate of Insurance through the certificate provider. Please confirm receipt and let us know if it looks good or if any additional language is required.');

  return emailShell_(
    '<p style="margin:0 0 12px 0;color:' + BLUE + ';">Hi <strong>' + property + ',</strong></p>' +
    '<p style="margin:0 0 14px 0;"><strong>Great news - we would like to move forward with leasing ' + unitRef + '!</strong> Please let us know if the unit is still available as soon as possible. If so, please review the items below:</p>' +
    '<ol style="padding-left:22px;margin:0;">' + list + '</ol>',
    context
  );
}

function buildPartnerBody_(items, headerMap, propertyName, context) {
  const property = escapeHtml(propertyName);
  const partnerCompanyName = escapeHtml(context.partnerCompanyName || 'your management company');
  const unitRef = escapeHtml(unitReference_(items, headerMap));
  const table = buildPerPOTable(items, headerMap);
  const portalRows = buildResidentPortalRows_(items, headerMap);
  let list = '';
  list += numberedItem_('Unit secured:', 'Please clarify if the unit is reserved for us. If we need to take any actions, please let us know <strong>within 24 hours.</strong> We perform background checks on all Example Housing Company guests; please let us know if you would like a copy. Please also let us know if there are any documents or forms we need to complete or sign.');
  list += numberedItem_('Please send us the exact full unit address.', '');
  list += numberedItem_('Lease agreement:', 'Please send us the lease agreement and any other documents we need to sign.' + table + '<strong>Please confirm the fees above so we can ensure they are all correctly included in our lease agreement.</strong>');
  list += numberedItem_('Move-in Funds', 'Please send us a breakdown of the move-in funds total and let us know if we can pay online through the portal or via ACH/Wire transfer.');
  list += numberedItem_('Resident Portal:', 'If your building has a resident portal for payments, maintenance, or lease signing, please use the following email address for each unit:' + portalRows + '<div>If your payment portal provider is the payment platform, please use <strong>payments@example.com</strong>.</div>');
  list += numberedItem_('Please provide the details of any required utility providers.', 'Please include water/sewer, gas, electricity, internet, and telecom services that need to be set up under our name.');
  list += numberedItem_('Additional information needed prior to moving in:', 'Please fill in this <a href="' + GENERAL_FORM_URL + '"><strong>form</strong></a>. <em>This form helps reduce unnecessary back-and-forth, phone calls, and miscommunications. If you prefer to share these details over the phone, please let us know a convenient time to call.</em>');
  list += numberedItem_('Insurance:', 'We will send our Certificate of Insurance through the certificate provider. Please confirm receipt and let us know if it looks good or if any additional language is required.');

  return emailShell_(
    '<p style="margin:0 0 12px 0;color:' + BLUE + ';">Hi Team at <strong>' + property + ',</strong></p>' +
    '<p style="margin:0 0 14px 0;">We are reaching out to secure <strong>' + unitRef + '</strong> at <strong>' + property + '</strong>, as part of our ongoing partnership with <strong>' + partnerCompanyName + '</strong>. <strong>Please let us know if the unit is still available as soon as possible.</strong> If so, please review the items below:</p>' +
    '<ol style="padding-left:22px;margin:0;">' + list + '</ol>',
    context
  );
}

function buildPrivateOwnerBody_(items, headerMap, propertyName, context) {
  const property = escapeHtml(propertyName);
  const unitRef = escapeHtml(unitReference_(items, headerMap));
  const guestBrand = context.brandRestricted ? 'Example Housing Company' : 'Example Company';
  const table = buildPerPOTable(items, headerMap);
  let list = '';
  list += numberedItem_('Unit secured:', 'Please clarify if the unit is reserved for us. If we need to take any actions, please let us know <strong>within 24 hours.</strong> We perform background checks on all ' + guestBrand + ' guests; please let us know if you would like a copy.');
  list += numberedItem_('Please send us the exact unit address.', '');
  list += numberedItem_('Lease agreement:', '<strong>We will send you our standard lease via the e-signature platform for your review and signature. If you prefer to use your own lease agreement instead, please let us know and we will be happy to proceed that way. You can also send any other documents that we need to sign. Please note that Example Housing Company is the lessee and is fully responsible - both legally and financially - for the lease. Our travelers do not sign the leases.</strong>' + table + '<strong>Please confirm the fees above so we can ensure they are all correctly included in our lease agreement.</strong>');
  list += numberedItem_('Move-in Funds', 'Please send us a breakdown of the move-in funds total. We are attaching our ACH/Wire form for you to complete so we can pay the initial and future funds via bank transfer.');
  list += numberedItem_('Additional information needed prior to moving in:', 'Please fill in this <a href="' + PRIVATE_FORM_URL + '"><strong>form</strong></a>. <em>This form helps reduce unnecessary back-and-forth, phone calls, and miscommunications. If you prefer to share these details over the phone, please let us know a convenient time to call.</em>');
  list += numberedItem_('Insurance:', 'We will send our Certificate of Insurance through the certificate provider. Please confirm receipt and let us know if it looks good or if any additional language is required.');
  list += numberedItem_('Form W-9:', 'Please provide a completed Form W-9 at your earliest convenience. This ensures that we have the correct tax information on file. A completed Form W-9 is required before we can issue a Form 1099, if applicable.');

  // A true Private Owner (no PARTNER fallback) gets the Operations Team team introduction.
  const intro = isPurePrivateOwner_(context)
    ? '<p style="margin:0 0 12px 0;color:' + BLUE + ';">Hi, <strong>' + property + '</strong> this is the Example Housing Company Operations Team team</p>'
    : '<p style="margin:0 0 12px 0;color:' + BLUE + ';">Hi <strong>' + property + ',</strong></p>';

  return emailShell_(
    intro +
    '<p style="margin:0 0 14px 0;"><strong>Great news - we would like to move forward with leasing ' + unitRef + '!</strong> Please let us know if the unit is still available as soon as possible. If so, please review the items below:</p>' +
    '<ol style="padding-left:22px;margin:0;">' + list + '</ol>',
    context
  );
}

function buildHtmlBody(templateType, firstRow, items, headerMap, mainPropertyName, context) {
  const normalizedType = templateType === 'PRIVATE_OWNER' ? 'PRIVATE_OWNER' : templateType;
  const resolvedContext = context || resolveEmailContext_(normalizedType === 'PRIVATE_OWNER' ? 'PRIVATE_OWNER' : '', '');
  if (normalizedType === 'PRIVATE_OWNER') return buildPrivateOwnerBody_(items, headerMap, mainPropertyName, resolvedContext);
  if (normalizedType === 'PARTNER') return buildPartnerBody_(items, headerMap, mainPropertyName, resolvedContext);
  return buildGeneralBody_(items, headerMap, mainPropertyName, resolvedContext);
}

/**
 * Attachments for a given template.
 * EVERY Private Owner email carries every file from the attachment folder,
 * including the ones that came through the PARTNER fallback.
 * (Only the greeting is conditional on isPurePrivateOwner_, not the attachments.)
 */
function attachmentsForContext_(context) {
  if (!context || context.templateType !== 'PRIVATE_OWNER') {
    return { attachments: [], missing: [], names: [] };
  }
  const pack = getPrivateAttachmentBlobs_();
  return { attachments: pack.attachments, missing: pack.problems, names: pack.names };
}

/**
 * Lists exactly what would be attached to a Private Owner email, without
 * sending anything. Run this whenever an attachment is missing from a test.
 */
function testAttachments() {
  const lines = [];
  lines.push('Attachment folder : ' + PRIVATE_ATTACHMENTS_FOLDER_ID);
  try {
    lines.push('Folder name       : "' + DriveApp.getFolderById(PRIVATE_ATTACHMENTS_FOLDER_ID).getName() + '"');
  } catch (error) {
    lines.push('Folder name       : CANNOT BE OPENED - ' + error);
  }
  lines.push('Running as        : ' + Session.getEffectiveUser().getEmail());
  lines.push('');

  const pack = getPrivateAttachmentBlobs_();
  lines.push('Resolved via      : ' + (pack.source || 'nothing worked'));
  lines.push('Files that will be attached (' + pack.attachments.length + '):');
  if (!pack.names.length) {
    lines.push('  (none)');
  } else {
    pack.names.forEach(function(name, index) {
      lines.push('  ' + (index + 1) + '. ' + name);
    });
  }
  lines.push('Total size        : ' + Math.round(pack.totalBytes / 1024) + ' KB');
  if (pack.problems.length) {
    lines.push('');
    lines.push('Problems:');
    pack.problems.forEach(function(problem) { lines.push('  - ' + problem); });
  }
  lines.push('');

  const pureContext = resolveEmailContext_('PRIVATE_OWNER', '');
  const partnerCompanyContext = resolveEmailContext_('PRIVATE_OWNER', 'Some Property Management');
  const generalContext = resolveEmailContext_('PROPERTY_MANAGER', '');
  lines.push('PRIVATE_OWNER, no PARTNER match -> ' + attachmentsForContext_(pureContext).attachments.length + ' attachment(s)');
  lines.push('PRIVATE_OWNER, PARTNER matched  -> ' + attachmentsForContext_(partnerCompanyContext).attachments.length + ' attachment(s)');
  lines.push('GENERAL template                 -> ' + attachmentsForContext_(generalContext).attachments.length + ' attachment(s) (expected 0)');

  const message = lines.join('\n');
  Logger.log(message);
  return message;
}

/* ===== MANUAL PREVIEWS ===== */

function buildSampleData_(units) {
  const headers = [
    'Reference Code', 'Record Code', 'Unit No', 'Full Address', 'Property Name', 'Display Name',
    'External Provider', 'Email Contact', 'Unit Email', 'Lease Start', 'Lease End Date',
    'Monthly Rent', 'Security Deposit', 'Admin', 'Application',
    'Prop Pet Fee Monthly', 'Prop Pet Fee One-Time', 'Prop Cleaning Fee', 'Parking Fee'
  ];
  const headerMap = {};
  headers.forEach(function(header, index) { headerMap[header] = index; });
  const items = units.map(function(unit, index) {
    return { dataIndex: index, rowValues: headers.map(function(header) { return unit[header] !== undefined ? unit[header] : ''; }) };
  });
  return { headerMap: headerMap, items: items };
}

function safeSendSample_(subject, htmlBody, attachments) {
  const options = { htmlBody: htmlBody, replyTo: FROM_ALIAS, name: 'Real Estate Admin' };
  if (attachments && attachments.length) options.attachments = attachments;
  try {
    options.from = FROM_ALIAS;
    GmailApp.createDraft(SAMPLE_RECIPIENT, subject, '', options).send();
  } catch (error) {
    delete options.from;
    GmailApp.createDraft(SAMPLE_RECIPIENT, subject, '', options).send();
  }
}

function sampleGeneral() {
  const data = buildSampleData_([{
    'Reference Code': 'REF-1001A', 'Record Code': 'REC-2001', 'Unit No': '507',
    'Full Address': '100 Example Avenue, Sample City, CA 90001 #507',
    'Property Name': 'Boylston Residences', 'Display Name': 'Boylston Residences',
    'External Provider': 'PROPERTY_MANAGER',
    'Email Contact': SAMPLE_RECIPIENT, 'Unit Email': 'ref-1001a@units.example.com',
    'Lease Start': '08/15/2026', 'Lease End Date': '11/30/2026',
    'Monthly Rent': 4100, 'Security Deposit': 4100, 'Admin': 200, 'Application': 0,
    'Prop Pet Fee Monthly': 50, 'Prop Pet Fee One-Time': 0, 'Prop Cleaning Fee': 350, 'Parking Fee': 0
  }]);
  const context = resolveEmailContext_('PROPERTY_MANAGER', '');
  const subject = buildAutomatedReachOutSubject_('Boylston Residences', 'REF-1001A', context, 'General');
  safeSendSample_(subject, buildHtmlBody('GENERAL', data.items[0].rowValues, data.items, data.headerMap, 'Boylston Residences', context), []);
}

function samplePrivateOwner() {
  const data = buildSampleData_([{
    'Reference Code': 'REF-1002A', 'Record Code': 'REC-2002', 'Unit No': 'A401',
    'Full Address': '200 Sample Street, Example City, TX 75001 #A401',
    'Property Name': 'Hana Street Home', 'Display Name': 'Hana Street Home',
    'External Provider': 'PRIVATE_OWNER',
    'Email Contact': SAMPLE_RECIPIENT, 'Lease Start': '10/27/2026', 'Lease End Date': '06/01/2027',
    'Monthly Rent': 2850, 'Security Deposit': 2400, 'Admin': 0, 'Application': 0,
    'Prop Pet Fee Monthly': 0, 'Prop Pet Fee One-Time': 0, 'Prop Cleaning Fee': 300, 'Parking Fee': 0
  }]);
  const context = resolveEmailContext_('PRIVATE_OWNER', '');
  const subject = buildAutomatedReachOutSubject_('Hana Street Home', 'REF-1002A', context, 'Private Owner');
  const pack = attachmentsForContext_(context);
  safeSendSample_(subject, buildHtmlBody('PRIVATE_OWNER', data.items[0].rowValues, data.items, data.headerMap, 'Hana Street Home', context), pack.attachments);
  if (pack.missing.length) Logger.log('Private Owner sample is missing attachment(s): ' + pack.missing.join(', '));
}

function samplePartner() {
  const data = buildSampleData_([{
    'Reference Code': 'REF-1003A', 'Record Code': 'REC-2003', 'Unit No': '227',
    'Full Address': '300 Demo Road, Test City, NY 10001 #227',
    'Property Name': 'Bayshore Apartments', 'Display Name': 'Bayshore Apartments',
    'External Provider': 'PROPERTY_MANAGER',
    'Email Contact': SAMPLE_RECIPIENT, 'Unit Email': 'ref-1003a@units.example.com',
    'Lease Start': '08/16/2026', 'Lease End Date': '11/01/2026',
    'Monthly Rent': 6688, 'Security Deposit': 0, 'Admin': 150, 'Application': 0,
    'Prop Pet Fee Monthly': 0, 'Prop Pet Fee One-Time': 0, 'Prop Cleaning Fee': 0, 'Parking Fee': 250
  }]);
  const context = resolveEmailContext_('PROPERTY_MANAGER', 'Example Property Management');
  const subject = buildAutomatedReachOutSubject_('Bayshore Apartments', 'REF-1003A', context, 'PARTNER');
  safeSendSample_(subject, buildHtmlBody('PARTNER', data.items[0].rowValues, data.items, data.headerMap, 'Bayshore Apartments', context), []);
}

function sampleAllTemplates() {
  sampleGeneral();
  samplePrivateOwner();
  samplePartner();
  Logger.log('General, Private Owner and PARTNER samples sent to ' + SAMPLE_RECIPIENT + '.');
}
