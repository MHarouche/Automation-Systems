/**
 * Insurance Charge Email Sender — US Insurance Control
 *
 * One email per recipient, grouping every unit / Property Code that belongs to
 * that contact, with the certificate(s) attached.
 *
 * DEPARTMENT_X -> mailbox operations@example.com   (deep blue)
 * DEPARTMENT_Y   -> mailbox operations-queue@example.com   (medium teal)
 *
 * TWO RUNS:
 *   All charges — the catch-up, reading the tab that has one row per PO per
 *                 month. Months and the per-unit total come from that tab.
 *   Monthly     — day 1, reading "Units to reach out to". Stamps the previous
 *                 month into the date cell, then sends. Months come from the
 *                 "Data (Insurance Fees)" ledger.
 *
 * The Email column may hold SEVERAL addresses separated by commas — all of them
 * are used.
 *
 * SENDER.DRY_RUN starts as true on purpose: while it is true the real-send
 * functions deliver nothing. The test functions ignore that flag.
 *
 * NOTE: needs only the built-in DriveApp. Do NOT add the advanced "Drive API"
 * service here — that one is only for the PDF reader.
 */

// ===================== CONFIG =====================
var SENDER = {
  SPREADSHEET_ID: 'YOUR_TAX_CONTROL_SPREADSHEET_ID',

  // "All charges" tab: ONE ROW PER PO PER MONTH. There is no space after "to"
  // in that tab's name, which is what keeps it apart from the other tabs.
  ALL_CHARGES_SHEET_PREFIXES: ['Units to reach out to(adhoc'],
  // 'Units to reach out to' is also a prefix of that name, so the monthly run
  // has to exclude it explicitly or every charge gets counted twice.
  EXCLUDE_SHEET_SUBSTRINGS: ['-all charges'],
  AMOUNT_HEADER_ALL_CHARGES: 'Total per Unit',
  // Pre-computed total the tab carries, repeated on every month row of a PO.
  // Matched on these names ONLY — never on a bare "Total", because that tab has
  // a separate TOTAL column meaning something else.
  TOTAL_PER_REFERENCE_HEADERS: ['total per po', 'total per unit', 'total per property', 'total per property code'],

  // Monthly run (day 1): the recurring tab, matched EXACTLY, and its date cell.
  MONTHLY_SHEET_PREFIXES: ['Units to reach out to'],
  DATE_CELL: 'D1',                          // next to "Date of interest ->"
  DATE_CELL_FORMAT: 'd-mmm-yyyy',           // renders 2026-08-01 as 1-Aug-2026
  AMOUNT_HEADER: 'Monthly Amount',

  PAYMENT_SOURCE_SHEET: 'PAYMENT_SOURCE Data',
  DRIVE_DATA_SHEET: 'Drive Data',
  SETTLED_SHEET: 'Settled units',           // single column, no header

  // Ledger behind "Months Charged" on the monthly run. ONLY "Rent Insurance
  // fee" rows count — the same tab also holds Late fee lines, out of scope.
  FEES_SHEET: 'Data (Insurance Fees)',
  FEE_TYPE_MATCH: 'rent insurance fee',
  MONTH_FORMAT: 'MMM yy',

  LOG_TARGETS: [
    { ID: 'YOUR_LOG_SPREADSHEET_ID', TAB: 'US Insurance' },
    { ID: 'YOUR_TAX_CONTROL_SPREADSHEET_ID', TAB: 'Logs (Unified)' }
  ],

  // Landlords whose mail must go somewhere else regardless of the tab's Email
  // column. Example Partner closed accounts are handled by their settlement team, not
  // by each property. `match` is tested against the building name AND the email
  // domain, because the two do not always agree.
  // Grouping stays per BUILDING here: one consolidated email would list every
  // unit but could only carry MAX_ATTACHMENTS certificates.
  RECIPIENT_OVERRIDES: [
    { label: 'Example Partner', match: 'example-partner', to: ['partner-settlement@example.net'] }
  ],

  // One row per Property Code that was actually emailed to a building.
  // Previews and tests never write here: a test only reaches the internal test
  // list, so the property was not contacted and must not look like it was.
  PO_LOG_SHEET: 'Logs (POs sent)',
  PO_LOG_HEADER: ['Property Code', 'Date Sent', 'Amount'],
  LOG_HEADER: ['Function', 'Timestamp', 'Status', 'Duration (sec)', 'Comment', 'Note'],

  DRY_RUN: true,                 // <<< true = real send delivers nothing
  ENFORCE_SENDER: true,          // blocks a REAL send from the wrong mailbox
  MAX_EMAILS_PER_RUN: 500,
  MAX_SUBJECT_CHARS: 200,
  MAX_ATTACHMENTS: 10,
  MAX_ATTACH_BYTES: 20 * 1024 * 1024,
  SHOW_AMOUNT: true,

  // Several addresses in one Email cell are all used. A handful of Property
  // Codes carry 10-15 contacts, so there is a ceiling; trimming is logged.
  MAX_RECIPIENTS_PER_EMAIL: 6,
  // false = every address goes in To. true = first in To, the rest in Cc.
  CC_EXTRA_RECIPIENTS: false,
  // Workspace allows 1,500 recipients a day and each address counts separately.
  RECIPIENT_WARN_THRESHOLD: 1000,

  // After a real send, leadership gets one summary email listing everything
  // that went out. Not sent for previews or tests (a test already goes to them).
  SEND_SUMMARY_TO_LEADERSHIP: true,
  SUMMARY_ROWS_IN_BODY: 50,      // the rest is in the attached CSV

  // Slack #insurance_control via a Workflow Builder webhook.
  // The URL is a credential — it is NOT stored here. Put it in
  // Project Settings > Script Properties under this key:
  SLACK_WEBHOOK_PROPERTY: 'SLACK_WEBHOOK_URL',
  // Name of the variable declared in the workflow trigger. The payload is sent
  // as { "<this key>": "<the post>" }, so it has to match exactly.
  SLACK_WEBHOOK_FIELD: 'message',

  // OFF on purpose. The webhook above is the only thing that should post.
  // If a Slack Workflow with the Google Sheets trigger is also watching this
  // tab, every run gets posted TWICE — and the sheet trigger replays whatever
  // rows are pending, which is how an DEPARTMENT_Y run ends up posting DEPARTMENT_X as well.
  // Only turn this back on after deleting that workflow in Slack.
  SLACK_FEED_SHEET: '',
  SLACK_SKIP_SOLO_TEST: true,    // keep your own visual checks out of the channel

  LEADERSHIP_RECIPIENTS: [
    'maintainer@example.com',
    'reviewer-three@example.com',
    'reviewer-two@example.com',
    'reviewer-one@example.com'
  ],
  SOLO_RECIPIENTS: ['maintainer@example.com'],

  TEST_MAX_EMAILS: 3,
  SOLO_MAX_EMAILS: 2,

  FROM_NAME: 'Example Company US — Real Estate Team',
  DATE_FORMAT: 'MMM d, yyyy',
  CURRENCY: '$'
};

// PAYMENT_SOURCE Data carries THREE Business Model values:
//   DEPARTMENT_X | ON_DEMAND_TH | ON_DEMAND
// Both on-demand flavours go out through the same mailbox.
var PROFILES = {
  DEPARTMENT_X: {
    key: 'DEPARTMENT_X',
    businessModels: ['DEPARTMENT_X'],
    mailbox: 'operations@example.com',
    accent: '#2E4A62',           // deep grayish blue
    accentSoft: '#E8EDF2'
  },
  DEPARTMENT_Y: {
    key: 'DEPARTMENT_Y',
    businessModels: ['ON_DEMAND_TH', 'ON_DEMAND'],
    mailbox: 'operations-queue@example.com',
    accent: '#2AA5BA',           // medium teal / pool blue
    accentSoft: '#E4F3F7'
  }
};
// =================================================


/* ====================== ALL CHARGES ====================== */

function previewAllChargesDEPARTMENT_X() { runSender_(PROFILES.DEPARTMENT_X, { mode: 'preview', allCharges: true }); }
function previewAllChargesDEPARTMENT_Y()   { runSender_(PROFILES.DEPARTMENT_Y,   { mode: 'preview', allCharges: true }); }

function testAllChargesDEPARTMENT_X_Maintainer() {
  runSender_(PROFILES.DEPARTMENT_X, { mode: 'test', allCharges: true, recipients: SENDER.SOLO_RECIPIENTS, maxEmails: SENDER.SOLO_MAX_EMAILS });
}
function testAllChargesDEPARTMENT_Y_Maintainer() {
  runSender_(PROFILES.DEPARTMENT_Y, { mode: 'test', allCharges: true, recipients: SENDER.SOLO_RECIPIENTS, maxEmails: SENDER.SOLO_MAX_EMAILS });
}

function testAllChargesDEPARTMENT_X() {
  runSender_(PROFILES.DEPARTMENT_X, { mode: 'test', allCharges: true, recipients: SENDER.LEADERSHIP_RECIPIENTS, maxEmails: SENDER.TEST_MAX_EMAILS });
}
function testAllChargesDEPARTMENT_Y() {
  runSender_(PROFILES.DEPARTMENT_Y, { mode: 'test', allCharges: true, recipients: SENDER.LEADERSHIP_RECIPIENTS, maxEmails: SENDER.TEST_MAX_EMAILS });
}

