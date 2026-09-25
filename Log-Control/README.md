# Log Control

Sanitized shared logging utilities for Google Apps Script.

- `src/BlackBox.gs` consolidates today's compatible log rows into a single `BLACK BOX` tab and sorts them newest first.
- `src/StandardLogTemplate.gs` provides a reusable wrapper that writes `Function | Timestamp | Status | Duration (sec) | Comment`.

Configure `STANDARD_LOG_SPREADSHEET_ID` and optionally `STANDARD_LOG_SHEET_NAME` as Script Properties. Do not commit real spreadsheet IDs or credentials.
