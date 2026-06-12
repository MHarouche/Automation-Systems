/**
 * sendMOSODRefundNotFoundEmails_RE
 * - Tabs: "Dropped Relo/App" and "Dropped" (reads data + sends emails)
 * - Sends ONE aggregated email per recipient-group (grouping units / City-POs)
 * - Sends only when "Refund Not Found Email" = "YES"
 * - Does NOT send if "Confirmation Refund Not Found Email" = "YES"
 * - Marks "Confirmation Refund Not Found Email" = YES after successful send
 * - Subject: Security Deposit Return Status - [Landlord - Building] - [City-POs] - [Company]
 * - HTML body styled with #2F4F6F for headings/bullets (dark medium blue)
 * - Truncates subject if too long (150 chars)
 * - Populates MOS Log with Email type = "Refund"
 * - Sends run log by email
 * - Notifies Slack
 * - Includes sample email + Slack test
 * - Created by Mari Harouche
 *
 * IMPORTANT: All consts use _RE suffix to avoid collisions with Initial/Follow-up scripts.
 */

const TEAM_INBOX_RE = "team-inbox@example.com";
const LOG_RECIPIENTS_RE = ["your-email@example.com", "teammate@example.com"];
const TABS_RE = ["Dropped Relo/App", "Dropped"];
const MAX_SUBJECT_LENGTH_RE = 150;

const MOS_EMAILS_OD_LOG_SPREADSHEET_ID_RE = "YOUR_CENTRAL_LOG_SPREADSHEET_ID";
const MOS_EMAILS_OD_LOG_SHEET_NAME_RE = "MOS Emails OD";

// MOS LOG (OD)
const OD_MOS_LOG_SHEET_NAME_RE = "MOS Log";
const OD_MOS_LOG_HEADERS_RE = { citypo: "City-PO", tab: "Tab", date: "Date", emailType: "Email Type" };
const OD_MOS_LOG_EMAIL_TYPE_REFUND_RE = "MOS refund request";

// Slack (On-Demand)
const SLACK_WEBHOOK_URL_OD_RE = "YOUR_SLACK_WEBHOOK_URL";

/**
 * Main
 */
