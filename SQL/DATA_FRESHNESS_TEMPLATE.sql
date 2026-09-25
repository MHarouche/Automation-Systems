-- ============================================================================
-- DATA FRESHNESS AND SOURCE DISCOVERY — generic template
--
-- Answers three questions about any data warehouse schema, without knowing anything
-- about it in advance:
--
--   1. What tables are in it, and when was each one last written?
--   2. Which of them carry a load timestamp, and what is that column called?
--   3. How often does a given table actually load?
--
-- Run the blocks in order. Each block is independent.
--
-- EDIT ONLY the lines marked  <<< EDIT.  No session variables are used, so this
-- works in Snowsight, DBeaver, a JDBC client, or anything else.
--
-- Written for the US Department Y Automated Reach-Out email automation, where the question was
-- "how often does the data behind this BI platform question change". Nothing in it
-- is specific to that use case.
-- ============================================================================


-- ============================================================================
-- BLOCK 1 — What is in the schema, and how fresh is each table?
--
-- LAST_ALTERED is the most portable freshness signal there is: every table has
-- it, no matter how the pipeline is built. Start here.
-- ============================================================================

SELECT TABLE_SCHEMA,
       TABLE_NAME,
       TABLE_TYPE,
       ROW_COUNT,
       ROUND(BYTES / POWER(1024, 3), 2)                          AS SIZE_GB,
       LAST_ALTERED                                              AS LAST_WRITE,
       DATEDIFF(hour, LAST_ALTERED, CURRENT_TIMESTAMP())         AS HOURS_SINCE_WRITE,
       CASE
         WHEN DATEDIFF(hour, LAST_ALTERED, CURRENT_TIMESTAMP()) <= 2  THEN 'fresh'
         WHEN DATEDIFF(hour, LAST_ALTERED, CURRENT_TIMESTAMP()) <= 26 THEN 'within a day'
         WHEN DATEDIFF(hour, LAST_ALTERED, CURRENT_TIMESTAMP()) <= 24 * 7 THEN 'within a week'
         ELSE 'STALE - over a week'
       END                                                       AS FRESHNESS
FROM YOUR_DATABASE.INFORMATION_SCHEMA.TABLES                         -- <<< EDIT database
WHERE TABLE_SCHEMA = 'SOURCE_CRM_TH'                         -- <<< EDIT schema
ORDER BY LAST_ALTERED DESC;


-- ============================================================================
-- BLOCK 2 — Which tables carry a load timestamp, and what is it called?
--
-- The name is never consistent. Seen in this warehouse alone:
--   DWH_LOADED_TS_UTC        SOURCE_CRM_TH.*, DATAMART.BOOKING
--   DWH_LOADED_UTC           SEMANTIC.SMT_PROPERTY
--   _DMS_INGESTION_TIMESTAMP SOURCE_TH.* (AWS DMS pipelines)
--   DATE_PART                partition column on some staging tables
--
-- Run this before Block 3 to find out which column to use.
--
-- The patterns are deliberately wide, so expect a few false positives from
-- business fields that merely contain the word - SYNCEDQUOTEID, NS_SYNCED_AT__C,
-- PI__NEEDS_SCORE_SYNCED__C all turn up in this warehouse. The pipeline column
-- is the one present on EVERY table in the schema; here that is
-- DWH_LOADED_TS_UTC, alongside DATE_PART as the partition column.
-- ============================================================================

SELECT TABLE_NAME,
       COLUMN_NAME,
       DATA_TYPE
FROM YOUR_DATABASE.INFORMATION_SCHEMA.COLUMNS                        -- <<< EDIT database
WHERE TABLE_SCHEMA = 'SOURCE_CRM_TH'                         -- <<< EDIT schema
  AND (COLUMN_NAME ILIKE '%DWH_LOADED%'
    OR COLUMN_NAME ILIKE '%INGESTION%'
    OR COLUMN_NAME ILIKE '%_LOADED%'
    OR COLUMN_NAME ILIKE '%LOAD_TS%'
    OR COLUMN_NAME ILIKE '%SYNCED%'
    OR COLUMN_NAME ILIKE '%ETL%'
    OR COLUMN_NAME = 'DATE_PART')
ORDER BY TABLE_NAME, COLUMN_NAME;


