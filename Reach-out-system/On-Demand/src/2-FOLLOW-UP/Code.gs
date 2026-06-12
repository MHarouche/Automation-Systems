/**
 * STEP 2 MOS PIPELINE AUTOMATION
 *
 * SendMOSODFollowUpEmails
 * - Tabs: "Dropped Relo/App" and "Dropped"
 * - Sends ONE aggregated email per recipient (grouping units)
 * - Sends only when "Follow-up Email" = "YES"
 * - Does NOT send if "Confirmation Follow-up Email" = "YES"
 * - Marks "Confirmation Follow-up Email" = YES after successful send
 * - HTML body styled with #2F4F6F for headings/bullets
 * - Subject includes attempt suffix: "2nd attempt", "3rd attempt", etc
 * - Truncates subject if too long (150 chars)
 * - Populates MOS Log with Email type = "Follow-up"
 * - Includes Move-Out Date column in the email table
 * - Biweekly driver: weekly Monday trigger, only runs if 11+ days since last send
 * - SHARED HELPERS: uses safeStr_, escapeHtml_, parseRecipients_,
 *   buildHtmlTableMOSOD_, buildTextTableMOSOD_, buildDetailForLog_,
 *   postToSlackOD_ and collectSampleItemsOD_ from the STEP 1 (Initial) file.
 *   Do NOT redefine them here.
 * - Created by Mari Harouche
 */

// ONLY CHANGES: all const names now end with _FU
const TEAM_INBOX_FU = "team-inbox@example.com";
const LOG_RECIPIENTSS_FU = ["your-email@example.com", "teammate@example.com"];
const TABSS_FU = ["Dropped Relo/App", "Dropped"];
const MAX_SUBJECT_LENGTHH_FU = 150; // safe cap for subject

const MOS_EMAILS_OD_LOG_SPREADSHEET_ID_FU = "YOUR_CENTRAL_LOG_SPREADSHEET_ID";
const MOS_EMAILS_OD_LOG_SHEET_NAME_FU = "MOS Emails OD";

/**
 * Used by the biweekly driver to remember last successful run time.
 * (Do NOT change this key once deployed.)
 */
const MOS_OD_FOLLOWUP_LAST_SUCCESS_KEY_FU = "MOS_OD_FOLLOWUP_LAST_SUCCESSFUL_RUN_ISO";

/**
 * MOS LOG (OD)
 */
const OD_MOS_LOG_SHEET_NAME_FU = "MOS Log";
const OD_MOS_LOG_HEADERS_FU = { citypo: "City-PO", tab: "Tab", date: "Date", emailType: "Email Type" };
const OD_MOS_LOG_EMAIL_TYPE_FOLLOWUP_FU = "Follow-up MOS";

/***** SLACK (ON-DEMAND) *****/
// NOTE: postToSlackOD_ lives in the STEP 1 file (shared scope).
const SLACK_WEBHOOK_URL_OD_FU = "YOUR_SLACK_WEBHOOK_URL";

/**
 * "Email type" matching helper (in case of minor variations)
 */
function isEmailTypeFollowUp_(v) {
  const s = safeStr_(v).toLowerCase();
  return s === "follow-up" || s === "followup" || s === "follow up";
}

