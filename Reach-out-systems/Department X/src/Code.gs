/**Created by Mari Harouche**/

/***** CONFIG *****/
// SOURCE (Source spreadsheet)
const SOURCE_SS_ID = 'YOUR_SOURCE_SPREADSHEET_ID';
const SOURCE_SHEET_NAME = 'Dropped-DEPARTMENT_X';

// EMAIL CONFIG
const EMAIL_SUBJECT_PREFIX = "Move-out & Security Deposit Return";
const MAX_SUBJECT_LENGTH = 150;
const LOG_RECIPIENTS = ["teammate@example.com", "your-email@example.com"];

// CENTRAL LOG
const MOS_EMAIL_DEPARTMENT_X_LOG_SS_ID = "YOUR_CENTRAL_LOG_SPREADSHEET_ID";
const MOS_EMAIL_DEPARTMENT_X_LOG_SHEET_NAME = "MOS Email DEPARTMENT_X";

/**
 * Used by the biweekly driver to remember last successful run time.
 * (Do NOT change this key once deployed.)
 */
const LAST_SUCCESS_KEY = "MOS_DEPARTMENT_X_LAST_SUCCESSFUL_RUN_ISO";

/**
 * MOS LOG (DEPARTMENT_X)
 */
const DEPARTMENT_X_MOS_LOG_SHEET_NAME = "MOS Log";
const DEPARTMENT_X_MOS_LOG_HEADERS = { citypo: "City-PO", date: "Date" };

/**
 * MAIN SENDER
 */
