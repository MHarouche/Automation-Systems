# Contract Renew System

Sanitized Google Apps Script automation for contract-renewal follow-ups.

`src/FollowUpAutomation.gs` loads eligible records, finds the original email conversations, groups units, applies cadence and reply/bounce safeguards, sends follow-ups in the existing threads, and maintains preview, control, and execution logs.

## Safety controls

- Dry-run and sample-email modes before production sends.
- Kill switch, send ledger, minimum interval, maximum attempts, and per-run cap.
- Script lock and thread-state checks to reduce duplicate or inappropriate outreach.
- Placeholder spreadsheet IDs, aliases, domains, recipients, and test data.

Replace all `YOUR_...` values and configure secrets through Apps Script Properties before use.