function sendAllChargesDEPARTMENT_X() { runSender_(PROFILES.DEPARTMENT_X, { mode: 'live', allCharges: true }); }
function sendAllChargesDEPARTMENT_Y()   { runSender_(PROFILES.DEPARTMENT_Y,   { mode: 'live', allCharges: true }); }

/**
 * Dry run of the real send that still mails the summary log to leadership, so
 * they can review exactly what WOULD go out. No building is contacted and the
 * subject is prefixed *** TEST ***.
 * For the monthly run instead, swap allCharges:true for monthly:true.
 */
function previewLogsDEPARTMENT_X() { runSender_(PROFILES.DEPARTMENT_X, { mode: 'preview', allCharges: true, summaryTest: true }); }
function previewLogsDEPARTMENT_Y()   { runSender_(PROFILES.DEPARTMENT_Y,   { mode: 'preview', allCharges: true, summaryTest: true }); }


/* ====================== MONTHLY (day 1) ====================== */

function previewMonthlyOutreachDEPARTMENT_X() { runSender_(PROFILES.DEPARTMENT_X, { mode: 'preview', monthly: true }); }
function previewMonthlyOutreachDEPARTMENT_Y()   { runSender_(PROFILES.DEPARTMENT_Y,   { mode: 'preview', monthly: true }); }

function runMonthlyOutreachDEPARTMENT_X() { runSender_(PROFILES.DEPARTMENT_X, { mode: 'live', monthly: true }); }
function runMonthlyOutreachDEPARTMENT_Y()   { runSender_(PROFILES.DEPARTMENT_Y,   { mode: 'live', monthly: true }); }

/** Run once, by hand, inside the matching mailbox. DEPARTMENT_X 08:00, DEPARTMENT_Y 10:00. */
function installMonthlyTriggerDEPARTMENT_X() { installMonthlySenderTrigger_(PROFILES.DEPARTMENT_X, 'runMonthlyOutreachDEPARTMENT_X', 8); }
function installMonthlyTriggerDEPARTMENT_Y()   { installMonthlySenderTrigger_(PROFILES.DEPARTMENT_Y,   'runMonthlyOutreachDEPARTMENT_Y',  10); }

function removeMonthlyTriggerDEPARTMENT_X() { Logger.log('%s trigger(s) removed.', removeInsuranceTriggers_('runMonthlyOutreachDEPARTMENT_X')); }
function removeMonthlyTriggerDEPARTMENT_Y()   { Logger.log('%s trigger(s) removed.', removeInsuranceTriggers_('runMonthlyOutreachDEPARTMENT_Y')); }


/* ====================== Engine ====================== */