function sendMOSRequests() {
  const functionName = "sendMOSRequests";
  const executionStart = new Date();
  let executionStatus = "OK";
  let executionComment = "";

  try {
    const ss = SpreadsheetApp.openById(SOURCE_SS_ID);
    const sheet = ss.getSheetByName(SOURCE_SHEET_NAME);
    const data = sheet.getDataRange().getValues();

    // Map column indexes
    const headers = data[0];
    const colIndex = {
      cityPO: headers.indexOf("City-PO"),
      landlordBuilding: headers.indexOf("Landlord - Building"),
      unit: headers.indexOf("Unit"),
      sendTo: headers.indexOf("Send MOS request to"),
      sendEmail: headers.indexOf("Send email"),
      confirmation: headers.indexOf("Confirmation"),
    };

    if (Object.values(colIndex).some(i => i === -1)) {
      Logger.log("Headers found: " + headers.join(", "));
      throw new Error("One or more required columns were not found. Check the headers.");
    }

    // Optional column: Move-Out Date (EXACT header title; not required, won't break the run if missing)
    colIndex.moveOutDate = headers.indexOf("Move-Out Date");

    // Group rows by recipient
    const emailMap = {};
    let totalEmails = 0;
    let sendErrors = 0;
    const logDetails = [];

    // MOS Log: track City-POs with successful send (dedupe)
    const departmentXLoggedCityPOsThisRun = new Set();

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const sendEmail = String(row[colIndex.sendEmail]).toUpperCase().trim() === "YES";
      const recipient = String(row[colIndex.sendTo]).trim();

      // "Send email" = YES, ignores "Confirmation"
      if (!sendEmail) continue;

      // Move-Out Date: format as MM/dd/yyyy when it's a real date cell
      let moveOutDate = colIndex.moveOutDate !== -1 ? row[colIndex.moveOutDate] : "";
      if (moveOutDate instanceof Date) {
        moveOutDate = Utilities.formatDate(moveOutDate, Session.getScriptTimeZone(), "MM/dd/yyyy");
      } else {
        moveOutDate = String(moveOutDate || "").trim();
      }

      if (!emailMap[recipient]) emailMap[recipient] = [];
      emailMap[recipient].push({
        cityPO: row[colIndex.cityPO],
        landlordBuilding: row[colIndex.landlordBuilding],
        unit: row[colIndex.unit],
        moveOutDate: moveOutDate,
        rowIndex: i + 1
      });
    }

    // Send emails
    for (const recipient in emailMap) {
      const items = emailMap[recipient];
      totalEmails++;

      const cityPOs = items.map(item => item.cityPO).join(", ");
      let subject = `${EMAIL_SUBJECT_PREFIX} ${items[0].landlordBuilding} ${items[0].unit} - [Company] - ${cityPOs}`;
      if (subject.length > MAX_SUBJECT_LENGTH) {
        subject = subject.slice(0, MAX_SUBJECT_LENGTH);
      }

      // Build compact table HTML
      let textTable = `<table border="1" cellpadding="3" cellspacing="0" style="border-collapse: collapse; width:auto;">
      <tr style="background-color:#e8f0fe;">
        <th style="text-align:left; padding:3px;">Landlord / Building</th>
        <th style="text-align:left; padding:3px;">Unit</th>
        <th style="text-align:left; padding:3px;">Move-Out Date</th>
        <th style="text-align:left; padding:3px;">Internal no.</th>
      </tr>`;

      items.forEach((item, index) => {
        const bgColor = index % 2 === 0 ? "#ffffff" : "#f5f5f5";
        textTable += `
        <tr style="background-color:${bgColor};">
          <td style="padding:3px;">${item.landlordBuilding || ""}</td>
          <td style="padding:3px;">${item.unit || ""}</td>
          <td style="padding:3px;">${item.moveOutDate || ""}</td>
          <td style="padding:3px;">${item.cityPO || ""}</td>
        </tr>`;
      });

      textTable += `</table>`;

      // Build email body (KEEP TEXT AS-IS)
      let htmlBody = `
      <div style="font-family: Arial, sans-serif; font-size:14px; color:#000000;">
        <p>Hello <strong>${items[0].landlordBuilding}</strong>,</p>

        <p>We’re reaching out on behalf of <strong>[Company] Inc.</strong>, a furnished rental company managing flexible-stay apartments across the US and globally.</p>

        <p>[Company] acquired [Previous Operator] and has assumed responsibility for all related leases and operations. Our portfolio also includes properties originally managed or booked through various housing platforms and apps.</p>

        <p style="color:#1a73e8;"><strong>Could you please help us by providing the following for the properties listed below:</strong></p>

        ${textTable}

        <ul>
          <li>Copy of the Move-Out Statement or Final Ledger</li>
          <li>Confirmation of the Security Deposit Return status</li>
          <li>If applicable, details of any damage charges deducted from the deposit, along with supporting documentation</li>
        </ul>

        <p>* If you are a private owner and don't work with move-out statements or ledgers, please let us know if there's any balance from us to you and if we had a security deposit on file with some deductions taken on your end, please let us know what those deductions were.</p>

        <p>* If a refund will be issued, we can send you a secure payment link upon request.</p>

        <p>Thank you very much for your cooperation.<br>
        Have a great day!<br>
        <strong>[Company] Finance Team</strong></p>
      </div>
    `;

      try {
        // Sends even if recipient is empty (falls back to team-inbox)
        GmailApp.sendEmail(recipient || "team-inbox@example.com", subject, "", { htmlBody: htmlBody });

        // ✅ MOS Log: mark City-PO(s) as successfully sent
        items.forEach(it => {
          const po = String(it.cityPO || "").trim();
          if (po) departmentXLoggedCityPOsThisRun.add(po);
        });

      } catch (e) {
        sendErrors++;
        Logger.log(`⚠️ Failed to send to: "${recipient}" | Error: ${e.message}`);
      }

      // Mark confirmation = Yes  (KEEP AS-IS)
      items.forEach(item => {
        sheet.getRange(item.rowIndex, colIndex.confirmation + 1).setValue("Yes");
      });

      // Add to log (KEEP AS-IS)
      logDetails.push({
        recipient: recipient || "(empty)",
        cityPOs: cityPOs,
        rows: items.length
      });
    }

    // Build log email body (KEEP AS-IS)
    let logHtml = `
    <div style="font-family: Arial, sans-serif; font-size:14px;">
      <p style="color:#1a73e8;"><strong>DEPARTMENT_X Move-out email LOG</strong></p>
      <p>Total emails processed: <strong>${totalEmails}</strong></p>
      <table border="1" cellpadding="3" cellspacing="0" style="border-collapse: collapse; width:auto;">
        <tr style="background-color:#e8f0fe;">
          <th>Recipient</th>
          <th>Number of Rows</th>
          <th>City-POs</th>
        </tr>`;

    logDetails.forEach((entry, index) => {
      const bgColor = index % 2 === 0 ? "#ffffff" : "#f5f5f5";
      logHtml += `
        <tr style="background-color:${bgColor};">
          <td style="padding:3px;">${entry.recipient}</td>
          <td style="padding:3px;">${entry.rows}</td>
          <td style="padding:3px;">${entry.cityPOs}</td>
        </tr>`;
    });

    logHtml += `</table></div>`;

    GmailApp.sendEmail(LOG_RECIPIENTS.join(","), "DEPARTMENT_X Move-out email LOG", "", { htmlBody: logHtml });

    if (totalEmails > 0) {
      postToSlackDepartmentX_("Hello @your-team ! DepartmentX MOS emails have been sent! :)");
    }

    // Append DEPARTMENT_X MOS Log (after successful run)
    if (departmentXLoggedCityPOsThisRun.size > 0) {
      appendDepartmentXMOSLogRows_([...departmentXLoggedCityPOsThisRun], new Date());
    }

    Logger.log("Emails processed: " + totalEmails);

    if (sendErrors > 0) {
      executionStatus = "REVIEW";
      executionComment = `Execution completed with send errors. Emails processed: ${totalEmails}; send errors: ${sendErrors}.`;
    } else {
      executionStatus = "OK";
      executionComment = `Execution completed successfully. Emails processed: ${totalEmails}; send errors: ${sendErrors}.`;
    }

  } catch (err) {
    executionStatus = "ERROR";
    executionComment = "Error: " + (err && err.message ? err.message : err);
    throw err;
  } finally {
    logMOSEmailDepartmentXExecution_(functionName, executionStart, executionStatus, executionComment);
  }
}


