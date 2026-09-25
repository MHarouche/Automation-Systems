WITH bk AS (
  SELECT DISTINCT PROPERTY_CODE, BOOKING_CODE, CHECKIN_DATE, CHECKOUT_DATE
  FROM YOUR_DATABASE.OPERATIONS.BOOKINGS
  WHERE SALES_ALLOCATION = 'DEPARTMENT_Y'
    AND PROPERTY_CODE ILIKE '%A'
    AND BOOKING_STATUS = 'finalized'
    AND CONFIRMED_DATE >= DATEADD(day, -30, CURRENT_DATE())
),

acc AS (
  SELECT UPPER(TRIM(BUILDING_NAME)) AS P_ACC,
         TRIM(ADDRESS_POSTCODE)     AS P_ZIP,
         COUNT(DISTINCT PROPERTY_CODE) AS N_PROPS
  FROM YOUR_DATABASE.OPERATIONS.PROPERTIES
  WHERE BUILDING_NAME IS NOT NULL
  GROUP BY 1, 2
),

pr AS (
  SELECT bk.PROPERTY_CODE AS PO, bk.BOOKING_CODE AS BC,
         bk.CHECKIN_DATE  AS CIN, bk.CHECKOUT_DATE AS COUT,
         p.ADDRESS_FULL, p.ADDRESS_APT, p.ADDRESS_STATE,
         p.EXTERNAL_PROVIDER, p.FRONTDESK_EMAIL,
         COALESCE(NULLIF(TRIM(p.BUILDING_NAME), ''), p.PROPERTY_NAME) AS PNAME,
         UPPER(TRIM(p.BUILDING_NAME))  AS P_ACC,
         TRIM(p.ADDRESS_POSTCODE)      AS P_ZIP,
         REGEXP_REPLACE(UPPER(COALESCE(p.ADDRESS_APT, '')), '[^A-Z0-9]', '') AS P_UNIT,
         COALESCE(acc.N_PROPS, 1)      AS N_PROPS
  FROM bk
  JOIN YOUR_DATABASE.OPERATIONS.PROPERTIES p
    ON p.PROPERTY_CODE = bk.PROPERTY_CODE
  LEFT JOIN acc
    ON acc.P_ACC = UPPER(TRIM(p.BUILDING_NAME))
   AND acc.P_ZIP = TRIM(p.ADDRESS_POSTCODE)
),

q AS (
  SELECT
      qt.QUOTENUMBER,
      qt.STATUS,
      qt.SOURCE_START_DATE__C                       AS Q_START,
      qt.SOURCE_END_DATE__C                         AS Q_END,
      qt.UNIT_CONTACT_EMAIL__C                  AS Q_EMAIL,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_RENT__C)      AS RENT,
      TRY_TO_NUMBER(qt.SOURCE_SECURITY_DEPOSIT__C)  AS DEPOSIT,
      TRY_TO_NUMBER(qt.SOURCE_CLEANING_FEE__C)      AS CLEANING,
      TRY_TO_NUMBER(qt.SOURCE_ADMIN_FEE__C)         AS ADMIN_FEE,
      TRY_TO_NUMBER(qt.SOURCE_APP_FEE__C)           AS APP_FEE,
      TRY_TO_NUMBER(qt.SOURCE_PET_FEE__C)           AS PET_ONETIME,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_PET_RENT__C)  AS PET_MONTHLY,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_PARKING__C)   AS PARKING,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_RENTERS_INSURANCE__C) AS RENTERS_INS,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_PROP_TAX_AMOUNT__C)   AS PROP_TAX,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_OTHER__C)             AS MONTHLY_OTHER,
      qt.SOURCE_MONTHLY_OTHER_DESC__C                       AS MONTHLY_OTHER_DESC,
      TRY_TO_NUMBER(qt.SOURCE_PET_DEPOSIT__C)               AS PET_DEPOSIT,
      UPPER(TRIM(a.NAME))                       AS ACC_NAME,
      TRIM(a.BILLINGPOSTALCODE)                 AS ACC_ZIP,
      REGEXP_REPLACE(
        UPPER(COALESCE(TRY_PARSE_JSON(qt.MAILING_ADDRESS__C):unit::string, '')),
        '[^A-Z0-9]', '')                        AS Q_UNIT
  FROM ANALYTICS.SOURCE_CRM_TH.SOURCE_QUOTE_TH qt
  JOIN ANALYTICS.SOURCE_CRM_TH.SOURCE_ACCOUNT_TH a
    ON a.ID = qt.PROPERTY__C
  WHERE (qt.STATUS IN ('Accepted', 'needs_review')
         OR (qt.STATUS = 'background_pending' AND qt.ACCEPTED_ON__C IS NOT NULL))
),

