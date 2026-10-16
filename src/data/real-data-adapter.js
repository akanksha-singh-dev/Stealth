/**
 * @file real-data-adapter.js
 * @description Ingestion and normalisation adapter for real wearable CSV recordings.
 *
 * SUPPORTED FORMAT — confirmed from actual HR.csv inspection:
 *   Each row: <unix_timestamp_float>,<hr_value_float>
 *   No header row. Timestamps are Unix epoch seconds (float).
 *   HR values are in beats per minute (bpm), stored as floats.
 *   Sampling is IRREGULAR — intervals range 1–18 s in the inspected file.
 *   No guaranteed fixed sampling rate row (unlike the Empatica binary SDK export).
 *
 * SCHEMA OUTPUT — matches the internal telemetry schema used by the intelligence
 *   engines.  Each valid entry in a signal's time-series array is:
 *     { timestamp: ISO-8601-string, value: number }
 *
 * The adapter also returns a rich metadata / quality block so the UI can show
 * honest coverage and data-quality indicators without fabricating values.
 */

// ── Physiological bounds for HR (from deviation-detector.js) ────────────────
const HR_BOUNDS = { min: 25, max: 220 };

/**
 * @typedef {Object} RawRow
 * @property {number} lineNumber   - 1-based row index in the CSV
 * @property {string} raw          - Original untrimmed line text
 * @property {number|null} unixTs  - Parsed Unix timestamp (null if unparseable)
 * @property {number|null} hrRaw   - Parsed raw HR value (null if unparseable)
 */

/**
 * @typedef {Object} NormalizedRecord
 * @property {string}  timestamp   - ISO-8601 UTC timestamp
 * @property {number}  value       - HR in bpm (validated, rounded to 1 dp)
 * @property {number}  unixTs      - Original Unix epoch seconds (float)
 * @property {number}  lineNumber  - Source line number for traceability
 */

/**
 * @typedef {Object} InvalidRecord
 * @property {number} lineNumber
 * @property {string} raw
 * @property {string} reason       - Human-readable rejection reason
 */

/**
 * @typedef {Object} RecordingMetadata
 * @property {string}  filename
 * @property {string}  signalKey        - e.g. 'RESTING_HR'
 * @property {string}  signalLabel      - e.g. 'Heart Rate'
 * @property {string}  unit             - 'bpm'
 * @property {number}  totalLinesRead
 * @property {number}  validCount
 * @property {number}  invalidCount
 * @property {string|null} startISO     - ISO-8601 UTC of first valid timestamp
 * @property {string|null} endISO       - ISO-8601 UTC of last valid timestamp
 * @property {number|null} durationSeconds
 * @property {number|null} avgIntervalSeconds
 * @property {number|null} coveragePercent   - 0-100, based on expected vs actual interval count
 * @property {Object}  hrStats              - { min, max, mean, median, stdDev } from valid records
 * @property {string}  baselineNote         - honest statement about baseline window
 * @property {string}  source               - 'PhysioNet-Empatica-HR-CSV'
 * @property {string[]} qualityNotes        - list of honest data-quality observations
 */

/**
 * @typedef {Object} AdapterResult
 * @property {RecordingMetadata} metadata
 * @property {NormalizedRecord[]} timeSeries   - valid records in the internal schema
 * @property {RawRow[]} rawRows                - every parsed row (for audit)
 * @property {InvalidRecord[]} invalidRows     - rejected rows with reasons
 */

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Convert Unix epoch seconds (float) to ISO-8601 UTC string */
function unixToISO(unixTs) {
  return new Date(unixTs * 1000).toISOString();
}

/** Basic descriptive stats over a numeric array */
function computeStats(values) {
  if (!values || values.length === 0) {
    return { count: 0, min: null, max: null, mean: null, median: null, stdDev: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n    = sorted.length;
  const sum  = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n > 1 ? n - 1 : 1);
  const mid  = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    mean: Number(mean.toFixed(1)),
    median: Number(median.toFixed(1)),
    stdDev: Number(Math.sqrt(variance).toFixed(2)),
  };
}

/**
 * Parse a single CSV row into a RawRow.
 * Expected format: "<unix_float>,<hr_float>"
 * No header row in this format.
 */