/**
 * DEPARTMENT_X MOS LOG helper
 * Appends [City-PO, Date] to the MOS Log tab in the source spreadsheet.
 * Always appends below last row; does not overwrite.
 * Forces date number format on the Date column.
 */
function appendDepartmentXMOSLogRows_(citypoList, dateObj) {
  if (!citypoList || citypoList.length === 0) return;

  const ss = SpreadsheetApp.openById(SOURCE_SS_ID);
  const logSheet = ss.getSheetByName(DEPARTMENT_X_MOS_LOG_SHEET_NAME);
  if (!logSheet) throw new Error(`DEPARTMENT_X MOS Log sheet not found: "${DEPARTMENT_X_MOS_LOG_SHEET_NAME}"`);

  const headerRow = logSheet.getRange(1, 1, 1, logSheet.getLastColumn()).getValues()[0];
  const colCityPO = headerRow.indexOf(DEPARTMENT_X_MOS_LOG_HEADERS.citypo) + 1;
  const colDate = headerRow.indexOf(DEPARTMENT_X_MOS_LOG_HEADERS.date) + 1;

  if (!colCityPO || !colDate) {
    throw new Error(`DEPARTMENT_X MOS Log headers missing. Need: "${DEPARTMENT_X_MOS_LOG_HEADERS.citypo}" and "${DEPARTMENT_X_MOS_LOG_HEADERS.date}"`);
  }

  const startRow = logSheet.getLastRow() + 1;

  const cityValues = citypoList.map(po => [po]);
  const dateValues = citypoList.map(() => [dateObj]);

  logSheet.getRange(startRow, colCityPO, cityValues.length, 1).setValues(cityValues);
  logSheet.getRange(startRow, colDate, dateValues.length, 1).setValues(dateValues);

  logSheet.getRange(startRow, colDate, dateValues.length, 1).setNumberFormat("yyyy-mm-dd");
}

function logMOSEmailDepartmentXExecution_(functionName, executionStart, status, comment) {
  try {
    const executionEnd = new Date();
    const durationSec = Math.round(((executionEnd.getTime() - executionStart.getTime()) / 1000) * 100) / 100;

    const ss = SpreadsheetApp.openById(MOS_EMAIL_DEPARTMENT_X_LOG_SS_ID);
    const sheet = ss.getSheetByName(MOS_EMAIL_DEPARTMENT_X_LOG_SHEET_NAME);
    if (!sheet) throw new Error('Log sheet not found: "' + MOS_EMAIL_DEPARTMENT_X_LOG_SHEET_NAME + '"');

    const lastCol = Math.max(1, sheet.getLastColumn());
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => normalizeDepartmentXCentralLogHeader_(h));

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
    Logger.log("Could not write MOS Email DEPARTMENT_X central log: " + String(logErr));
  }
}

function normalizeDepartmentXCentralLogHeader_(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * BIWEEKLY DRIVER (NY timezone)
 * Trigger runs weekly on Monday 9:00 AM NY time,
 * but this function only executes sendMOSRequests() if >= 12 days passed
 * since the last successful run recorded in Script Properties.
 */
function biweeklyDriverNY() {
  const props = PropertiesService.getScriptProperties();

  const now = new Date();
  const lastRunIso = props.getProperty(LAST_SUCCESS_KEY);
  const lastRun = lastRunIso ? new Date(lastRunIso) : null;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const daysSinceLast = lastRun ? (now.getTime() - lastRun.getTime()) / MS_PER_DAY : 9999;

  if (daysSinceLast < 11) {
    Logger.log(`Skipping run. Last successful run was ${daysSinceLast.toFixed(2)} days ago (${lastRunIso}).`);
    return;
  }

  // Run sender
  sendMOSRequests();

  // Record success timestamp (so the next run will be ~14 days later)
  props.setProperty(LAST_SUCCESS_KEY, now.toISOString());
  Logger.log("Recorded last successful run: " + now.toISOString());
}

/**
 * INSTALL TRIGGER (Monday 9:00 AM New York time)
 */
function installMonday9amNYTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === "biweeklyDriverNY" || fn === "sendMOSRequests" || fn === "createBiweeklyTrigger") {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger("biweeklyDriverNY")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();

  Logger.log("Installed weekly Monday 9:00 AM NY trigger for biweeklyDriverNY().");
}

