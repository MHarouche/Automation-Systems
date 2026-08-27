# Intake Email Integration

Sanitized Google Apps Script reference implementation maintained by **Mari Harouche**.

This project demonstrates an event-driven email workflow without including any production identifiers, organization-specific terminology, real contacts, credentials, channels, webhooks or internal URLs.

## Flow

1. A qualifying record notification is read from a chat channel.
2. The record is added to `Pending Queue`.
3. `Delivery History` and the Sent mailbox are checked to prevent duplicates.
4. The process waits for a unique record in `Source Data` and uses `Reference Properties` for routing.
5. A General, Private Owner or Partner template is generated and sent.
6. The result is recorded, the responsible operations owner is labeled, and the original chat thread receives a confirmation.

Issues and pending conditions are written to `Warnings`, including a human-readable automation comment.

## Source files

| File | Purpose |
| --- | --- |
| `src/EmailTemplates.gs` | Email templates, compact financial table, partner matching and manual samples. |
| `src/NotificationPipeline.gs` | Channel capture, queue processing, duplicate protection, sending, tracking, labels, warnings and thread replies. |
| `src/SourceDataImport.gs` | Imports the newest exact-subject source CSV from email. |
| `src/ReferenceDataImport.gs` | Combines unique attachments from the newest reference-data export. |
| `src/appsscript.json` | V8 runtime and time-zone configuration. |

## Required placeholders

Replace every `YOUR_...` placeholder before use. Store all tokens and webhook URLs in Apps Script Properties; never hardcode secrets.

Required properties:

- `SLACK_BOT_TOKEN`
- `SOURCE_THREAD_WEBHOOK_URL`
- `TEST_NOTIF_WEBHOOK_URL`

The example is published with `PIPELINE.LIVE = false`.

## Safety

- Test recipients use `example.com` addresses.
- Source IDs, account IDs and channel IDs are placeholders.
- The repository contains no webhook URL or OAuth token.
- Internal organization names and workflow labels were replaced with generic terminology.