function runSender_(profile, opts) {
  var isTest    = opts.mode === 'test';
  var isPreview = opts.mode === 'preview';
  var dryRun    = isPreview || (opts.mode === 'live' && SENDER.DRY_RUN);
  var allCharges = !!opts.allCharges;
  var monthly    = !!opts.monthly;
  var summaryTest = !!opts.summaryTest;   // previewLogs*: dry run, but mail the log anyway

  var tag = isTest      ? (opts.recipients.length === 1 ? ' [SOLO TEST]' : ' [LEADERSHIP TEST]')
          : summaryTest ? ' [PREVIEW + LOG EMAILED]'
          : isPreview   ? ' [PREVIEW — no email at all]'
          : dryRun      ? ' [DRY RUN]' : '';
  var fnName = (summaryTest ? 'previewLogs'
              : allCharges  ? 'sendAllCharges'
                            : 'runMonthlyOutreach') + profile.key + tag;
  var start = new Date();
  var notes = [];
  var info = [];               // informational only — never forces REVIEW

  var labels = {
    amountHeader: allCharges ? SENDER.AMOUNT_HEADER_ALL_CHARGES : SENDER.AMOUNT_HEADER,
    totalLabel:   allCharges ? 'Total' : 'Total per month',
    perUnitSuffix: allCharges ? '' : '/month'
  };

  // Anything that can put an email in somebody's inbox — a real send, a test,
  // or previewLogs (which mails the log) — is locked to the profile's mailbox.
  var willSend = !dryRun || isTest || summaryTest;

  try {
    assertMailbox_(profile, willSend, notes);

    var ss = SpreadsheetApp.openById(SENDER.SPREADSHEET_ID);
    if (monthly) notes.push(stampDateOfInterest_(ss));

    var prefixes = allCharges ? SENDER.ALL_CHARGES_SHEET_PREFIXES : SENDER.MONTHLY_SHEET_PREFIXES;

    var settled = loadSettled_(ss);
    var paymentSource    = loadPaymentSourceIndex_(ss);
    var certs   = loadCertIndex_(ss);
    var rows    = loadSourceRows_(ss, notes, prefixes);

    // All-charges: the tab has one row per PO per month, so the months come
    // from it. Monthly: they come from the fees ledger.
    var months = allCharges ? monthsFromRows_(rows) : loadChargedMonths_(ss);

    // Per-unit figure. All-charges prefers the total the tab already computes;
    // it only adds up the month rows if that column is missing, and says so.
    var usesTabTotal = false;
    if (allCharges) {
      for (var t = 0; t < rows.length; t++) {
        if (rows[t].totalPerPo !== null && rows[t].totalPerPo !== 0) { usesTabTotal = true; break; }
      }
      if (usesTabTotal) info.push('Per-unit figure taken from the tab\'s per-PO total column.');
      else notes.push('No per-PO total column found on the tab — the month rows were added up instead.');
    }

    var picked = [];
    var skip = { settled: 0, noEmail: 0, noPaymentSource: 0, otherModel: 0, noCode: 0 };
    var noCertUnits = 0;
    // Property Codes that will NOT be emailed for a reason worth acting on.
    // Settled units and other-model rows are excluded on purpose, so they stay
    // as counts only — these are the ones somebody has to fix.
    var overrideCount = {};
    var problems = [], problemSeen = {};
    function flagProblem(code, building, unit, reason) {
      if (problemSeen[code + '|' + reason]) return;
      problemSeen[code + '|' + reason] = true;
      problems.push({ code: code, building: building, unit: unit, reason: reason });
    }

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.code)         { skip.noCode++;   continue; }
      if (settled[r.code]) { skip.settled++;  continue; }

      var p = paymentSource[r.code];
      if (!p) {
        skip.noPaymentSource++;
        flagProblem(r.code, r.building, r.unit, 'Property Code not found in PAYMENT_SOURCE Data');
        continue;
      }
      if (profile.businessModels.indexOf(p.businessModel) === -1) { skip.otherModel++; continue; }
      if (!r.emails.length) {
        skip.noEmail++;
        flagProblem(r.code, p.building || r.building, p.addressApt || r.unit, 'No email address on the tab');
        continue;
      }

      var ids = certs[r.code] || [];
      if (!ids.length) noCertUnits++;

      var building = p.building || r.building;
      var ov = overrideFor_(building, r.emails);
      var emails = ov ? ov.to : r.emails;
      // Overridden mail still groups per building, so each email carries its
      // own certificates instead of one giant message hitting the attachment cap.
      var groupKey = ov ? ov.to.join(', ') + ' | ' + building : r.emailKey;
      if (ov) overrideCount[ov.label] = (overrideCount[ov.label] || 0) + 1;

      picked.push({
        code: r.code,
        emailKey: groupKey,
        emails: emails,
        building: building,
        addressFull: p.addressFull || r.address,
        addressApt: p.addressApt || r.unit,
        startDate: p.startDate,
        endDate: p.endDate,
        amount: usesTabTotal ? (r.totalPerPo || 0) : r.amount,
        // A tab total is already the whole PO, so repeated month rows must not
        // add to it; a summed amount must.
        amountIsTotal: usesTabTotal,
        months: months[r.code] || '',
        fileIds: ids
      });
    }

    var groups = groupByRecipient_(picked);

    if (isTest) {
      // Show both flavours, so the no-attachment wording gets reviewed too.
      var withCert = groups.filter(function (g) { return g.fileIds.length > 0; });
      withCert.sort(function (a, b) { return (b.fileIds.length - a.fileIds.length) || (b.units.length - a.units.length); });
      var noCert = groups.filter(function (g) { return g.fileIds.length === 0; });
      noCert.sort(function (a, b) { return b.units.length - a.units.length; });
      groups = withCert.slice(0, Math.max(1, opts.maxEmails - 1)).concat(noCert.slice(0, 1));
      if (!groups.length) throw new Error('No group available to test for ' + profile.key + '.');
      groups = groups.slice(0, opts.maxEmails);
    }

    if (groups.length > SENDER.MAX_EMAILS_PER_RUN) {
      notes.push(groups.length + ' emails would exceed the cap of ' + SENDER.MAX_EMAILS_PER_RUN +
                 ' — trimmed to the first ' + SENDER.MAX_EMAILS_PER_RUN + '.');
      groups = groups.slice(0, SENDER.MAX_EMAILS_PER_RUN);
    }

    // Pre-flight: the Gmail quota counts RECIPIENTS, not messages, and there is
    // no record of who already received. Running out halfway would leave half
    // the properties emailed and a re-run would mail them twice — so if the
    // whole batch does not fit, nothing is sent.
    if (!dryRun) {
      var needed = 0;
      for (var q = 0; q < groups.length; q++) {
        needed += isTest ? opts.recipients.length
                         : Math.min(groups[q].emails.length, SENDER.MAX_RECIPIENTS_PER_EMAIL);
      }
      var left = MailApp.getRemainingDailyQuota();
      if (needed > left) {
        throw new Error('This run needs ' + needed + ' recipients but only ' + left +
          ' are left on ' + (profile.mailbox) + ' today. Nothing was sent. ' +
          'Lower SENDER.MAX_RECIPIENTS_PER_EMAIL or SENDER.MAX_EMAILS_PER_RUN, or run the other profile tomorrow.');
      }
      info.push(needed + ' of ' + left + ' remaining recipients used.');
    }

    var sent = 0, failed = 0, totalUnits = 0, totalAmount = 0, recipients = 0, trimmed = 0;
    var ledger = [];              // one record per email, for the summary
    var poSent = [];              // one row per Property Code actually contacted

    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      totalUnits += grp.units.length;
      totalAmount += grp.total;

      var mail = buildEmail_(grp, profile, isTest, opts.recipients, labels);
      recipients += mail.recipientCount;
      if (mail.trimmed) trimmed++;

      var record = {
        to: mail.to,
        cc: mail.cc,
        buildings: grp.buildings.join(' / '),
        codes: codesOf_(grp).join(', '),
        unitCount: grp.units.length,
        amount: grp.total,
        attachments: mail.attachments.length,
        status: ''
      };

      if (dryRun) {
        record.status = 'Not sent — preview';
        ledger.push(record);
        Logger.log('[%s] -> %s | %s unit(s) | %s attachment(s) | %s',
          isPreview ? 'PREVIEW' : 'DRY RUN', mail.to, grp.units.length, mail.attachments.length, mail.subject);
        continue;
      }

      try {
        var options = { htmlBody: mail.htmlBody, attachments: mail.attachments, name: SENDER.FROM_NAME };
        if (mail.cc) options.cc = mail.cc;
        GmailApp.sendEmail(mail.to, mail.subject, mail.plainBody, options);
        sent++;
        record.status = 'Sent';
        if (!isTest) {
          for (var pu = 0; pu < grp.units.length; pu++) {
            poSent.push([grp.units[pu].code, start, grp.units[pu].amount]);
          }
        }
        Logger.log('SENT -> %s%s | %s unit(s) | %s attachment(s)',
          mail.to, mail.cc ? ' (cc ' + mail.cc + ')' : '', grp.units.length, mail.attachments.length);
      } catch (sendErr) {
        failed++;
        record.status = 'Failed: ' + String(sendErr && sendErr.message ? sendErr.message : sendErr);
        Logger.log('FAILED -> %s: %s', mail.to, sendErr);
        notes.push('Send failed for ' + mail.to + ': ' + sendErr);
      }
      ledger.push(record);
    }

    if (trimmed) {
      notes.push(trimmed + ' email(s) had more than ' + SENDER.MAX_RECIPIENTS_PER_EMAIL +
                 ' contacts and were trimmed to that many.');
    }
    if (recipients > SENDER.RECIPIENT_WARN_THRESHOLD) {
      notes.push(recipients + ' recipient addresses in one run — the Workspace daily cap is 1,500.');
    }

    // Totals over the whole run, counted once and reused by the summary email
    // and the Slack post so the two can never disagree.
    var totals = { units: 0, amount: 0, attachments: 0 };
    for (var tt = 0; tt < ledger.length; tt++) {
      totals.units += ledger[tt].unitCount;
      totals.amount += ledger[tt].amount;
      totals.attachments += ledger[tt].attachments;
    }

    // Problems are deduped per Property Code; the skip counters are per ROW, and
    // the all-charges tab has one row per month. Counting the deduped list keeps
    // "Not sent: 6" from sitting next to "36 without an email address".
    var byReason = {};
    for (var pb = 0; pb < problems.length; pb++) {
      byReason[problems[pb].reason] = (byReason[problems[pb].reason] || 0) + 1;
    }
    var noEmailCodes = byReason['No email address on the tab'] || 0;
    var noPaymentSourceCodes  = byReason['Property Code not found in PAYMENT_SOURCE Data'] || 0;

    // Who gets the run log: a test reports back to whoever the test was aimed
    // at, everything else goes to leadership.
    var wantSummary = SENDER.SEND_SUMMARY_TO_LEADERSHIP && (summaryTest || isTest || !dryRun);
    var logMailTo = isTest ? opts.recipients : SENDER.LEADERSHIP_RECIPIENTS;
    var logMailNote;

    if (wantSummary && (ledger.length || problems.length)) {
      try {
        sendRunSummary_(profile, allCharges ? 'All charges' : 'Monthly', ledger, problems,
          { sent: sent, failed: failed, units: totalUnits, amount: totalAmount,
            recipients: recipients, skip: skip, noCertUnits: noCertUnits,
            noEmailCodes: noEmailCodes, noPaymentSourceCodes: noPaymentSourceCodes },
          start, summaryTest || isTest, logMailTo);
        logMailNote = 'LOG EMAILED to ' + logMailTo.join(', ') + '.';
      } catch (summaryErr) {
        logMailNote = 'LOG EMAIL FAILED: ' + String(summaryErr && summaryErr.message ? summaryErr.message : summaryErr);
        notes.push(logMailNote);
      }
    } else if (wantSummary) {
      logMailNote = 'LOG NOT EMAILED: there was nothing to report.';
    } else {
      logMailNote = 'LOG NOT EMAILED: this function never mails the log — run previewLogs' +
                    profile.key + '() for that.';
    }

    var status = (failed > 0 || skip.noPaymentSource > 0 || notes.length) ? 'REVIEW' : 'OK';

    var comment = [
      logMailNote,
      profile.key + (allCharges ? ' all-charges' : ' monthly') +
        (isTest ? ' TEST (delivered to: ' + opts.recipients.join(', ') + ')' : (dryRun ? ' PREVIEW — nothing sent' : '')),
      groups.length + ' email(s) / ' + recipients + ' recipient(s) / ' + totalUnits + ' unit(s)' +
        (SENDER.SHOW_AMOUNT ? ' / ' + fmtMoney_(totalAmount) : ''),
      dryRun ? '' : sent + ' sent, ' + failed + ' failed',
      noCertUnits ? noCertUnits + ' unit(s) had no certificate — attachment line omitted' : '',
      'skipped: ' + skip.settled + ' settled, ' + skip.otherModel + ' other Business Model, ' +
        skip.noEmail + ' no email, ' + skip.noPaymentSource + ' no PAYMENT_SOURCE Data match',
      overrideSummary_(overrideCount)
    ].filter(String).join('. ') + '.' +
      (info.length ? ' ' + info.join(' ') : '') +
      (notes.length ? ' ' + notes.join(' ') : '');

    logPropertyCodesSent_(poSent);
    logRun_(fnName, start, status, comment);
    Logger.log('%s | %s', status, comment);

    writeSlackFeed_(profile, allCharges ? 'All charges' : 'Monthly', {
      dryRun: dryRun, isTest: isTest, isSoloTest: isTest && opts.recipients.length === 1,
      emails: dryRun ? ledger.length : sent, failed: failed,
      recipients: recipients, totals: totals,
      noCertUnits: noCertUnits, skip: skip,
      notSent: problems.length + failedRows_(ledger).length,
      noEmailCodes: noEmailCodes, noPaymentSourceCodes: noPaymentSourceCodes
    }, start);

  } catch (err) {
    logRun_(fnName, start, 'ERROR', String(err && err.stack ? err.stack : err));
    throw err;
  }
}

/**
 * DEPARTMENT_X may only leave realestate-admin@ and DEPARTMENT_Y only readmin-ondemand@.
 * If this run can deliver an email at all, the wrong mailbox is a hard stop —
 * a message sent from the wrong account is not something you can take back,
 * and it would put the monthly trigger on the wrong profile.
 * A read-only preview is allowed anywhere, but says so loudly.
 */
function assertMailbox_(profile, willSend, notes) {
  var me = '';
  try { me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}

  if (!me) {
    if (willSend && SENDER.ENFORCE_SENDER) {
      throw new Error('Could not confirm which mailbox is running this script, and ' + profile.key +
        ' may only send from ' + profile.mailbox + '. Nothing was sent.');
    }
    notes.push('Could not identify the mailbox running this script.');
    return;
  }

  if (me === profile.mailbox.toLowerCase()) return;

  var msg = profile.key + ' may only send from ' + profile.mailbox + ', but this is running as ' + me + '.';
  if (willSend && SENDER.ENFORCE_SENDER) {
    throw new Error(msg + ' Nothing was sent. Open the Apps Script project inside ' +
      profile.mailbox + ' and run it there.');
  }
  notes.push(msg + ' Read-only preview, so nothing was sent.');
}


