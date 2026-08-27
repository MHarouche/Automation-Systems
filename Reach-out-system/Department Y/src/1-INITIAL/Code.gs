/** STEP 1 MOS PIPELINE AUTOMATION
 *
 * sendMOSODinitialEmails
 * - Tabs: "Dropped Relo/App" and "Dropped"
 * - Sends ONE aggregated email per recipient (grouping units)
 * - Sends only when "Send MOS Email?" = "YES"
 * - Marks Confirmation = YES after successful send
 * - HTML body styled with #2F4F6F for headings/bullets
 * - Truncates subject if too long (150 chars)
 * - Created by Mari Harouche
 */

const TEAM_INBOX = "team-inbox@example.com";
const LOG_RECIPIENTS = ["your-email@example.com", "teammate@example.com"];
const TABS = ["Dropped Relo/App", "Dropped"];
const MAX_SUBJECT_LENGTH = 150; // safe cap for subject

const MOS_EMAILS_OD_LOG_SPREADSHEET_ID = "YOUR_CENTRAL_LOG_SPREADSHEET_ID";
const MOS_EMAILS_OD_LOG_SHEET_NAME = "MOS Emails OD";

/**
 * Used by the biweekly driver to remember last successful run time.
 * (Do NOT change this key once deployed.)
 */
const MOS_OD_LAST_SUCCESS_KEY = "MOS_OD_LAST_SUCCESSFUL_RUN_ISO";

/**
 * MOS LOG (OD)
 */
const OD_MOS_LOG_SHEET_NAME = "MOS Log";
const OD_MOS_LOG_HEADERS = { citypo: "City-PO", tab: "Tab", date: "Date", emailType: "Email Type" };