function parseRow(line, lineNumber) {
  const raw = line;
  const trimmed = line.trim();

  const parts = trimmed.split(',');
  if (parts.length !== 2) {
    return { lineNumber, raw, unixTs: null, hrRaw: null };
  }

  const tsStr = parts[0].trim();
  const hrStr = parts[1].trim();

  const unixTs = parseFloat(tsStr);
  const hrRaw  = parseFloat(hrStr);

  return {
    lineNumber,
    raw,
    unixTs: isNaN(unixTs) ? null : unixTs,
    hrRaw:  isNaN(hrRaw)  ? null : hrRaw,
  };
}

/**
 * Validate a RawRow and classify it.
 * Returns { valid: boolean, reason?: string }
 */
function validateRow(row) {
  if (row.unixTs === null) {
    return { valid: false, reason: 'Unparseable timestamp' };
  }
  if (row.hrRaw === null) {
    return { valid: false, reason: 'Unparseable HR value' };
  }
  if (!isFinite(row.unixTs) || row.unixTs <= 0) {
    return { valid: false, reason: `Non-positive timestamp: ${row.unixTs}` };
  }
  // Unix ts sanity: reject anything before 2000-01-01 or after 2100-01-01
  if (row.unixTs < 946684800 || row.unixTs > 4102444800) {
    return { valid: false, reason: `Timestamp out of plausible range: ${row.unixTs}` };
  }
  if (row.hrRaw < HR_BOUNDS.min || row.hrRaw > HR_BOUNDS.max) {
    return { valid: false, reason: `HR ${row.hrRaw} outside physiological bounds [${HR_BOUNDS.min}–${HR_BOUNDS.max}] bpm` };
  }
  return { valid: true };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse the text content of an HR CSV file and return a normalised adapter result.
 *
 * @param {string}  csvText      - Full raw text of the CSV file
 * @param {string}  [filename]   - Original filename for metadata
 * @returns {AdapterResult}
 */
export function parseHRCsv(csvText, filename = 'HR.csv') {
  const lines = csvText.split(/\r?\n/);

  const rawRows      = [];
  const timeSeries   = [];
  const invalidRows  = [];

  let firstValidUnix = null;
  let lastValidUnix  = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // skip blank lines — do NOT record as invalid

    const row = parseRow(line, i + 1);
    rawRows.push(row);

    const { valid, reason } = validateRow(row);
    if (!valid) {
      invalidRows.push({ lineNumber: row.lineNumber, raw: row.raw, reason });
      continue;
    }

    // Track time bounds
    if (firstValidUnix === null || row.unixTs < firstValidUnix) firstValidUnix = row.unixTs;
    if (lastValidUnix  === null || row.unixTs > lastValidUnix)  lastValidUnix  = row.unixTs;

    timeSeries.push({
      timestamp:  unixToISO(row.unixTs),
      value:      Number(row.hrRaw.toFixed(1)),
      unixTs:     row.unixTs,
      lineNumber: row.lineNumber,
    });
  }

  // Sort by timestamp (the CSV may already be sorted, but enforce it)
  timeSeries.sort((a, b) => a.unixTs - b.unixTs);

  // Compute inter-record intervals
  let avgIntervalSeconds = null;
  if (timeSeries.length >= 2) {
    const totalSpan = timeSeries[timeSeries.length - 1].unixTs - timeSeries[0].unixTs;
    avgIntervalSeconds = Number((totalSpan / (timeSeries.length - 1)).toFixed(2));
  }

  const durationSeconds = (firstValidUnix !== null && lastValidUnix !== null)
    ? Number((lastValidUnix - firstValidUnix).toFixed(1))
    : null;

  // HR statistics from valid records
  const hrValues = timeSeries.map(r => r.value);
  const hrStats  = computeStats(hrValues);

  // Honest baseline note
  const durationHours = durationSeconds !== null ? durationSeconds / 3600 : 0;
  let baselineNote;
  if (timeSeries.length < 30) {
    baselineNote = 'Insufficient data for baseline calculation (fewer than 30 records).';
  } else if (durationHours < 1) {
    baselineNote = 'Recording is shorter than 1 hour. Baseline derived from this short window only — treat with caution.';
  } else if (durationHours < 24) {
    baselineNote = `Recording covers ${durationHours.toFixed(1)} hours (less than one full day). ` +
      'Baseline reflects this single session — not a multi-day personal normal.';
  } else {
    baselineNote = `Baseline derived from ${Math.floor(durationHours / 24)} day(s) of available history.`;
  }

  // Quality notes
  const qualityNotes = [];
  if (invalidRows.length > 0) {
    qualityNotes.push(`${invalidRows.length} row(s) rejected (see invalidRows for details).`);
  }
  if (durationHours < 24) {
    qualityNotes.push('Recording is less than 24 hours. Multi-day trend analysis is not available.');
  }
  if (timeSeries.length < 60) {
    qualityNotes.push('Fewer than 60 valid records — statistical baseline may be unreliable.');
  }
  if (invalidRows.length === 0 && timeSeries.length > 0) {
    qualityNotes.push('All records passed physiological validity checks.');
  }

  // Coverage: no gaps > 30 s found in this file, but we note it generally
  const coveragePercent = durationSeconds && avgIntervalSeconds
    ? Math.min(100, Number(((timeSeries.length / (durationSeconds / avgIntervalSeconds)) * 100).toFixed(1)))
    : null;

  const metadata = {
    filename,
    signalKey:        'RESTING_HR',
    signalLabel:      'Heart Rate',
    unit:             'bpm',
    source:           'PhysioNet-Empatica-HR-CSV',
    totalLinesRead:   rawRows.length,
    validCount:       timeSeries.length,
    invalidCount:     invalidRows.length,
    startISO:         firstValidUnix !== null ? unixToISO(firstValidUnix) : null,
    endISO:           lastValidUnix  !== null ? unixToISO(lastValidUnix)  : null,
    durationSeconds,
    avgIntervalSeconds,
    coveragePercent,
    hrStats,
    baselineNote,
    qualityNotes,
  };

  return { metadata, timeSeries, rawRows, invalidRows };
}