/* ====================== Data loading ====================== */

/** "Settled units": single column, NO header. Every value is a code to skip. */
function loadSettled_(ss) {
  var sh = ss.getSheetByName(SENDER.SETTLED_SHEET);
  if (!sh) throw new Error('Tab "' + SENDER.SETTLED_SHEET + '" not found.');
  var last = sh.getLastRow(), set = {}, n = 0;
  if (last < 1) return set;
  var vals = sh.getRange(1, 1, last, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    var c = normCode_(vals[i][0]);
    if (c && !set[c]) { set[c] = true; n++; }
  }
  Logger.log('Settled units: %s code(s) that must NOT be emailed.', n);
  return set;
}

function loadPaymentSourceIndex_(ss) {
  var sh = ss.getSheetByName(SENDER.PAYMENT_SOURCE_SHEET);
  if (!sh) throw new Error('Tab "' + SENDER.PAYMENT_SOURCE_SHEET + '" not found.');
  var values = sh.getDataRange().getValues();
  if (values.length < 2) throw new Error('Tab "' + SENDER.PAYMENT_SOURCE_SHEET + '" is empty.');

  var H = headerIndex_(values[0]);
  var cCode  = pick_(H, ['property code']);
  var cBuild = pick_(H, ['building name']);
  var cApt   = pick_(H, ['address apt']);
  var cFull  = pick_(H, ['address full', 'full address']);
  var cStart = pick_(H, ['start date']);
  var cEnd   = pick_(H, ['end date']);
  var cModel = pick_(H, ['business model']);
  if (cCode < 0)  throw new Error('PAYMENT_SOURCE Data has no "Property Code" column.');
  if (cModel < 0) throw new Error('PAYMENT_SOURCE Data has no "Business Model" column.');

  var idx = {}, n = 0;
  for (var r = 1; r < values.length; r++) {
    var code = normCode_(values[r][cCode]);
    if (!code) continue;
    var rec = {
      building:    cBuild >= 0 ? String(values[r][cBuild] || '').trim() : '',
      addressFull: cFull  >= 0 ? String(values[r][cFull]  || '').trim() : '',
      addressApt:  cApt   >= 0 ? aptToText_(values[r][cApt]) : '',
      startDate:   cStart >= 0 ? values[r][cStart] : '',
      endDate:     cEnd   >= 0 ? values[r][cEnd]   : '',
      businessModel: String(values[r][cModel] || '').trim().toUpperCase(),
      _sortKey:    cStart >= 0 ? dateSortKey_(values[r][cStart]) : 0
    };
    // One Property Code can have several contracts: keep the latest Start Date.
    if (!idx[code]) { idx[code] = rec; n++; }
    else if (rec._sortKey >= idx[code]._sortKey) idx[code] = rec;
  }
  Logger.log('PAYMENT_SOURCE Data: %s Property Code(s) indexed.', n);
  return idx;
}

/** Drive Data -> { code: [fileId, ...] }, reading the Doc Title link. */
function loadCertIndex_(ss) {
  var sh = ss.getSheetByName(SENDER.DRIVE_DATA_SHEET);
  if (!sh) throw new Error('Tab "' + SENDER.DRIVE_DATA_SHEET + '" not found.');
  var last = sh.getLastRow(), map = {}, n = 0;
  if (last < 2) return map;

  var rowCount = last - 1;
  var codes = sh.getRange(2, 5, rowCount, 1).getValues();          // E = Property Code
  var rich  = sh.getRange(2, 1, rowCount, 1).getRichTextValues();  // A = Doc Title (linked)
  var forms = null;

  for (var i = 0; i < rowCount; i++) {
    var code = normCode_(codes[i][0]);
    if (!code) continue;
    var id = fileIdFromRich_(rich[i][0]);
    if (!id) {
      if (forms === null) forms = sh.getRange(2, 1, rowCount, 1).getFormulas();
      id = fileIdFromUrl_(hyperlinkUrl_(forms[i][0]));
    }
    if (!id) continue;
    var list = map[code];
    if (!list) { list = map[code] = []; n++; }
    if (list.indexOf(id) === -1) list.push(id);
  }
  Logger.log('Certificates: %s Property Code(s) with at least one PDF.', n);
  return map;
}

/**
 * "Data (Insurance Fees)" -> { code: "Nov 25, Dec 25" } for the monthly run.
 * Only "Rent Insurance fee" rows — the Late fee rows in that same tab are a
 * different dispute. Months are listed one by one, never as a range: charges
 * skip months and a range would claim months that were not billed.
 */
function loadChargedMonths_(ss) {
  var sh = ss.getSheetByName(SENDER.FEES_SHEET);
  if (!sh) { Logger.log('Tab "%s" not found — Months Charged will be blank.', SENDER.FEES_SHEET); return {}; }
  var last = sh.getLastRow();
  if (last < 2) return {};

  var values = sh.getRange(1, 1, last, Math.max(4, sh.getLastColumn())).getValues();
  var H = headerIndex_(values[0]);
  var cCode = pick_(H, ['city-po', 'city po', 'property code']);
  var cDate = pick_(H, ['date']);
  var cType = pick_(H, ['type']);
  if (cCode < 0 || cDate < 0) {
    Logger.log('Tab "%s" has no City-PO/Date column — Months Charged will be blank.', SENDER.FEES_SHEET);
    return {};
  }

  var tz = Session.getScriptTimeZone();
  var seen = {}, order = {};

  for (var r = 1; r < values.length; r++) {
    var code = normCode_(values[r][cCode]);
    if (!code) continue;
    if (cType >= 0 && String(values[r][cType] || '').trim().toLowerCase().indexOf(SENDER.FEE_TYPE_MATCH) === -1) continue;
    var d = toDate_(values[r][cDate]);
    if (!d) continue;

    var key = d.getFullYear() * 100 + d.getMonth();
    var bucket = seen[code] || (seen[code] = {});
    if (bucket[key]) continue;
    bucket[key] = Utilities.formatDate(d, tz, SENDER.MONTH_FORMAT);
    (order[code] = order[code] || []).push(key);
  }

  return joinMonths_(seen, order);
}

/** Distinct months per Property Code, from the source tab's own Date column. */
function monthsFromRows_(rows) {
  var tz = Session.getScriptTimeZone();
  var seen = {}, order = {};

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r.code || !r.date) continue;
    var key = r.date.getFullYear() * 100 + r.date.getMonth();
    var bucket = seen[r.code] || (seen[r.code] = {});
    if (bucket[key]) continue;
    bucket[key] = Utilities.formatDate(r.date, tz, SENDER.MONTH_FORMAT);
    (order[r.code] = order[r.code] || []).push(key);
  }

  return joinMonths_(seen, order);
}

function joinMonths_(seen, order) {
  var out = {};
  for (var code in seen) {
    if (!seen.hasOwnProperty(code)) continue;
    var keys = order[code].sort(function (a, b) { return a - b; });
    var monthLabels = [];
    for (var k = 0; k < keys.length; k++) monthLabels.push(seen[code][keys[k]]);
    out[code] = monthLabels.join(', ');
  }
  Logger.log('Months resolved for %s Property Code(s).', Object.keys(out).length);
  return out;
}

/** Charge tab -> [{code, emails, emailKey, building, address, unit, amount, date, totalPerPo}] */
function loadSourceRows_(ss, notes, prefixes) {
  var sheets = resolveSourceSheets_(ss, prefixes);
  if (!sheets.length) throw new Error('No charge tab found with these prefixes: ' + prefixes.join(' | '));

  var out = [];
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var last = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (last < 2) continue;

    var values = sh.getRange(1, 1, last, lastCol).getValues();
    var H = headerIndex_(values[0]);
    var cCode  = pick_(H, ['city-po', 'city po', 'property code']);
    var cEmail = pick_(H, ['email']);
    var cBuild = pick_(H, ['building name']);
    var cAddr  = pick_(H, ['full address', 'address full']);
    var cUnit  = pick_(H, ['unit']);
    var cAmt   = pick_(H, ['amount']);
    var cDate  = pick_(H, ['date']);
    var cTotal = pick_(H, SENDER.TOTAL_PER_REFERENCE_HEADERS);
    if (cCode < 0 || cEmail < 0) {
      notes.push('Tab "' + sh.getName() + '" ignored: missing City-PO or Email column.');
      continue;
    }
    Logger.log('Tab "%s": per-PO total column = %s', sh.getName(),
      cTotal < 0 ? 'NOT FOUND' : '"' + values[0][cTotal] + '"');

    var before = out.length;
    for (var r = 1; r < values.length; r++) {
      var code = normCode_(values[r][cCode]);
      if (!code) continue;
      var emails = normEmails_(values[r][cEmail]);
      out.push({
        code: code,
        emails: emails,
        emailKey: emails.join(', '),
        building: cBuild >= 0 ? String(values[r][cBuild] || '').trim() : '',
        address:  cAddr  >= 0 ? String(values[r][cAddr]  || '').trim() : '',
        unit:     cUnit  >= 0 ? aptToText_(values[r][cUnit]) : '',
        amount:   cAmt   >= 0 ? toNumber_(values[r][cAmt]) : 0,
        date:     cDate  >= 0 ? toDate_(values[r][cDate]) : null,
        totalPerPo: cTotal >= 0 ? toNumber_(values[r][cTotal]) : null
      });
    }
    Logger.log('Tab "%s": %s row(s).', sh.getName(), out.length - before);
  }
  return out;
}

