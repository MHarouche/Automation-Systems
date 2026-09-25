-- ============================================================================
-- DATA FRESHNESS BY BI PLATFORM QUESTION NUMBER
--
-- Type a question number, get the load time of every table behind it.
--
-- data warehouse does not know BI platform question numbers, so the mapping below is
-- maintained by hand. It is a one-time, one-line-per-table job per question,
-- and after that anyone can check a question by number alone.
--
-- TO CHECK A QUESTION:  edit the last WHERE clause.        <<< EDIT
-- TO ADD A QUESTION:    add rows to the VALUES list.       <<< EDIT
-- ============================================================================

WITH QUESTIONS AS (
  SELECT * FROM VALUES
    -- (question number, name, FULL table path: DATABASE.SCHEMA.TABLE)
    -- One row per source table. Repeat the number for each table.
    (10001, 'Automated Reach-Out intro emails', 'ANALYTICS.SOURCE_CRM_TH.SOURCE_QUOTE_TH'),
    (10001, 'Automated Reach-Out intro emails', 'ANALYTICS.SOURCE_CRM_TH.SOURCE_ACCOUNT_TH'),
    (10001, 'Automated Reach-Out intro emails', 'YOUR_DATABASE.OPERATIONS.BOOKINGS'),
    (10001, 'Automated Reach-Out intro emails', 'YOUR_DATABASE.OPERATIONS.PROPERTIES')
    -- , (12345, 'Your question here', 'YOUR_DATABASE.YOUR_SCHEMA.YOUR_TABLE')   <<< ADD HERE
  AS q(QUESTION, LABEL, FULL_TABLE)
)
SELECT q.QUESTION,
       q.LABEL,
       q.FULL_TABLE                                               AS SOURCE_TABLE,
       t.ROW_COUNT                                                AS ROWS_,
       t.LAST_ALTERED                                             AS LAST_LOAD,
       DATEDIFF(hour, t.LAST_ALTERED, CURRENT_TIMESTAMP())        AS HOURS_AGO,
       CASE WHEN t.LAST_ALTERED IS NULL THEN 'NOT FOUND - check the name'
            WHEN DATEDIFF(hour, t.LAST_ALTERED, CURRENT_TIMESTAMP()) <= 3  THEN 'just loaded'
            WHEN DATEDIFF(hour, t.LAST_ALTERED, CURRENT_TIMESTAMP()) <= 26 THEN 'loaded today'
            WHEN DATEDIFF(hour, t.LAST_ALTERED, CURRENT_TIMESTAMP()) <= 72 THEN 'up to 3 days old'
            ELSE 'STALE - over 3 days' END                        AS STATUS
FROM QUESTIONS q
LEFT JOIN YOUR_DATABASE.INFORMATION_SCHEMA.TABLES t
       ON t.TABLE_SCHEMA = SPLIT_PART(q.FULL_TABLE, '.', 2)
      AND t.TABLE_NAME   = SPLIT_PART(q.FULL_TABLE, '.', 3)
WHERE q.QUESTION = 10001                                          -- <<< EDIT
ORDER BY HOURS_AGO DESC NULLS FIRST;


-- ============================================================================
-- FINDING THE TABLES BEHIND A QUESTION (one-time, per question)
--
--   Native SQL question: open it and read the FROM and JOIN lines.
--   GUI question:        open it, then the SQL / "View the SQL" option, and
--                        read the FROM and JOIN lines there.
--
-- Copy each DATABASE.SCHEMA.TABLE into the VALUES list above. Ignore CTE names
-- (the aliases defined in the query's own WITH block) - they are not tables.
-- A table that is misspelled or that you cannot see comes back as
-- 'NOT FOUND - check the name' rather than silently disappearing.
-- ============================================================================


-- ============================================================================
-- WHY THE MAPPING IS MANUAL
--
-- A question number only exists inside BI platform's own application database.
-- BI platform does stamp it into the SQL comment it sends to data warehouse, but
-- reading that requires DATA_WAREHOUSE.ACCOUNT_USAGE.QUERY_HISTORY, which read-only
-- roles here are not granted (verified 2026-09-07: "Schema
-- 'DATA_WAREHOUSE.ACCOUNT_USAGE' does not exist or not authorized").
--
-- YOUR_DATABASE.INFORMATION_SCHEMA.QUERY_HISTORY() is readable but returns only the
-- calling role's own queries, never BI platform's service user, and it is slow
-- enough to time out past a few dozen rows. It is not a substitute.
--
-- If someone with A_ROLE_WISOURCE_QUERY_HISTORY_ACCESS grants SELECT on ACCOUNT_USAGE.QUERY_HISTORY,
-- the mapping can be derived automatically and this file can be replaced.
-- ============================================================================


-- ============================================================================
-- WHAT LAST_LOAD DOES AND DOES NOT MEAN
--
-- It is when the pipeline last wrote to the table. It is NOT proof that the
-- data is current: a table can be rebuilt hourly and still sit days behind the
-- source system. YOUR_DATABASE.OPERATIONS.BOOKINGS is exactly that case.
--
-- To measure the real gap, check a business date inside the table - see
-- DATA_WAREHOUSE_DATA_FRESHNESS_TEMPLATE.sql, Block 4.
--
-- Also: re-running a question more often than its sources load changes nothing.
-- The answer only moves when the data moves.
-- ============================================================================