function sendMOSODinitialEmails() {
  const functionName = "sendMOSODinitialEmails";
  const executionStart = new Date();
  let executionStatus = "OK";
  let executionComment = "";
  let lockAcquired = false;

  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);
    lockAcquired = true;
  } catch (e) {
    executionStatus = "ERROR";
    executionComment = "Could not acquire script lock. " + String(e);
    sendLogEmail_("Initial MOS OD Script ERROR", "Could not acquire script lock.\n\n" + String(e));
    logMOSODEmailExecution_(functionName, executionStart, executionStatus, executionComment);
    return;
  }

  const summary = { emailsSent: 0, rowsMarked: 0, errors: 0, details: [] };

  // MOS Log: collect successful City-PO + Tab + Email Type pairs (dedupe)
  const odSuccessLogKeysThisRun = new Set();
  const odSuccessLogRowsThisRun = [];

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    for (let t = 0; t < TABS.length; t++) {
      const tabName = TABS[t];
      const sheet = ss.getSheetByName(tabName);
      if (!sheet) continue;

      const hdr = getHeaderIndices_(sheet, tabName);
      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      if (lastRow < 2) continue;

      const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();

      /**
       * groups key:
       * - Dropped => recipient + INITIAL MOS
       * - Dropped Relo/App normal => recipient + INITIAL MOS
       * - Dropped Relo/App APP/PAP => recipient + INITIAL PAP/APP
       *
       * email -> {
       *   items:[{rowNumber,building,unit,citypo,moveOutDate,emailType}],
       *   tabName,
       *   rowNumbers:Set,
       *   emailType
       * }
       */
      const groups = {};

      for (let i = 0; i < data.length; i++) {
        const rowNumber = i + 2;
        const row = data[i];

        const emailRaw     = safeStr_(hdr.colEmailTo      ? row[hdr.colEmailTo - 1]      : "");
        const sendMOS      = safeStr_(hdr.colSendMOS      ? row[hdr.colSendMOS - 1]      : "").toUpperCase();
        const confirmation = safeStr_(hdr.colConfirmation ? row[hdr.colConfirmation - 1] : "");
        const building     = safeStr_(hdr.colBuilding     ? row[hdr.colBuilding - 1]     : "");
        const unit         = safeStr_(hdr.colUnit         ? row[hdr.colUnit - 1]         : "");
        const citypo       = safeStr_(hdr.colCityPO       ? row[hdr.colCityPO - 1]       : "");
        const moveOutDate  = safeStr_(hdr.colMoveOutDate  ? row[hdr.colMoveOutDate - 1]  : "");

        // sending condition
        if (!emailRaw) continue;
        if (sendMOS !== "YES") continue;

        // if Confirmation Initial MOS Email = YES, do NOT send again
        if (confirmation.toUpperCase() === "YES") continue;

        const recipients = parseRecipients_(emailRaw);
        if (recipients.length === 0) continue;

        const emailType = (tabName === "Dropped Relo/App" && isPAPAPPBuilding_(building))
          ? "Initial PAP/APP"
          : "Initial MOS";

        const item = { rowNumber, building, unit, citypo, moveOutDate, emailType };

        recipients.forEach(rcpt => {
          const key = `${rcpt.toLowerCase()}||${tabName}||${emailType}`;
          if (!groups[key]) {
            groups[key] = {
              items: [],
              tabName,
              rowNumbers: new Set(),
              emailType: emailType,
              to: rcpt.toLowerCase()
            };
          }
          groups[key].items.push(item);
          groups[key].rowNumbers.add(rowNumber);
        });
      } // rows

      // Send aggregated emails per recipient + type
      const groupKeys = Object.keys(groups);
      for (let r = 0; r < groupKeys.length; r++) {
        const groupKey = groupKeys[r];
        const group = groups[groupKey];
        const to = group.to;
        const items = group.items;
        const emailType = group.emailType;

        if (!items || items.length === 0) continue;

        // Subject
        let subject = buildSubjectNew_(items);
        if (subject.length > MAX_SUBJECT_LENGTH) {
          subject = subject.substring(0, MAX_SUBJECT_LENGTH - 3) + "...";
        }

        const buildingName = items[0].building || "your property";

        let textBody = "";
        let htmlBody = "";

        if (emailType === "Initial PAP/APP") {
          textBody = buildTextBodyMOSODPAPAPP_(buildingName, items);
          htmlBody = buildHtmlBodyMOSODPAPAPP_(buildingName, items);
        } else {
          const htmlTable = buildHtmlTableMOSOD_(items);
          const textTable = buildTextTableMOSOD_(items);

          textBody = `
Hi Team at ${buildingName},

We’re reaching out on behalf of [Company] Inc., a furnished rental company managing flexible-stay apartments across the US and globally.

[Company] acquired [Previous Operator] and has assumed responsibility for all related leases and operations. Our portfolio also includes properties originally managed or booked through various housing platforms and apps.

Could you please help us by providing the following for the properties listed below:

${textTable}

- Copy of the Move-Out Statement or Final Ledger
- Confirmation of the Security Deposit Return status
- If applicable, details of any damage charges deducted from the deposit, along with supporting documentation

If a refund will be issued, we can send you a secure payment link upon request.

Thank you very much for your cooperation.

Have a great day!

[Company] Finance Team
`.trim();

          htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;">
  <p style="color:#2F4F6F;"><strong>Hi Team at ${escapeHtml_(buildingName)}</strong>,</p>

  <p>We’re reaching out on behalf of <strong style="color:#2F4F6F;">[Company]</strong>, a furnished rental company managing flexible-stay apartments across the US and globally.<br>

  <p>[Company] acquired [Previous Operator] and has assumed responsibility for all related leases and operations. Our portfolio also includes properties originally managed or booked through various housing platforms and apps.</p>

  <p>Could you please help us by providing the following for the properties listed below:</p>

  ${htmlTable}

  <ul>
    <li style="color:#2F4F6F;"><strong>Copy of the Move-Out Statement or Final Ledger</strong></li>
    <li style="color:#2F4F6F;"><strong>Confirmation of the Security Deposit Return status</strong></li>
    <li style="color:#2F4F6F;"><strong>If applicable, details of any damage charges deducted from the deposit, along with supporting documentation</strong></li>
  </ul>

  <p>If a refund will be issued, we can send you a secure payment link upon request.</p>

  <p>Thank you very much for your cooperation.<br>Have a great day!<br>
  <strong style="color:#2F4F6F;">[Company] Finance Team</strong></p>
</div>`.trim();
        }

        try {
          GmailApp.sendEmail(
            to,
            subject,
            textBody,
            { htmlBody: htmlBody, replyTo: TEAM_INBOX, name: "[Company] Finance Team" }
          );

          summary.emailsSent++;

          // MOS Log: mark City-PO(s) as successfully sent for this tab + email type
          const uniquePOsForThisEmail = [...new Set(items.map(it => safeStr_(it.citypo)).filter(Boolean))];
          uniquePOsForThisEmail.forEach(po => {
            const logKey = `${po}||${tabName}||${emailType}`;
            if (!odSuccessLogKeysThisRun.has(logKey)) {
              odSuccessLogKeysThisRun.add(logKey);
              odSuccessLogRowsThisRun.push({ citypo: po, tab: tabName, emailType: emailType });
            }
          });

          // Mark Confirmation = YES for all rows related to this recipient/type
          const rowsToMark = Array.from(group.rowNumbers || []);
          for (let k = 0; k < rowsToMark.length; k++) {
            const rn = rowsToMark[k];
            try {
              if (hdr.colConfirmation) sheet.getRange(rn, hdr.colConfirmation).setValue("YES");
              summary.rowsMarked++;
            } catch (errMark) {
              summary.errors++;
              summary.details.push({ type: "mark-error", tab: tabName, row: rn, err: String(errMark) });
            }
          }

          // Collect detail for log
          const detail = buildDetailForLog_(tabName, to, subject, items);
          detail.emailType = emailType;
          summary.details.push(detail);

        } catch (sendErr) {
          summary.errors++;
          summary.details.push({ type: "send-error", tab: tabName, to, err: String(sendErr) });
        }
      } // groups
    } // tabs

    // Send log
    sendSummaryLog_(summary);

    if (summary.emailsSent > 0) {
      postToSlackOD_("Hello @your-team ! Department Y INITIAL MOS emails have been sent! :)");
    }

    // Append OD MOS Log (after successful run)
    if (odSuccessLogRowsThisRun.length > 0) {
      appendODMOSLogRowsWithType_(odSuccessLogRowsThisRun, new Date());
    }

    if (summary.errors > 0) {
      executionStatus = "REVIEW";
      executionComment = `Execution completed with warnings/errors. Emails sent: ${summary.emailsSent}; rows marked: ${summary.rowsMarked}; errors: ${summary.errors}.`;
    } else {
      executionStatus = "OK";
      executionComment = `Execution completed successfully. Emails sent: ${summary.emailsSent}; rows marked: ${summary.rowsMarked}; errors: ${summary.errors}.`;
    }

  } catch (e) {
    executionStatus = "ERROR";
    executionComment = String(e);
    sendLogEmail_("Initial MOS OD Script ERROR", String(e) + "\n\n" + (e.stack || ""));
    throw e;
  } finally {
    logMOSODEmailExecution_(functionName, executionStart, executionStatus, executionComment);

    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

function normalizeHeader_(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * OD MOS LOG helper
 * Appends [City-PO, Tab, Date] to the MOS Log tab in the MOS OD spreadsheet.
 * Always appends below last row; does not overwrite.
 * Forces date number format on the Date column.
 */
function appendODMOSLogRows_(rows, dateObj) {
  if (!rows || rows.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("MOS Log");
  if (!logSheet) throw new Error('OD MOS Log sheet not found: "MOS Log"');

  const lastCol = Math.max(1, logSheet.getLastColumn());
  const headerRow = logSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const normalized = headerRow.map(h => normalizeHeader_(h));

  const colCityPO = normalized.indexOf("citypo") + 1;
  const colTab = normalized.indexOf("tab") + 1;
  const colDate = normalized.indexOf("date") + 1;
  const colEmailType = normalized.indexOf("emailtype") + 1;

  if (!colCityPO || !colTab || !colDate || !colEmailType) {
    throw new Error('OD MOS Log headers missing. Need: "City-PO", "Tab", "Date", "Email Type"');
  }

  const startRow = logSheet.getLastRow() + 1;

  const cityValues = rows.map(r => [r.citypo]);
  const tabValues = rows.map(r => [r.tab]);
  const dateValues = rows.map(() => [dateObj]);
  const emailTypeValues = rows.map(() => ["Initial MOS"]);

  logSheet.getRange(startRow, colCityPO, cityValues.length, 1).setValues(cityValues);
  logSheet.getRange(startRow, colTab, tabValues.length, 1).setValues(tabValues);
  logSheet.getRange(startRow, colDate, dateValues.length, 1).setValues(dateValues);
  logSheet.getRange(startRow, colEmailType, emailTypeValues.length, 1).setValues(emailTypeValues);

  logSheet.getRange(startRow, colDate, dateValues.length, 1).setNumberFormat("yyyy-mm-dd");
}

/**
 * New helper:
 * Same purpose as appendODMOSLogRows_, but respects row.emailType
 */
function appendODMOSLogRowsWithType_(rows, dateObj) {
  if (!rows || rows.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("MOS Log");
  if (!logSheet) throw new Error('OD MOS Log sheet not found: "MOS Log"');

  const lastCol = Math.max(1, logSheet.getLastColumn());
  const headerRow = logSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const normalized = headerRow.map(h => normalizeHeader_(h));

  const colCityPO = normalized.indexOf("citypo") + 1;
  const colTab = normalized.indexOf("tab") + 1;
  const colDate = normalized.indexOf("date") + 1;
  const colEmailType = normalized.indexOf("emailtype") + 1;

  if (!colCityPO || !colTab || !colDate || !colEmailType) {
    throw new Error('OD MOS Log headers missing. Need: "City-PO", "Tab", "Date", "Email Type"');
  }

  const startRow = logSheet.getLastRow() + 1;

  const cityValues = rows.map(r => [r.citypo]);
  const tabValues = rows.map(r => [r.tab]);
  const dateValues = rows.map(() => [dateObj]);
  const emailTypeValues = rows.map(r => [r.emailType || "Initial MOS"]);

  logSheet.getRange(startRow, colCityPO, cityValues.length, 1).setValues(cityValues);
  logSheet.getRange(startRow, colTab, tabValues.length, 1).setValues(tabValues);
  logSheet.getRange(startRow, colDate, dateValues.length, 1).setValues(dateValues);
  logSheet.getRange(startRow, colEmailType, emailTypeValues.length, 1).setValues(emailTypeValues);

  logSheet.getRange(startRow, colDate, dateValues.length, 1).setNumberFormat("yyyy-mm-dd");
}

/* -------------------- Subject -------------------- */
// Pattern requested:
// Security Deposit Return & Move-out - [BUILDING] - [UNIT NUMBERs] - [Company] - [PO NUMBERs]
function buildSubjectNew_(items) {
  if (!items || items.length === 0) return "Security Deposit Return & Move-out - [Company]";

  const firstBuilding = items[0].building || "";
  const units = items.map(it => it.unit || "").filter(Boolean).join(", ");
  const poList = [...new Set(items.map(it => it.citypo || "").filter(Boolean))];
  const poString = poList.join(", ");

  const parts = ["Security Deposit Return & Move-out"];
  if (firstBuilding) parts.push(firstBuilding);
  if (units) parts.push(units);
  parts.push("[Company]");
  if (poString) parts.push(poString);

  return parts.join(" - ");
}

/* -------------------- Logs -------------------- */
function buildDetailForLog_(tabName, to, subject, items) {
  const buildings = [...new Set(items.map(i => i.building).filter(Boolean))];
  const units = items.map(i => i.unit).filter(Boolean);
  const pos = [...new Set(items.map(i => i.citypo).filter(Boolean))];
  const rows = items.map(i => i.rowNumber).join(", ");
  return {
    type: "sent",
    tab: tabName,
    to,
    buildings: buildings.join(", "),
    units: units.join(", "),
    pos: pos.join(", "),
    countUnits: units.length,
    subject,
    rows
  };
}

function sendSummaryLog_(summary) {
  const subject = `MOS OD Script Log — sent:${summary.emailsSent} marked:${summary.rowsMarked} errors:${summary.errors}`;

  const rowsHtml = summary.details.map(d => {
    if (d.type === "sent") {
      return `<tr>
        <td>${escapeHtml_(d.tab)}</td>
        <td>${escapeHtml_(d.to)}</td>
        <td>${escapeHtml_(d.buildings || "")}</td>
        <td>${escapeHtml_(d.units || "")}</td>
        <td>${escapeHtml_(d.pos || "")}</td>
        <td style="text-align:right;">${d.countUnits || 0}</td>
        <td>${escapeHtml_(d.subject || "")}</td>
        <td>${escapeHtml_(d.rows || "")}</td>
      </tr>`;
    } else if (d.type === "send-error") {
      return `<tr style="color:#a00;"><td colspan="8">SEND ERROR [${escapeHtml_(d.tab)} → ${escapeHtml_(d.to)}]: ${escapeHtml_(d.err)}</td></tr>`;
    } else if (d.type === "mark-error") {
      return `<tr style="color:#a00;"><td colspan="8">MARK ERROR [${escapeHtml_(d.tab)} row ${escapeHtml_(String(d.row))}]: ${escapeHtml_(d.err)}</td></tr>`;
    } else if (d.type === "qtysent-error") {
      return `<tr style="color:#a00;"><td colspan="8">QTY SENT ERROR [${escapeHtml_(d.tab)} row ${escapeHtml_(String(d.row))}]: ${escapeHtml_(d.err)}</td></tr>`;
    } else {
      return `<tr><td colspan="8">${escapeHtml_(JSON.stringify(d))}</td></tr>`;
    }
  }).join("");

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;">
  <p><strong>Execution completed.</strong></p>
  <p>Emails sent: <strong>${summary.emailsSent}</strong><br>
     Rows marked: <strong>${summary.rowsMarked}</strong><br>
     Errors: <strong>${summary.errors}</strong></p>

  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
    <thead style="background:#f3f6fa;">
      <tr>
        <th>Tab</th>
        <th>Recipient</th>
        <th>Building(s)</th>
        <th>Unit(s)</th>
        <th>PO(s)</th>
        <th>#Units</th>
        <th>Subject</th>
        <th>Rows</th>
      </tr>
    </thead>
    <tbody>${rowsHtml || `<tr><td colspan="8">No details.</td></tr>`}</tbody>
  </table>
</div>`.trim();

  const text = [
    "Execution completed.",
    `Emails sent: ${summary.emailsSent}`,
    `Rows marked: ${summary.rowsMarked}`,
    `Errors: ${summary.errors}`,
    "",
    "Details:",
    JSON.stringify(summary.details, null, 2)
  ].join("\n");

  sendLogEmail_(subject, text, html);
}

function sendLogEmail_(subject, textBody, htmlBody) {
  try {
    GmailApp.sendEmail(
      LOG_RECIPIENTS[0],
      subject,
      textBody,
      {
        htmlBody: htmlBody || undefined,
        cc: LOG_RECIPIENTS.slice(1).join(",") || undefined,
        name: "Initial MOS OD Script Logger",
        replyTo: TEAM_INBOX
      }
    );
  } catch (e) {
    GmailApp.sendEmail(LOG_RECIPIENTS[0], subject + " (fallback)", String(textBody || "") + "\n\n" + String(e));
  }
}

/* -------------------- Helpers -------------------- */

function safeStr_(v) { return v == null ? "" : String(v).trim(); }

function escapeHtml_(s) {
  return String(s || "").replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);
  });
}