function resolveSourceSheets_(ss, prefixes) {
  // The monthly prefix is also a prefix of the all-charges tab name, so the
  // monthly run must match EXACTLY and skip the excluded names.
  var exactOnly = (prefixes === SENDER.MONTHLY_SHEET_PREFIXES);
  var allowAllCharges = (prefixes === SENDER.ALL_CHARGES_SHEET_PREFIXES);

  var all = ss.getSheets(), found = [], seen = {};
  for (var p = 0; p < prefixes.length; p++) {
    var pref = prefixes[p].toLowerCase();
    for (var i = 0; i < all.length; i++) {
      var nm = all[i].getName();
      if (seen[nm]) continue;
      var lower = nm.toLowerCase();
      if (!allowAllCharges && isExcludedSheet_(lower)) continue;
      var hit = exactOnly ? (lower === pref) : (lower.indexOf(pref) === 0);
      if (hit) { found.push(all[i]); seen[nm] = true; }
    }
  }
  return found;
}

/**
 * Returns the override whose `match` appears in the building name or in any of
 * the row's email domains, or null. Both are checked because they disagree: in
 * the September data two Example Partner properties are only recognisable by the
 * building name and one only by the @example-partner.com domain.
 */
/** "Example Partner: 109 unit(s) redirected to partner-settlement@example.net" */
function overrideSummary_(counts) {
  var parts = [];
  for (var i = 0; i < SENDER.RECIPIENT_OVERRIDES.length; i++) {
    var ov = SENDER.RECIPIENT_OVERRIDES[i];
    if (!counts[ov.label]) continue;
    parts.push(ov.label + ': ' + counts[ov.label] + ' unit(s) redirected to ' + ov.to.join(', '));
  }
  return parts.join('. ');
}

function overrideFor_(building, emails) {
  var b = String(building || '').toLowerCase();
  var joined = (emails || []).join(' ').toLowerCase();

  for (var i = 0; i < SENDER.RECIPIENT_OVERRIDES.length; i++) {
    var ov = SENDER.RECIPIENT_OVERRIDES[i];
    var needle = String(ov.match).toLowerCase();
    if (b.indexOf(needle) !== -1 || joined.indexOf('@' + needle) !== -1) return ov;
  }
  return null;
}

function isExcludedSheet_(lowerName) {
  for (var i = 0; i < SENDER.EXCLUDE_SHEET_SUBSTRINGS.length; i++) {
    if (lowerName.indexOf(SENDER.EXCLUDE_SHEET_SUBSTRINGS[i]) !== -1) return true;
  }
  return false;
}


/* ====================== Monthly date stamp ====================== */

/**
 * Writes the 1st of the PREVIOUS month into the date cell of the recurring tab.
 * It goes in as a real Date — the cell holds one and the sheet formulas compare
 * dates — and only the display format says "1-Aug-2026".
 */
function stampDateOfInterest_(ss) {
  var sheets = resolveSourceSheets_(ss, SENDER.MONTHLY_SHEET_PREFIXES);
  if (!sheets.length) throw new Error('Recurring tab "' + SENDER.MONTHLY_SHEET_PREFIXES[0] + '" not found.');
  var sh = sheets[0];

  var target = previousMonthFirstDay_(new Date());
  var cell = sh.getRange(SENDER.DATE_CELL);
  var current = cell.getValue();

  var already = (Object.prototype.toString.call(current) === '[object Date]') &&
                current.getFullYear() === target.getFullYear() &&
                current.getMonth() === target.getMonth() &&
                current.getDate() === target.getDate();

  var shown = Utilities.formatDate(target, Session.getScriptTimeZone(), 'd-MMM-yyyy');
  if (already) return 'Date of interest already ' + shown + '.';

  cell.setValue(target).setNumberFormat(SENDER.DATE_CELL_FORMAT);
  SpreadsheetApp.flush();
  Utilities.sleep(8000);          // let the sheet formulas recalculate
  SpreadsheetApp.flush();

  return 'Date of interest set to ' + shown + ' in ' + sh.getName() + '!' + SENDER.DATE_CELL + '.';
}

function previousMonthFirstDay_(from) {
  return new Date(from.getFullYear(), from.getMonth() - 1, 1);
}


/* ====================== Grouping ====================== */

/** One email per recipient set. Repeated charges on the same unit are summed. */
function groupByRecipient_(picked) {
  var byEmail = {};
  for (var i = 0; i < picked.length; i++) {
    var u = picked[i];
    var g = byEmail[u.emailKey];
    if (!g) {
      g = byEmail[u.emailKey] = {
        emails: u.emails, emailKey: u.emailKey,
        units: [], index: {}, buildings: [], fileIds: [], total: 0
      };
    }

    var key = u.code + '|' + normUnitKey_(u.addressApt);
    var existing = g.index[key];
    if (existing) {
      // Several month rows for the same unit. A per-PO total is already
      // complete, so the repeats are ignored; a monthly amount adds up.
      if (!u.amountIsTotal) { existing.amount += u.amount; g.total += u.amount; }
      continue;
    }

    var unit = {
      code: u.code, addressFull: u.addressFull, addressApt: u.addressApt,
      startDate: u.startDate, endDate: u.endDate, amount: u.amount, months: u.months
    };
    g.index[key] = unit;
    g.units.push(unit);
    g.total += u.amount;

    if (u.building && g.buildings.indexOf(u.building) === -1) g.buildings.push(u.building);
    for (var f = 0; f < u.fileIds.length; f++) {
      if (g.fileIds.indexOf(u.fileIds[f]) === -1) g.fileIds.push(u.fileIds[f]);
    }
  }

  var list = [];
  for (var k in byEmail) if (byEmail.hasOwnProperty(k)) list.push(byEmail[k]);
  list.sort(function (a, b) { return b.units.length - a.units.length; });
  return list;
}


/* ====================== Email building ====================== */

function buildEmail_(grp, profile, isTest, testRecipients, labels) {
  var addresses = grp.emails.slice(0, SENDER.MAX_RECIPIENTS_PER_EMAIL);
  var trimmed = grp.emails.length > addresses.length;

  var to, cc = '';
  if (isTest) {
    to = testRecipients.join(',');
  } else if (SENDER.CC_EXTRA_RECIPIENTS && addresses.length > 1) {
    to = addresses[0];
    cc = addresses.slice(1).join(',');
  } else {
    to = addresses.join(',');
  }

  // The test prefix is part of the truncation budget, otherwise the subject
  // blows past Gmail's limit. It is short on purpose: the real destination
  // goes in the body banner instead.
  var prefix = isTest ? '[TEST ' + profile.key + '] ' : '';
  var subject = clampSubject_(prefix + buildSubject_(grp, prefix.length));
  var att = loadAttachments_(grp.fileIds);
  var hasAttachment = att.blobs.length > 0;

  return {
    to: to,
    cc: cc,
    subject: subject,
    htmlBody: buildHtml_(grp, profile, isTest ? grp.emailKey : '', hasAttachment, labels),
    plainBody: buildPlain_(grp, isTest ? grp.emailKey : '', hasAttachment, labels),
    attachments: att.blobs,
    recipientCount: isTest ? testRecipients.length : addresses.length,
    trimmed: trimmed
  };
}

/** Safety net: nothing leaves this function above MAX_SUBJECT_CHARS. */
function clampSubject_(s) {
  s = String(s || '');
  return s.length <= SENDER.MAX_SUBJECT_CHARS ? s : s.substring(0, SENDER.MAX_SUBJECT_CHARS - 1) + '…';
}

/**
 * "Insurance Charge on Our Ledger - Example Company US - <property codes>"
 * Only Property Codes go in the subject; extras collapse into "+N".
 */
function buildSubject_(grp, reserve) {
  var BASE = 'Insurance Charge on Our Ledger - Example Company US - ';
  var max = SENDER.MAX_SUBJECT_CHARS - (reserve || 0);
  if (max < BASE.length + 12) max = BASE.length + 12;

  var codes = [];
  for (var i = 0; i < grp.units.length; i++) {
    if (codes.indexOf(grp.units[i].code) === -1) codes.push(grp.units[i].code);
  }

  var s = BASE + joinCap_(codes, codes.length);
  if (s.length <= max) return s;
  for (var c = codes.length - 1; c >= 1; c--) {
    s = BASE + joinCap_(codes, c);
    if (s.length <= max) return s;
  }
  return s.substring(0, max - 1) + '…';
}

/** "a, b, c +7" */
function joinCap_(items, n) {
  if (!items || !items.length || n <= 0) return '';
  var shown = items.slice(0, n).join(', ');
  var rest = items.length - n;
  return rest > 0 ? shown + ' +' + rest : shown;
}