function SendMOSODFollowUpEmails() {
  const functionName = "SendMOSODFollowUpEmails";
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
    sendLogEmailFU_("MOS OD Follow-up Script ERROR", "Could not acquire script lock.\n\n" + String(e));
    logMOSODFollowUpEmailExecution_(functionName, executionStart, executionStatus, executionComment);
    return;
  }

  const summary = { emailsSent: 0, rowsMarked: 0, errors: 0, details: [] };

  // MOS Log: collect successful City-PO + Tab pairs (dedupe)
  const odSuccessLogKeysThisRun = new Set();
  const odSuccessLogRowsThisRun = [];

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // Load follow-up counts from MOS Log (per City-PO + Tab)
    const followUpCountsByKey = getFollowUpCountsFromMOSLog_();

    for (let t = 0; t < TABSS_FU.length; t++) {
      const tabName = TABSS_FU[t];
      const sheet = ss.getSheetByName(tabName);
      if (!sheet) continue;

      const hdr = getHeaderIndicesFollowUp_(sheet, tabName);
      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      if (lastRow < 2) continue;

      const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();

      // email -> { items:[{rowNumber,building,unit,citypo,moveOutDate,attemptNo}], tabName, rowNumbers:Set }
      const groups = {};

      for (let i = 0; i < data.length; i++) {
        const rowNumber = i + 2;
        const row = data[i];

        const emailRaw     = safeStr_(hdr.colEmailTo      ? row[hdr.colEmailTo - 1]      : "");
        const followUpFlag = safeStr_(hdr.colFollowUp     ? row[hdr.colFollowUp - 1]     : "").toUpperCase();
        const confirmation = safeStr_(hdr.colConfirmation ? row[hdr.colConfirmation - 1] : "");
        const building     = safeStr_(hdr.colBuilding     ? row[hdr.colBuilding - 1]     : "");
        const unit         = safeStr_(hdr.colUnit         ? row[hdr.colUnit - 1]         : "");
        const citypo       = safeStr_(hdr.colCityPO       ? row[hdr.colCityPO - 1]       : "");
        const moveOutDate  = safeStr_(hdr.colMoveOutDate  ? row[hdr.colMoveOutDate - 1]  : "");

        // sending condition
        if (!emailRaw) continue;
        if (followUpFlag !== "YES") continue; // covers "NO SD" too

        const recipients = parseRecipients_(emailRaw);
        if (recipients.length === 0) continue;

        // Attempt number logic:
        // - First follow-up = "2nd attempt"
        // - Next = "3rd attempt", etc
        // Based on how many Follow-up log entries exist for that City-PO + Tab
        const logKey = `${citypo}||${tabName}`.toLowerCase();
        const priorFollowUps = followUpCountsByKey[logKey] || 0;
        const attemptNo = 2 + priorFollowUps;

        const item = { rowNumber, building, unit, citypo, moveOutDate, attemptNo };
        recipients.forEach(rcpt => {
          const key = rcpt.toLowerCase();
          if (!groups[key]) groups[key] = { items: [], tabName, rowNumbers: new Set() };
          groups[key].items.push(item);
          groups[key].rowNumbers.add(rowNumber);
        });
      } // rows

      // Send aggregated emails per recipient
      const recipientEmails = Object.keys(groups);
      for (let r = 0; r < recipientEmails.length; r++) {
        const to = recipientEmails[r];
        const items = groups[to].items;
        if (!items || items.length === 0) continue;

        // Use the highest attemptNo among grouped items (safe: never understates attempt)
        const attemptNoForEmail = Math.max.apply(null, items.map(it => it.attemptNo || 2));
        const attemptSuffix = ordinalAttemptSuffix_(attemptNoForEmail) + " attempt";

        // Subject
        let subject = buildFollowUpSubject_(items, attemptSuffix);
        if (subject.length > MAX_SUBJECT_LENGTHH_FU) {
          subject = subject.substring(0, MAX_SUBJECT_LENGTHH_FU - 3) + "...";
        }

        // Bodies (same body as initial)
        const htmlTable = buildHtmlTableMOSOD_(items);
        const textTable = buildTextTableMOSOD_(items);

        const buildingName = items[0].building || "your property";
        const textBody = `
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

  <p>Thank you very much for your cooperation.<br>Have a great day!<br>
  <strong style="color:#2F4F6F;">[Company] Finance Team</strong></p>
</div>`.trim();

        try {
          GmailApp.sendEmail(
            to,
            subject,
            textBody,
            { htmlBody: htmlBody, replyTo: TEAM_INBOX_FU, name: "[Company] Finance Team" }
          );

          summary.emailsSent++;

          // MOS Log: mark City-PO(s) as successfully sent for this tab
          const uniquePOsForThisEmail = [...new Set(items.map(it => safeStr_(it.citypo)).filter(Boolean))];
          uniquePOsForThisEmail.forEach(po => {
            const key = `${po}||${tabName}`;
            if (!odSuccessLogKeysThisRun.has(key)) {
              odSuccessLogKeysThisRun.add(key);
              odSuccessLogRowsThisRun.push({ citypo: po, tab: tabName });
            }
          });

          // Mark Confirmation Follow-up Email = YES for all rows related to this recipient
          const rowsToMark = Array.from(groups[to].rowNumbers || []);
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
          summary.details.push(detail);

        } catch (sendErr) {
          summary.errors++;
          summary.details.push({ type: "send-error", tab: tabName, to, err: String(sendErr) });
        }
      } // recipients
    } // tabs

    // Send log email
    sendSummaryLogFU_(summary);

    if (summary.emailsSent > 0) {
      postToSlackOD_("Hi @your-team! Follow-up MOS Emails sent :)");
    }

    // Append OD MOS Log (after successful run)
    if (odSuccessLogRowsThisRun.length > 0) {
      appendODMOSLogRowsFollowUp_(odSuccessLogRowsThisRun, new Date());
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
    sendLogEmailFU_("MOS OD Follow-up Script ERROR", String(e) + "\n\n" + (e.stack || ""));
    throw e;
  } finally {
    logMOSODFollowUpEmailExecution_(functionName, executionStart, executionStatus, executionComment);

    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

/**
 * BIWEEKLY DRIVER (Follow-up OD)
 * Trigger runs weekly on Monday ~11:00-12:00 BRT,
 * but this function only executes SendMOSODFollowUpEmails() if 11+ days passed
 * since the last successful run recorded in Script Properties.
 * (11 instead of 14/15 to avoid edge problems with trigger timing.)
 */
function biweeklyDriverODFollowUp() {
  const props = PropertiesService.getScriptProperties();

  const now = new Date();
  const lastRunIso = props.getProperty(MOS_OD_FOLLOWUP_LAST_SUCCESS_KEY_FU);
  const lastRun = lastRunIso ? new Date(lastRunIso) : null;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const daysSinceLast = lastRun ? (now.getTime() - lastRun.getTime()) / MS_PER_DAY : 9999;

  if (daysSinceLast < 11) {
    Logger.log(`[OD Follow-up] Skipping run. Last successful run was ${daysSinceLast.toFixed(2)} days ago (${lastRunIso}).`);
    return;
  }

  SendMOSODFollowUpEmails();

  // Record success timestamp (so the next run will be ~14 days later)
  props.setProperty(MOS_OD_FOLLOWUP_LAST_SUCCESS_KEY_FU, now.toISOString());
  Logger.log("[OD Follow-up] Recorded last successful run: " + now.toISOString());
}

/**
 * INSTALL TRIGGER (Monday between 11:00-12:00 BRT / America/Sao_Paulo)
 * Removes any previous trigger pointing to the follow-up sender/driver,
 * then installs the weekly Monday trigger for the biweekly driver.
 */
function installMondayODFollowUpTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === "biweeklyDriverODFollowUp" || fn === "SendMOSODFollowUpEmails") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("biweeklyDriverODFollowUp")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(11)
    .inTimezone("America/Sao_Paulo")
    .create();

  Logger.log("Installed weekly Monday 11:00-12:00 BRT trigger for biweeklyDriverODFollowUp().");
}