function parseRecipients_(raw) {
  return (raw || "")
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

function buildHtmlTableMOSOD_(items) {
  const rows = items.map(it =>
    `<tr><td>${escapeHtml_(it.building || "")}</td><td>${escapeHtml_(it.unit || "")}</td><td>${escapeHtml_(it.moveOutDate || "")}</td><td>${escapeHtml_(it.citypo || "")}</td></tr>`
  ).join("");
  return `
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:10px 0;font-family:Arial,sans-serif;font-size:13px;">
  <thead><tr><th align="left">Landlord / Building</th><th align="left">Unit #</th><th align="left">Move-Out Date</th><th align="left">Internal no.</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`.trim();
}

function buildTextTableMOSOD_(items) {
  const lines = ["Landlord / Building | Unit # | Move-Out Date | Internal no."];
  items.forEach(it => lines.push(`${it.building || ""} | ${it.unit || ""} | ${it.moveOutDate || ""} | ${it.citypo || ""}`));
  return lines.join("\n");
}

function isPAPAPPBuilding_(building) {
  const txt = safeStr_(building).toUpperCase();
  return txt.indexOf("APP") !== -1 || txt.indexOf("PAP") !== -1;
}

function buildTextBodyMOSODPAPAPP_(buildingName, items) {
  const textTable = buildTextTableMOSOD_(items);

  return `
Hi Team at ${buildingName},

We’re reaching out on behalf of [Company] Inc., a furnished rental company managing flexible-stay apartments across the US and globally.

[Company] acquired [Previous Operator] and has assumed responsibility for all related leases and operations. Our portfolio also includes properties originally managed or booked through various housing platforms and apps.

Could you please provide the following information regarding the move-out of the units listed below?

${textTable}

Kindly confirm:

- If the keys were returned
- If the unit was walked/inspected after move-out
- If no damages were identified

Thank you very much for your cooperation.

Have a great day!

[Company] Finance Team
`.trim();
}

function buildHtmlBodyMOSODPAPAPP_(buildingName, items) {
  const htmlTable = buildHtmlTableMOSOD_(items);

  return `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;">
  <p style="color:#2F4F6F;"><strong>Hi Team at ${escapeHtml_(buildingName)}</strong>,</p>

  <p>We’re reaching out on behalf of <strong style="color:#2F4F6F;">[Company] Inc.</strong>, a furnished rental company managing flexible-stay apartments across the US and globally.</p>

  <p>[Company] acquired [Previous Operator] and has assumed responsibility for all related leases and operations. Our portfolio also includes properties originally managed or booked through various housing platforms and apps.</p>

  <p>Could you please provide the following information regarding the move-out of the units listed below?</p>

  ${htmlTable}

  <p><strong style="color:#2F4F6F;">Kindly confirm:</strong></p>

  <ul>
    <li>If the keys were returned</li>
    <li>If the unit was walked/inspected after move-out</li>
    <li>If no damages were identified</li>
  </ul>

  <p>Thank you very much for your cooperation.</p>

  <p>Have a great day!<br>
  <strong style="color:#2F4F6F;">[Company] Finance Team</strong></p>
</div>`.trim();
}

function logMOSODEmailExecution_(functionName, executionStart, status, comment) {
  try {
    const executionEnd = new Date();
    const durationSec = Math.round(((executionEnd.getTime() - executionStart.getTime()) / 1000) * 100) / 100;

    const ss = SpreadsheetApp.openById(MOS_EMAILS_OD_LOG_SPREADSHEET_ID);
    const sheet = ss.getSheetByName(MOS_EMAILS_OD_LOG_SHEET_NAME);
    if (!sheet) throw new Error('Log sheet not found: "' + MOS_EMAILS_OD_LOG_SHEET_NAME + '"');

    const lastCol = Math.max(1, sheet.getLastColumn());
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => normalizeHeader_(h));

    const colFunction = headers.indexOf("function") + 1;
    const colTimestamp = headers.indexOf("timestamp") + 1;
    const colStatus = headers.indexOf("status") + 1;
    const colDuration = headers.indexOf("durationsec") + 1;
    const colComment = headers.indexOf("comment") + 1;

    if (!colFunction || !colTimestamp || !colStatus || !colDuration || !colComment) {
      throw new Error('Central log headers missing. Need: "Function", "Timestamp", "Status", "Duration (sec)", "Comment"');
    }

    const targetRow = sheet.getLastRow() + 1;

    sheet.getRange(targetRow, colFunction).setValue(functionName);
    sheet.getRange(targetRow, colTimestamp).setValue(executionEnd);
    sheet.getRange(targetRow, colStatus).setValue(status);
    sheet.getRange(targetRow, colDuration).setValue(durationSec);
    sheet.getRange(targetRow, colComment).setValue(comment || "");

  } catch (logErr) {
    Logger.log("Could not write MOS Emails OD central log: " + String(logErr));
  }
}