/**
 * The closing paragraph. With a certificate attached it points at the
 * attachment; without one it never mentions an attachment.
 */
function closingLine_(hasAttachment) {
  return hasAttachment
    ? 'For your convenience, we’re attaching the certificate again now. ' +
      'Could you please remove these charges and confirm once the credit has been applied?'
    : 'Could you please remove these charges and confirm once the credit has been applied? ' +
      'If you need a copy of the Certificate of Insurance, we’ll be glad to send it over.';
}

function buildHtml_(grp, profile, testDestination, hasAttachment, labels) {
  var greeting = grp.buildings.length ? grp.buildings.join(' / ') : '';
  var tz = Session.getScriptTimeZone();
  var cols = SENDER.SHOW_AMOUNT ? 6 : 5;

  var banner = '';
  if (testDestination) {
    banner =
      '<div style="border:2px dashed ' + profile.accent + ';background:' + profile.accentSoft + ';' +
      'padding:10px 12px;margin-bottom:18px;font-size:13px;color:' + profile.accent + ';">' +
        '<strong>TEST EMAIL — ' + profile.key + ' profile.</strong> ' +
        'On a real run this would go to <strong>' + esc_(testDestination) + '</strong>. ' +
        'No building was contacted.' +
      '</div>';
  }

  var rows = '';
  for (var i = 0; i < grp.units.length; i++) {
    var u = grp.units[i];
    var bg = (i % 2 === 0) ? '#FFFFFF' : profile.accentSoft;
    rows += '<tr style="background:' + bg + ';">' +
              td_(esc_(u.addressFull)) +
              td_(esc_(u.addressApt)) +
              td_(esc_(fmtDate_(u.startDate, tz))) +
              td_(esc_(fmtDate_(u.endDate, tz))) +
              td_(esc_(u.months || '—')) +
              (SENDER.SHOW_AMOUNT ? td_(esc_(fmtMoney_(u.amount))) : '') +
            '</tr>';
  }

  var totalRow = '';
  if (SENDER.SHOW_AMOUNT && grp.units.length > 1) {
    totalRow = '<tr style="background:' + profile.accentSoft + ';font-weight:bold;">' +
                 '<td colspan="' + (cols - 1) + '" style="text-align:left;padding:8px 14px 8px 10px;' +
                   'border:1px solid #D0D7DE;">' + labels.totalLabel + '</td>' +
                 td_(esc_(fmtMoney_(grp.total))) +
               '</tr>';
  }

  return '' +
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;text-align:left;">' +
    banner +
    '<p>Dear ' + (greeting ? esc_(greeting) + ' Team' : 'Team') + ',</p>' +
    '<p>We&rsquo;ve noticed insurance charge(s) on our ledger for the unit(s) we lease with you, shown below. ' +
       'We provided a Certificate of Insurance at move-in, so these charges should not apply.</p>' +
    '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:18px 0;text-align:left;">' +
      '<thead><tr style="background:' + profile.accent + ';color:#FFFFFF;">' +
        th_('Address') + th_('Unit') + th_('Lease Start') + th_('Lease End') + th_('Months Charged') +
        (SENDER.SHOW_AMOUNT ? th_(labels.amountHeader) : '') +
      '</tr></thead>' +
      '<tbody>' + rows + totalRow + '</tbody>' +
    '</table>' +
    '<p>' + esc_(closingLine_(hasAttachment)) + '</p>' +
    '<p>If you need anything further from us to process this, please let us know.</p>' +
    '<p>Thank you for your help.</p>' +
    '<p style="margin-bottom:2px;">Best regards,</p>' +
    '<p style="margin-top:0;color:' + profile.accent + ';font-weight:bold;">Example Company US<br>Real Estate Team</p>' +
  '</div>';
}

function th_(t) {
  return '<th style="text-align:left;padding:8px 14px 8px 10px;font-weight:bold;' +
         'border:1px solid #D0D7DE;white-space:nowrap;">' + t + '</th>';
}
function td_(t) {
  return '<td style="text-align:left;padding:7px 14px 7px 10px;border:1px solid #D0D7DE;' +
         'vertical-align:top;">' + (t || '') + '</td>';
}

function buildPlain_(grp, testDestination, hasAttachment, labels) {
  var greeting = grp.buildings.length ? grp.buildings.join(' / ') + ' Team' : 'Team';
  var tz = Session.getScriptTimeZone();
  var lines = [];
  if (testDestination) {
    lines.push('*** TEST EMAIL — on a real run this would go to ' + testDestination + '. No building was contacted. ***');
    lines.push('');
  }
  lines = lines.concat([
    'Dear ' + greeting + ',',
    '',
    'We\'ve noticed insurance charge(s) on our ledger for the unit(s) we lease with you, shown below. ' +
      'We provided a Certificate of Insurance at move-in, so these charges should not apply.',
    ''
  ]);
  for (var i = 0; i < grp.units.length; i++) {
    var u = grp.units[i];
    lines.push('- ' + u.addressFull + ' | Unit ' + u.addressApt +
               ' | ' + fmtDate_(u.startDate, tz) + ' to ' + fmtDate_(u.endDate, tz) +
               ' | charged: ' + (u.months || '—') +
               (SENDER.SHOW_AMOUNT ? ' | ' + fmtMoney_(u.amount) + labels.perUnitSuffix : ''));
  }
  if (SENDER.SHOW_AMOUNT && grp.units.length > 1) lines.push('  ' + labels.totalLabel + ': ' + fmtMoney_(grp.total));
  lines.push('');
  lines.push(closingLine_(hasAttachment).replace(/[’]/g, "'"));
  lines.push('');
  lines.push('If you need anything further from us to process this, please let us know.');
  lines.push('');
  lines.push('Thank you for your help.');
  lines.push('');
  lines.push('Best regards,');
  lines.push('Example Company US');
  lines.push('Real Estate Team');
  return lines.join('\n');
}

function loadAttachments_(fileIds) {
  var blobs = [], bytes = 0;
  for (var i = 0; i < fileIds.length && blobs.length < SENDER.MAX_ATTACHMENTS; i++) {
    try {
      var f = DriveApp.getFileById(fileIds[i]);
      var size = f.getSize();
      if (blobs.length && bytes + size > SENDER.MAX_ATTACH_BYTES) break;
      blobs.push(f.getBlob());
      bytes += size;
    } catch (e) {
      Logger.log('Attachment %s unavailable: %s', fileIds[i], e);
    }
  }
  return { blobs: blobs };
}


/* ====================== Run summary to leadership ====================== */

function codesOf_(grp) {
  var codes = [];
  for (var i = 0; i < grp.units.length; i++) {
    if (codes.indexOf(grp.units[i].code) === -1) codes.push(grp.units[i].code);
  }
  return codes;
}

/**
 * One email to leadership after a real send, listing every message that went
 * out. The first rows are in the body; the complete list is attached as CSV so
 * nothing is lost when a run covers hundreds of properties.
 */