cand AS (
  SELECT pr.*,
         q.QUOTENUMBER, q.STATUS, q.Q_START, q.Q_END, q.Q_EMAIL,
         q.RENT, q.DEPOSIT, q.CLEANING, q.ADMIN_FEE, q.APP_FEE,
         q.PET_ONETIME, q.PET_MONTHLY, q.PARKING,
         q.RENTERS_INS, q.PROP_TAX, q.MONTHLY_OTHER, q.MONTHLY_OTHER_DESC,
         q.PET_DEPOSIT,
         CASE
           WHEN pr.P_UNIT <> ''
                AND q.Q_UNIT NOT IN ('TBD','NA','MULTI','VARIOUS','NONE','HOUSE','SFH','')
                AND q.Q_UNIT = pr.P_UNIT
             THEN 1
           WHEN pr.N_PROPS = 1
                AND pr.P_UNIT = ''
                AND q.Q_UNIT IN ('TBD','NA','MULTI','VARIOUS','NONE','HOUSE','SFH','')
             THEN 3
           WHEN pr.N_PROPS = 1
             THEN 4
           ELSE 9
         END AS TIER
  FROM pr
  JOIN q
    ON q.ACC_NAME = pr.P_ACC
   AND q.ACC_ZIP  = pr.P_ZIP
  WHERE q.Q_START <= DATEADD(day, 2, pr.CIN)
    AND COALESCE(q.Q_END, pr.CIN) >= pr.CIN
),

pick AS (
  SELECT * FROM cand
  WHERE TIER < 9
  QUALIFY ROW_NUMBER() OVER (
            PARTITION BY PO, BC
            ORDER BY TIER,
                     Q_START DESC,
                     IFF(STATUS = 'Accepted', 0, 1),
                     QUOTENUMBER DESC) = 1
),

j AS (
  SELECT pr.PO, pr.BC, pr.CIN, pr.COUT,
         pr.ADDRESS_FULL, pr.ADDRESS_APT, pr.ADDRESS_STATE,
         pr.EXTERNAL_PROVIDER, pr.FRONTDESK_EMAIL, pr.PNAME,
         k.QUOTENUMBER, k.Q_START, k.Q_EMAIL,
         k.RENT, k.DEPOSIT, k.CLEANING, k.ADMIN_FEE, k.APP_FEE,
         k.PET_ONETIME, k.PET_MONTHLY, k.PARKING,
         k.RENTERS_INS, k.PROP_TAX, k.MONTHLY_OTHER, k.MONTHLY_OTHER_DESC,
         k.PET_DEPOSIT,
         COUNT(k.QUOTENUMBER) OVER (PARTITION BY k.QUOTENUMBER) AS NPOS
  FROM pr
  LEFT JOIN pick k
    ON k.PO = pr.PO AND k.BC = pr.BC
)

SELECT
    PO                                              AS "Reference Code",
    BC                                              AS "Record Code",
    IFF(NPOS > 1, NULL, QUOTENUMBER)                AS "Source Quote Number",
    ADDRESS_FULL                                    AS "Full Address",
    ADDRESS_APT                                     AS "Unit No",
    PNAME                                           AS "Property Name",
    EXTERNAL_PROVIDER                               AS "External Provider",
    COALESCE(IFF(NPOS > 1, NULL, Q_START), CIN)     AS "Lease Start",
    COUT                                            AS "Lease End Date",
    IFF(NPOS > 1, NULL, RENT)                       AS "Monthly Rent",
    IFF(NPOS > 1, NULL, DEPOSIT)                    AS "Security Deposit",
    IFF(NPOS > 1, NULL, ADMIN_FEE)                  AS "Admin",
    IFF(NPOS > 1, NULL, APP_FEE)                    AS "Application",
    IFF(NPOS > 1, NULL, PET_MONTHLY)                AS "Prop Pet Fee Monthly",
    IFF(NPOS > 1, NULL, PET_ONETIME)                AS "Prop Pet Fee One-Time",
    IFF(NPOS > 1, NULL, CLEANING)                   AS "Prop Cleaning Fee",
    IFF(NPOS > 1, NULL, PARKING)                    AS "Parking Fee",
    IFF(NPOS > 1, NULL, RENTERS_INS)                AS "Renters Insurance",
    IFF(NPOS > 1, NULL, PROP_TAX)                   AS "Prop Tax Amount",
    IFF(NPOS > 1, NULL, MONTHLY_OTHER)              AS "Monthly Other",
    IFF(NPOS > 1, NULL, MONTHLY_OTHER_DESC)         AS "Monthly Other Desc",
    IFF(NPOS > 1, NULL, PET_DEPOSIT)                AS "Pet Deposit",
    COALESCE(NULLIF(TRIM(Q_EMAIL), ''), FRONTDESK_EMAIL) AS "Email Contact",
    ADDRESS_STATE                                   AS "State"
FROM j
ORDER BY 1;