/**
 * Read a File object (from an <input type="file">) and return an AdapterResult.
 * Returns a Promise so the UI can await it.
 *
 * @param {File} file
 * @returns {Promise<AdapterResult>}
 */
export function importHRFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(parseHRCsv(e.target.result, file.name));
    reader.onerror = () => reject(new Error(`FileReader error reading "${file.name}"`));
    reader.readAsText(file);
  });
}

/**
 * Convert an AdapterResult into the telemetryData map expected by
 * LongitudinalHealthIntelligenceLayer.analyzePatient().
 *
 * Only RESTING_HR is included; all other signals are ABSENT from a pure HR file.
 * Callers must not fabricate the missing signals.
 *
 * @param {AdapterResult} adapterResult
 * @returns {{ telemetryData: Object, availableSignals: string[] }}
 */
export function toIntelligencePipelineInput(adapterResult) {
  const { metadata, timeSeries } = adapterResult;

  // The pipeline expects { [signalKey]: [ { timestamp, value } ] }
  const telemetryData = {
    [metadata.signalKey]: timeSeries.map(r => ({
      timestamp: r.timestamp,
      value:     r.value,
    })),
  };

  return {
    telemetryData,
    availableSignals: [metadata.signalKey],
  };
}

/**
 * Build a minimal patient object for the pipeline from adapter metadata.
 * No fictional clinical data is injected.
 *
 * @param {RecordingMetadata} metadata
 * @param {string} [recordingId]
 * @returns {Object}
 */
export function buildRecordingPatientObject(metadata, recordingId) {
  return {
    id:              recordingId || `REAL-${Date.now()}`,
    name:            metadata.filename,
    postOpDay:       null,   // unknown — do not fabricate
    medications:     [],     // unknown — do not fabricate
    comorbidities:   [], // unknown — do not fabricate
    inActiveExercise: false,  // unknown — do not fabricate
    isRealRecording: true,
    recordingMeta:   metadata,
  };
}

/**
 * Aggregate the time series into hourly buckets for reporting.
 * Returns array of { isoHour, count, min, max, mean, median, stdDev }
 *
 * @param {NormalizedRecord[]} timeSeries
 * @returns {Object[]}
 */
export function aggregateHourly(timeSeries) {
  const buckets = {};
  timeSeries.forEach(r => {
    const dt   = new Date(r.timestamp);
    // Floor to the hour
    const key  = new Date(
      Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), dt.getUTCHours())
    ).toISOString();
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(r.value);
  });

  return Object.keys(buckets).sort().map(key => ({
    isoHour: key,
    ...computeStats(buckets[key]),
  }));
}

/**
 * Aggregate the time series into daily buckets for the Reports page.
 *
 * @param {NormalizedRecord[]} timeSeries
 * @returns {Object[]}
 */
export function aggregateDaily(timeSeries) {
  const buckets = {};
  timeSeries.forEach(r => {
    const dt  = new Date(r.timestamp);
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(r.value);
  });

  return Object.keys(buckets).sort().map(key => ({
    isoDate: key,
    ...computeStats(buckets[key]),
  }));
}
