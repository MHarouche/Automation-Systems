/**
 * Sender - builds the Intake intro email bodies, resolves PARTNER branding,
 * and provides manual preview functions.
 *
 * The queue, Gmail checks, sending, tracking, Slack notifications and triggers
 * live in SlackPipeline.gs.
 */

const SPREADSHEET_ID = 'YOUR_MAIN_SPREADSHEET_ID';
const PRIVATE_FILE_URL = 'YOUR_PRIVATE_ATTACHMENT_FILE_URL';
const SAMPLE_RECIPIENT = 'maintainer@example.com';

const BLUE = '#5B6BE1';
const DARK_GRAY = '#333333';
const LIGHT_GRAY = '#F5F6FA';

const FROM_ALIAS = 'operations@example.com';
const MAX_SUBJECT_LENGTH = 200;
const GENERAL_FORM_URL = 'https://example.com/general-intake-form';
const PRIVATE_FORM_URL = 'https://example.com/private-owner-form';

const PRIVATE_PROVIDERS = ['PRIVATE_OWNER', 'INDEPENDENT_OWNER'];

const PARTNER_SOURCE = {
  SPREADSHEET_ID: 'YOUR_PARTNER_GRID_SPREADSHEET_ID',
  SHEET_NAME: 'PARTNER AGREEMENT GRID',
  HEADER: 'PARTNER',
  CACHE_SECONDS: 1800
};

/* ===== GENERIC HELPERS ===== */

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

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

function extractDriveId(url) {
  const value = String(url || '');
  let match = value.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  match = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  match = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

function getPrivatePdfBlobFromUrl() {
  try {
    const fileId = extractDriveId(PRIVATE_FILE_URL);
    return fileId ? DriveApp.getFileById(fileId).getBlob() : null;
  } catch (error) {
    Logger.log('Error loading the PRIVATE OWNER attachment: ' + error);
    return null;
  }
}

function fmtDateOnly(value) {
  if (value === '' || value == null) return '';
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'MM/dd/yyyy');
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

function unitReference_(items, headerMap) {
  const units = items
    .map(function(item) { return unitNumberText_(getCellValue_(item.rowValues, headerMap, 'Unit No')); })
    .filter(Boolean);
  if (!units.length) return 'the unit';
  if (units.length === 1) return 'unit #' + units[0];
  return 'units ' + units.map(function(unit) { return '#' + unit; }).join(', ');
}

/* ===== PARTNER MATCHING AND TEMPLATE RESOLUTION ===== */

function loadPartnerNames_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'MOVE_IN_PARTNER_NAMES_V1';
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sheet = SpreadsheetApp.openById(PARTNER_SOURCE.SPREADSHEET_ID).getSheetByName(PARTNER_SOURCE.SHEET_NAME);
  if (!sheet) throw new Error('PARTNER sheet not found: ' + PARTNER_SOURCE.SHEET_NAME);
  const data = sheet.getDataRange().getDisplayValues();
  if (!data.length) return [];

  const headerMap = {};
  data[0].forEach(function(header, index) {
    const key = String(header || '').trim();
    if (key) headerMap[key] = index;
  });
  const partnerCompanyIndex = headerMap[PARTNER_SOURCE.HEADER];
  if (partnerCompanyIndex === undefined) throw new Error('PARTNER column not found: ' + PARTNER_SOURCE.HEADER);

  const seen = {};
  const names = [];
  for (let row = 1; row < data.length; row++) {
    const display = String(data[row][partnerCompanyIndex] || '').trim();
    const normalized = normalizeLookupText_(display);
    if (!display || normalized.length < 3 || seen[normalized]) continue;
    seen[normalized] = true;
    names.push({ display: display, normalized: normalized });
  }
  names.sort(function(a, b) { return b.normalized.length - a.normalized.length; });
  const serialized = JSON.stringify(names);
  if (serialized.length < 90000) cache.put(cacheKey, serialized, PARTNER_SOURCE.CACHE_SECONDS);
  return names;
}

function findPartnerMatch_(candidateValues) {
  const candidates = (candidateValues || [])
    .map(normalizeLookupText_)
    .filter(function(value) { return value.length >= 3; });
  if (!candidates.length) return '';

  const partnerCompanys = loadPartnerNames_();
  for (let i = 0; i < partnerCompanys.length; i++) {
    const partnerCompany = partnerCompanys[i];
    for (let j = 0; j < candidates.length; j++) {
      const candidate = candidates[j];
      if (candidate.indexOf(partnerCompany.normalized) !== -1 ||
          (candidate.length >= 5 && partnerCompany.normalized.indexOf(candidate) !== -1)) {
        return partnerCompany.display;
      }
    }
  }
  return '';
}

function resolveEmailContext_(provider, partnerCompanyName) {
  const providerKey = String(provider || '').trim().toUpperCase();
  const isPrivate = PRIVATE_PROVIDERS.indexOf(providerKey) !== -1;
  const isPartner = Boolean(String(partnerCompanyName || '').trim());
  return {
    templateType: isPrivate ? 'PRIVATE_OWNER' : (isPartner ? 'PARTNER' : 'GENERAL'),
    partnerCompanyName: String(partnerCompanyName || '').trim(),
    brandRestricted: isPartner,
    companyName: isPartner ? 'Example Housing Company' : 'Example Housing Company'
  };
}

