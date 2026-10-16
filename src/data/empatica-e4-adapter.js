/**
 * @file empatica-e4-adapter.js
 * @description Multi-signal adapter for Empatica E4 standard CSV exports.
 *
 * ── VERIFIED FILE FORMAT (from PhysioNet wearable-exam-stress/1.0.0, S1/Final) ──
 *   Row 1: <unix_start_timestamp_float>    e.g. 1544027347.000000
 *   Row 2: <sample_rate_Hz_float>          e.g. 1.000000  (or 64.0 for BVP)
 *   Row 3+: <signal_value_float>           one value per row
 *
 * Timestamps are generated as:
 *   t(i) = startUnix + i * (1 / sampleRateHz)   where i = 0, 1, 2 ...
 *
 * ── DATASET SOURCE ────────────────────────────────────────────────────────────
 *   "A Wearable Exam Stress Dataset for Predicting Cognitive Performance"
 *   Amin, Wickramasuriya, Faghih -- PhysioNet, 2022
 *   DOI: 10.13026/kvkb-aj90
 *   Licence: Open Data Commons Attribution License v1.0 (no login required)
 *   URL: https://physionet.org/content/wearable-exam-stress/1.0.0/
 *
 * ── DATASET LIMITATIONS (disclosed in UI and every generated report) ───────────
 *   - Each session is 1.5-3 hours, NOT multi-day continuous monitoring.
 *   - Multi-day rehabilitation baselines CANNOT be computed from this data.
 *   - Dates are de-identified (date-shifted); time-of-day is preserved.
 *   - ROM, gait, steps, SpO2, pain score are NOT present in this dataset.
 *   - EDA is recorded but NOT mapped to any intelligence-layer signal.
 *   - Temperature < 25 C are sensor warm-up artefacts and are excluded.
 *
 * ── SIGNAL MAPPING ────────────────────────────────────────────────────────────
 *   HR.csv   -> RESTING_HR   (bpm,  1 Hz)
 *   TEMP.csv -> TEMPERATURE  (Celsius, 4 Hz, downsampled to per-minute medians)
 *   IBI.csv  -> HRV          (ms, irregular -- one record per heartbeat)
 *
 * ── FILE NAMING CONVENTIONS SUPPORTED ─────────────────────────────────────────
 *   Plain export:    HR.csv, TEMP.csv, IBI.csv
 *   Dataset style:   S1_Final_HR.csv, S1_Final_TEMP.csv, S1_Final_IBI.csv
 *   parseE4FilenameMetadata() auto-detects which convention is used.
 *
 * ── REUSABILITY ───────────────────────────────────────────────────────────────
 *   Compatible with any Empatica E4 export in standard 3-row-header format.
 *   See exam-stress-catalogue.js for the session registry and future-dataset
 *   extension pattern.
 */

const SIGNAL_BOUNDS = {
  RESTING_HR:  { min: 25,   max: 220,  unit: 'bpm' },
  // Empatica E4 records WRIST SKIN temperature, not core body temp.
  // Values below 25 C are sensor warm-up artifacts (device not yet on wrist).
  // Valid wrist skin range: 25.0 - 40.0 C during normal use.
  TEMPERATURE: { min: 25.0, max: 40.0, unit: 'degC' },
  HRV:         { min: 100,  max: 2000, unit: 'ms'  }, // physiological IBI 100-2000ms
};

function computeStats(values) {
  if (!values || values.length === 0)
    return { count: 0, min: null, max: null, mean: null, median: null, stdDev: null };
  const sorted = [...values].sort((a, b) => a - b);
  const n      = sorted.length;
  const sum    = sorted.reduce((a, b) => a + b, 0);
  const mean   = sum / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  const mid    = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    count:  n,
    min:    sorted[0],
    max:    sorted[n - 1],
    mean:   Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    stdDev: Number(Math.sqrt(variance).toFixed(3)),
  };
}

function unixToISO(unix) {
  return new Date(unix * 1000).toISOString();
}

function _emptyMeta(filename, signalKey) {
  return {
    filename, signalKey,
    signalLabel: _signalLabel(signalKey),
    unit: SIGNAL_BOUNDS[signalKey]?.unit || '',
    source: 'PhysioNet-WearableExamStress-E4',
    totalLinesRead: 0, validCount: 0, invalidCount: 0,
    startISO: null, endISO: null, durationSeconds: null,
    avgIntervalSeconds: null, coveragePercent: 0,
    stats: { count: 0, min: null, max: null, mean: null, median: null, stdDev: null },
    baselineNote: 'No data available.', qualityNotes: [],
  };
}