function sendRunSummary_(profile, modeLabel, ledger, problems, stats, start, isTestLog, mailTo) {
  var tz = Session.getScriptTimeZone();
  var when = Utilities.formatDate(start, tz, 'MMM d, yyyy HH:mm');
  var shown = ledger.slice(0, SENDER.SUMMARY_ROWS_IN_BODY);

  // Totals over the WHOLE run, not just the rows shown in the body.
  var grandUnits = 0, grandAmount = 0, grandAttachments = 0;
  for (var g = 0; g < ledger.length; g++) {
    grandUnits += ledger[g].unitCount;
    grandAmount += ledger[g].amount;
    grandAttachments += ledger[g].attachments;
  }

  var rows = '';
  for (var i = 0; i < shown.length; i++) {
    var r = shown[i];
    var ok = (r.status === 'Sent' || r.status === 'Not sent — preview');
    var bg = ok ? ((i % 2 === 0) ? '#FFFFFF' : profile.accentSoft) : '#FDECEC';
    rows += '<tr style="background:' + bg + ';">' +
      td_(esc_(r.to) + (r.cc ? '<br><span style="color:#666;">cc ' + esc_(r.cc) + '</span>' : '')) +
      td_(esc_(r.buildings || '—')) +
      td_(esc_(r.codes)) +
      td_(String(r.unitCount)) +
      td_(esc_(fmtMoney_(r.amount))) +
      td_(r.attachments ? String(r.attachments) : '—') +
      td_(ok ? esc_(r.status) : '<strong style="color:#B00020;">' + esc_(r.status) + '</strong>') +
      '</tr>';
  }

  rows += '<tr style="background:' + profile.accentSoft + ';font-weight:bold;">' +
    '<td colspan="3" style="text-align:left;padding:8px 14px 8px 10px;border:1px solid #D0D7DE;">' +
      'Total — ' + ledger.length + ' email(s)</td>' +
    td_(String(grandUnits)) +
    td_(esc_(fmtMoney_(grandAmount))) +
    td_(String(grandAttachments)) +
    td_('') +
  '</tr>';

  // Emails that were attempted and rejected by Gmail belong in the not-sent
  // section too, not only as a red line inside the sent table.
  var failedRows = failedRows_(ledger);

  var banner = isTestLog
    ? '<div style="border:3px solid #B00020;background:#FDECEC;padding:12px 14px;margin-bottom:18px;' +
      'font-size:15px;color:#B00020;font-weight:bold;">' +
        'TEST — NO BUILDING WAS CONTACTED. This is a preview of what the ' + profile.key +
        ' run would deliver.' +
      '</div>'
    : '';

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;text-align:left;">' +
      banner +
      '<p><strong>' + profile.key + ' — ' + esc_(modeLabel) +
        (isTestLog ? ' preview (nothing sent).' : ' send completed.') + '</strong> ' + esc_(when) + '</p>' +
      '<ul>' +
        '<li><strong>' + (isTestLog ? ledger.length : stats.sent) + '</strong> email(s) ' +
          (isTestLog ? 'would be sent' : 'sent') +
          (stats.failed ? ', <strong style="color:#B00020;">' + stats.failed + ' failed</strong>' : '') + '</li>' +
        '<li><strong>Total insurance charged: ' + fmtMoney_(grandAmount) + '</strong></li>' +
        '<li>' + stats.recipients + ' recipient address(es) · ' + grandUnits + ' unit(s) · ' +
          grandAttachments + ' certificate(s) attached</li>' +
        (stats.noCertUnits ? '<li>' + stats.noCertUnits + ' unit(s) had no certificate — those emails did not mention an attachment</li>' : '') +
        '<li>Excluded by design: ' + stats.skip.settled + ' settled · ' +
          stats.skip.otherModel + ' from the other Business Model</li>' +
        '<li><strong>Not sent: ' + (problems.length + failedRows.length) + '</strong> — ' +
          (stats.noEmailCodes || 0) + ' without an email address · ' +
          (stats.noPaymentSourceCodes || 0) + ' with no PAYMENT_SOURCE Data match' +
          (failedRows.length ? ' · ' + failedRows.length + ' rejected by Gmail' : '') + '</li>' +
      '</ul>' +
      '<p>' + (ledger.length > shown.length
        ? 'First ' + shown.length + ' of ' + ledger.length + ' — the full list is attached as CSV.'
        : 'Full list below, also attached as CSV.') + '</p>' +
      '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;text-align:left;font-size:13px;">' +
        '<thead><tr style="background:' + profile.accent + ';color:#FFFFFF;">' +
          th_('Sent to') + th_('Building') + th_('Property Codes') + th_('Units') +
          th_('Amount') + th_('Attachments') + th_('Status') +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
      notSentBlock_(profile, problems, failedRows) +
      '<p style="color:#666;font-size:12px;margin-top:18px;">Sent from ' + esc_(profile.mailbox) + '.</p>' +
    '</div>';

  // One CSV with the whole run: what went out and what did not.
  var csv = ['Record,Status,Sent to,Cc,Building,Property Code(s),Unit,Units,Amount,Attachments,Reason'];
  for (var c = 0; c < ledger.length; c++) {
    var Lr = ledger[c];
    csv.push(['Email', Lr.status, Lr.to, Lr.cc, Lr.buildings, Lr.codes, '',
              Lr.unitCount, Lr.amount, Lr.attachments, ''].map(csvCell_).join(','));
  }
  for (var pr = 0; pr < problems.length; pr++) {
    var P = problems[pr];
    csv.push(['Not sent', 'Skipped', '', '', P.building, P.code, P.unit, '', '', '', P.reason]
      .map(csvCell_).join(','));
  }
  var stamp = Utilities.formatDate(start, tz, 'yyyy-MM-dd_HHmm');

  try {
    var notSent = problems.length + failedRows.length;
    GmailApp.sendEmail(mailTo.join(','),
      (isTestLog ? '*** TEST *** ' : '') +
        'US Insurance — ' + profile.key + ' ' + modeLabel +
        (isTestLog ? ' preview: ' : ' send: ') +
        (isTestLog ? ledger.length : stats.sent) + ' email(s), ' +
        grandUnits + ' unit(s), ' + fmtMoney_(grandAmount) + ' insurance' +
        (notSent ? ' — ' + notSent + ' not sent' : ''),
      (isTestLog ? 'TEST — no building was contacted. ' : '') +
        (isTestLog ? ledger.length + ' email(s) would go out' : stats.sent + ' sent, ' + stats.failed + ' failed') +
        '. ' + notSent + ' not sent. Total insurance ' + fmtMoney_(grandAmount) + '. Full list attached.',
      {
        htmlBody: html,
        name: SENDER.FROM_NAME,
        attachments: [Utilities.newBlob(csv.join('\n'), 'text/csv',
          (isTestLog ? 'TEST_' : '') + 'insurance_send_' + profile.key + '_' + stamp + '.csv')]
      });
    Logger.log('Run summary sent to %s', mailTo.join(', '));
  } catch (e) {
    Logger.log('Could not send the run summary: %s', e);
    throw e;   // the caller records this in the sheet log, not just here
  }
}

/**
 * The "not sent" section: Property Codes that were skipped for a reason someone
 * has to fix, plus any email Gmail refused. Settled units and other-model rows
 * are left out on purpose — those are excluded by design, not by a problem.
 */
function notSentBlock_(profile, problems, failedRows) {
  if (!problems.length && !failedRows.length) {
    return '<p style="margin-top:22px;color:#1E7B34;"><strong>Nothing was left out — ' +
           'every Property Code in scope was emailed.</strong></p>';
  }

  var rows = '';
  for (var f = 0; f < failedRows.length; f++) {
    var L = failedRows[f];
    rows += '<tr style="background:#FDECEC;">' +
      td_(esc_(L.codes)) + td_(esc_(L.buildings || '—')) + td_(esc_(L.to)) +
      td_('<strong style="color:#B00020;">' + esc_(L.status) + '</strong>') + '</tr>';
  }

  var shown = problems.slice(0, SENDER.SUMMARY_ROWS_IN_BODY);
  for (var i = 0; i < shown.length; i++) {
    var p = shown[i];
    rows += '<tr style="background:' + ((i % 2 === 0) ? '#FFFFFF' : '#FFF7E6') + ';">' +
      td_(esc_(p.code)) + td_(esc_(p.building || '—')) + td_(esc_(p.unit || '—')) +
      td_(esc_(p.reason)) + '</tr>';
  }

  var total = problems.length + failedRows.length;
  return '' +
    '<h3 style="margin-top:26px;margin-bottom:6px;color:#B00020;">Not sent — ' + total + ' item(s)</h3>' +
    '<p style="margin-top:0;font-size:13px;color:#555;">' +
      (problems.length > shown.length
        ? 'First ' + shown.length + ' of ' + problems.length + ' skipped Property Codes' +
          (failedRows.length ? ' plus ' + failedRows.length + ' failed send(s)' : '') + '. Everything is in the CSV.'
        : 'All of them are listed here and in the CSV.') +
    '</p>' +
    '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;text-align:left;font-size:13px;">' +
      '<thead><tr style="background:#B00020;color:#FFFFFF;">' +
        th_('Property Code') + th_('Building') + th_('Unit / Sent to') + th_('Reason') +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function failedRows_(ledger) {
  var out = [];
  for (var i = 0; i < ledger.length; i++) {
    if (ledger[i].status.indexOf('Failed') === 0) out.push(ledger[i]);
  }
  return out;
}

/**
 * Posts one message to the Slack Workflow Builder webhook.
 *
 * The URL lives in Script Properties, never in this file — it is a credential:
 * anyone holding it can post to the channel.
 * A workflow webhook expects the variables declared in its trigger, so the
 * payload is { "<SLACK_WEBHOOK_FIELD>": text }. If that name does not match the
 * workflow, Slack accepts the call but the post comes out empty — which is why
 * the response body is logged.
 */
function postSlackWebhook_(text) {
  var url;
  try {
    url = PropertiesService.getScriptProperties().getProperty(SENDER.SLACK_WEBHOOK_PROPERTY);
  } catch (e) {
    Logger.log('Could not read the Slack webhook property: %s', e);
    return;
  }
  if (!url) {
    Logger.log('No Slack webhook set. Add the URL in Project Settings > Script Properties under "%s".',
      SENDER.SLACK_WEBHOOK_PROPERTY);
    return;
  }

  var payload = {};
  payload[SENDER.SLACK_WEBHOOK_FIELD] = text;

  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) Logger.log('Posted to Slack (HTTP %s).', code);
    else Logger.log('Slack refused the post — HTTP %s: %s', code, res.getContentText());
  } catch (e) {
    // A notification must never break a run that already delivered emails.
    Logger.log('Could not reach the Slack webhook: %s', e);
  }
}

var SLACK_FEED_HEADER = [
  'Timestamp', 'Profile', 'Mode', 'Headline', 'Emails', 'Total Insurance',
  'Recipients', 'Units', 'Certificates', 'No Certificate', 'Settled',
  'Other Business Model', 'Not Sent', 'No Email', 'No PAYMENT_SOURCE', 'Message'
];

