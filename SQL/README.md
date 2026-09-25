# SQL

Sanitized warehouse-query examples used for freshness monitoring and source reconciliation.

| File | Purpose |
| --- | --- |
| `LOADS_PER_DAY.sql` | Discovers load timestamp columns and counts loads by day. |
| `FRESHNESS_BY_REPORT.sql` | Maps a BI report to source tables and reports freshness. |
| `DATA_FRESHNESS_TEMPLATE.sql` | Generic source discovery and freshness template. |
| `FASTPATH_SOURCE.sql` | Builds a recent accepted-record fast path. |
| `REPLACEMENT_SOURCE.sql` | Demonstrates a multi-source replacement dataset. |

Database, schema, table, report, role, and business identifiers were replaced with `YOUR_...` or generic example names. Review all assumptions before running the queries.