function _signalLabel(key) {
  return {
    RESTING_HR:  'Heart Rate',
    // Note: Empatica E4 measures wrist skin temperature (not core body temp)
    TEMPERATURE: 'Wrist Skin Temp',
    HRV:         'HRV (IBI)',
  }[key] || key;
}

// ── CSV format detection ─────────────────────────────────────────────────────
/**
 * Detect which CSV format a signal file uses.
 *
 * Format A — Empatica E4 three-row-header:
 *   Line 1: unix start timestamp (float, no comma)
 *   Line 2: sample rate Hz      (float, no comma)
 *   Line 3+: one value per line (float, no comma)
 *
 * Format B — timestamp,value pairs (plain sensor export):
 *   Every line: <unix_ts_float>,<value_float>
 *
 * @param {string} csvText
 * @returns {'e4-header' | 'timestamp-value' | 'unknown'}
 */
export function detectCsvFormat(csvText) {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  if (lines.length < 2) return 'unknown';

  // Check if the first two non-empty lines are plain floats (no comma) → E4 header format
  const l1HasComma = lines[0].includes(',');
  const l2HasComma = lines[1].includes(',');

  if (!l1HasComma && !l2HasComma) {
    const startTs = parseFloat(lines[0]);
    const hz      = parseFloat(lines[1]);
    if (
      !isNaN(startTs) && startTs > 946684800 && startTs < 4102444800 &&
      !isNaN(hz)      && hz > 0              && hz < 10000
    ) {
      return 'e4-header';
    }
  }

  // Check if most lines look like "timestamp,value"
  const sample = lines.slice(0, Math.min(10, lines.length));
  const tsValMatches = sample.filter(l => {
    const parts = l.split(',');
    if (parts.length < 2) return false;
    const ts  = parseFloat(parts[0]);
    const val = parseFloat(parts[1]);
    return !isNaN(ts) && ts > 946684800 && ts < 4102444800 && !isNaN(val);
  });
  if (tsValMatches.length >= Math.ceil(sample.length * 0.7)) return 'timestamp-value';

  return 'unknown';
}

// ── timestamp,value parser (plain sensor export) ──────────────────────────────
/**
 * Parse a CSV where every row is "unix_timestamp_float,value_float".
 * Used for plain sensor exports that lack the Empatica E4 three-row header.
 *
 * @param {string} csvText
 * @param {string} signalKey  - 'RESTING_HR' | 'TEMPERATURE' | 'HRV'
 * @param {string} filename
 */
export function parseTimestampValueCsv(csvText, signalKey, filename) {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  const bounds = SIGNAL_BOUNDS[signalKey] || { min: -Infinity, max: Infinity, unit: '' };

  const timeSeries  = [];
  const rawRows     = [];
  const invalidRows = [];

  // Skip an optional header row (if first line doesn't parse as numbers)
  let startIdx = 0;
  const firstParts = lines[0]?.split(',') || [];
  if (firstParts.length >= 2 && isNaN(parseFloat(firstParts[0]))) {
    startIdx = 1; // skip text header
  }

  lines.slice(startIdx).forEach((line, idx) => {
    const lineNumber = idx + 1 + startIdx;
    const parts = line.split(',');
    if (parts.length < 2) {
      rawRows.push({ lineNumber, raw: line, unixTs: null, valueRaw: null });
      invalidRows.push({ lineNumber, raw: line, reason: 'Expected 2 columns (timestamp, value)' });
      return;
    }
    const unixTs = parseFloat(parts[0]);
    const value  = parseFloat(parts[1]);

    rawRows.push({ lineNumber, raw: line, unixTs: isNaN(unixTs) ? null : unixTs, valueRaw: isNaN(value) ? null : value });

    if (isNaN(unixTs) || unixTs < 946684800 || unixTs > 4102444800) {
      invalidRows.push({ lineNumber, raw: line, reason: `Invalid timestamp: ${parts[0]}` });
      return;
    }
    if (isNaN(value) || !isFinite(value)) {
      invalidRows.push({ lineNumber, raw: line, reason: 'Unparseable or non-finite value' });
      return;
    }
    if (value < bounds.min || value > bounds.max) {
      invalidRows.push({ lineNumber, raw: line, reason: `${value} outside bounds [${bounds.min}-${bounds.max}] ${bounds.unit}` });
      return;
    }
    timeSeries.push({ timestamp: unixToISO(unixTs), value: Number(value.toFixed(2)), unixTs, lineNumber });
  });

  const values = timeSeries.map(r => r.value);
  const stats  = computeStats(values);
  const first  = timeSeries[0]?.unixTs ?? null;
  const last   = timeSeries[timeSeries.length - 1]?.unixTs ?? null;
  const durSec = first && last ? Number((last - first).toFixed(1)) : null;
  const durH   = durSec ? durSec / 3600 : 0;

  const baselineNote = timeSeries.length < 30
    ? 'Insufficient data for baseline (fewer than 30 valid records).'
    : `Baseline from a ${durH.toFixed(1)}-hour recording (${new Date(first * 1000).toLocaleDateString('en-US', { timeZone: 'UTC' })} UTC). Timestamp-value format import.`;

  return {
    timeSeries,
    rawRows,
    invalidRows,
    metadata: {
      filename, signalKey,
      signalLabel: _signalLabel(signalKey),
      unit: bounds.unit,
      source: 'User-Imported CSV (timestamp-value format)',
      startUnix: first, sampleHz: null, intervalSec: null,
      totalLinesRead: rawRows.length,
      validCount:     timeSeries.length,
      invalidCount:   invalidRows.length,
      startISO: first ? unixToISO(first) : null,
      endISO:   last  ? unixToISO(last)  : null,
      durationSeconds:   durSec,
      avgIntervalSeconds: rawRows.length > 1
        ? Number(((last - first) / (rawRows.length - 1)).toFixed(4))
        : null,
      coveragePercent: rawRows.length > 0
        ? Math.min(100, Number(((timeSeries.length / rawRows.length) * 100).toFixed(1)))
        : 0,
      stats, baselineNote,
      qualityNotes: [
        'Imported from timestamp-value format CSV (not Empatica E4 header format).',
        ...(invalidRows.length > 0 ? [`${invalidRows.length} row(s) rejected.`] : ['All records passed validity checks.']),
        ...(durH < 24 ? ['Recording < 24 h — multi-day trend analysis unavailable.'] : []),
      ],
    },
  };
}