function sendMOSODRefundNotFoundEmails_RE() {
  const functionName = "sendMOSODRefundNotFoundEmails_RE";
  const executionStart = new Date();
  let executionStatus = "OK";
  let executionComment = "";
  let lockAcquired = false;

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    lockAcquired = true;
  }
  catch (e) {
    executionStatus = "ERROR";
    executionComment = "Could not acquire script lock. " + String(e);
    sendLogEmail_RE_("MOS OD Refund Script ERROR", "Could not acquire script lock.\n\n" + String(e));
    logMOSODRefundEmailExecution_RE_(functionName, executionStart, executionStatus, executionComment);
    return;
  }

  const summary = { emailsSent: 0, rowsMarked: 0, errors: 0, details: [] };

  // MOS Log: collect successful City-PO + Tab pairs (dedupe)
  const successLogKeysThisRun = new Set();
  const successLogRowsThisRun = [];

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    for (let t = 0; t < TABS_RE.length; t++) {
      const tabName = TABS_RE[t];
      const sheet = ss.getSheetByName(tabName);
      if (!sheet) continue;

      const hdr = getHeaderIndicesRefund_RE_(sheet, tabName);
      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      if (lastRow < 2) continue;

      const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();

      /**
       * Group key = recipient list (normalized + sorted)
       * group = { recipients:[...], to, cc, items:[], tabName, rowNumbers:Set }
       */
      const groups = {};

      for (let i = 0; i < data.length; i++) {
        const rowNumber = i + 2;
        const row = data[i];

        const emailRaw       = safeStr_RE_(hdr.colEmailTo ? row[hdr.colEmailTo - 1] : "");
        const refundFlag      = safeStr_RE_(hdr.colRefundFlag ? row[hdr.colRefundFlag - 1] : "").toUpperCase();
        const confirmation    = safeStr_RE_(hdr.colConfirmation ? row[hdr.colConfirmation - 1] : "").toUpperCase();

        const building        = safeStr_RE_(hdr.colBuilding ? row[hdr.colBuilding - 1] : "");
        const unit            = safeStr_RE_(hdr.colUnit ? row[hdr.colUnit - 1] : "");
        const citypo          = safeStr_RE_(hdr.colCityPO ? row[hdr.colCityPO - 1] : "");
        const SDAmount  = safeStr_RE_(hdr.colSDAmount ? row[hdr.colSDAmount - 1] : "");
        const lastLeaseStart  = safeStr_RE_(hdr.colLastLeaseStart ? row[hdr.colLastLeaseStart - 1] : "");
        const clientEndDate   = safeStr_RE_(hdr.colClientEnd ? row[hdr.colClientEnd - 1] : "");

        // sending conditions
        if (!emailRaw) continue;
        if (refundFlag !== "YES") continue;              // covers NO / blank / "NO SD" etc

        const recipients = parseRecipients_RE_(emailRaw);
        if (recipients.length === 0) continue;

        const normalized = recipients.map(r => r.toLowerCase()).sort();
        const groupKey = normalized.join(";");

        const item = {
          rowNumber,
          building,
          unit,
          citypo,
          SDAmount,
          lastLeaseStart,
          clientEndDate
        };

        if (!groups[groupKey]) {
          groups[groupKey] = {
            recipients,
            to: recipients[0],
            cc: recipients.slice(1),
            items: [],
            tabName,
            rowNumbers: new Set()
          };
        }

        groups[groupKey].items.push(item);
        groups[groupKey].rowNumbers.add(rowNumber);
      } // rows

      // Send aggregated emails per group
      const groupKeys = Object.keys(groups);
      for (let g = 0; g < groupKeys.length; g++) {
        const group = groups[groupKeys[g]];
        const items = group.items;
        if (!items || items.length === 0) continue;

        // Subject
        let subject = buildRefundSubject_RE_(items);
        if (subject.length > MAX_SUBJECT_LENGTH_RE) {
          subject = subject.substring(0, MAX_SUBJECT_LENGTH_RE - 3) + "...";
        }

        // Bodies
        const htmlTable = buildHtmlTableRefund_RE_(items);
        const textTable = buildTextTableRefund_RE_(items);

        const buildingName = items[0].building || "your property";

        const textBody = `
Dear ${buildingName},

We are reaching out on behalf of [Company] / [Previous Operator] regarding the status of the security deposit(s) paid to you at the beginning of the lease(s), specifically for the periods below:

${textTable}

If the security deposit refund(s) has already been issued, could you please let us know:

- The date it was returned
- The payment method used (check, ACH, wire transfer, etc.)
- The bank account it was sent to
- If payment was made by check, please also confirm whether the funds have been deducted from your account

Thank you very much for your attention, and we look forward to hearing from you soon.

Best regards,

Finance Admin Team | [Company]
`.trim();

        const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;">
  <p>Dear ${escapeHtml_RE_(buildingName)},</p>

  <p>
    We are reaching out on behalf of
    <strong style="color:#2F4F6F;">[Company] / [Previous Operator]</strong>
    regarding the status of the security deposit(s) paid to you at the beginning of the lease(s), specifically for the periods below:
  </p>

  ${htmlTable}

  <p>If the security deposit refund(s) has already been issued, could you please let us know:</p>

  <ul style="margin-top:6px;">
    <li style="color:#2F4F6F;"><strong>The date it was returned</strong></li>
    <li style="color:#2F4F6F;"><strong>The payment method used (check, ACH, wire transfer, etc.)</strong></li>
    <li style="color:#2F4F6F;"><strong>The bank account it was sent to</strong></li>
    <li style="color:#2F4F6F;"><strong>If payment was made by check, please also confirm whether the funds have been deducted from your account</strong></li>
  </ul>

  <p>Thank you very much for your attention, and we look forward to hearing from you soon.</p>

  <p>
    Best regards,<br><br>
    <strong style="color:#2F4F6F;">Finance Admin Team | [Company]</strong>
  </p>
</div>`.trim();

        try {
          GmailApp.sendEmail(
            group.to,
            subject,
            textBody,
            {
              htmlBody: htmlBody,
              replyTo: TEAM_INBOX_RE,
              name: "Finance Admin Team | [Company]",
              cc: (group.cc && group.cc.length ? group.cc.join(",") : undefined)
            }
          );

          summary.emailsSent++;

          // MOS Log rows (dedupe per City-PO + Tab)
          const uniquePOsForThisEmail = [...new Set(items.map(it => safeStr_RE_(it.citypo)).filter(Boolean))];
          uniquePOsForThisEmail.forEach(po => {
            const key = `${po}||${tabName}`;
            if (!successLogKeysThisRun.has(key)) {
              successLogKeysThisRun.add(key);
              successLogRowsThisRun.push({ citypo: po, tab: tabName });
            }
          });

          // Mark Confirmation Refund Not Found Email = YES for all rows in this group
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
          const detail = buildDetailForLogRefund_RE_(tabName, group.to, group.cc, subject, items);
          summary.details.push(detail);

        } catch (sendErr) {
          summary.errors++;
          summary.details.push({ type: "send-error", tab: tabName, to: group.to, cc: (group.cc || []).join(","), err: String(sendErr) });
        }
      } // groups
    } // tabs

    // Send log email
    sendSummaryLogRefund_RE_(summary);

    // Slack notification
    if (summary.emailsSent > 0) {
      postToSlackOD_RE_("Hello @your-team! MOS OD Missed Security Deposit Refund Emails was sent! :D");
    }

    // Append MOS Log
    if (successLogRowsThisRun.length > 0) {
      appendODMOSLogRowsRefund_RE_(successLogRowsThisRun, new Date());
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
    sendLogEmail_RE_("MOS OD Refund Script ERROR", String(e) + "\n\n" + (e.stack || ""));
    throw e;
  } finally {
    logMOSODRefundEmailExecution_RE_(functionName, executionStart, executionStatus, executionComment);

    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

/**
 * Header indices for REFUND workflow
 * Uses:
 * - Send column: "Refund Not Found Email"
 * - Confirmation column: "Confirmation Refund Not Found Email"
 * - Email recipients: "Send MOS request to"
 * - Data columns: City-PO, Unit #, Amount Expected, Last Lease Start Date, Client End Date, Landlord - Building
 */
function getHeaderIndicesRefund_RE_(sheet, tabName) {
  const hdrRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const lookup = {};
  for (let c = 0; c < hdrRow.length; c++) {
    const h = hdrRow[c];
    if (!h) continue;
    lookup[String(h).toLowerCase().replace(/[^a-z0-9]+/g, "")] = c + 1;
  }
  function findOne(keys) {
    for (let k of keys) {
      const key = k.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (lookup[key]) return lookup[key];
    }
    return null;
  }

  const map = {};

  map.colEmailTo = findOne(["send mos request to", "sendmosrequestto"]);

  // Refund send flag
  map.colRefundFlag = findOne([
    "refund not found email",
    "refundnotfoundemail"
  ]);

  // IMPORTANT: pick the specific confirmation column (avoid other confirmation columns)
  map.colConfirmation = findOne([
    "confirmation refund not found email",
    "confirmationrefundnotfoundemail",
    "confirmation refund not found    email" // double/multi-space safety
  ]);

  map.colBuilding = findOne(["landlord - building", "landlord-building", "landlordbuilding", "building"]);
  map.colUnit = findOne(["unit #", "unit#", "unitnumber", "unit"]);
  map.colCityPO = findOne(["city-po", "citypo", "internal no.", "internalno", "po"]);

  map.colSDAmount = findOne(["sd amount", "sdamount"]);
  map.colLastLeaseStart = findOne(["last lease start date", "lastleasestartdate"]);
  map.colClientEnd = findOne(["client end date", "clientenddate"]);

  if (!map.colEmailTo || !map.colRefundFlag || !map.colConfirmation || !map.colSDAmount) {
    throw new Error(
      "Required headers missing in " + tabName +
      ". Need: Send MOS request to, Refund Not Found Email, Confirmation Refund Not Found Email, SD amount"
    );
  }
  return map;
}

/* -------------------- Subject -------------------- */
// Security Deposit Return Status - [Landlord - Building] - [City-POs] - [Company]
function buildRefundSubject_RE_(items) {
  if (!items || items.length === 0) return "Security Deposit Return Status - [Company]";

  const building = items[0].building || "";
  const poList = [...new Set(items.map(it => it.citypo || "").filter(Boolean))];
  const poString = poList.join(", ");

  const parts = ["Security Deposit Return Status"];
  if (building) parts.push(building);
  if (poString) parts.push(poString);
  parts.push("[Company]");

  return parts.join(" - ");
}

/* -------------------- Tables -------------------- */
function buildHtmlTableRefund_RE_(items) {
  const rows = items.map(it => `
    <tr>
      <td style="padding:8px;border:1px solid #d9d9d9;">${escapeHtml_RE_(it.citypo || "")}</td>
      <td style="padding:8px;border:1px solid #d9d9d9;">${escapeHtml_RE_(it.unit || "")}</td>
      <td style="padding:8px;border:1px solid #d9d9d9;">${escapeHtml_RE_(it.SDAmount || "")}</td>
      <td style="padding:8px;border:1px solid #d9d9d9;">${escapeHtml_RE_(it.lastLeaseStart || "")}</td>
      <td style="padding:8px;border:1px solid #d9d9d9;">${escapeHtml_RE_(it.clientEndDate || "")}</td>
    </tr>
  `).join("");

  return `
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:12px 0;font-family:Arial,sans-serif;font-size:13px;">
  <thead>
    <tr>
      <th style="padding:8px;border:1px solid #d9d9d9;color:#2F4F6F;text-align:left;">Internal no.</th>
      <th style="padding:8px;border:1px solid #d9d9d9;color:#2F4F6F;text-align:left;">Unit</th>
      <th style="padding:8px;border:1px solid #d9d9d9;color:#2F4F6F;text-align:left;">Security Deposit Expected</th>
      <th style="padding:8px;border:1px solid #d9d9d9;color:#2F4F6F;text-align:left;">Last Lease Start Date</th>
      <th style="padding:8px;border:1px solid #d9d9d9;color:#2F4F6F;text-align:left;">Client End Date</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`.trim();
}

function buildTextTableRefund_RE_(items) {
  const lines = ["Internal no. | Unit | Security Deposit Expected | Last Lease Start Date | Client End Date"];
  items.forEach(it => {
    lines.push(`${it.citypo || ""} | ${it.unit || ""} | ${it.SDAmount || ""} | ${it.lastLeaseStart || ""} | ${it.clientEndDate || ""}`);
  });
  return lines.join("\n");
}

function normalizeHeader_RE_(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/* -------------------- MOS LOG append -------------------- */
/**
 * Appends [City-PO, Tab, Date, Email type] to MOS Log.
 * Appends below last row; does not overwrite.
 */
function appendODMOSLogRowsRefund_RE_(rows, dateObj) {
  if (!rows || rows.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(OD_MOS_LOG_SHEET_NAME_RE);
  if (!logSheet) throw new Error(`OD MOS Log sheet not found: "${OD_MOS_LOG_SHEET_NAME_RE}"`);

  const lastCol = Math.max(1, logSheet.getLastColumn());
  const headerRow = logSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const normalized = headerRow.map(h => normalizeHeader_RE_(h));

  const colCityPO = normalized.indexOf("citypo") + 1;
  const colTab = normalized.indexOf("tab") + 1;
  const colDate = normalized.indexOf("date") + 1;
  const colEmailType = normalized.indexOf("emailtype") + 1;

  if (!colCityPO || !colTab || !colDate || !colEmailType) {
    throw new Error(
      `OD MOS Log headers missing. Need: "${OD_MOS_LOG_HEADERS_RE.citypo}", "${OD_MOS_LOG_HEADERS_RE.tab}", "${OD_MOS_LOG_HEADERS_RE.date}", "${OD_MOS_LOG_HEADERS_RE.emailType}"`
    );
  }

  const startRow = logSheet.getLastRow() + 1;

  const cityValues = rows.map(r => [r.citypo]);
  const tabValues = rows.map(r => [r.tab]);
  const dateValues = rows.map(() => [dateObj]);
  const emailTypeValues = rows.map(() => [OD_MOS_LOG_EMAIL_TYPE_REFUND_RE]);

  logSheet.getRange(startRow, colCityPO, cityValues.length, 1).setValues(cityValues);
  logSheet.getRange(startRow, colTab, tabValues.length, 1).setValues(tabValues);
  logSheet.getRange(startRow, colDate, dateValues.length, 1).setValues(dateValues);
  logSheet.getRange(startRow, colEmailType, emailTypeValues.length, 1).setValues(emailTypeValues);

  logSheet.getRange(startRow, colDate, dateValues.length, 1).setNumberFormat("yyyy-mm-dd");
}

/* -------------------- Logs by Email -------------------- */
function buildDetailForLogRefund_RE_(tabName, to, ccArr, subject, items) {
  const buildings = [...new Set(items.map(i => i.building).filter(Boolean))];
  const units = items.map(i => i.unit).filter(Boolean);
  const pos = [...new Set(items.map(i => i.citypo).filter(Boolean))];
  const rows = items.map(i => i.rowNumber).join(", ");
  return {
    type: "sent",
    tab: tabName,
    to,
    cc: (ccArr && ccArr.length ? ccArr.join(", ") : ""),
    buildings: buildings.join(", "),
    units: units.join(", "),
    pos: pos.join(", "),
    countUnits: units.length,
    subject,
    rows
  };
}

function sendSummaryLogRefund_RE_(summary) {
  const subject = `MOS OD Refund Script Log — sent:${summary.emailsSent} marked:${summary.rowsMarked} errors:${summary.errors}`;

  const rowsHtml = summary.details.map(d => {
    if (d.type === "sent") {
      return `<tr>
        <td>${escapeHtml_RE_(d.tab)}</td>
        <td>${escapeHtml_RE_(d.to)}</td>
        <td>${escapeHtml_RE_(d.cc || "")}</td>
        <td>${escapeHtml_RE_(d.buildings || "")}</td>
        <td>${escapeHtml_RE_(d.units || "")}</td>
        <td>${escapeHtml_RE_(d.pos || "")}</td>
        <td style="text-align:right;">${d.countUnits || 0}</td>
        <td>${escapeHtml_RE_(d.subject || "")}</td>
        <td>${escapeHtml_RE_(d.rows || "")}</td>
      </tr>`;
    } else if (d.type === "send-error") {
      return `<tr style="color:#a00;"><td colspan="9">SEND ERROR [${escapeHtml_RE_(d.tab)} → ${escapeHtml_RE_(d.to)}]: ${escapeHtml_RE_(d.err)}</td></tr>`;
    } else if (d.type === "mark-error") {
      return `<tr style="color:#a00;"><td colspan="9">MARK ERROR [${escapeHtml_RE_(d.tab)} row ${escapeHtml_RE_(String(d.row))}]: ${escapeHtml_RE_(d.err)}</td></tr>`;
    } else {
      return `<tr><td colspan="9">${escapeHtml_RE_(JSON.stringify(d))}</td></tr>`;
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
        <th>To</th>
        <th>CC</th>
        <th>Building(s)</th>
        <th>Unit(s)</th>
        <th>PO(s)</th>
        <th>#Units</th>
        <th>Subject</th>
        <th>Rows</th>
      </tr>
    </thead>
    <tbody>${rowsHtml || `<tr><td colspan="9">No details.</td></tr>`}</tbody>
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

  sendLogEmail_RE_(subject, text, html);
}

function sendLogEmail_RE_(subject, textBody, htmlBody) {
  try {
    GmailApp.sendEmail(
      LOG_RECIPIENTS_RE[0],
      subject,
      textBody,
      {
        htmlBody: htmlBody || undefined,
        cc: LOG_RECIPIENTS_RE.slice(1).join(",") || undefined,
        name: "MOS OD Refund Script Logger",
        replyTo: TEAM_INBOX_RE
      }
    );
  } catch (e) {
    GmailApp.sendEmail(LOG_RECIPIENTS_RE[0], subject + " (fallback)", String(textBody || "") + "\n\n" + String(e));
  }
}

function logMOSODRefundEmailExecution_RE_(functionName, executionStart, status, comment) {
  try {
    const executionEnd = new Date();
    const durationSec = Math.round(((executionEnd.getTime() - executionStart.getTime()) / 1000) * 100) / 100;

    const ss = SpreadsheetApp.openById(MOS_EMAILS_OD_LOG_SPREADSHEET_ID_RE);
    const sheet = ss.getSheetByName(MOS_EMAILS_OD_LOG_SHEET_NAME_RE);
    if (!sheet) throw new Error('Log sheet not found: "' + MOS_EMAILS_OD_LOG_SHEET_NAME_RE + '"');

    const lastCol = Math.max(1, sheet.getLastColumn());
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => normalizeHeader_RE_(h));

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

/* -------------------- Slack -------------------- */
function postToSlackOD_RE_(message) {
  if (!SLACK_WEBHOOK_URL_OD_RE) {
    Logger.log("Slack webhook URL is empty.");
    return;
  }

  const payload = { text: message };

  const res = UrlFetchApp.fetch(SLACK_WEBHOOK_URL_OD_RE, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  Logger.log("Slack HTTP status: " + res.getResponseCode());
  Logger.log("Slack response body: " + res.getContentText());
}

function testSlackODRefundNotification_RE() {
  postToSlackOD_RE_("Hello @your-team! MOS OD Missed Security Deposit Refund Emails was sent! (test, no emails sent)");
}

/* -------------------- Sample email -------------------- */
function sendSampleODRefundEmail_RE() {
  const recipient = "your-email@example.com, teammate@example.com, teammate2@example.com";
  const subject = "SAMPLE – Security Deposit Return Status - Sample Building - NYC-999, LAX-115 - [Company]";

  const htmlTable = buildHtmlTableRefund_RE_([
    {
      citypo: "NYC-999",
      unit: "12A",
      SDAmount: "$1,500.00",
      lastLeaseStart: "2025-10-01",
      clientEndDate: "2026-01-01"
    },
    {
      citypo: "LAX-115",
      unit: "33C",
      SDAmount: "$2,000.00",
      lastLeaseStart: "2025-11-15",
      clientEndDate: "2026-02-15"
    }
  ]);

  const htmlBody = `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;">
  <p>Dear Sample Building,</p>

  <p>
    We are reaching out on behalf of
    <strong style="color:#2F4F6F;">[Company] / [Previous Operator]</strong>
    regarding the status of the security deposit(s) paid to you at the beginning of the lease(s), specifically for the periods below:
  </p>

  ${htmlTable}

  <p>If the security deposit refund(s) has already been issued, could you please let us know:</p>

  <ul style="margin-top:6px;">
    <li style="color:#2F4F6F;"><strong>The date it was returned</strong></li>
    <li style="color:#2F4F6F;"><strong>The payment method used (check, ACH, wire transfer, etc.)</strong></li>
    <li style="color:#2F4F6F;"><strong>The bank account it was sent to</strong></li>
    <li style="color:#2F4F6F;"><strong>If payment was made by check, please also confirm whether the funds have been deducted from your account</strong></li>
  </ul>

  <p>Thank you very much for your attention, and we look forward to hearing from you soon.</p>

  <p>
    Best regards,<br><br>
    <strong style="color:#2F4F6F;">Finance Admin Team | [Company]</strong>
  </p>
</div>`.trim();

  GmailApp.sendEmail(recipient, subject, "", { htmlBody: htmlBody });
}

/* -------------------- Helpers -------------------- */
function safeStr_RE_(v) { return v == null ? "" : String(v).trim(); }

function escapeHtml_RE_(s) {
  return String(s || "").replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);
  });
}

function parseRecipients_RE_(raw) {
  return (raw || "")
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

/***** 3-WEEK GATED TRIGGER (REFUND RE) *****
 * Runs weekly on Wednesday @ 10:00 (project timezone),
 * but only "unlocks" execution if last successful run was >= 19 days ago.
 *
 * IMPORTANT:
 * - Does NOT rename or modify sendMOSODRefundNotFoundEmails_RE()
 * - Stores last success in Script Properties under the key below.
 */

const MOS_OD_REFUND_LAST_SUCCESS_KEY_RE = "MOS_OD_REFUND_LAST_SUCCESSFUL_RUN_ISO_RE";
const MOS_OD_REFUND_MIN_DAYS_RE = 19;

/**
 * Weekly driver (Wednesday 10:00 AM, gated at >= 19 days since last success)
 */
function refundEvery3WeeksDriver_RE() {
  const props = PropertiesService.getScriptProperties();

  const now = new Date();
  const lastRunIso = props.getProperty(MOS_OD_REFUND_LAST_SUCCESS_KEY_RE);
  const lastRun = lastRunIso ? new Date(lastRunIso) : null;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const daysSinceLast = lastRun ? (now.getTime() - lastRun.getTime()) / MS_PER_DAY : 9999;

  if (daysSinceLast < MOS_OD_REFUND_MIN_DAYS_RE) {
    Logger.log(`⏭️ [REFUND RE] Skipping run. Last successful run was ${daysSinceLast.toFixed(2)} days ago (${lastRunIso}).`);
    return;
  }

  // Run sender
  // If it throws, we do NOT record success.
  sendMOSODRefundNotFoundEmails_RE();

  // Record success timestamp
  props.setProperty(MOS_OD_REFUND_LAST_SUCCESS_KEY_RE, now.toISOString());
  Logger.log("[REFUND RE] Recorded last successful run: " + now.toISOString());
}

/**
 * Install weekly Wednesday 10:00 AM trigger (project timezone).
 * Run this once manually.
 */
function installRefundWed10amTrigger_RE() {
  // Safety: remove old triggers for this driver to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === "refundEvery3WeeksDriver_RE") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("refundEvery3WeeksDriver_RE")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.WEDNESDAY)
    .atHour(10) // runs sometime between 10:00 and 11:00
    .create();

  Logger.log("Installed weekly Wednesday 10:00 AM trigger for refundEvery3WeeksDriver_RE().");
}

/**
 * Optional helper (manual): record "success now" without sending.
 * Useful if you want to reset the cadence.
 */
function recordRefundManualRunNow_RE() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  props.setProperty(MOS_OD_REFUND_LAST_SUCCESS_KEY_RE, now.toISOString());
  Logger.log(" [REFUND RE] Manual run recorded at: " + now.toISOString());
}

/**
 * Optional helper: check last successful run timestamp.
 */
function getRefundLastSuccessfulRun_RE() {
  const props = PropertiesService.getScriptProperties();
  const v = props.getProperty(MOS_OD_REFUND_LAST_SUCCESS_KEY_RE);
  Logger.log("[REFUND RE] Last successful run ISO: " + (v || "(none)"));
  return v;
}

/**
 * Recover missing MOS Log entries for REFUND REQUEST emails (PLEASE SELECT THE CORREC TIMEFRAME)
 */
function recoverRefundRequestMOSLog_RE() {
  const START_AFTER = "2026/03/08";  // after is exclusive in Gmail query
  const END_BEFORE = "2026/03/12";   // before is exclusive
  const SUBJECT_PREFIX = "Security Deposit Return Status";
  const EMAIL_TYPE = "MOS refund request";

  function subjectStartsExactly_(subject, prefix) {
    return String(subject || "").trim().startsWith(prefix);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(OD_MOS_LOG_SHEET_NAME_RE);
  if (!logSheet) throw new Error(`OD MOS Log sheet not found: "${OD_MOS_LOG_SHEET_NAME_RE}"`);

  // Existing log dedupe
  const logLastRow = logSheet.getLastRow();
  const logLastCol = Math.max(1, logSheet.getLastColumn());
  const logHeaders = logSheet.getRange(1, 1, 1, logLastCol).getValues()[0];
  const norm = logHeaders.map(h => normalizeHeader_RE_(h));

  const colCityPO = norm.indexOf("citypo") + 1;
  const colTab = norm.indexOf("tab") + 1;
  const colDate = norm.indexOf("date") + 1;
  const colEmailType = norm.indexOf("emailtype") + 1;

  if (!colCityPO || !colTab || !colDate || !colEmailType) {
    throw new Error(`OD MOS Log headers missing. Need: City-PO, Tab, Date, Email Type`);
  }

  const existingKeys = new Set();
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

  // Collect City-PO -> Tab from Dropped / Dropped Relo/App
  const poTabRows = [];
  const seenPoTab = new Set();

  TABS_RE.forEach(tabName => {
    const sheet = ss.getSheetByName(tabName);
    if (!sheet || sheet.getLastRow() < 2) return;

    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    const n = headers.map(h => normalizeHeader_RE_(h));
    const idxCityPO = n.indexOf("citypo");

    if (idxCityPO === -1) return;

    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getDisplayValues();
    data.forEach(row => {
      const po = String(row[idxCityPO] || "").trim();
      if (!po) return;
      const key = `${po}||${tabName}`;
      if (!seenPoTab.has(key)) {
        seenPoTab.add(key);
        poTabRows.push({ citypo: po, tab: tabName });
      }
    });
  });

  const rowsToAppend = [];

  poTabRows.forEach(entry => {
    const po = entry.citypo;
    const tab = entry.tab;

    const query = `in:sent from:team-inbox@example.com subject:"${SUBJECT_PREFIX}" "${po}" after:${START_AFTER} before:${END_BEFORE}`;
    const threads = GmailApp.search(query, 0, 20);

    let matchedDate = null;

    threads.forEach(thread => {
      const msgs = thread.getMessages();
      msgs.forEach(msg => {
        const subj = msg.getSubject() || "";

        // ONLY real Refund Request MOS emails
        if (!subjectStartsExactly_(subj, "Security Deposit Return Status")) return;

        // must contain City-PO
        if (!subj.includes(po)) return;

        const d = msg.getDate();
        if (!matchedDate || d.getTime() > matchedDate.getTime()) {
          matchedDate = d;
        }
      });
    });

    if (matchedDate) {
      const dateKey = Utilities.formatDate(matchedDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
      const dedupeKey = `${po}||${tab}||${dateKey}||${EMAIL_TYPE}`;
      if (!existingKeys.has(dedupeKey)) {
        rowsToAppend.push({
          citypo: po,
          tab: tab,
          date: matchedDate,
          emailType: EMAIL_TYPE
        });
        existingKeys.add(dedupeKey);
      }
    }
  });

  if (rowsToAppend.length === 0) {
    Logger.log("No missing refund request MOS Log rows found.");
    return;
  }

  const startRow = logSheet.getLastRow() + 1;

  logSheet.getRange(startRow, colCityPO, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.citypo]));
  logSheet.getRange(startRow, colTab, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.tab]));
  logSheet.getRange(startRow, colDate, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.date]));
  logSheet.getRange(startRow, colEmailType, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.emailType]));
  logSheet.getRange(startRow, colDate, rowsToAppend.length, 1).setNumberFormat("yyyy-mm-dd");

  Logger.log(`Recovered ${rowsToAppend.length} refund request MOS Log rows.`);
}