/**
 * Appends one row per run to the Slack feed tab. A Slack Workflow with the
 * Google Sheets trigger ("when a new row is added to a spreadsheet") picks it
 * up and posts to #insurance_control — no webhook and no bot token.
 *
 * Every figure is also a separate column, so the workflow can either post the
 * ready-made Message in one variable or compose its own layout.
 */
function writeSlackFeed_(profile, modeLabel, r, start) {
  if (r.isSoloTest && SENDER.SLACK_SKIP_SOLO_TEST) return;

  var when = Utilities.formatDate(start, Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');
  var what = r.isTest ? 'test (sent to the test list)'
           : r.dryRun ? 'preview (nothing sent)'
                      : 'send';
  var headline = profile.key + ' — ' + modeLabel + ' ' + what + '. ' + when;

  var message = [
    headline,
    '',
    '* ' + r.emails + ' email(s) ' + (r.dryRun ? 'would be sent' : 'sent') +
      (r.failed ? ' · ' + r.failed + ' FAILED' : ''),
    '* Total insurance charged: ' + fmtMoney_(r.totals.amount),
    '* ' + r.recipients + ' recipient address(es) · ' + r.totals.units + ' unit(s) · ' +
      r.totals.attachments + ' certificate(s) attached',
    '* ' + r.noCertUnits + ' unit(s) had no certificate — those emails did not mention an attachment',
    '* Excluded by design: ' + r.skip.settled + ' settled · ' + r.skip.otherModel +
      ' from the other Business Model',
    '* Not sent: ' + r.notSent + ' — ' + r.noEmailCodes + ' without an email address · ' +
      r.noPaymentSourceCodes + ' with no PAYMENT_SOURCE Data match'
  ].join('\n');

  postSlackWebhook_(message);

  if (!SENDER.SLACK_FEED_SHEET) return;
  try {
    var ss = SpreadsheetApp.openById(SENDER.SPREADSHEET_ID);
    var sh = ss.getSheetByName(SENDER.SLACK_FEED_SHEET);
    if (!sh) {
      sh = ss.insertSheet(SENDER.SLACK_FEED_SHEET);
      sh.getRange(1, 1, 1, SLACK_FEED_HEADER.length).setValues([SLACK_FEED_HEADER]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, SLACK_FEED_HEADER.length).setValues([SLACK_FEED_HEADER]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }

    sh.appendRow([
      start, profile.key, modeLabel + ' ' + what, headline,
      r.emails, r.totals.amount, r.recipients, r.totals.units, r.totals.attachments,
      r.noCertUnits, r.skip.settled, r.skip.otherModel,
      r.notSent, r.noEmailCodes, r.noPaymentSourceCodes, message
    ]);
    SpreadsheetApp.flush();
    Logger.log('Slack feed row added: %s', headline);
  } catch (e) {
    // Never let the notification break a run that already delivered emails.
    Logger.log('Could not write the Slack feed row: %s', e);
  }
}

function csvCell_(s) {
  return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
}


/* ====================== Triggers ====================== */

function installMonthlySenderTrigger_(profile, handler, hour) {
  var me = '';
  try { me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  if (me && me !== profile.mailbox.toLowerCase()) {
    throw new Error('Install this trigger inside ' + profile.mailbox + '. It is running as ' + me + '.');
  }

  var removed = removeInsuranceTriggers_(handler);
  ScriptApp.newTrigger(handler).timeBased().onMonthDay(1).atHour(hour).create();

  var msg = 'Trigger installed: ' + handler + ' on day 1 at ' + hour + ':00 (' +
            Session.getScriptTimeZone() + ')' + (removed ? ', ' + removed + ' old one(s) removed' : '') + '.';
  logRun_('installMonthlyTrigger' + profile.key, new Date(), 'OK', msg);
  Logger.log(msg);
}

function removeInsuranceTriggers_(handler) {
  var all = ScriptApp.getProjectTriggers(), n = 0;
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === handler) { ScriptApp.deleteTrigger(all[i]); n++; }
  }
  return n;
}


/* ====================== Log ====================== */

/**
 * Appends every Property Code that was really emailed to a building, one row
 * each: Property Code | Date Sent | Amount. Written in a single call so a run
 * of hundreds does not hammer the sheet.
 */
function logPropertyCodesSent_(rows) {
  if (!SENDER.PO_LOG_SHEET || !rows.length) return;
  try {
    var ss = SpreadsheetApp.openById(SENDER.SPREADSHEET_ID);
    var sh = ss.getSheetByName(SENDER.PO_LOG_SHEET);
    if (!sh) sh = ss.insertSheet(SENDER.PO_LOG_SHEET);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, SENDER.PO_LOG_HEADER.length)
        .setValues([SENDER.PO_LOG_HEADER]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    SpreadsheetApp.flush();
    Logger.log('%s Property Code(s) recorded in "%s".', rows.length, SENDER.PO_LOG_SHEET);
  } catch (e) {
    Logger.log('Could not write "%s": %s', SENDER.PO_LOG_SHEET, e);
  }
}

function logRun_(fnName, start, status, comment) {
  var dur = Math.round((new Date().getTime() - start.getTime()) / 10) / 100;
  var row = [fnName, start, status, dur, comment, ''];
  for (var i = 0; i < SENDER.LOG_TARGETS.length; i++) {
    var t = SENDER.LOG_TARGETS[i];
    try {
      var sh = SpreadsheetApp.openById(t.ID).getSheetByName(t.TAB);
      if (!sh) { Logger.log('Log tab "%s" not found.', t.TAB); continue; }
      if (sh.getLastRow() === 0) sh.appendRow(SENDER.LOG_HEADER);
      sh.appendRow(row);
    } catch (e) {
      Logger.log('Log write failed (%s): %s', t.TAB, e);
    }
  }
}


/* ====================== Helpers ====================== */

function headerIndex_(headerRow) {
  var m = {};
  for (var i = 0; i < headerRow.length; i++) {
    var k = String(headerRow[i]).replace(/[﻿]/g, '').replace(/[→⟶]/g, '->')
      .replace(/\s+/g, ' ').trim().toLowerCase();
    if (k && !(k in m)) m[k] = i;
  }
  return m;
}

/** Column by name: exact match first, then "contains". */
function pick_(H, candidates) {
  for (var i = 0; i < candidates.length; i++) if (candidates[i] in H) return H[candidates[i]];
  for (var j = 0; j < candidates.length; j++) {
    for (var k in H) if (H.hasOwnProperty(k) && k.indexOf(candidates[j]) !== -1) return H[k];
  }
  return -1;
}

function fileIdFromRich_(richValue) {
  if (!richValue) return '';
  var url = richValue.getLinkUrl();
  if (!url) {
    var runs = richValue.getRuns();
    for (var i = 0; i < runs.length; i++) { var u = runs[i].getLinkUrl(); if (u) { url = u; break; } }
  }
  return fileIdFromUrl_(url);
}

function hyperlinkUrl_(formula) {
  var m = String(formula || '').match(/HYPERLINK\(\s*"([^"]+)"/i);
  return m ? m[1] : '';
}

function fileIdFromUrl_(url) {
  if (!url) return '';
  var m = String(url).match(/\/d\/([A-Za-z0-9_-]{10,})/) || String(url).match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : '';
}

function normCode_(v) {
  var s = String(v == null ? '' : v).trim();
  if (/^#?N\/A$/i.test(s)) return '';
  return s.toUpperCase();
}

/**
 * One Email cell may carry several addresses separated by commas, semicolons,
 * newlines or spaces. Returns them lowercased, deduped and sorted — sorting is
 * what makes "a@x, b@x" and "b@x, a@x" group into a single email.
 */
function normEmails_(v) {
  var parts = String(v == null ? '' : v).toLowerCase().split(/[,;\s]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var e = parts[i].replace(/^[<(]+|[>)]+$/g, '').trim();
    if (!/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(e)) continue;
    if (out.indexOf(e) === -1) out.push(e);
  }
  return out.sort();
}

function normUnitKey_(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/\.0+$/, '').replace(/[^A-Z0-9]/g, '');
}

/** Four-digit units were auto-formatted as dates upstream; numbers arrive "2201.0". */
function aptToText_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return String(v.getFullYear());
  return String(v == null ? '' : v).trim().replace(/\.0+$/, '');
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function dateSortKey_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getTime();
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

/** Cell value -> Date, accepting a real Date or a Sheets serial (day 0 = 1899-12-30). */
function toDate_(v) {
  if (v === '' || v == null) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return v;
  var n = parseFloat(v);
  if (isNaN(n) || n <= 0) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
}

function fmtDate_(v, tz) {
  if (v === '' || v == null) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz || Session.getScriptTimeZone(), SENDER.DATE_FORMAT);
  }
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    var d = new Date(Date.UTC(1899, 11, 30) + Math.round(parseFloat(v)) * 86400000);
    return Utilities.formatDate(d, 'UTC', SENDER.DATE_FORMAT);
  }
  return String(v);
}

function fmtMoney_(n) {
  var v = toNumber_(n);
  var neg = v < 0;
  v = Math.abs(v).toFixed(2);
  var parts = v.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + SENDER.CURRENCY + parts.join('.');
}

function esc_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