function buildIntakeSubject_(propertyName, poList, context, testTemplateLabel) {
  const company = context && context.companyName ? context.companyName : 'Example Housing Company';
  let subject = 'New Intake ' + String(propertyName || '').trim() + ' | ' + company + ' | ' + String(poList || '').trim();
  if (testTemplateLabel) subject = 'TEST ' + subject + ' | ' + testTemplateLabel;
  if (subject.length > MAX_SUBJECT_LENGTH) subject = subject.substring(0, MAX_SUBJECT_LENGTH - 1).trimEnd() + '…';
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

function buildPerPOTable(items, headerMap) {
  return items.map(function(item) {
    const row = item.rowValues;
    const po = String(getCellValue_(row, headerMap, 'Reference Code') || '').trim();
    const propertyName = String(getCellValue_(row, headerMap, 'Property Name') || '').trim();
    const unitNo = unitNumberText_(getCellValue_(row, headerMap, 'Unit No'));
    const address = String(getCellValue_(row, headerMap, 'Full Address') || '').trim();
    const leaseStart = fmtDateOnly(getCellValue_(row, headerMap, 'Lease Start'));
    const leaseEnd = fmtDateOnly(getCellValue_(row, headerMap, 'Lease End Date'));

    const moneyFields = [
      ['Base Rent', 'Monthly Rent'],
      ['Monthly Pet Fee', 'Prop Pet Fee Monthly'],
      ['Monthly Parking Fee', 'Parking Fee'],
      ['Security Deposit', 'Security Deposit'],
      ['Cleaning Fee', 'Prop Cleaning Fee'],
      ['Administrative Fee', 'Admin'],
      ['Application Fee', 'Application'],
      ['One-Time Pet Fee', 'Prop Pet Fee One-Time']
    ];

    let rows = compactTableRow_('Internal No.', po, true);
    if (unitNo) rows += compactTableRow_('Unit No.', '#' + unitNo, true);
    if (address) rows += compactTableRow_('Full Address', address, false);
    if (leaseStart || leaseEnd) rows += compactTableRow_('Lease Term', (leaseStart || 'TBD') + ' - ' + (leaseEnd || 'TBD'), false);

    moneyFields.forEach(function(field) {
      const value = getCellValue_(row, headerMap, field[1]);
      if (moneyAmount_(value) !== 0) rows += compactTableRow_(field[0], fmtMoney(value), false);
    });

    const heading = [propertyName, unitNo ? 'Unit #' + unitNo : ''].filter(Boolean).join(' - ') || 'Lease details';
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
  list += numberedItem_('Resident Portal:', 'If your building has a resident portal for payments, maintenance, or lease signing, please use the following email address for each unit:' + portalRows + '<div>If your payment portal provider is your payment platform, please use <strong>payments@example.com</strong>.</div>');
  list += numberedItem_('Please provide the details of any required utility providers.', 'Please include water/sewer, gas, electricity, internet, and telecom services that need to be set up under our name.');
  list += numberedItem_('Additional information needed prior to moving in:', 'Please fill in this <a href="' + GENERAL_FORM_URL + '"><strong>form</strong></a>. <em>This form helps reduce unnecessary back-and-forth, phone calls, and miscommunications. If you prefer to share these details over the phone, please let us know a convenient time to call.</em>');
  list += numberedItem_('Insurance:', 'We will send our Certificate of Insurance through our certificate provider. Please confirm receipt and let us know if it looks good or if any additional language is required.');

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
  list += numberedItem_('Resident Portal:', 'If your building has a resident portal for payments, maintenance, or lease signing, please use the following email address for each unit:' + portalRows + '<div>If your payment portal provider is your payment platform, please use <strong>payments@example.com</strong>.</div>');
  list += numberedItem_('Please provide the details of any required utility providers.', 'Please include water/sewer, gas, electricity, internet, and telecom services that need to be set up under our name.');
  list += numberedItem_('Additional information needed prior to moving in:', 'Please fill in this <a href="' + GENERAL_FORM_URL + '"><strong>form</strong></a>. <em>This form helps reduce unnecessary back-and-forth, phone calls, and miscommunications. If you prefer to share these details over the phone, please let us know a convenient time to call.</em>');
  list += numberedItem_('Insurance:', 'We will send our Certificate of Insurance through our certificate provider. Please confirm receipt and let us know if it looks good or if any additional language is required.');

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
  list += numberedItem_('Lease agreement:', '<strong>We will send you our standard lease via our e-signature platform for your review and signature. If you prefer to use your own lease agreement instead, please let us know and we will be happy to proceed that way. You can also send any other documents that we need to sign. Please note that Example Housing Company is the lessee and is fully responsible - both legally and financially - for the lease. Our travelers do not sign the leases.</strong>' + table + '<strong>Please confirm the fees above so we can ensure they are all correctly included in our lease agreement.</strong>');
  list += numberedItem_('Move-in Funds', 'Please send us a breakdown of the move-in funds total. We are attaching our ACH/Wire form for you to complete so we can pay the initial and future funds via bank transfer.');
  list += numberedItem_('Additional information needed prior to moving in:', 'Please fill in this <a href="' + PRIVATE_FORM_URL + '"><strong>form</strong></a>. <em>This form helps reduce unnecessary back-and-forth, phone calls, and miscommunications. If you prefer to share these details over the phone, please let us know a convenient time to call.</em>');
  list += numberedItem_('Insurance:', 'We will send our Certificate of Insurance through our certificate provider. Please confirm receipt and let us know if it looks good or if any additional language is required.');
  list += numberedItem_('Form W-9:', 'Please provide a completed Form W-9 at your earliest convenience. This ensures that we have the correct tax information on file. A completed Form W-9 is required before we can issue a Form 1099, if applicable.');

  return emailShell_(
    '<p style="margin:0 0 12px 0;color:' + BLUE + ';">Hi <strong>' + property + ',</strong></p>' +
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

/* ===== MANUAL PREVIEWS ===== */

function buildSampleData_(units) {
  const headers = [
    'Reference Code', 'Record Code', 'Unit No', 'Full Address', 'Property Name',
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
    'Property Name': 'Example Residences', 'External Provider': 'PROPERTY_MANAGER',
    'Email Contact': SAMPLE_RECIPIENT, 'Unit Email': 'ref-1001a@units.example.com',
    'Lease Start': '08/15/2026', 'Lease End Date': '11/30/2026',
    'Monthly Rent': 4100, 'Security Deposit': 4100, 'Admin': 200, 'Application': 0,
    'Prop Pet Fee Monthly': 50, 'Prop Pet Fee One-Time': 0, 'Prop Cleaning Fee': 350, 'Parking Fee': 0
  }]);
  const context = resolveEmailContext_('PROPERTY_MANAGER', '');
  const subject = buildIntakeSubject_('Example Residences', 'REF-1001A', context, 'General');
  safeSendSample_(subject, buildHtmlBody('GENERAL', data.items[0].rowValues, data.items, data.headerMap, 'Example Residences', context), []);
}

function samplePrivateOwner() {
  const data = buildSampleData_([{
    'Reference Code': 'REF-1002A', 'Record Code': 'REC-2002', 'Unit No': 'A401',
    'Full Address': '200 Sample Street, Example City, TX 75001 #A401',
    'Property Name': 'Sample Private Home', 'External Provider': 'PRIVATE_OWNER',
    'Email Contact': SAMPLE_RECIPIENT, 'Lease Start': '10/27/2026', 'Lease End Date': '06/01/2027',
    'Monthly Rent': 2850, 'Security Deposit': 2400, 'Admin': 0, 'Application': 0,
    'Prop Pet Fee Monthly': 0, 'Prop Pet Fee One-Time': 0, 'Prop Cleaning Fee': 300, 'Parking Fee': 0
  }]);
  const context = resolveEmailContext_('PRIVATE_OWNER', '');
  const subject = buildIntakeSubject_('Sample Private Home', 'REF-1002A', context, 'Private Owner');
  const attachment = getPrivatePdfBlobFromUrl();
  safeSendSample_(subject, buildHtmlBody('PRIVATE_OWNER', data.items[0].rowValues, data.items, data.headerMap, 'Sample Private Home', context), attachment ? [attachment] : []);
}

function samplePartner() {
  const data = buildSampleData_([{
    'Reference Code': 'REF-1003A', 'Record Code': 'REC-2003', 'Unit No': '227',
    'Full Address': '300 Demo Road, Test City, NY 10001 #227',
    'Property Name': 'Demo Apartments', 'External Provider': 'PROPERTY_MANAGER',
    'Email Contact': SAMPLE_RECIPIENT, 'Unit Email': 'ref-1003a@units.example.com',
    'Lease Start': '08/16/2026', 'Lease End Date': '11/01/2026',
    'Monthly Rent': 6688, 'Security Deposit': 0, 'Admin': 150, 'Application': 0,
    'Prop Pet Fee Monthly': 0, 'Prop Pet Fee One-Time': 0, 'Prop Cleaning Fee': 0, 'Parking Fee': 250
  }]);
  const context = resolveEmailContext_('PROPERTY_MANAGER', 'Example Partner Company');
  const subject = buildIntakeSubject_('Demo Apartments', 'REF-1003A', context, 'PARTNER');
  safeSendSample_(subject, buildHtmlBody('PARTNER', data.items[0].rowValues, data.items, data.headerMap, 'Demo Apartments', context), []);
}

function sampleAllTemplates() {
  sampleGeneral();
  samplePrivateOwner();
  samplePartner();
  Logger.log('General, Private Owner and PARTNER samples sent to ' + SAMPLE_RECIPIENT + '.');
}
