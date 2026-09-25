const BLACK_BOX_CONFIG = {
  OUTPUT_SHEET_NAME: "BLACK BOX",
  TEMPLATE_SHEET_NAME: "Template",
  TRIGGER_FUNCTION: "syncBlackBoxLogsTodayOnly",
  // Headers read from each source tab.
  SOURCE_HEADERS: ["Function", "Timestamp", "Status", "Duration (sec)", "Comment"],
  // Derived header: it is populated with the source tab name.
  TAB_NAME_HEADER: "Tab Name"
};

function syncBlackBoxLogsTodayOnly() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const outputSheet = ss.getSheetByName(BLACK_BOX_CONFIG.OUTPUT_SHEET_NAME);
    if (!outputSheet) throw new Error('Sheet not found: "BLACK BOX"');

    const tz = Session.getScriptTimeZone();
    const todayKey = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

    // Read the actual BLACK BOX headers so columns are matched by name,
    // regardless of their position (including "Tab Name").
    const outputWidth = Math.max(
      outputSheet.getLastColumn(),
      BLACK_BOX_CONFIG.SOURCE_HEADERS.length
    );
    const outputHeaders = outputSheet
      .getRange(1, 1, 1, outputWidth)
      .getValues()[0]
      .map(normalizeBlackBoxHeader_);

    // Timestamp is required because it is used as the sort key.
    const tsHeaderNorm = normalizeBlackBoxHeader_("Timestamp");
    if (outputHeaders.indexOf(tsHeaderNorm) < 0) {
      throw new Error('BLACK BOX must have a "Timestamp" column.');
    }

    const tabNameNorm = normalizeBlackBoxHeader_(BLACK_BOX_CONFIG.TAB_NAME_HEADER);
    const tabNameCol = outputHeaders.indexOf(tabNameNorm); // -1 when absent

    const collected = []; // { row: [...], date: Date }

    ss.getSheets().forEach(sheet => {
      const sheetName = sheet.getName();

      if (sheetName === BLACK_BOX_CONFIG.OUTPUT_SHEET_NAME) return;
      if (sheetName === BLACK_BOX_CONFIG.TEMPLATE_SHEET_NAME) return;

      const lastRow = sheet.getLastRow();
      const lastCol = sheet.getLastColumn();
      if (lastRow < 2 || lastCol < 1) return;

      const sourceHeaders = sheet
        .getRange(1, 1, 1, lastCol)
        .getValues()[0]
        .map(normalizeBlackBoxHeader_);

      const timestampIdx = sourceHeaders.indexOf(tsHeaderNorm);
      if (timestampIdx < 0) return;

      const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
      const displays = sheet.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();

      for (let i = 0; i < values.length; i++) {
        const rowDate = parseBlackBoxDate_(values[i][timestampIdx], displays[i][timestampIdx]);
        if (!rowDate) continue;

        const rowKey = Utilities.formatDate(rowDate, tz, "yyyy-MM-dd");
        if (rowKey !== todayKey) continue;

        // Build the output row in the exact order of the BLACK BOX headers.
        const outputRow = outputHeaders.map((headerNorm, c) => {
          if (!headerNorm) return "";
          if (c === tabNameCol) return sheetName;
          const srcIdx = sourceHeaders.indexOf(headerNorm);
          return srcIdx >= 0 ? values[i][srcIdx] : "";
        });

        // Ignore rows where only "Tab Name" would contain a value.
        const hasData = outputRow.some((cell, c) =>
          c !== tabNameCol && String(cell || "").trim() !== ""
        );
        if (!hasData) continue;

        collected.push({ row: outputRow, date: rowDate });
      }
    });

    // Newest entries first (Timestamp descending).
    collected.sort((a, b) => b.date.getTime() - a.date.getTime());

    // Clear previous content below the header across the full output width.
    const prevLastRow = outputSheet.getLastRow();
    if (prevLastRow > 1) {
      outputSheet.getRange(2, 1, prevLastRow - 1, outputWidth).clearContent();
    }

    // Write the sorted rows starting at row 2.
    if (collected.length > 0) {
      const rows = collected.map(item => item.row);
      outputSheet.getRange(2, 1, rows.length, outputWidth).setValues(rows);
    }

  } finally {
    lock.releaseLock();
  }
}

function parseBlackBoxDate_(value, displayValue) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;

  const s = String(displayValue || value || "").trim();
  if (!s) return null;

  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;

  // MM/DD/YYYY HH:mm:ss or M/D/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    return new Date(
      Number(m[3]),
      Number(m[1]) - 1,
      Number(m[2]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
  }

  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  return null;
}

function normalizeBlackBoxHeader_(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u00A0/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function installBlackBoxFiveMinuteTrigger() {
  deleteBlackBoxTrigger_();

  ScriptApp.newTrigger(BLACK_BOX_CONFIG.TRIGGER_FUNCTION)
    .timeBased()
    .everyMinutes(5)
    .create();
}

function deleteBlackBoxTrigger_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === BLACK_BOX_CONFIG.TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