/**
 * ONE-TIME HELPER
 * Records the last Follow-up send as June 8, 2026 (BR: 08/06/2026),
 * so the next send happens on Monday June 22, 2026.
 * Run this ONCE after deploying.
 */
function recordODFollowUpLastRunJune8_2026() {
  const props = PropertiesService.getScriptProperties();
  const june8 = new Date(2026, 5, 8, 10, 30, 0); // months are 0-based: 5 = June
  props.setProperty(MOS_OD_FOLLOWUP_LAST_SUCCESS_KEY_FU, june8.toISOString());
  Logger.log("[OD Follow-up] Last run recorded as: " + june8.toISOString());
}

/**
 * Reads MOS Log and returns a map:
 *   key = (citypo||tab).toLowerCase()
 *   val = count of rows with Email type = Follow-up
 */
function getFollowUpCountsFromMOSLog_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(OD_MOS_LOG_SHEET_NAME_FU);
  if (!logSheet) return {};

  const lastRow = logSheet.getLastRow();
  const lastCol = logSheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return {};

  const headerRow = logSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const colCityPO = headerRow.indexOf(OD_MOS_LOG_HEADERS_FU.citypo) + 1;
  const colTab = headerRow.indexOf(OD_MOS_LOG_HEADERS_FU.tab) + 1;
  const colEmailType = headerRow.indexOf(OD_MOS_LOG_HEADERS_FU.emailType) + 1;

  if (!colCityPO || !colTab || !colEmailType) return {};

  const data = logSheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
  const counts = {};

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const citypo = safeStr_(row[colCityPO - 1]);
    const tab = safeStr_(row[colTab - 1]);
    const emailType = safeStr_(row[colEmailType - 1]);

    if (!citypo || !tab) continue;
    if (!isEmailTypeFollowUp_(emailType)) continue;

    const key = `${citypo}||${tab}`.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function normalizeHeaderFollowUp_(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * OD MOS LOG helper (FOLLOW-UP)
 * Appends [City-PO, Tab, Date, Email type] to the MOS Log tab.
 * Always appends below last row; does not overwrite.
 * Forces date number format on the Date column.
 */
function appendODMOSLogRowsFollowUp_(rows, dateObj) {
  if (!rows || rows.length === 0) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("MOS Log");
  if (!logSheet) throw new Error('OD MOS Log sheet not found: "MOS Log"');

  const lastCol = Math.max(1, logSheet.getLastColumn());
  const headerRow = logSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const normalized = headerRow.map(h => normalizeHeaderFollowUp_(h));

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
  const emailTypeValues = rows.map(() => ["Follow-up MOS"]);

  logSheet.getRange(startRow, colCityPO, cityValues.length, 1).setValues(cityValues);
  logSheet.getRange(startRow, colTab, tabValues.length, 1).setValues(tabValues);
  logSheet.getRange(startRow, colDate, dateValues.length, 1).setValues(dateValues);
  logSheet.getRange(startRow, colEmailType, emailTypeValues.length, 1).setValues(emailTypeValues);

  logSheet.getRange(startRow, colDate, dateValues.length, 1).setNumberFormat("yyyy-mm-dd");
}

/* -------------------- Subject (FOLLOW-UP) -------------------- */
// Pattern requested:
// Follow-up Security Deposit Return & Move-out - [BUILDING] - [UNIT NUMBERs] - [Company] - [PO NUMBERs] 2nd attempt
function buildFollowUpSubject_(items, attemptSuffix) {
  if (!items || items.length === 0) return `Follow-up Security Deposit Return & Move-out - [Company] - ${attemptSuffix}`;

  const firstBuilding = items[0].building || "";
  const units = items.map(it => it.unit || "").filter(Boolean).join(", ");
  const poList = [...new Set(items.map(it => it.citypo || "").filter(Boolean))];
  const poString = poList.join(", ");

  const parts = ["Follow-up Security Deposit Return & Move-out"];
  if (firstBuilding) parts.push(firstBuilding);
  if (units) parts.push(units);
  parts.push("[Company]");
  if (poString) parts.push(poString);

  let subject = parts.join(" - ");
  subject = subject + " " + attemptSuffix;
  return subject;
}

/* -------------------- Attempt suffix helpers -------------------- */
function ordinalAttemptSuffix_(n) {
  const num = Number(n) || 2;
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return num + "th";
  const mod10 = num % 10;
  if (mod10 === 1) return num + "st";
  if (mod10 === 2) return num + "nd";
  if (mod10 === 3) return num + "rd";
  return num + "th";
}

/* -------------------- Logs (FOLLOW-UP versions, renamed to avoid
   collision with the STEP 1 file functions of the same purpose) -------------------- */

function sendSummaryLogFU_(summary) {
  const subject = `MOS OD Follow-up Script Log — sent:${summary.emailsSent} marked:${summary.rowsMarked} errors:${summary.errors}`;

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

  sendLogEmailFU_(subject, text, html);
}

function sendLogEmailFU_(subject, textBody, htmlBody) {
  try {
    GmailApp.sendEmail(
      LOG_RECIPIENTSS_FU[0],
      subject,
      textBody,
      {
        htmlBody: htmlBody || undefined,
        cc: LOG_RECIPIENTSS_FU.slice(1).join(",") || undefined,
        name: "MOS OD Follow-up Script Logger",
        replyTo: TEAM_INBOX_FU
      }
    );
  } catch (e) {
    GmailApp.sendEmail(LOG_RECIPIENTSS_FU[0], subject + " (fallback)", String(textBody || "") + "\n\n" + String(e));
  }
}

function logMOSODFollowUpEmailExecution_(functionName, executionStart, status, comment) {
  try {
    const executionEnd = new Date();
    const durationSec = Math.round(((executionEnd.getTime() - executionStart.getTime()) / 1000) * 100) / 100;

    const ss = SpreadsheetApp.openById(MOS_EMAILS_OD_LOG_SPREADSHEET_ID_FU);
    const sheet = ss.getSheetByName(MOS_EMAILS_OD_LOG_SHEET_NAME_FU);
    if (!sheet) throw new Error('Log sheet not found: "' + MOS_EMAILS_OD_LOG_SHEET_NAME_FU + '"');

    const lastCol = Math.max(1, sheet.getLastColumn());
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => normalizeHeaderFollowUp_(h));

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

/* -------------------- Helpers --------------------
 * safeStr_, escapeHtml_, parseRecipients_, buildHtmlTableMOSOD_,
 * buildTextTableMOSOD_, buildDetailForLog_, postToSlackOD_ and
 * collectSampleItemsOD_ are defined in the STEP 1 (Initial) file.
 * Do NOT redefine them here — duplicate definitions override each other
 * across files in the same Apps Script project.
 */

/**
 * Header indices for FOLLOW-UP workflow
 * Uses:
 * - Send column: "Follow-up Email"
 * - Confirmation column: "Confirmation Follow-up Email"
 * Keeps the rest the same style as the initial script (header-based, no fixed-column fallback).
 */
function getHeaderIndicesFollowUp_(sheet, tabName) {
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

  // For both tabs, match by header names (no fixed indices)
  map.colEmailTo = findOne(["send mos request to", "sendmosrequestto"]);

  // Follow-up Email (send flag)
  map.colFollowUp = findOne([
    "follow-up email",
    "follow up email",
    "followupemail"
  ]);

  // Confirmation Follow-up Email
  map.colConfirmation = findOne([
    "confirmation follow-up email",
    "confirmation follow up email",
    "confirmationfollowupemail",
    "confirmationfollow-upemail"
  ]);

  map.colBuilding = findOne(["landlord - building", "landlord-building", "landlordbuilding", "building"]);
  map.colUnit     = findOne(["unit #", "unit#", "unitnumber", "unit"]);
  map.colCityPO   = findOne(["city-po", "citypo", "internal no.", "internalno", "po"]);

  // Move-Out Date: EXACT header title only, to avoid matching other "move-out" columns
  map.colMoveOutDate = findExact("Move-Out Date");

  if (!map.colEmailTo || !map.colFollowUp || !map.colConfirmation) {
    throw new Error(
      "Required headers missing in " + tabName +
      ". Need: Send MOS request to, Follow-up Email, Confirmation Follow-up Email"
    );
  }
  return map;
}

/**
 * ONE-TIME HELPER
 */
function recordODFollowUpManualRunNow() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  props.setProperty(MOS_OD_FOLLOWUP_LAST_SUCCESS_KEY_FU, now.toISOString());
  Logger.log(" [OD Follow-up] Manual run recorded at: " + now.toISOString());
}

/**
 * Test Slack without sending any emails.
 * Run this manually to authorize UrlFetchApp and validate the webhook.
 */
function testSlackODFollowUpNotification() {
  postToSlackOD_("Hi @your-team! Follow-up MOS email sent :) (test, no emails sent).");
}

/**
 * Sends a SAMPLE On-Demand follow-up move-out email to the maintainer only.
 * Reads REAL rows from the tabs (read-only) so you can see the Move-Out Date column.
 * Does NOT mark confirmation, does NOT log.
 */
function sendSampleMariODFollowUpEmail() {
  const recipient = "your-email@example.com";
  const subject = "SAMPLE – Follow-up Security Deposit Return & Move-out – On Demand 2nd attempt";

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

function recoverFollowUpMOSLog() {
  const START_AFTER = "2026/03/08";
  const END_BEFORE = "2026/03/12";
  const SUBJECT_PREFIX = "Follow-up Security Deposit Return & Move-out";
  const EMAIL_TYPE = "Follow-up MOS";
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

        // ONLY real Follow-up MOS emails
        if (!subjectStartsExactly_(subj, "Follow-up Security Deposit Return & Move-out")) return;

        // must contain City-PO
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
    Logger.log("No missing Follow-up MOS Log rows found.");
    return;
  }

  const startRow = logSheet.getLastRow() + 1;
  logSheet.getRange(startRow, colCityPO, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.citypo]));
  logSheet.getRange(startRow, colTab, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.tab]));
  logSheet.getRange(startRow, colDate, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.date]));
  logSheet.getRange(startRow, colEmailType, rowsToAppend.length, 1).setValues(rowsToAppend.map(r => [r.emailType]));
  logSheet.getRange(startRow, colDate, rowsToAppend.length, 1).setNumberFormat("yyyy-mm-dd");

  Logger.log(`Recovered ${rowsToAppend.length} Follow-up MOS Log rows.`);
}