function getHeaderIndices_(sheet, tabName) {
  const hdrRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lookup = {};
  const exactLookup = {};
  for (let c = 0; c < hdrRow.length; c++) {
    const h = hdrRow[c];
    if (!h) continue;
    lookup[String(h).toLowerCase().replace(/[^a-z0-9]+/g, "")] = c + 1;
    const exactKey = String(h).trim();
    if (!exactLookup[exactKey]) exactLookup[exactKey] = c + 1;
  }
  function findOne(keys) {
    for (let k of keys) {
      const key = k.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (lookup[key]) return lookup[key];
    }
    return null;
  }
  // Exact title match only (trims surrounding spaces, nothing else)
  function findExact(title) {
    return exactLookup[title] || null;
  }

  const map = {};
  if (tabName === "Dropped") {
    map.colEmailTo  = findOne(["send mos request to", "sendmosrequestto"]);
    map.colSendMOS  = findOne([
      "send initial mos email?",
      "send initial mos email",
      "sendinitialmosemail",
      "sendinitialmosemail?"
    ]);
    map.colConfirmation = findOne([
      "confirmation initial mos  email",
      "confirmation initial mos email",
      "confirmationinitialmosemail",
      "confirmationinitialmosemail?"
    ]);
    map.colBuilding = findOne(["landlord - building", "landlord-building", "landlordbuilding", "building"]);
    map.colUnit     = findOne(["unit #", "unit#", "unitnumber", "unit"]);
    map.colCityPO   = findOne(["city-po", "citypo", "internal no.", "internalno", "po"]);
  } else {
    map.colEmailTo      = findOne(["sendmosrequestto", "send mos request to"]);
    map.colSendMOS      = findOne([
      "send initial mos email?",
      "send initial mos email",
      "sendinitialmosemail",
      "sendinitialmosemail?"
    ]);
    map.colConfirmation = findOne([
      "confirmation initial mos  email",
      "confirmation initial mos email",
      "confirmationinitialmosemail",
      "confirmationinitialmosemail?"
    ]);
    map.colBuilding     = findOne(["landlord - building", "landlord-building", "landlordbuilding", "building"]);
    map.colUnit         = findOne(["unit #", "unit#", "unitnumber", "unit"]);
    map.colCityPO       = findOne(["city-po", "citypo", "internal no.", "internalno", "po"]);
  }

  // Move-Out Date: EXACT header title only, to avoid matching other "move-out" columns
  map.colMoveOutDate = findExact("Move-Out Date");

  if (!map.colEmailTo || !map.colSendMOS || !map.colConfirmation) {
    throw new Error("Required headers missing in " + tabName + ". Need: Send MOS request to, Send Initial MOS Email?, Confirmation Initial MOS  Email");
  }
  return map;
}