// ── Core single-file parser ───────────────────────────────────────────────────
export function parseEmpaticaSignalCsv(csvText, signalKey, filename) {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');

  if (lines.length < 3) {
    return {
      timeSeries: [], rawRows: [],
      invalidRows: [{ lineNumber: 1, raw: csvText.slice(0, 40), reason: 'File has fewer than 3 lines' }],
      metadata: _emptyMeta(filename, signalKey),
    };
  }

  const startUnix = parseFloat(lines[0]);
  const sampleHz  = parseFloat(lines[1]);

  if (isNaN(startUnix) || startUnix < 946684800 || startUnix > 4102444800) {
    return {
      timeSeries: [], rawRows: [],
      invalidRows: [{ lineNumber: 1, raw: lines[0], reason: `Invalid start timestamp: ${lines[0]}` }],
      metadata: _emptyMeta(filename, signalKey),
    };
  }

  if (isNaN(sampleHz) || sampleHz <= 0 || sampleHz > 10000) {
    return {
      timeSeries: [], rawRows: [],
      invalidRows: [{ lineNumber: 2, raw: lines[1], reason: `Invalid sample rate: ${lines[1]}` }],
      metadata: _emptyMeta(filename, signalKey),
    };
  }

  const intervalSec = 1 / sampleHz;
  const bounds = SIGNAL_BOUNDS[signalKey] || { min: -Infinity, max: Infinity, unit: '' };

  const timeSeries  = [];
  const rawRows     = [];
  const invalidRows = [];

  lines.slice(2).forEach((line, idx) => {
    const lineNumber = idx + 3;
    const value  = parseFloat(line);
    const unixTs = startUnix + idx * intervalSec;
    rawRows.push({ lineNumber, raw: line, unixTs, valueRaw: isNaN(value) ? null : value });

    if (isNaN(value) || !isFinite(value)) {
      invalidRows.push({ lineNumber, raw: line, reason: 'Unparseable or non-finite value' });
      return;
    }
    if (value < bounds.min || value > bounds.max) {
      invalidRows.push({ lineNumber, raw: line, reason: `${value} outside bounds [${bounds.min}-${bounds.max}] ${bounds.unit}` });
      return;
    }
    timeSeries.push({ timestamp: unixToISO(unixTs), value: Number(value.toFixed(2)), unixTs, lineNumber });
  });

  const values = timeSeries.map(r => r.value);
  const stats  = computeStats(values);
  const first  = timeSeries[0]?.unixTs ?? null;
  const last   = timeSeries[timeSeries.length - 1]?.unixTs ?? null;
  const durSec = first && last ? Number((last - first).toFixed(1)) : null;
  const durH   = durSec ? durSec / 3600 : 0;

  const baselineNote = timeSeries.length < 30
    ? 'Insufficient data for baseline (fewer than 30 valid records).'
    : `Baseline from a ${durH.toFixed(1)}-hour exam session (${new Date(startUnix * 1000).toLocaleDateString('en-US', { timeZone: 'UTC' })} UTC). Single-session baseline — not a multi-day personal normal.`;

  return {
    timeSeries,
    rawRows,
    invalidRows,
    metadata: {
      filename, signalKey,
      signalLabel: _signalLabel(signalKey),
      unit: bounds.unit,
      source: 'PhysioNet-WearableExamStress-E4',
      startUnix, sampleHz, intervalSec,
      totalLinesRead: rawRows.length,
      validCount:     timeSeries.length,
      invalidCount:   invalidRows.length,
      startISO: first ? unixToISO(first) : null,
      endISO:   last  ? unixToISO(last)  : null,
      durationSeconds:   durSec,
      avgIntervalSeconds: Number(intervalSec.toFixed(4)),
      coveragePercent: rawRows.length > 0
        ? Math.min(100, Number(((timeSeries.length / rawRows.length) * 100).toFixed(1)))
        : 0,
      stats, baselineNote,
      qualityNotes: [
        ...(invalidRows.length > 0 ? [`${invalidRows.length} row(s) rejected.`] : ['All records passed validity checks.']),
        ...(durH < 24 ? ['Session < 24 h — multi-day trend analysis unavailable.'] : []),
      ],
    },
  };
}

