# Tax Reduction System

Sanitized Google Apps Script reference implementation for reconciling tax/insurance charge data and sending grouped outreach with supporting documents.

## Files

| File | Responsibility |
| --- | --- |
| `src/OutreachSender.gs` | Preview, dry-run, send, and logging workflow for grouped recipient outreach. |
| `src/ContactDataImport.gs` | Refreshes contact datasets used to resolve recipients. |
| `src/PaymentDataImport.gs` | Imports the payment-source reference table. |
| `src/DataAudit.gs` | Audits and repairs document metadata, reconciles units, and reports exceptions. |

## Attribution and scope

The upstream document-ingestion step was developed by a third-party contributor and is not included in this repository. This project begins with the normalized files and metadata made available to the Apps Script workflow.

## Sanitization

Production spreadsheet IDs, folder IDs, people, company names, mailboxes, partner details, webhooks, and test records were replaced with neutral placeholders. Configure `YOUR_...` values and Script Properties before use. Keep real credentials and webhook URLs out of source control.