/**
 * ONE-TIME HELPER
 */
function recordODManualRunNow() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  props.setProperty(MOS_OD_LAST_SUCCESS_KEY, now.toISOString());
  Logger.log(" [OD] Manual run recorded at: " + now.toISOString());
}

/***** SLACK (DEPARTMENT Y) *****/
const SLACK_WEBHOOK_URL_OD = "YOUR_SLACK_WEBHOOK_URL";

function postToSlackOD_(message) {
  if (!SLACK_WEBHOOK_URL_OD) {
    Logger.log("Slack webhook URL is empty.");
    return;
  }

  const payload = { text: message };

  const res = UrlFetchApp.fetch(SLACK_WEBHOOK_URL_OD, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  Logger.log("Slack HTTP status: " + res.getResponseCode());
  Logger.log("Slack response body: " + res.getContentText());
}

/**
 * Test Slack without sending any emails.
 * Run this manually to authorize UrlFetchApp and validate the webhook.
 */
function testSlackODNotification() {
  postToSlackOD_("Hello! This is a test message.");
}

/**
 * SAMPLE helper:
 * Reads up to maxItems real rows from the "Dropped Relo/App" and "Dropped" tabs
 * (read-only — does NOT mark anything) so samples show real data,
 * including the Move-Out Date column.
 * If papappOnly = true, returns only PAP/APP buildings.
 */
function collectSampleItemsOD_(maxItems, papappOnly) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const out = [];

  for (let t = 0; t < TABS.length && out.length < maxItems; t++) {
    const tabName = TABS[t];
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) continue;

    const hdr = getHeaderIndices_(sheet, tabName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) continue;

    const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();

    for (let i = 0; i < data.length && out.length < maxItems; i++) {
      const row = data[i];
      const building    = safeStr_(hdr.colBuilding    ? row[hdr.colBuilding - 1]    : "");
      const unit        = safeStr_(hdr.colUnit        ? row[hdr.colUnit - 1]        : "");
      const citypo      = safeStr_(hdr.colCityPO      ? row[hdr.colCityPO - 1]      : "");
      const moveOutDate = safeStr_(hdr.colMoveOutDate ? row[hdr.colMoveOutDate - 1] : "");

      if (!building && !unit && !citypo) continue;
      if (papappOnly && !isPAPAPPBuilding_(building)) continue;

      out.push({ building, unit, citypo, moveOutDate });
    }
  }

  return out;
}