// ── IBI parser (irregular per-beat format) ───────────────────────────────────
export function parseEmpaticaIbiCsv(csvText, filename) {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  if (lines.length < 2)
    return { timeSeries: [], rawRows: [], invalidRows: [], metadata: _emptyMeta(filename, 'HRV') };

  // IBI header row 1 can be either:
  //   "1544027337.000000"          (timestamp only)
  //   "1544027337.000000, IBI"     (timestamp + literal "IBI" label)
  const startUnix = parseFloat(lines[0].split(',')[0]);
  if (isNaN(startUnix) || startUnix < 946684800) {
    return {
      timeSeries: [], rawRows: [],
      invalidRows: [{ lineNumber: 1, raw: lines[0], reason: `Invalid start timestamp: ${lines[0]}` }],
      metadata: _emptyMeta(filename, 'HRV'),
    };
  }

  const bounds = SIGNAL_BOUNDS['HRV'];
  const timeSeries = [], rawRows = [], invalidRows = [];

  lines.slice(1).forEach((line, idx) => {
    const lineNumber = idx + 2;
    const parts = line.split(',');
    if (parts.length < 2) {
      rawRows.push({ lineNumber, raw: line, unixTs: null, valueRaw: null });
      invalidRows.push({ lineNumber, raw: line, reason: 'Expected 2 columns (relTime, ibi)' });
      return;
    }
    const relSec = parseFloat(parts[0]);
    const ibiSec = parseFloat(parts[1]);
    const ibiMs  = ibiSec * 1000;
    const unixTs = startUnix + relSec;
    rawRows.push({ lineNumber, raw: line, unixTs, valueRaw: ibiMs });

    if (isNaN(relSec) || isNaN(ibiSec)) {
      invalidRows.push({ lineNumber, raw: line, reason: 'Unparseable value' });
      return;
    }
    if (ibiMs < bounds.min || ibiMs > bounds.max) {
      invalidRows.push({ lineNumber, raw: line, reason: `IBI ${ibiMs.toFixed(0)} ms out of bounds` });
      return;
    }
    timeSeries.push({ timestamp: unixToISO(unixTs), value: Number(ibiMs.toFixed(1)), unixTs, lineNumber });
  });

  const stats = computeStats(timeSeries.map(r => r.value));
  const first = timeSeries[0]?.unixTs ?? null;
  const last  = timeSeries[timeSeries.length - 1]?.unixTs ?? null;

  return {
    timeSeries, rawRows, invalidRows,
    metadata: {
      filename, signalKey: 'HRV', signalLabel: 'HRV (IBI)', unit: 'ms',
      source: 'PhysioNet-WearableExamStress-E4',
      startUnix, sampleHz: null, intervalSec: null,
      totalLinesRead: rawRows.length,
      validCount:     timeSeries.length,
      invalidCount:   invalidRows.length,
      startISO: first ? unixToISO(first) : null,
      endISO:   last  ? unixToISO(last)  : null,
      durationSeconds: first && last ? Number((last - first).toFixed(1)) : null,
      avgIntervalSeconds: null,
      coveragePercent: 100,
      stats,
      baselineNote: 'IBI-derived HRV. Single exam session only — not a multi-day baseline.',
      qualityNotes: [
        'IBI values converted from seconds to milliseconds.',
        'Irregular sampling — one record per detected heartbeat.',
        invalidRows.length > 0 ? `${invalidRows.length} row(s) rejected.` : 'All IBI records passed validity checks.',
      ],
    },
  };
}

