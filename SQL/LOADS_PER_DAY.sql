-- ============================================================================
-- HOW MANY TIMES DID A TABLE LOAD TODAY?
--
-- The one-line freshness query cannot answer this. INFORMATION_SCHEMA.TABLES
-- stores a single LAST_ALTERED value per table - the most recent write. There
-- is no history of previous writes in it, so there is nothing to count.
--
-- Counting loads means reading the load timestamp stored INSIDE the table, and
-- that column is named differently everywhere. Step 1 finds the name for you,
-- Step 2 does the counting.
--
-- READ STEP 3 BEFORE TRUSTING THE NUMBER. For roughly half the tables here the
-- count is always 1, and that does not mean it loaded once.
-- ============================================================================


-- ============================================================================
-- STEP 1 - Find the load-timestamp column for your table
--
-- Edit the table list. Everything else stays.
-- ============================================================================

SELECT TABLE_SCHEMA || '.' || TABLE_NAME AS TABLE_,
       COLUMN_NAME,
       DATA_TYPE
FROM YOUR_DATABASE.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('SOURCE_QUOTE_TH', 'SMT_PROPERTY', 'BOOKING')   -- <<< YOUR TABLES HERE
  AND DATA_TYPE ILIKE '%TIMESTAMP%'
  AND (COLUMN_NAME ILIKE '%LOADED%'
    OR COLUMN_NAME ILIKE '%INGESTION%'
    OR COLUMN_NAME ILIKE '%LOAD_TS%')
ORDER BY 1, 2;

-- What this warehouse uses, measured 2026-09-07:
--   DWH_LOADED_TS_UTC         SOURCE_CRM_TH.*, DATAMART.*
--   DWH_LOADED_UTC            SEMANTIC.*
--   _DMS_INGESTION_TIMESTAMP  SOURCE_TH.*  (AWS DMS pipelines)
--
-- Expect the occasional business field to slip through the filter - on
-- SMT_PROPERTY it also returns LAUNCHOPS_PHOTOS_UPLOADED_TS, which is a photo
-- upload date, not a pipeline column. The pipeline one is the column that
-- appears on every table in the schema.


-- ============================================================================
-- STEP 2 - Count the loads, last 3 days
--
-- One block per table. To add a table: copy a block, paste it after a
-- UNION ALL, and change the three names marked below to match. The column name
-- appears 5 times inside a block - change all of them.
-- ============================================================================

SELECT 'SOURCE_QUOTE_TH'                                             AS TABLE_,          -- <<< label
       DWH_LOADED_TS_UTC::date                                    AS LOAD_DAY,        -- <<< load column
       COUNT(DISTINCT DWH_LOADED_TS_UTC)                          AS LOADS_THAT_DAY,
       COUNT(*)                                                   AS ROWS_CHANGED,
       LISTAGG(DISTINCT TO_CHAR(DWH_LOADED_TS_UTC, 'HH24:MI'), ', ') AS TIMES_UTC
FROM ANALYTICS.SOURCE_CRM_TH.SOURCE_QUOTE_TH                                         -- <<< table
WHERE DWH_LOADED_TS_UTC >= DATEADD(day, -3, CURRENT_DATE())
GROUP BY 1, 2

UNION ALL

SELECT 'SOURCE_ACCOUNT_TH',
       DWH_LOADED_TS_UTC::date,
       COUNT(DISTINCT DWH_LOADED_TS_UTC),
       COUNT(*),
       LISTAGG(DISTINCT TO_CHAR(DWH_LOADED_TS_UTC, 'HH24:MI'), ', ')
FROM ANALYTICS.SOURCE_CRM_TH.SOURCE_ACCOUNT_TH
WHERE DWH_LOADED_TS_UTC >= DATEADD(day, -3, CURRENT_DATE())
GROUP BY 1, 2

ORDER BY 1, 2 DESC;


-- ============================================================================
-- STEP 3 - THE CATCH: incremental versus full rebuild
--
-- Measured on the four tables behind the Automated Reach-Out feed, 2026-09-07:
--
--   TABLE                             DISTINCT LOAD TIMESTAMPS IN THE WHOLE TABLE
--   SOURCE_CRM_TH.SOURCE_QUOTE_TH    586      <- real history, countable
--   SOURCE_CRM_TH.SOURCE_ACCOUNT_TH   48      <- real history, countable
--   DATAMART.BOOKING                    1      <- rebuilt whole, NOT countable
--   SEMANTIC.SMT_PROPERTY               1      <- rebuilt whole, NOT countable
--
-- INCREMENTAL (many distinct timestamps): only changed rows get a new
-- timestamp, so Step 2 shows genuine history. But a day with no rows means
-- "loaded, nothing changed" just as often as "did not load" - SOURCE_QUOTE_TH has
-- no rows at all for 2026-09-06 and the pipeline certainly ran. Absence is not
-- proof.
--
-- FULL REBUILD (exactly 1 distinct timestamp): every row is rewritten on every
-- load, so all rows carry the same timestamp and the previous ones are gone.
-- Step 2 returns 1, always. That is the history being overwritten, not the
-- load count. For these, LAST_ALTERED is the only signal available.
--
-- Tell them apart with this - run it once per table:
--
--   SELECT COUNT(DISTINCT DWH_LOADED_TS_UTC) FROM YOUR_DATABASE.YOUR_SCHEMA.YOUR_TABLE;
--
-- 1 means full rebuild and Step 2 will not work on it.
--
-- Recovering the load count for a full-rebuild table would mean sampling the
-- table through Time Travel hour by hour, which is limited by the retention
-- window and is not worth it for a routine check.
-- ============================================================================