/**
 * Sends a SAMPLE Department Y move-out email to the maintainer only.
 * Reads REAL rows from the tabs (read-only) so you can see the Move-Out Date column.
 * Does NOT mark confirmation, does NOT log.
 */
function sendSampleMariODEmail() {
  const recipient = "your-email@example.com";
  const subject = "SAMPLE – Security Deposit Return & Move-out – Department Y";

  let items = collectSampleItemsOD_(3, false);
  if (items.length === 0) {
    items = [
      { building: "OD Sample Property", unit: "12A", moveOutDate: "2026-05-15", citypo: "LAX-115" },
      { building: "OD Sample Property", unit: "33C", moveOutDate: "2026-05-28", citypo: "NYC-999" }
    ];
  }

  const buildingName = items[0].building || "OD Sample Property";
  const htmlTable = buildHtmlTableMOSOD_(items);

  const htmlBody = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;">
      <p style="color:#2F4F6F;"><strong>Hi Team at ${escapeHtml_(buildingName)}</strong>,</p>

      <p>We’re reaching out on behalf of <strong style="color:#2F4F6F;">[Company]</strong>, a furnished rental company managing flexible-stay apartments across the US and globally.<br>

      <p>[Company] acquired [Previous Operator] and has assumed responsibility for all related leases and operations. Our portfolio also includes properties originally managed or booked through various housing platforms and apps.</p>

      <p>Could you please help us by providing the following for the properties listed below:</p>

      ${htmlTable}

      <ul>
        <li style="color:#2F4F6F;"><strong>Copy of the Move-Out Statement or Final Ledger</strong></li>
        <li style="color:#2F4F6F;"><strong>Confirmation of the Security Deposit Return status</strong></li>
        <li style="color:#2F4F6F;"><strong>If applicable, details of any damage charges deducted from the deposit, along with supporting documentation</strong></li>
      </ul>

      <p>If a refund will be issued, we can send you a secure payment link upon request.</p>

      <p>Thank you very much for your cooperation.<br>
      Have a great day!<br>
      <strong style="color:#2F4F6F;">[Company] Finance Team</strong></p>
    </div>
  `;

  GmailApp.sendEmail(recipient, subject, "", { htmlBody });
}

/**
 * Sends a SAMPLE PAP/APP move-out email to the maintainer only.
 * Reads REAL PAP/APP rows from the tabs (read-only) so you can see the Move-Out Date column.
 * Does NOT mark confirmation, does NOT log.
 */
function sendSampleMariODPAPAPPEmail() {
  const recipient = "your-email@example.com";
  const subject = "SAMPLE – Security Deposit Return & Move-out – PAP/APP";

  let items = collectSampleItemsOD_(3, true);
  if (items.length === 0) {
    items = [
      { building: "APP-Sample Tower - APP-Sample Tower", unit: "12A", moveOutDate: "2026-05-15", citypo: "LAX-115" },
      { building: "APP-Sample Tower - APP-Sample Tower", unit: "33C", moveOutDate: "2026-05-28", citypo: "NYC-999" }
    ];
  }

  const buildingName = items[0].building || "APP Sample Property";

  const textBody = buildTextBodyMOSODPAPAPP_(buildingName, items);
  const htmlBody = buildHtmlBodyMOSODPAPAPP_(buildingName, items);

  GmailApp.sendEmail(recipient, subject, textBody, { htmlBody: htmlBody });
}

function recoverInitialMOSLog() {
  const START_AFTER = "2026/03/08";
  const END_BEFORE = "2026/03/12";
  const SUBJECT_PREFIX = "Security Deposit Return & Move-out";
  const EMAIL_TYPE = "Initial MOS";
  const LOG_SHEET_NAME = "MOS Log";

  function norm_(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function subjectStartsExactly_(subject, prefix) {
    return String(subject || "").trim().startsWith(prefix);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!logSheet) throw new Error(`MOS Log sheet not found: "${LOG_SHEET_NAME}"`);

  const logLastCol = Math.max(1, logSheet.getLastColumn());
  const logHeaders = logSheet.getRange(1, 1, 1, logLastCol).getValues()[0].map(norm_);

  const colCityPO = logHeaders.indexOf("citypo") + 1;
  const colTab = logHeaders.indexOf("tab") + 1;
  const colDate = logHeaders.indexOf("date") + 1;
  const colEmailType = logHeaders.indexOf("emailtype") + 1;

  if (!colCityPO || !colTab || !colDate || !colEmailType) {
    throw new Error(`MOS Log headers missing. Need: City-PO, Tab, Date, Email Type`);
  }

  const existingKeys = new Set();
  const logLastRow = logSheet.getLastRow();
  if (logLastRow >= 2) {
    const existingData = logSheet.getRange(2, 1, logLastRow - 1, logLastCol).getValues();
    existingData.forEach(r => {
      const po = String(r[colCityPO - 1] || "").trim();
      const tab = String(r[colTab - 1] || "").trim();
      const dt = r[colDate - 1] instanceof Date
        ? Utilities.formatDate(r[colDate - 1], Session.getScriptTimeZone(), "yyyy-MM-dd")
        : String(r[colDate - 1] || "").trim();
      const et = String(r[colEmailType - 1] || "").trim();
      if (po && tab && dt && et) {
        existingKeys.add(`${po}||${tab}||${dt}||${et}`);
      }
    });
  }

  const tabs = ["Dropped Relo/App", "Dropped"];
  const poTabRows = [];
  const seen = new Set();

  tabs.forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet || sheet.getLastRow() < 2) return;

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(norm_);
    const idxCityPO = headers.indexOf("citypo");
    if (idxCityPO === -1) return;

    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
    data.forEach(row => {
      const po = String(row[idxCityPO] || "").trim();
      if (!po) return;
      const key = `${po}||${tabName}`;
      if (!seen.has(key)) {
        seen.add(key);
        poTabRows.push({ citypo: po, tab: tabName });
      }
    });
  });

  const rowsToAppend = [];

  poTabRows.forEach(entry => {
    const query = `in:sent from:team-inbox@example.com subject:"${SUBJECT_PREFIX}" "${entry.citypo}" after:${START_AFTER} before:${END_BEFORE}`;
    const threads = GmailApp.search(query, 0, 20);

    let matchedDate = null;

    threads.forEach(thread => {
      thread.getMessages().forEach(msg => {
        const subj = msg.getSubject() || "";

        if (!subjectStartsExactly_(subj, "Security Deposit Return & Move-out")) return;
        if (subj.includes("Follow-up Security Deposit Return & Move-out")) return;
        if (subj.includes("Security Deposit Return Status")) return;
        if (!subj.includes(entry.citypo)) return;

        const d = msg.getDate();
        if (!matchedDate || d.getTime() > matchedDate.getTime()) {
          matchedDate = d;
        }
      });
    });

    if (matchedDate) {
      const dateKey = Utilities.formatDate(matchedDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
      const dedupeKey = `${entry.citypo}||${entry.tab}||${dateKey}||${EMAIL_TYPE}`;

      if (!existingKeys.has(dedupeKey)) {
        rowsToAppend.push({
          citypo: entry.citypo,
          tab: entry.tab,
          date: matchedDate,
          emailType: EMAIL_TYPE
        });
        existingKeys.add(dedupeKey);
      }
    }
  });

  if (!rowsToAppend.length) {
    Logger.log("No missing Initial MOS Log rows found.");
    return;
  }

  const startRow = logSheet.getLastRow() + 1;
  logSheet.getRange(startRow, colCityPO, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.citypo]));
  logSheet.getRange(startRow, colTab, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.tab]));
  logSheet.getRange(startRow, colDate, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.date]));
  logSheet.getRange(startRow, colEmailType, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.emailType]));
  logSheet.getRange(startRow, colDate, rowsToAppend.length, 1).setNumberFormat("yyyy-mm-dd");

  Logger.log(`Recovered ${rowsToAppend.length} Initial MOS Log rows.`);
}