// ── Multi-signal session builder ──────────────────────────────────────────────
/**
 * Helper: extract {text, format, filename} from a signal entry.
 * Accepts both old plain-string entries (backward compat) and new object entries.
 */
function _resolveSignalEntry(entry, defaultFilename) {
  if (typeof entry === 'string') {
    return { text: entry, format: detectCsvFormat(entry), filename: defaultFilename };
  }
  return { text: entry.text, format: entry.format || detectCsvFormat(entry.text), filename: entry.filename || defaultFilename };
}

/**
 * Dispatch to the right single-file parser based on detected format.
 * 'e4-header'       → parseEmpaticaSignalCsv
 * 'timestamp-value' → parseTimestampValueCsv
 * 'unknown'         → try E4 header (will likely fail gracefully with empty series)
 */
function _dispatchSignalParser(entry, signalKey, defaultFilename) {
  const { text, format, filename } = _resolveSignalEntry(entry, defaultFilename);
  if (format === 'timestamp-value') {
    return parseTimestampValueCsv(text, signalKey, filename);
  }
  // Default: E4 header format (or unknown → attempt E4 parse)
  return parseEmpaticaSignalCsv(text, signalKey, filename);
}

export function parseE4Session({ subjectId, sessionLabel, signals }) {
  const parsedSignals  = {};
  const signalMetadata = {};
  const qualityMap     = {};

  // Determine dataset source label (user-imported vs. PhysioNet bundled)
  const isUserImport = Object.values(signals).some(s =>
    typeof s === 'object' && s !== null && s.format === 'timestamp-value'
  );

  if (signals.HR) {
    const r = _dispatchSignalParser(signals.HR, 'RESTING_HR', 'HR.csv');
    parsedSignals['RESTING_HR']  = r.timeSeries;
    signalMetadata['RESTING_HR'] = r.metadata;
    qualityMap['RESTING_HR']     = { invalidRows: r.invalidRows };
  }

  if (signals.TEMP) {
    const r = _dispatchSignalParser(signals.TEMP, 'TEMPERATURE', 'TEMP.csv');
    parsedSignals['TEMPERATURE']  = _downsampleToMinuteMedians(r.timeSeries);
    signalMetadata['TEMPERATURE'] = { ...r.metadata, note: 'Downsampled to 1-minute medians.' };
    qualityMap['TEMPERATURE']     = { invalidRows: r.invalidRows };
  }

  if (signals.IBI) {
    // IBI has its own dedicated parser; it always expects its own format.
    // For timestamp-value format, fall back gracefully to E4 IBI parser
    // (IBI format is always: startTs on line 1, then relTime,ibi rows).
    const { text, filename } = _resolveSignalEntry(signals.IBI, 'IBI.csv');
    const r = parseEmpaticaIbiCsv(text, filename);
    parsedSignals['HRV']  = r.timeSeries;
    signalMetadata['HRV'] = r.metadata;
    qualityMap['HRV']     = { invalidRows: r.invalidRows };
  }

  const allMetas = Object.values(signalMetadata);
  const startISO = allMetas.map(m => m.startISO).filter(Boolean).sort()[0] ?? null;
  const endISO   = allMetas.map(m => m.endISO).filter(Boolean).sort().pop()  ?? null;
  const durationSeconds = startISO && endISO ? (new Date(endISO) - new Date(startISO)) / 1000 : null;

  return {
    subjectId, sessionLabel,
    sessionId:     `${subjectId}-${sessionLabel}`,
    startISO, endISO, durationSeconds,
    durationHours: durationSeconds ? Number((durationSeconds / 3600).toFixed(2)) : null,
    availableSignals:   Object.keys(parsedSignals),
    unavailableSignals: ['SPO2', 'PAIN_SCORE', 'DAILY_STEPS', 'GAIT_VELOCITY', 'KNEE_FLEXION_ROM', 'SWELLING_SCORE', 'BODY_WEIGHT'],
    parsedSignals, signalMetadata, qualityMap,
    totalValidRecords: Object.values(parsedSignals).reduce((s, ts) => s + ts.length, 0),
    datasetSource: isUserImport ? {
      name:    'User-Imported CSV',
      authors: 'Unknown',
      year:    null,
      doi:     null,
      licence: 'N/A',
      url:     null,
      device:  'Wearable sensor (type unknown)',
    } : {
      name:    'Wearable Exam Stress Dataset',
      authors: 'Amin, Wickramasuriya, Faghih',
      year:    2022,
      doi:     '10.13026/kvkb-aj90',
      licence: 'Open Data Commons Attribution License v1.0',
      url:     'https://physionet.org/content/wearable-exam-stress/1.0.0/',
      device:  'Empatica E4 wristband',
    },
    clinicalLimitations: isUserImport ? [
      'User-imported CSV — data source and clinical context are unknown.',
      'Multi-day rehabilitation baselines require sufficient data coverage.',
      'ROM, gait, steps, SpO₂, pain, and weight are not present unless explicitly imported.',
      'No clinical diagnosis or rehabilitation trajectory can be derived from raw signal data alone.',
    ] : [
      'Exam-stress research dataset — not a clinical rehabilitation dataset.',
      'Each session is 1.5-3 hours. Multi-day rehabilitation baselines cannot be computed.',
      'Dates are de-identified (date-shifted). Time-of-day is preserved.',
      'ROM, gait, steps, SpO2, pain, and weight are not available.',
      'No clinical diagnosis or rehabilitation trajectory can be derived from this data.',
    ],
  };
}

