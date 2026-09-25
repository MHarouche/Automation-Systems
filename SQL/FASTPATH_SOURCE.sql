WITH q AS (
  SELECT
      qt.QUOTENUMBER,
      qt.STATUS,
      a.NAME                                                   AS ACC_NAME,
      TRY_PARSE_JSON(qt.MAILING_ADDRESS__C):street::string     AS Q_STREET,
      TRY_PARSE_JSON(qt.MAILING_ADDRESS__C):city::string       AS Q_CITY,
      TRY_PARSE_JSON(qt.MAILING_ADDRESS__C):state::string      AS Q_STATE,
      TRY_PARSE_JSON(qt.MAILING_ADDRESS__C):zip::string        AS Q_ZIP,
      TRY_PARSE_JSON(qt.MAILING_ADDRESS__C):unit::string       AS Q_UNIT,
      REGEXP_SUBSTR(
        TRIM(TRY_PARSE_JSON(qt.MAILING_ADDRESS__C):street::string),
        '^[0-9-]+')                                            AS Q_NUM,
      qt.SOURCE_START_DATE__C                                      AS Q_START,
      qt.SOURCE_END_DATE__C                                        AS Q_END,
      qt.UNIT_CONTACT_EMAIL__C                                 AS Q_EMAIL,
      qt.UNIT_CONTACT_NAME__C                                  AS Q_CONTACT,
      qt.ACCEPTED_ON__C,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_RENT__C)                     AS RENT,
      TRY_TO_NUMBER(qt.SOURCE_SECURITY_DEPOSIT__C)                 AS DEPOSIT,
      TRY_TO_NUMBER(qt.SOURCE_ADMIN_FEE__C)                        AS ADMIN_FEE,
      TRY_TO_NUMBER(qt.SOURCE_APP_FEE__C)                          AS APP_FEE,
      TRY_TO_NUMBER(qt.SOURCE_CLEANING_FEE__C)                     AS CLEANING,
      TRY_TO_NUMBER(qt.SOURCE_PET_FEE__C)                          AS PET_ONETIME,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_PET_RENT__C)                 AS PET_MONTHLY,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_PARKING__C)                  AS PARKING,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_RENTERS_INSURANCE__C)        AS RENTERS_INS,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_PROP_TAX_AMOUNT__C)          AS PROP_TAX,
      TRY_TO_NUMBER(qt.SOURCE_MONTHLY_OTHER__C)                    AS MONTHLY_OTHER,
      qt.SOURCE_MONTHLY_OTHER_DESC__C                              AS MONTHLY_OTHER_DESC,
      TRY_TO_NUMBER(qt.SOURCE_PET_DEPOSIT__C)                      AS PET_DEPOSIT
  FROM ANALYTICS.SOURCE_CRM_TH.SOURCE_QUOTE_TH qt
  LEFT JOIN ANALYTICS.SOURCE_CRM_TH.SOURCE_ACCOUNT_TH a
    ON a.ID = qt.PROPERTY__C
  WHERE (qt.STATUS IN ('Accepted', 'needs_review')
         OR (qt.STATUS = 'background_pending' AND qt.ACCEPTED_ON__C IS NOT NULL))
    AND qt.ACCEPTED_ON__C >= DATEADD(day, -10, CURRENT_DATE())
),

pendentes AS (
  SELECT q.*
  FROM q
  WHERE q.Q_NUM IS NOT NULL
    AND q.Q_NUM <> ''
    AND q.Q_ZIP IS NOT NULL
)

SELECT
    Q_NUM || '|' || Q_ZIP                           AS "Address Key",
    IFF(LENGTH(TRIM(Q_STATE)) = 2,
        Q_NUM || '|' || UPPER(TRIM(Q_STATE)), NULL)   AS "Address Key 2",
    QUOTENUMBER                                     AS "Source Quote Number",
    STATUS                                          AS "Quote Status",
    ACC_NAME                                        AS "Property Name",
    Q_STREET                                        AS "Full Address",
    Q_UNIT                                          AS "Unit No",
    Q_CITY                                          AS "City",
    Q_STATE                                         AS "State",
    Q_START                                         AS "Lease Start",
    Q_END                                           AS "Lease End Date",
    RENT                                            AS "Monthly Rent",
    DEPOSIT                                         AS "Security Deposit",
    ADMIN_FEE                                       AS "Admin",
    APP_FEE                                         AS "Application",
    PET_MONTHLY                                     AS "Prop Pet Fee Monthly",
    PET_ONETIME                                     AS "Prop Pet Fee One-Time",
    CLEANING                                        AS "Prop Cleaning Fee",
    PARKING                                         AS "Parking Fee",
    RENTERS_INS                                     AS "Renters Insurance",
    PROP_TAX                                        AS "Prop Tax Amount",
    MONTHLY_OTHER                                   AS "Monthly Other",
    MONTHLY_OTHER_DESC                              AS "Monthly Other Desc",
    PET_DEPOSIT                                     AS "Pet Deposit",
    Q_EMAIL                                         AS "Email Contact",
    Q_CONTACT                                       AS "Contact Name",
    ACCEPTED_ON__C                                  AS "Accepted On"
FROM pendentes
QUALIFY ROW_NUMBER() OVER (
          PARTITION BY Q_NUM, Q_ZIP
          ORDER BY Q_START DESC, QUOTENUMBER DESC) = 1
ORDER BY "Accepted On" DESC;
