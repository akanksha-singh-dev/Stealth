/**
 * @file exam-stress-adapter.test.js
 * @description Validation tests for the real Wearable Exam Stress Dataset integration.
 *
 * Tests cover:
 *  1.  CSV parsing -- HR, TEMP, IBI standard 3-row-header format
 *  2.  Timestamp generation from startUnix + sampleRate
 *  3.  Subject/session separation (S1-Final vs S2-Final must not mix)
 *  4.  Session-specific baseline calculation (only when >=30 valid records)
 *  5.  Baseline suppression when data is insufficient
 *  6.  Signal quality metrics: valid count, invalid count, coverage percent
 *  7.  Missing data indicators (absent signals never silently fabricated)
 *  8.  Report generation covering actual recording period only
 *  9.  Multi-day rehabilitation trends must be explicitly marked UNAVAILABLE
 * 10.  Dataset source attribution (DOI, licence, device, context)
 * 11.  Clinical limitations present in every session result
 * 12.  Filename metadata parsing (both naming conventions)
 * 13.  Catalogue: bundled sessions, getCatalogueEntry, validateSessionAttribution
 * 14.  Baseline sufficiency assessment (assessBaselineSufficiency)
 * 15.  Unavailable signal list -- never fabricated in pipeline output
 * 16.  TEMP warm-up artefact filtering (values < 25 C rejected)
 * 17.  IBI conversion from seconds to milliseconds
 * 18.  Stats accuracy for known values
 * 19.  Report: per-signal summary, no fabricated multi-day data
 * 20.  Intelligence pipeline runs without crashing on real-signal input
 *
 * Run with: node --test tests/exam-stress-adapter.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEmpaticaSignalCsv,
  parseEmpaticaIbiCsv,
  parseE4Session,
  sessionToIntelligencePipelineInput,
  buildSessionPatientObject,
  _downsampleToMinuteMedians,
  aggregateHourly,
  aggregateDaily,
  parseE4FilenameMetadata,
  generateSessionReport,
} from '../src/data/empatica-e4-adapter.js';

import {
  DATASET_SOURCE,
  DATASET_LIMITATIONS,
  AVAILABLE_SIGNALS,
  UNAVAILABLE_SIGNALS,
  MIN_RECORDS_FOR_BASELINE,
  SUBJECT_SESSION_CATALOGUE,
  getCatalogueEntry,
  getBundledSessions,
  validateSessionAttribution,
  assessBaselineSufficiency,
  buildSessionProvenance,
} from '../src/data/exam-stress-catalogue.js';

import { LongitudinalHealthIntelligenceLayer } from '../src/core/health-intelligence-layer.js';
import { BaselineEngine } from '../src/core/baseline-engine.js';

// ── Test helpers ──────────────────────────────────────────────────────────────
const BASE_TS = 1544027347.0; // 2018-12-05 UTC (de-identified date from S1/Final)

function makeHRCsv(startTs, sampleHz, values) {
  return [startTs, sampleHz, ...values].join('\n');
}

function makeTEMPCsv(startTs, sampleHz, values) {
  return [startTs, sampleHz, ...values].join('\n');
}

function makeIBICsv(startTs, rows) {
  const header = `${startTs}, IBI`;
  return [header, ...rows.map(r => `${r[0]},${r[1]}`)].join('\n');
}

function genHRValues(n, fn = i => 75 + Math.sin(i * 0.1) * 5) {
  return Array.from({ length: n }, (_, i) => Number(fn(i).toFixed(2)));
}

function genTEMPValues(n, fn = i => 30 + Math.sin(i * 0.05) * 2) {
  return Array.from({ length: n }, (_, i) => Number(fn(i).toFixed(2)));
}

function genIBIRows(n, baseRelSec = 1.0, ibiSec = 0.8) {
  return Array.from({ length: n }, (_, i) => [baseRelSec + i * ibiSec, ibiSec]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CSV PARSING
// ─────────────────────────────────────────────────────────────────────────────
test('parseEmpaticaSignalCsv -- parses actual S1_Final_HR.csv 3-row-header format', () => {
  const csv = makeHRCsv(BASE_TS, 1.0, [116.00, 82.50, 96.33, 86.25, 98.60]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'S1_Final_HR.csv');

  assert.equal(result.metadata.validCount, 5);
  assert.equal(result.metadata.invalidCount, 0);
  assert.equal(result.metadata.signalKey, 'RESTING_HR');
  assert.equal(result.metadata.unit, 'bpm');
  assert.equal(result.metadata.source, 'PhysioNet-WearableExamStress-E4');
  assert.equal(result.metadata.sampleHz, 1.0);
});

test('parseEmpaticaSignalCsv -- parses TEMP at 4 Hz', () => {
  const csv = makeTEMPCsv(BASE_TS, 4.0, genTEMPValues(40));
  const result = parseEmpaticaSignalCsv(csv, 'TEMPERATURE', 'S1_Final_TEMP.csv');

  assert.ok(result.metadata.validCount > 0);
  assert.equal(result.metadata.sampleHz, 4.0);
  assert.ok(Math.abs(result.metadata.avgIntervalSeconds - 0.25) < 0.01, '4 Hz => 0.25 s intervals');
});

test('parseEmpaticaIbiCsv -- parses IBI with startTs, IBI header', () => {
  const csv = makeIBICsv(BASE_TS, genIBIRows(20));
  const result = parseEmpaticaIbiCsv(csv, 'S1_Final_IBI.csv');

  assert.equal(result.metadata.signalKey, 'HRV');
  assert.equal(result.metadata.unit, 'ms');
  assert.ok(result.timeSeries.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TIMESTAMP GENERATION
// ─────────────────────────────────────────────────────────────────────────────
test('Timestamps are startUnix + i*(1/sampleHz) for regular signals', () => {
  const csv = makeHRCsv(BASE_TS, 1.0, [75, 76, 77]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');
  const times = result.timeSeries.map(r => r.unixTs);

  assert.ok(Math.abs(times[0] - BASE_TS) < 0.001, 'First at startUnix');
  assert.ok(Math.abs(times[1] - (BASE_TS + 1.0)) < 0.001, 'Second at startUnix + 1s');
  assert.ok(Math.abs(times[2] - (BASE_TS + 2.0)) < 0.001, 'Third at startUnix + 2s');
});

test('Timestamps are valid ISO-8601 and not midnight', () => {
  const csv = makeHRCsv(BASE_TS, 1.0, [75.0]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');
  const ts = result.timeSeries[0].timestamp;

  assert.ok(!isNaN(new Date(ts).getTime()), 'Must be valid ISO');
  assert.ok(!ts.includes('T00:00:00'), 'Must not be midnight');
  assert.ok(ts.startsWith('2018-'), 'De-identified to 2018');
});

test('IBI timestamps are startUnix + relTime', () => {
  const csv = makeIBICsv(BASE_TS, [[10.0, 0.8], [20.0, 0.75]]);
  const result = parseEmpaticaIbiCsv(csv, 'IBI.csv');

  assert.ok(Math.abs(result.timeSeries[0].unixTs - (BASE_TS + 10.0)) < 0.001);
  assert.ok(Math.abs(result.timeSeries[1].unixTs - (BASE_TS + 20.0)) < 0.001);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. SUBJECT / SESSION SEPARATION
// ─────────────────────────────────────────────────────────────────────────────
test('Two sessions with different subject IDs do not mix data', () => {
  const hr1 = makeHRCsv(BASE_TS, 1.0, genHRValues(30, () => 65.0));
  const hr2 = makeHRCsv(BASE_TS + 10000, 1.0, genHRValues(30, () => 90.0));

  const s1 = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hr1 } });
  const s2 = parseE4Session({ subjectId: 'S2', sessionLabel: 'Final', signals: { HR: hr2 } });

  assert.equal(s1.subjectId, 'S1');
  assert.equal(s2.subjectId, 'S2');
  assert.equal(s1.sessionId, 'S1-Final');
  assert.equal(s2.sessionId, 'S2-Final');
  assert.ok(new Date(s1.endISO) < new Date(s2.startISO), 'S1 must end before S2 starts');

  const hr1Mean = s1.parsedSignals['RESTING_HR'].reduce((a, r) => a + r.value, 0)
    / s1.parsedSignals['RESTING_HR'].length;
  const hr2Mean = s2.parsedSignals['RESTING_HR'].reduce((a, r) => a + r.value, 0)
    / s2.parsedSignals['RESTING_HR'].length;

  assert.ok(hr1Mean < 70, `S1 HR mean should be ~65, got ${hr1Mean}`);
  assert.ok(hr2Mean > 85, `S2 HR mean should be ~90, got ${hr2Mean}`);
});

test('Same subject, different sessions produce separate session IDs', () => {
  const hr1 = makeHRCsv(BASE_TS, 1.0, genHRValues(30, () => 68.0));
  const hr2 = makeHRCsv(BASE_TS + 7200, 1.0, genHRValues(30, () => 80.0));

  const s1 = parseE4Session({ subjectId: 'S1', sessionLabel: 'Midterm1', signals: { HR: hr1 } });
  const s2 = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final',    signals: { HR: hr2 } });

  assert.equal(s1.sessionId, 'S1-Midterm1');
  assert.equal(s2.sessionId, 'S1-Final');
  assert.notEqual(s1.startISO, s2.startISO);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SESSION-SPECIFIC BASELINE
// ─────────────────────────────────────────────────────────────────────────────
test('Baseline reflects session data, not a fabricated 14-day history', () => {
  const values = genHRValues(60, i => 72 + Math.sin(i) * 3);
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, values);
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });

  const engine  = new BaselineEngine();
  const profile = engine.buildMetricBaselineProfile(
    session.parsedSignals['RESTING_HR'],
    { signalName: 'RESTING_HR', unit: 'bpm' }
  );

  assert.ok(profile.normalRange.median > 68 && profile.normalRange.median < 78,
    `Median should be near 72, got ${profile.normalRange.median}`);
  assert.ok(profile.normalRange.upperBound < 220, 'Upper bound not at physiological max');
  assert.ok(profile.normalRange.lowerBound > 25,  'Lower bound not at physiological min');
  assert.equal(profile.stats.count, 60);
});

test('Baseline note does not claim 14-day history for a session recording', () => {
  const hrCsv = makeHRCsv(BASE_TS, 1.0, genHRValues(100));
  const result = parseEmpaticaSignalCsv(hrCsv, 'RESTING_HR', 'HR.csv');

  assert.ok(!result.metadata.baselineNote.includes('14-day'));
  assert.ok(
    result.metadata.baselineNote.includes('session') ||
    result.metadata.baselineNote.includes('hour') ||
    result.metadata.baselineNote.includes('Insufficient'),
    `Note must acknowledge session-only scope. Got: "${result.metadata.baselineNote}"`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. BASELINE SUPPRESSION
// ─────────────────────────────────────────────────────────────────────────────
test('assessBaselineSufficiency returns false for < 30 records', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(15));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const suff    = assessBaselineSufficiency(session);

  assert.equal(suff['RESTING_HR'].sufficient, false);
  assert.equal(suff['RESTING_HR'].recordCount, 15);
  assert.ok(suff['RESTING_HR'].note.toLowerCase().includes('suppressed'));
});

test('assessBaselineSufficiency returns true for >= 30 records', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(50));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const suff    = assessBaselineSufficiency(session);

  assert.equal(suff['RESTING_HR'].sufficient, true);
  assert.ok(suff['RESTING_HR'].note.includes('computable'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. SIGNAL QUALITY METRICS
// ─────────────────────────────────────────────────────────────────────────────
test('Quality metrics: valid, invalid, and coverage percent are present', () => {
  const csv = makeHRCsv(BASE_TS, 1.0, [75, 250, 30, 80, 20, 70]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');

  assert.ok(result.metadata.validCount > 0);
  assert.ok(result.metadata.invalidCount > 0);
  assert.equal(result.metadata.validCount + result.metadata.invalidCount, result.metadata.totalLinesRead);
  assert.ok(result.metadata.coveragePercent !== null);
  assert.ok(result.metadata.coveragePercent >= 0 && result.metadata.coveragePercent <= 100);
});

test('Quality notes mention multi-day unavailability', () => {
  const hrCsv = makeHRCsv(BASE_TS, 1.0, genHRValues(50));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const meta = session.signalMetadata['RESTING_HR'];

  assert.ok(Array.isArray(meta.qualityNotes));
  assert.ok(
    meta.qualityNotes.some(n => n.includes('multi-day') || n.includes('24 h')),
    `qualityNotes must mention multi-day. Got: ${JSON.stringify(meta.qualityNotes)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. MISSING DATA INDICATORS
// ─────────────────────────────────────────────────────────────────────────────
test('Missing signals are absent from parsedSignals, not filled with zeros', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });

  assert.ok(!('TEMPERATURE' in session.parsedSignals));
  assert.ok(!('HRV' in session.parsedSignals));
  assert.ok(session.unavailableSignals.includes('SPO2'));
  assert.ok(session.unavailableSignals.includes('PAIN_SCORE'));
  assert.ok(session.unavailableSignals.includes('GAIT_VELOCITY'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. REPORT COVERS ACTUAL PERIOD ONLY
// ─────────────────────────────────────────────────────────────────────────────
test('generateSessionReport covers actual session period, not a fabricated window', () => {
  const hrCsv   = makeHRCsv(BASE_TS, 1.0, genHRValues(60));
  const tempCsv = makeTEMPCsv(BASE_TS, 4.0, genTEMPValues(240));
  const ibiCsv  = makeIBICsv(BASE_TS, genIBIRows(50));

  const session = parseE4Session({
    subjectId: 'S1', sessionLabel: 'Final',
    signals: { HR: hrCsv, TEMP: tempCsv, IBI: ibiCsv },
  });
  const report = generateSessionReport(session, null);

  assert.ok(report.durationHours < 1, 'Synthetic session is well under 1 hour');
  assert.equal(report.sessionStartISO, session.startISO);
  assert.equal(report.sessionEndISO,   session.endISO);
  assert.ok(report.coverageNote.includes('NOT AVAILABLE'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. MULTI-DAY REHAB TRENDS UNAVAILABLE
// ─────────────────────────────────────────────────────────────────────────────
test('generateSessionReport marks multi-day and rehab trends as unavailable', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const report  = generateSessionReport(session, null);

  assert.equal(report.multiDayTrendsAvailable,      false);
  assert.equal(report.rehabilitationTrendsAvailable, false);
  assert.equal(report.postOpTrajectoryAvailable,     false);
});

test('clinicalLimitations include a multi-day warning', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });

  assert.ok(session.clinicalLimitations.some(l => l.toLowerCase().includes('multi-day')));
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. DATASET SOURCE ATTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────
test('Session result datasetSource has DOI, licence, and PhysioNet URL', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });

  assert.ok(session.datasetSource.doi);
  assert.ok(session.datasetSource.licence);
  assert.ok(session.datasetSource.url.includes('physionet.org'));
  assert.equal(session.datasetSource.device, 'Empatica E4 wristband');
});

test('DATASET_SOURCE constant has correct DOI and exam context (not rehab)', () => {
  assert.equal(DATASET_SOURCE.doi, '10.13026/kvkb-aj90');
  assert.ok(DATASET_SOURCE.context.includes('exam'));
  assert.ok(!DATASET_SOURCE.context.includes('rehab'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. CLINICAL LIMITATIONS IN EVERY SESSION
// ─────────────────────────────────────────────────────────────────────────────
test('Every session result has at least 4 clinical limitations', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });

  assert.ok(Array.isArray(session.clinicalLimitations));
  assert.ok(session.clinicalLimitations.length >= 4);
});

test('Dataset is not mislabelled as a rehabilitation dataset', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });

  // One limitation MUST say "NOT a clinical rehabilitation dataset"
  assert.ok(
    session.clinicalLimitations.some(l => l.toLowerCase().includes('not a clinical rehabilitation')),
    'Must explicitly say this is NOT a rehabilitation dataset'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. FILENAME METADATA PARSING
// ─────────────────────────────────────────────────────────────────────────────
test('parseE4FilenameMetadata handles dataset-style names', () => {
  const cases = [
    { name: 'S1_Final_HR.csv',      sid: 'S1',  sl: 'Final',    sk: 'HR'   },
    { name: 'S10_Midterm1_HR.csv',  sid: 'S10', sl: 'Midterm1', sk: 'HR'   },
    { name: 'S3_Midterm2_TEMP.csv', sid: 'S3',  sl: 'Midterm2', sk: 'TEMP' },
    { name: 'S7_Final_IBI.csv',     sid: 'S7',  sl: 'Final',    sk: 'IBI'  },
  ];
  for (const { name, sid, sl, sk } of cases) {
    const meta = parseE4FilenameMetadata(name);
    assert.equal(meta.subjectId,    sid, `subjectId for ${name}`);
    assert.equal(meta.sessionLabel, sl,  `sessionLabel for ${name}`);
    assert.equal(meta.signalKey,    sk,  `signalKey for ${name}`);
  }
});

test('parseE4FilenameMetadata handles plain E4 export filenames', () => {
  for (const { name, sk } of [
    { name: 'HR.csv',   sk: 'HR'   },
    { name: 'TEMP.csv', sk: 'TEMP' },
    { name: 'IBI.csv',  sk: 'IBI'  },
  ]) {
    const meta = parseE4FilenameMetadata(name);
    assert.equal(meta.signalKey,    sk,   `Signal key for ${name}`);
    assert.equal(meta.subjectId,    null, `subjectId null for ${name}`);
    assert.equal(meta.sessionLabel, null, `sessionLabel null for ${name}`);
  }
});

test('parseE4FilenameMetadata returns all nulls for unknown files', () => {
  const meta = parseE4FilenameMetadata('randomfile.csv');
  assert.equal(meta.subjectId, null);
  assert.equal(meta.sessionLabel, null);
  assert.equal(meta.signalKey, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. CATALOGUE: LOOKUP / VALIDATION / BUNDLED SESSIONS
// ─────────────────────────────────────────────────────────────────────────────
test('getCatalogueEntry -- S1-Final is found and bundled', () => {
  const entry = getCatalogueEntry('S1-Final');
  assert.ok(entry !== null);
  assert.equal(entry.bundledLocally, true);
  assert.equal(entry.subjectId, 'S1');
  assert.equal(entry.sessionLabel, 'Final');
  assert.ok(entry.localBasePath.includes('wearable-exam-stress'));
});

test('getCatalogueEntry -- returns null for unknown session', () => {
  assert.equal(getCatalogueEntry('S99-Unknown'), null);
});

test('getBundledSessions -- returns S1-Final', () => {
  const bundled = getBundledSessions();
  assert.ok(bundled.length >= 1);
  assert.ok(bundled.every(e => e.bundledLocally));
  assert.ok(bundled.map(e => e.sessionId).includes('S1-Final'));
});

test('SUBJECT_SESSION_CATALOGUE has 30+ entries covering S1-S10', () => {
  assert.ok(SUBJECT_SESSION_CATALOGUE.length >= 30);
  const subjects = [...new Set(SUBJECT_SESSION_CATALOGUE.map(e => e.subjectId))];
  assert.ok(subjects.includes('S1'));
  assert.ok(subjects.includes('S10'));
});

test('validateSessionAttribution passes for correctly attributed session', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(10));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const entry   = getCatalogueEntry('S1-Final');
  const { valid, issues } = validateSessionAttribution(session, entry);

  assert.equal(valid, true);
  assert.equal(issues.length, 0);
});

test('validateSessionAttribution fails for wrong subject', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(10));
  const session = parseE4Session({ subjectId: 'S2', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const entry   = getCatalogueEntry('S1-Final');
  const { valid, issues } = validateSessionAttribution(session, entry);

  assert.equal(valid, false);
  assert.ok(issues.some(i => i.includes('Subject mismatch')));
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. AVAILABLE / UNAVAILABLE SIGNAL LISTS
// ─────────────────────────────────────────────────────────────────────────────
test('Catalogue entry has correct available and unavailable signal lists', () => {
  const entry = getCatalogueEntry('S1-Final');
  for (const sig of AVAILABLE_SIGNALS) {
    assert.ok(entry.availableSignals.includes(sig), `${sig} in availableSignals`);
  }
  for (const sig of UNAVAILABLE_SIGNALS) {
    assert.ok(entry.unavailableSignals.includes(sig), `${sig} in unavailableSignals`);
    assert.ok(!entry.availableSignals.includes(sig), `${sig} must NOT be in availableSignals`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. UNAVAILABLE SIGNALS NEVER FABRICATED
// ─────────────────────────────────────────────────────────────────────────────
test('HR-only pipeline input never includes fabricated signals', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const { telemetryData, availableSignals } = sessionToIntelligencePipelineInput(session);

  for (const sig of UNAVAILABLE_SIGNALS) {
    assert.ok(!(sig in telemetryData), `${sig} must NOT be fabricated`);
  }
  assert.ok('RESTING_HR' in telemetryData);
  assert.equal(availableSignals.length, 1);
});

test('Three-signal session exposes HR + TEMP + HRV only', () => {
  const hrCsv   = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const tempCsv = makeTEMPCsv(BASE_TS, 4.0, genTEMPValues(120));
  const ibiCsv  = makeIBICsv(BASE_TS, genIBIRows(30));
  const session = parseE4Session({
    subjectId: 'S1', sessionLabel: 'Final',
    signals: { HR: hrCsv, TEMP: tempCsv, IBI: ibiCsv },
  });
  const { telemetryData } = sessionToIntelligencePipelineInput(session);

  assert.ok('RESTING_HR'  in telemetryData);
  assert.ok('TEMPERATURE' in telemetryData);
  assert.ok('HRV'         in telemetryData);
  for (const sig of UNAVAILABLE_SIGNALS) {
    assert.ok(!(sig in telemetryData), `${sig} must NOT be fabricated`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. TEMP WARM-UP ARTEFACT FILTERING
// ─────────────────────────────────────────────────────────────────────────────
test('TEMP values below 25 C are rejected as warm-up artefacts', () => {
  const csv = makeTEMPCsv(BASE_TS, 4.0, [21.89, 21.89, 25.5, 30.1, 31.0, 21.89]);
  const result = parseEmpaticaSignalCsv(csv, 'TEMPERATURE', 'TEMP.csv');

  assert.equal(result.metadata.validCount, 3, 'Three values >= 25 C are valid');
  assert.equal(result.metadata.invalidCount, 3, 'Three warm-up values rejected');
  assert.ok(
    result.invalidRows.every(r => r.reason.includes('25') || r.reason.includes('outside bounds')),
    'Rejection reasons must mention 25 C threshold'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. IBI ms CONVERSION
// ─────────────────────────────────────────────────────────────────────────────
test('IBI values are converted from seconds to milliseconds', () => {
  const csv = makeIBICsv(BASE_TS, [[1.0, 0.75]]); // 0.75 s = 750 ms
  const result = parseEmpaticaIbiCsv(csv, 'IBI.csv');

  assert.equal(result.timeSeries.length, 1);
  assert.equal(result.timeSeries[0].value, 750.0);
  assert.equal(result.metadata.unit, 'ms');
});

test('IBI out of physiological range [100-2000 ms] is rejected', () => {
  const csv = makeIBICsv(BASE_TS, [
    [1.0, 0.8],   // valid 800 ms
    [1.8, 0.05],  // 50 ms -- too short
    [2.0, 3.0],   // 3000 ms -- too long
  ]);
  const result = parseEmpaticaIbiCsv(csv, 'IBI.csv');
  assert.equal(result.timeSeries.length, 1);
  assert.equal(result.invalidRows.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. STATS ACCURACY
// ─────────────────────────────────────────────────────────────────────────────
test('HR stats are correct for known values', () => {
  const csv    = makeHRCsv(BASE_TS, 1.0, [60, 65, 70, 75, 80]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');
  const s = result.metadata.stats;

  assert.equal(s.min,    60);
  assert.equal(s.max,    80);
  assert.equal(s.mean,   70);
  assert.equal(s.median, 70);
  assert.equal(s.count,   5);
});

test('TEMP stats reflect only valid (>= 25 C) values', () => {
  const csv    = makeTEMPCsv(BASE_TS, 4.0, [21.0, 30.0, 30.0, 30.0]);
  const result = parseEmpaticaSignalCsv(csv, 'TEMPERATURE', 'TEMP.csv');

  assert.equal(result.metadata.stats.count, 3);
  assert.equal(result.metadata.stats.min,  30.0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. REPORT PER-SIGNAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
test('generateSessionReport per-signal summary is accurate and complete', () => {
  const hrCsv   = makeHRCsv(BASE_TS, 1.0, genHRValues(50));
  const tempCsv = makeTEMPCsv(BASE_TS, 4.0, genTEMPValues(200));
  const ibiCsv  = makeIBICsv(BASE_TS, genIBIRows(40));
  const session = parseE4Session({
    subjectId: 'S1', sessionLabel: 'Final',
    signals: { HR: hrCsv, TEMP: tempCsv, IBI: ibiCsv },
  });
  const report = generateSessionReport(session, null);

  assert.ok('RESTING_HR'  in report.perSignalSummary, 'HR in report');
  assert.ok('TEMPERATURE' in report.perSignalSummary, 'TEMP in report');
  assert.ok('HRV'         in report.perSignalSummary, 'HRV in report');

  for (const sig of UNAVAILABLE_SIGNALS) {
    assert.ok(!(sig in report.perSignalSummary), `${sig} must NOT be in report`);
  }

  const hrSummary = report.perSignalSummary['RESTING_HR'];
  assert.equal(hrSummary.recordCount, 50);
  assert.equal(hrSummary.unit, 'bpm');
  assert.ok(hrSummary.stats.mean > 0);
});

test('generateSessionReport with catalogue entry embeds provenance', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const entry   = getCatalogueEntry('S1-Final');
  const report  = generateSessionReport(session, entry);

  assert.equal(report.displayName, entry.displayName);
  assert.ok(report.catalogue !== null);
  assert.equal(report.catalogue.sessionId, 'S1-Final');
  assert.equal(report.catalogue.bundledLocally, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 20. INTELLIGENCE PIPELINE INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────
test('Intelligence pipeline runs on HR + TEMP + HRV session without crashing', () => {
  const hrCsv   = makeHRCsv(BASE_TS, 1.0, genHRValues(60));
  const tempCsv = makeTEMPCsv(BASE_TS, 4.0, genTEMPValues(240));
  const ibiCsv  = makeIBICsv(BASE_TS, genIBIRows(60));
  const session = parseE4Session({
    subjectId: 'S1', sessionLabel: 'Final',
    signals: { HR: hrCsv, TEMP: tempCsv, IBI: ibiCsv },
  });

  const { telemetryData } = sessionToIntelligencePipelineInput(session);
  const patient = buildSessionPatientObject(session, 'S1-Final-Test');

  const layer = new LongitudinalHealthIntelligenceLayer();
  let result;
  assert.doesNotThrow(() => { result = layer.analyzePatient({ patient, telemetryData }); });

  assert.ok(result.baselineProfiles);
  assert.ok(result.clinicalObservation);
  assert.ok(result.fuserReport);

  for (const sig of UNAVAILABLE_SIGNALS) {
    assert.ok(!(sig in result.baselineProfiles), `${sig} must NOT have a fabricated baseline`);
  }
});

test('buildSessionPatientObject does not fabricate clinical metadata', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(10));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const patient = buildSessionPatientObject(session, 'S1-Final-Test');

  assert.equal(patient.postOpDay, null, 'postOpDay must be null');
  assert.deepEqual(patient.medications,   [], 'medications must be empty');
  assert.deepEqual(patient.comorbidities, [], 'comorbidities must be empty');
  assert.equal(patient.isRealRecording, true);
  assert.ok(patient.sessionResult, 'sessionResult must be included');
});

// ─────────────────────────────────────────────────────────────────────────────
// BONUS: buildSessionProvenance full integration
// ─────────────────────────────────────────────────────────────────────────────
test('buildSessionProvenance produces a complete, honest provenance block', () => {
  const hrCsv  = makeHRCsv(BASE_TS, 1.0, genHRValues(30));
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: hrCsv } });
  const entry   = getCatalogueEntry('S1-Final');
  const prov    = buildSessionProvenance(entry, session);

  assert.equal(prov.subjectId,    'S1');
  assert.equal(prov.sessionLabel, 'Final');
  assert.ok(prov.datasetSource.doi.includes('kvkb-aj90'));
  assert.ok(prov.multiDayTrendsNote.includes('UNAVAILABLE'));
  assert.ok(prov.rehabilitationNote.includes('UNAVAILABLE'));
  assert.ok(prov.reportCoverageNote.includes('NOT AVAILABLE'));
  assert.ok(Array.isArray(prov.limitations) && prov.limitations.length >= 4);
});