// ── Browser import helpers ────────────────────────────────────────────────────
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error(`FileReader error for "${file.name}"`));
    reader.readAsText(file);
  });
}

/**
 * Parse subject ID and session label from a filename.
 * Handles two conventions:
 *   1. Plain export:   "HR.csv"             -> { subjectId: null, sessionLabel: null }
 *   2. Dataset style:  "S1_Final_HR.csv"    -> { subjectId: 'S1', sessionLabel: 'Final' }
 *                      "S10_Midterm1_HR.csv"-> { subjectId: 'S10', sessionLabel: 'Midterm1' }
 *
 * @param {string} filename
 * @returns {{ subjectId: string|null, sessionLabel: string|null, signalKey: string|null }}
 */
export function parseE4FilenameMetadata(filename) {
  const base = filename.replace(/\.csv$/i, '').toUpperCase();

  // Dataset convention: S<n>_<Session>_<SIGNAL>
  const datasetMatch = filename.match(/^(S\d+)_(\w+)_(HR|TEMP|IBI|EDA|BVP|ACC)\.csv$/i);
  if (datasetMatch) {
    return {
      subjectId:    datasetMatch[1].toUpperCase(),
      sessionLabel: _normaliseSessionLabel(datasetMatch[2]),
      signalKey:    datasetMatch[3].toUpperCase(),
    };
  }

  // Plain E4 export convention: HR.csv, TEMP.csv, IBI.csv
  const plainSignals = ['HR', 'TEMP', 'IBI', 'EDA', 'BVP', 'ACC'];
  const plainMatch = plainSignals.find(s => base === s);
  if (plainMatch) {
    return { subjectId: null, sessionLabel: null, signalKey: plainMatch };
  }

  return { subjectId: null, sessionLabel: null, signalKey: null };
}