/**
 * ONE-TIME HELPER
 */
function recordManualRunNow() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  props.setProperty(LAST_SUCCESS_KEY, now.toISOString());
  Logger.log("Manual run recorded at: " + now.toISOString());
}

/**
 * Sends a SAMPLE DEPARTMENT_X move-out email to the maintainer only.
 * Does NOT read the sheet, does NOT mark confirmation, does NOT log.
 */
function sendSampleDEPARTMENT_XEmail() {
  const recipient = "your-email@example.com";
  const subject = "SAMPLE – Move-out & Security Deposit Return – DEPARTMENT_X";

  // Sample table (same structure as DEPARTMENT_X script)
  const textTable = `
    <table border="1" cellpadding="3" cellspacing="0" style="border-collapse: collapse; width:auto;">
      <tr style="background-color:#e8f0fe;">
        <th style="text-align:left; padding:3px;">Landlord / Building</th>
        <th style="text-align:left; padding:3px;">Unit</th>
        <th style="text-align:left; padding:3px;">Move-Out Date</th>
        <th style="text-align:left; padding:3px;">Internal no.</th>
      </tr>
      <tr style="background-color:#ffffff;">
        <td style="padding:3px;">Sample DepartmentX Building LLC</td>
        <td style="padding:3px;">816</td>
        <td style="padding:3px;">05/15/2026</td>
        <td style="padding:3px;">SEA-637</td>
      </tr>
      <tr style="background-color:#f5f5f5;">
        <td style="padding:3px;">Sample DepartmentX Building LLC</td>
        <td style="padding:3px;">204</td>
        <td style="padding:3px;">05/28/2026</td>
        <td style="padding:3px;">CHI-140</td>
      </tr>
    </table>
  `;

  // Updated DEPARTMENT_X body (matches your current script wording)
  const htmlBody = `
    <div style="font-family: Arial, sans-serif; font-size:14px; color:#000000;">
      <p>Hello <strong>Sample DepartmentX Building LLC</strong>,</p>

      <p>We’re reaching out on behalf of <strong>[Company] Inc.</strong>, a furnished rental company managing flexible-stay apartments across the US and globally.</p>

      <p>[Company] acquired [Previous Operator] and has assumed responsibility for all related leases and operations. Our portfolio also includes properties originally managed or booked through various housing platforms and apps.</p>

      <p style="color:#1a73e8;"><strong>Could you please help us by providing the following for the properties listed below:</strong></p>

      ${textTable}

      <ul>
        <li>Copy of the Move-Out Statement or Final Ledger</li>
        <li>Confirmation of the Security Deposit Return status</li>
        <li>If applicable, details of any damage charges deducted from the deposit, along with supporting documentation</li>
      </ul>

      <p>* If you are a private owner and don't work with move-out statements or ledgers, please let us know if there's any balance from us to you and if we had a security deposit on file with some deductions taken on your end, please let us know what those deductions were.</p>

      <p>* If a refund will be issued, we can send you a secure payment link upon request.</p>

      <p>Thank you very much for your cooperation.<br>
      Have a great day!<br>
      <strong>[Company] Finance Team</strong></p>
    </div>
  `;

  GmailApp.sendEmail(recipient, subject, "", { htmlBody });
}

/***** SLACK (DEPARTMENT_X) *****/
const SLACK_WEBHOOK_URL_DEPARTMENT_X = "YOUR_SLACK_WEBHOOK_URL";

function postToSlackDepartmentX_(message) {
  if (!SLACK_WEBHOOK_URL_DEPARTMENT_X) {
    Logger.log("Slack webhook URL is empty.");
    return;
  }

  const payload = { text: message };

  const res = UrlFetchApp.fetch(SLACK_WEBHOOK_URL_DEPARTMENT_X, {
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
function testSlackDepartmentXNotification() {
  postToSlackDepartmentX_("Hello @your-team ! Test message (no emails sent).");
}