-- ============================================================================
-- BLOCK 3 — How often does one table load?
--
-- One row per day, counting distinct load timestamps. LOADS_THAT_DAY = 1 every
-- day means a daily pipeline; 24 means hourly.
--
-- READ THE CAVEAT BELOW before drawing a conclusion.
-- ============================================================================

SELECT DWH_LOADED_TS_UTC::date                    AS LOAD_DAY,   -- <<< EDIT column (x3)
       COUNT(DISTINCT DWH_LOADED_TS_UTC)          AS LOADS_THAT_DAY,
       MIN(DWH_LOADED_TS_UTC)::string             AS FIRST_LOAD_UTC,
       MAX(DWH_LOADED_TS_UTC)::string             AS LAST_LOAD_UTC,
       COUNT(*)                                   AS ROWS_WRITTEN
FROM ANALYTICS.SOURCE_CRM_TH.SOURCE_QUOTE_TH                    -- <<< EDIT table
WHERE DWH_LOADED_TS_UTC >= DATEADD(day, -14, CURRENT_TIMESTAMP())
GROUP BY 1
ORDER BY 1 DESC;

-- CAVEAT — full rebuild versus incremental
--
--   INCREMENTAL table: only the rows that changed get a new timestamp, so this
--   block shows real history. A day with no rows may mean "loaded, nothing
--   changed" rather than "did not load" - absence is not proof.
--
--   FULL REBUILD table: every row is rewritten on every load, so all rows carry
--   the SAME timestamp and this block returns exactly ONE day. That does not
--   mean it loaded once; it means the history was overwritten. Use Block 1's
--   LAST_ALTERED for those, and Block 4 to measure how far behind they are.
--
--   Tell them apart by ROWS_WRITTEN: if it equals the table's full ROW_COUNT
--   from Block 1, it is a full rebuild.


-- ============================================================================
-- BLOCK 4 — How far behind reality is the table?
--
-- The load timestamp says when the pipeline ran. It does NOT say whether the
-- data is current. A table can be rebuilt every hour and still be three days
-- behind the source system.
--
-- This is usually the number that actually matters. Point it at the business
-- date that should be moving daily.
-- ============================================================================

SELECT MAX(CONFIRMED_DATE)::string                              AS NEWEST_BUSINESS_DATE, -- <<< EDIT column (x3)
       DATEDIFF(day, MAX(CONFIRMED_DATE), CURRENT_DATE())       AS DAYS_BEHIND,
       COUNT(DISTINCT CONFIRMED_DATE)                           AS DISTINCT_DAYS_PRESENT,
       COUNT(*)                                                 AS ROWS_IN_WINDOW
FROM YOUR_DATABASE.OPERATIONS.BOOKINGS                                 -- <<< EDIT table
WHERE CONFIRMED_DATE >= DATEADD(day, -14, CURRENT_DATE());      -- <<< EDIT column


-- ============================================================================
-- BLOCK 5 — Daily volume, to tell a real gap from a quiet day
--
-- A missing day in Block 3 or 4 is only a problem if that day should have had
-- data. Weekends are usually quiet. This block shows the shape.
-- ============================================================================

SELECT CONFIRMED_DATE::string                                   AS BUSINESS_DAY, -- <<< EDIT column (x2)
       DAYNAME(CONFIRMED_DATE)                                  AS WEEKDAY,
       COUNT(*)                                                 AS ROWS_,
       DATEDIFF(day, CONFIRMED_DATE, CURRENT_DATE())            AS DAYS_AGO
FROM YOUR_DATABASE.OPERATIONS.BOOKINGS                                 -- <<< EDIT table
WHERE CONFIRMED_DATE >= DATEADD(day, -14, CURRENT_DATE())       -- <<< EDIT column
GROUP BY 1, 2, 4
ORDER BY 1 DESC;


-- ============================================================================
-- WHAT THIS TEMPLATE CANNOT TELL YOU
--
-- How often a BI platform question RUNS. That lives in BI platform's own application
-- database, not in data warehouse. Two things follow:
--
--   - Running a question more often than its sources load changes nothing. The
--     answer only moves when the data moves, and Block 3 is what measures that.
--
--   - Seeing the actual query executions would need
--     DATA_WAREHOUSE.ACCOUNT_USAGE.QUERY_HISTORY, which most read-only roles cannot
--     reach. YOUR_DATABASE.INFORMATION_SCHEMA.QUERY_HISTORY() shows only the
--     calling role's own queries, so it will look almost empty and is not a
--     substitute.
-- ============================================================================