/** Normalise session labels: 'final' -> 'Final', 'midterm1' -> 'Midterm1', etc. */
function _normaliseSessionLabel(raw) {
  const upper = raw.toUpperCase();
  if (upper === 'FINAL')    return 'Final';
  if (upper === 'MIDTERM1') return 'Midterm1';
  if (upper === 'MIDTERM2') return 'Midterm2';
  // Capitalise first letter as fallback
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

/**
 * Import a set of E4 CSV files from a browser file picker.
 * Auto-detects both naming conventions (plain and dataset-style).
 * Subject/session identity is extracted from filenames when available.
 *
 * @param {File[]} files  - Files from <input type="file" multiple>
 * @param {string} [fallbackSubjectId]
 * @param {string} [fallbackSessionLabel]
 * @returns {Promise<Object>} session result from parseE4Session()
 */
/**
 * Attempt to infer signal type from CSV content when the filename is unrecognised.
 * Samples up to 30 data values and checks which physiological range they fall into.
 *
 * @param {string} csvText
 * @param {'e4-header'|'timestamp-value'|'unknown'} fmt
 * @returns {'HR'|'TEMP'|'IBI'|null}
 */
function _guessSignalFromContent(csvText, fmt) {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  if (lines.length < 3) return null;

  // Extract up to 30 numeric values depending on format
  const values = [];
  if (fmt === 'timestamp-value') {
    for (const l of lines.slice(0, 30)) {
      const parts = l.split(',');
      if (parts.length >= 2) {
        const v = parseFloat(parts[1]);
        if (!isNaN(v)) values.push(v);
      }
    }
  } else {
    // E4 header: skip first two lines (timestamp, sample rate), read values
    for (const l of lines.slice(2, 32)) {
      const v = parseFloat(l.split(',')[0]);
      if (!isNaN(v)) values.push(v);
    }
  }

  if (values.length === 0) return null;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const allInHR   = values.every(v => v >= 20   && v <= 250);
  const allInTemp = values.every(v => v >= 15.0  && v <= 45.0);
  const allInIbi  = values.every(v => v >= 0.2   && v <= 3.0);  // IBI in seconds

  // HR: mean typically 50-130, values 20-250
  if (allInHR   && mean >= 40  && mean <= 180) return 'HR';
  // TEMP: wrist skin 28-40 C
  if (allInTemp && mean >= 20.0 && mean <= 42.0 && !allInHR) return 'TEMP';
  // IBI: inter-beat intervals in seconds (0.3-1.5 s)
  if (allInIbi  && mean >= 0.3  && mean <= 1.5)  return 'IBI';

  return null;
}

export async function importE4SessionFromFileList(
  files,
  fallbackSubjectId    = 'UNKNOWN',
  fallbackSessionLabel = 'Imported'
) {
  const fileMap = {};
  let detectedSubjectId    = null;
  let detectedSessionLabel = null;
  const acceptedKeys = ['HR', 'TEMP', 'IBI'];

  for (const f of files) {
    // ── Step 1: filename-based detection ────────────────────────────────────
    const meta = parseE4FilenameMetadata(f.name);
    let signalKey = meta.signalKey && acceptedKeys.includes(meta.signalKey)
      ? meta.signalKey
      : null;

    // Fallback A: bare basename match ("HR.csv" → 'HR', case-insensitive)
    if (!signalKey) {
      const upperBase = f.name.replace(/\.csv$/i, '').toUpperCase().trim();
      if (acceptedKeys.includes(upperBase)) signalKey = upperBase;
    }

    // Always read the file text so we can do content-based detection if needed
    const text = await readFileAsText(f);
    const fmt  = detectCsvFormat(text);

    // ── Step 2: content-based signal guessing (last resort) ─────────────────
    if (!signalKey) {
      signalKey = _guessSignalFromContent(text, fmt);
      if (signalKey) {
        console.debug(`[E4 Import] Guessed signal "${signalKey}" from content of "${f.name}"`);
      }
    }

    console.debug(`[E4 Import] File: "${f.name}"  fmt: "${fmt}"  key: "${signalKey ?? 'NONE'}"`)

    if (signalKey) {
      fileMap[signalKey] = { text, format: fmt, filename: f.name };
      if (!detectedSubjectId    && meta.subjectId)    detectedSubjectId    = meta.subjectId;
      if (!detectedSessionLabel && meta.sessionLabel) detectedSessionLabel = meta.sessionLabel;
    }
  }

  if (!fileMap.HR && !fileMap.TEMP && !fileMap.IBI) {
    const foundNames = Array.from(files).map(f => `"${f.name}"`).join(', ');
    throw new Error(
      `No recognisable signal files found in: ${foundNames}\n\n` +
      'Accepted file names (any of):\n' +
      '  • HR.csv — heart rate\n' +
      '  • TEMP.csv — temperature\n' +
      '  • IBI.csv — inter-beat interval (HRV)\n' +
      '  • S1_Final_HR.csv / S1_Final_TEMP.csv / S1_Final_IBI.csv\n\n' +
      'Accepted CSV formats:\n' +
      '  • Empatica E4: line 1=start timestamp, line 2=sample rate, line 3+=values\n' +
      '  • Timestamp-value rows: unix_timestamp,value  (one per line)'
    );
  }

  const subjectId    = detectedSubjectId    || fallbackSubjectId;
  const sessionLabel = detectedSessionLabel || fallbackSessionLabel;

  // Normalise: wrap any plain string values from old callers
  const normalisedSignals = {};
  for (const [key, val] of Object.entries(fileMap)) {
    if (typeof val === 'string') {
      normalisedSignals[key] = { text: val, format: detectCsvFormat(val), filename: `${key}.csv` };
    } else {
      normalisedSignals[key] = val;
    }
  }

  return parseE4Session({ subjectId, sessionLabel, signals: normalisedSignals });
}

/** @deprecated Use importE4SessionFromFileList() instead. */
export async function importE4Session(files, subjectId = 'UNKNOWN', sessionLabel = 'Imported') {
  return importE4SessionFromFileList(files, subjectId, sessionLabel);
}

/**
 * Generate a complete, scope-honest session report from a parsed session result.
 * Never fabricates unavailable signals or multi-day trends.
 *
 * @param {Object} sessionResult  - from parseE4Session()
 * @param {Object} [catalogue]    - optional SessionCatalogueEntry for richer provenance
 * @returns {Object}
 */
export function generateSessionReport(sessionResult, catalogue = null) {
  const perSignal = {};

  for (const [signalKey, timeSeries] of Object.entries(sessionResult.parsedSignals || {})) {
    const meta  = sessionResult.signalMetadata[signalKey] || {};
    const stats = meta.stats || {};
    const n     = timeSeries.length;
    const baselineSufficient = n >= 30;

    perSignal[signalKey] = {
      signalLabel:      meta.signalLabel || signalKey,
      unit:             meta.unit || '',
      recordCount:      n,
      startISO:         meta.startISO,
      endISO:           meta.endISO,
      durationSeconds:  meta.durationSeconds,
      sampleHz:         meta.sampleHz ?? null,
      coveragePercent:  meta.coveragePercent ?? null,
      stats:            stats,
      baselineSufficient,
      baselineNote:     meta.baselineNote || (baselineSufficient
        ? 'Session baseline computable from available records.'
        : `Insufficient records (${n} < 30) -- baseline not computed.`),
      qualityNotes:     meta.qualityNotes || [],
      invalidCount:     meta.invalidCount ?? 0,
    };
  }

  return {
    reportType:    'WearableExamStressSessionReport',
    reportVersion: '2.0',
    source:        'PhysioNet-WearableExamStress-E4',
    generatedAt:   new Date().toISOString(),
    subjectId:     sessionResult.subjectId,
    sessionLabel:  sessionResult.sessionLabel,
    sessionId:     sessionResult.sessionId,
    displayName:   catalogue?.displayName || `${sessionResult.subjectId} -- ${sessionResult.sessionLabel}`,
    sessionStartISO:  sessionResult.startISO,
    sessionEndISO:    sessionResult.endISO,
    durationHours:    sessionResult.durationHours,
    availableSignals: sessionResult.availableSignals,
    unavailableSignals: sessionResult.unavailableSignals,
    totalValidRecords: sessionResult.totalValidRecords,
    perSignalSummary:  perSignal,
    datasetSource:    sessionResult.datasetSource,
    clinicalLimitations: sessionResult.clinicalLimitations,
    // Explicit unavailability statements -- never fabricated
    multiDayTrendsAvailable:        false,
    rehabilitationTrendsAvailable:  false,
    postOpTrajectoryAvailable:      false,
    coverageNote: sessionResult.durationHours
      ? `Report covers the ${sessionResult.durationHours.toFixed(1)}-hour exam session (${sessionResult.startISO} to ${sessionResult.endISO}). Multi-day trends: NOT AVAILABLE.`
      : 'Recording period: unknown.',
    // Provenance from catalogue if available
    catalogue: catalogue ? {
      sessionId:      catalogue.sessionId,
      bundledLocally: catalogue.bundledLocally,
      fileNames:      catalogue.fileNames,
    } : null,
  };
}

export function sessionToIntelligencePipelineInput(sessionResult) {
  const telemetryData = {};
  for (const [key, ts] of Object.entries(sessionResult.parsedSignals)) {
    if (ts.length > 0)
      telemetryData[key] = ts.map(r => ({ timestamp: r.timestamp, value: r.value }));
  }
  return { telemetryData, availableSignals: Object.keys(telemetryData) };
}

export function buildSessionPatientObject(sessionResult, recordingId) {
  return {
    id:              recordingId || sessionResult.sessionId,
    name:            `${sessionResult.subjectId} \u2014 ${sessionResult.sessionLabel}`,
    postOpDay:       null,
    medications:     [],
    comorbidities:   [],
    inActiveExercise: false,
    isRealRecording: true,
    sessionResult,
  };
}

// ── Aggregation helpers ───────────────────────────────────────────────────────
export function _downsampleToMinuteMedians(timeSeries) {
  const buckets = {};
  timeSeries.forEach(r => {
    const d = new Date(r.timestamp);
    const key = new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()
    )).toISOString();
    if (!buckets[key]) buckets[key] = { unixTs: new Date(key).getTime() / 1000, values: [] };
    buckets[key].values.push(r.value);
  });
  return Object.keys(buckets).sort().map(key => {
    const b = buckets[key];
    const sorted = [...b.values].sort((a, c) => a - c);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    return { timestamp: key, value: Number(median.toFixed(2)), unixTs: b.unixTs, lineNumber: -1 };
  });
}

export function aggregateHourly(timeSeries) {
  const buckets = {};
  timeSeries.forEach(r => {
    const d = new Date(r.timestamp);
    const key = new Date(Date.UTC(
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()
    )).toISOString();
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(r.value);
  });
  return Object.keys(buckets).sort().map(k => ({ isoHour: k, ...computeStats(buckets[k]) }));
}

export function aggregateDaily(timeSeries) {
  const buckets = {};
  timeSeries.forEach(r => {
    const d = new Date(r.timestamp);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(r.value);
  });
  return Object.keys(buckets).sort().map(k => ({ isoDate: k, ...computeStats(buckets[k]) }));
}
