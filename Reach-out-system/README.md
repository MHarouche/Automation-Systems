# Reach-out System

A fully automated email reach-out system built on Google Apps Script. It
requests move-out documents and security deposit returns from property
managers/landlords with **no human action required** — emails go out a few days
after the relevant contract/move-out dates, driven entirely by business rules
maintained in spreadsheets.

> **Note:** this is a sanitized version of a production system. All spreadsheet
> IDs, email addresses, webhook URLs, company and team names were replaced with
> placeholders (`YOUR_..._ID`, `[Company]`, `team-inbox@example.com`, etc.).

Created by **Mari Harouche**.

## Architecture

```
Reach-out-system/
├── Department X/
│   └── src/Code.gs              # Department X sender (source spreadsheet flow)
└── Department Y/
    └── src/
        ├── 1-INITIAL/Code.gs    # Step 1 — Initial request emails
        ├── 2-FOLLOW-UP/Code.gs  # Step 2 — Follow-up emails (2nd, 3rd... attempts)
        └── 3-REMINDER/Code.gs   # Step 3 — Reminder emails
```

## Flows

### Department X

A single script attached to the source spreadsheet. Sends aggregated request
emails every 15 days, on Mondays, based on send flags maintained in the sheet.

**Biweekly scheduling trick:** Apps Script has no native biweekly trigger. The
trigger fires **weekly**, but a driver function checks the last successful run
timestamp stored in Script Properties — if fewer than ~13 days have passed
(threshold 11 to absorb trigger-time jitter), it skips and waits for the next
Monday that satisfies the rule.

### Department Y pipeline

Three scripts in the same Apps Script project, fed by an upstream automation
that adds eligible units into two tabs of the working spreadsheet.

1. **Initial (`1-INITIAL`)** — sent only once per unit, requesting move-out
   information and documents for newly added units. Runs weekly. A special
   building category gets a dedicated template.
2. **Follow-ups (`2-FOLLOW-UP`)** — for units with a deposit still to be
   returned and no reply to the Initial email after 15+ days. Uses the same
   biweekly driver pattern as Department X. Same template as the Initial, with
   "Follow-up" and the attempt number (2nd, 3rd...) in the subject, computed
   from the send log.
3. **Reminder (`3-REMINDER`)** — focused email for units with no deposit-return
   information for 30+ days, asking whether the deposit was returned, when, and
   through which payment method. Uses a 3-week gated driver (weekly trigger +
   19-day gate), the same pattern as the biweekly flows.

## Engineering highlights

- **Per-recipient aggregation:** rows are grouped by recipient so each contact
  receives a single email with an HTML table of all their units.
- **Idempotent sends:** confirmation columns are marked after each successful
  send, so a unit is never emailed twice by the same step.
- **Send log as state:** every send is appended to a log tab (unit key, tab,
  date, email type), which also powers the follow-up attempt counter.
- **Observability:** every execution is appended to a central log spreadsheet
  (function, timestamp, OK/REVIEW/ERROR status, duration, comment), plus a
  summary email to maintainers and a Slack webhook notification on success.
- **Resilient column lookup:** columns are resolved by header name (normalized
  or exact-match where precision matters), so the scripts survive column
  reordering in the spreadsheets.
- **Shared-scope discipline:** steps 1 and 2 live in the same Apps Script
  project and share helper functions defined once in the Step 1 file, avoiding
  the cross-file duplicate-definition override pitfall.

## Setup

1. Create the Apps Script projects bound to your spreadsheets and paste the
   `Code.gs` files.
2. Replace the placeholders (`YOUR_SOURCE_SPREADSHEET_ID`,
   `YOUR_CENTRAL_LOG_SPREADSHEET_ID`, `YOUR_SLACK_WEBHOOK_URL`, emails and
   `[Company]` strings).
3. Run the `installMonday...Trigger()` functions once to install the weekly
   triggers, and the `record...RunNow()` helpers to seed the biweekly drivers.
