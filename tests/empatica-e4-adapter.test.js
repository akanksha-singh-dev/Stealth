/**
 * @file empatica-e4-adapter.test.js
 * @description Tests for the multi-signal Empatica E4 adapter.
 *
 * Tests cover:
 *  1. Standard 3-row header parsing (HR, TEMP)
 *  2. IBI irregular format ("startTs, IBI" header)
 *  3. Correct timestamp generation from startUnix + sampleRate
 *  4. TEMP warm-up artifact filtering (values below 25 C rejected)
 *  5. Physiological bounds enforcement per signal
 *  6. IBI conversion from seconds to milliseconds
 *  7. TEMP downsampling to per-minute medians
 *  8. parseE4Session multi-signal combination
 *  9. sessionToIntelligencePipelineInput — no fabricated signals
 * 10. Graceful empty/malformed file handling
 * 11. Dataset limitations documented in session result
 * 12. Stats accuracy for known values
 *
 * Run with: node --test tests/empatica-e4-adapter.test.js
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
} from '../src/data/empatica-e4-adapter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const BASE_TS = 1544027347.0; // 2018-12-05 UTC (de-identified date from dataset)

function makeStandardCsv(startTs, sampleHz, values) {
  return [startTs, sampleHz, ...values].join('\n');
}

function makeIbiCsv(startTs, rows) {
  // rows: [[relSec, ibiSec], ...]
  const header = `${startTs}, IBI`;
  return [header, ...rows.map(r => `${r[0]},${r[1]}`)].join('\n');
}

// ── 1. Standard 3-row header parsing ─────────────────────────────────────────
test('parseEmpaticaSignalCsv — parses standard E4 HR format correctly', () => {
  const csv = makeStandardCsv(BASE_TS, 1.0, [72.0, 74.0, 75.0, 73.0, 71.0]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');

  assert.equal(result.timeSeries.length, 5);
  assert.equal(result.invalidRows.length, 0);
  assert.equal(result.metadata.validCount, 5);
  assert.equal(result.metadata.sampleHz, 1.0);
  assert.equal(result.metadata.signalKey, 'RESTING_HR');
  assert.equal(result.metadata.unit, 'bpm');
  assert.equal(result.metadata.source, 'PhysioNet-WearableExamStress-E4');
});

// ── 2. Timestamp generation from startUnix + sampleRate ──────────────────────
test('parseEmpaticaSignalCsv — generates timestamps as startUnix + i*(1/Hz)', () => {
  const csv = makeStandardCsv(BASE_TS, 1.0, [72, 73, 74]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');

  const times = result.timeSeries.map(r => r.unixTs);
  assert.ok(Math.abs(times[0] - BASE_TS) < 0.001, 'First record should be at startUnix');
  assert.ok(Math.abs(times[1] - (BASE_TS + 1.0)) < 0.001, 'Second at startUnix + 1s');
  assert.ok(Math.abs(times[2] - (BASE_TS + 2.0)) < 0.001, 'Third at startUnix + 2s');
});

test('parseEmpaticaSignalCsv — 4 Hz sample rate generates correct intervals', () => {
  const csv = makeStandardCsv(BASE_TS, 4.0, [30.0, 30.1, 30.2, 30.3]);
  const result = parseEmpaticaSignalCsv(csv, 'TEMPERATURE', 'TEMP.csv');
  const times = result.timeSeries.map(r => r.unixTs);
  const gap = times[1] - times[0];
  assert.ok(Math.abs(gap - 0.25) < 0.001, `4 Hz => interval should be 0.25s, got ${gap}`);
});

test('parseEmpaticaSignalCsv — ISO timestamps are not midnight', () => {
  const csv = makeStandardCsv(BASE_TS, 1.0, [70.0]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');
  // BASE_TS = 2018-12-05 in UTC (de-identified but not midnight)
  assert.ok(!result.timeSeries[0].timestamp.includes('T00:00:00'), 'Timestamp must not be midnight UTC');
});

// ── 3. Physiological bounds ───────────────────────────────────────────────────
test('parseEmpaticaSignalCsv — rejects HR values outside [25, 220] bpm', () => {
  const csv = makeStandardCsv(BASE_TS, 1.0, [70.0, 250.0, 20.0, 80.0]);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');
  assert.equal(result.metadata.validCount, 2);
  assert.equal(result.metadata.invalidCount, 2);
  assert.ok(result.invalidRows.some(r => r.reason.includes('250') || r.reason.includes('outside bounds')));
});

test('parseEmpaticaSignalCsv — rejects TEMP warm-up values below 25 C', () => {
  // Empatica records room temp (21-24 C) when device is not yet on wrist
  const csv = makeStandardCsv(BASE_TS, 4.0, [21.89, 21.89, 25.5, 30.1, 31.0]);
  const result = parseEmpaticaSignalCsv(csv, 'TEMPERATURE', 'TEMP.csv');

  assert.equal(result.metadata.validCount, 3, '21.89 and 21.89 should be rejected as warm-up artifacts');
  assert.equal(result.metadata.invalidCount, 2);
});

test('parseEmpaticaSignalCsv — rejects TEMP above 40 C (non-physiological for wrist)', () => {
  const csv = makeStandardCsv(BASE_TS, 4.0, [30.0, 41.0, 30.5]);
  const result = parseEmpaticaSignalCsv(csv, 'TEMPERATURE', 'TEMP.csv');
  assert.equal(result.metadata.validCount, 2);
  assert.equal(result.metadata.invalidCount, 1);
});

// ── 4. IBI format with "startTs, IBI" header ─────────────────────────────────
test('parseEmpaticaIbiCsv — handles "startTs, IBI" header row correctly', () => {
  const csv = makeIbiCsv(BASE_TS, [[1.0, 0.75], [1.75, 0.80], [2.55, 0.72]]);
  const result = parseEmpaticaIbiCsv(csv, 'IBI.csv');

  assert.equal(result.timeSeries.length, 3);
  assert.equal(result.metadata.signalKey, 'HRV');
  assert.equal(result.metadata.unit, 'ms');
});

test('parseEmpaticaIbiCsv — converts IBI from seconds to milliseconds', () => {
  const csv = makeIbiCsv(BASE_TS, [[1.0, 0.75]]); // 0.75s = 750ms
  const result = parseEmpaticaIbiCsv(csv, 'IBI.csv');
  assert.equal(result.timeSeries[0].value, 750.0, 'IBI should be converted to ms');
});

test('parseEmpaticaIbiCsv — generates correct absolute timestamps from relTime', () => {
  const csv = makeIbiCsv(BASE_TS, [[10.0, 0.8], [20.0, 0.75]]);
  const result = parseEmpaticaIbiCsv(csv, 'IBI.csv');

  const expectedTs0 = BASE_TS + 10.0;
  const expectedTs1 = BASE_TS + 20.0;
  assert.ok(Math.abs(result.timeSeries[0].unixTs - expectedTs0) < 0.001);
  assert.ok(Math.abs(result.timeSeries[1].unixTs - expectedTs1) < 0.001);
});

test('parseEmpaticaIbiCsv — rejects IBI outside physiological range', () => {
  // Physiological IBI range: 100-2000ms (30-600 bpm)
  const csv = makeIbiCsv(BASE_TS, [
    [1.0, 0.8],    // valid 800ms
    [1.8, 0.05],   // too short 50ms (>1200bpm) — reject
    [2.0, 3.0],    // too long 3000ms (<20bpm) — reject
  ]);
  const result = parseEmpaticaIbiCsv(csv, 'IBI.csv');
  assert.equal(result.timeSeries.length, 1);
  assert.equal(result.invalidRows.length, 2);
});

// ── 5. TEMP downsampling ──────────────────────────────────────────────────────
test('_downsampleToMinuteMedians — groups 4 Hz TEMP data to per-minute medians', () => {
  // Create 4 records at 2018-12-05T09:00:xx and 4 at 09:01:xx
  const makeTs = (h, m, s) => new Date(Date.UTC(2018, 11, 5, h, m, s)).toISOString();
  const timeSeries = [
    { timestamp: makeTs(9, 0, 0), value: 30.0, unixTs: 0, lineNumber: 1 },
    { timestamp: makeTs(9, 0, 1), value: 30.4, unixTs: 0, lineNumber: 2 },
    { timestamp: makeTs(9, 0, 2), value: 30.2, unixTs: 0, lineNumber: 3 },
    { timestamp: makeTs(9, 0, 3), value: 30.6, unixTs: 0, lineNumber: 4 },
    { timestamp: makeTs(9, 1, 0), value: 31.0, unixTs: 0, lineNumber: 5 },
    { timestamp: makeTs(9, 1, 1), value: 31.2, unixTs: 0, lineNumber: 6 },
    { timestamp: makeTs(9, 1, 2), value: 31.4, unixTs: 0, lineNumber: 7 },
    { timestamp: makeTs(9, 1, 3), value: 31.6, unixTs: 0, lineNumber: 8 },
  ];

  const result = _downsampleToMinuteMedians(timeSeries);
  assert.equal(result.length, 2, 'Should produce 2 minute-buckets');
  assert.ok(result[0].value >= 30.0 && result[0].value <= 30.6, 'First minute median in range');
  assert.ok(result[1].value >= 31.0 && result[1].value <= 31.6, 'Second minute median in range');
});

// ── 6. Multi-signal session parsing ──────────────────────────────────────────
test('parseE4Session — combines HR + TEMP + IBI into one session', () => {
  const hrCsv   = makeStandardCsv(BASE_TS, 1.0, Array.from({ length: 60 }, () => 75.0));
  const tempCsv = makeStandardCsv(BASE_TS, 4.0, Array.from({ length: 240 }, (_, i) => 28 + i * 0.01));
  const ibiCsv  = makeIbiCsv(BASE_TS, Array.from({ length: 60 }, (_, i) => [i * 1.0, 0.8]));

  const session = parseE4Session({
    subjectId:    'S1',
    sessionLabel: 'Final',
    signals: { HR: hrCsv, TEMP: tempCsv, IBI: ibiCsv },
  });

  assert.equal(session.subjectId, 'S1');
  assert.equal(session.sessionLabel, 'Final');
  assert.ok(session.availableSignals.includes('RESTING_HR'));
  assert.ok(session.availableSignals.includes('TEMPERATURE'));
  assert.ok(session.availableSignals.includes('HRV'));
  assert.ok(session.totalValidRecords > 0);
  assert.ok(Array.isArray(session.clinicalLimitations));
  assert.ok(session.clinicalLimitations.length > 0);
});

test('parseE4Session — only HR produces session with 1 available signal', () => {
  const hrCsv = makeStandardCsv(BASE_TS, 1.0, [70, 72, 74]);
  const session = parseE4Session({ subjectId: 'S2', sessionLabel: 'Midterm1', signals: { HR: hrCsv } });
  assert.equal(session.availableSignals.length, 1);
  assert.equal(session.availableSignals[0], 'RESTING_HR');
});

// ── 7. Pipeline input — no fabricated signals ─────────────────────────────────
test('sessionToIntelligencePipelineInput — only includes genuinely present signals', () => {
  const hrCsv = makeStandardCsv(BASE_TS, 1.0, [70, 72, 74, 71, 73]);
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Test', signals: { HR: hrCsv } });
  const { telemetryData, availableSignals } = sessionToIntelligencePipelineInput(session);

  const FABRICATED = ['TEMPERATURE', 'HRV', 'SPO2', 'PAIN_SCORE', 'GAIT_VELOCITY',
    'DAILY_STEPS', 'KNEE_FLEXION_ROM', 'SWELLING_SCORE', 'BODY_WEIGHT'];
  FABRICATED.forEach(sig => {
    assert.ok(!(sig in telemetryData), `${sig} must NOT appear when not in source data`);
  });

  assert.ok('RESTING_HR' in telemetryData);
  assert.equal(availableSignals.length, 1);
});

test('sessionToIntelligencePipelineInput — each record has timestamp and numeric value', () => {
  const hrCsv = makeStandardCsv(BASE_TS, 1.0, [68, 70, 72]);
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Test', signals: { HR: hrCsv } });
  const { telemetryData } = sessionToIntelligencePipelineInput(session);

  telemetryData['RESTING_HR'].forEach((r, i) => {
    assert.ok('timestamp' in r, `Record ${i} must have timestamp`);
    assert.ok('value' in r, `Record ${i} must have value`);
    assert.equal(typeof r.value, 'number');
    assert.ok(!isNaN(new Date(r.timestamp).getTime()), `Record ${i} timestamp must be valid ISO`);
  });
});

// ── 8. buildSessionPatientObject — no fabricated clinical data ────────────────
test('buildSessionPatientObject — does not fabricate clinical metadata', () => {
  const hrCsv = makeStandardCsv(BASE_TS, 1.0, [70]);
  const session = parseE4Session({ subjectId: 'S3', sessionLabel: 'Midterm2', signals: { HR: hrCsv } });
  const patient = buildSessionPatientObject(session, 'REC-001');

  assert.equal(patient.postOpDay, null, 'postOpDay must be null — not fabricated');
  assert.deepEqual(patient.medications, [], 'medications must be empty array');
  assert.deepEqual(patient.comorbidities, [], 'comorbidities must be empty array');
  assert.equal(patient.isRealRecording, true);
  assert.ok(patient.sessionResult, 'sessionResult must be included');
});

// ── 9. Aggregation helpers ────────────────────────────────────────────────────
test('aggregateHourly — buckets records by UTC hour', () => {
  const timeSeries = [
    { timestamp: '2018-12-05T09:00:00Z', value: 70, unixTs: 0, lineNumber: 1 },
    { timestamp: '2018-12-05T09:30:00Z', value: 80, unixTs: 0, lineNumber: 2 },
    { timestamp: '2018-12-05T10:00:00Z', value: 90, unixTs: 0, lineNumber: 3 },
  ];
  const hourly = aggregateHourly(timeSeries);
  assert.equal(hourly.length, 2);
  assert.equal(hourly[0].count, 2); // 09:00 and 09:30
  assert.equal(hourly[1].count, 1); // 10:00
});

test('aggregateDaily — no entry for periods with no data', () => {
  const timeSeries = [
    { timestamp: '2018-12-05T09:00:00Z', value: 70, unixTs: 0, lineNumber: 1 },
    { timestamp: '2018-12-07T09:00:00Z', value: 75, unixTs: 0, lineNumber: 2 },
  ];
  const daily = aggregateDaily(timeSeries);
  assert.equal(daily.length, 2, 'Only 2 days have data — dec 6 must not appear');
  assert.ok(!daily.map(d => d.isoDate).includes('2018-12-06'), 'Dec 6 has no data and must not be fabricated');
});

// ── 10. Graceful empty/bad file handling ─────────────────────────────────────
test('parseEmpaticaSignalCsv — handles empty file gracefully', () => {
  const result = parseEmpaticaSignalCsv('', 'RESTING_HR', 'HR.csv');
  assert.equal(result.timeSeries.length, 0);
  assert.ok(result.invalidRows.length > 0, 'Should have at least one invalid row describing the problem');
});

test('parseEmpaticaSignalCsv — handles file with only header rows', () => {
  const csv = `${BASE_TS}\n1.0\n`; // 2 header rows, no data
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');
  assert.equal(result.timeSeries.length, 0);
  assert.equal(result.metadata.validCount, 0);
});

test('parseEmpaticaIbiCsv — handles empty IBI file gracefully', () => {
  const result = parseEmpaticaIbiCsv('', 'IBI.csv');
  assert.equal(result.timeSeries.length, 0);
});

test('parseEmpaticaSignalCsv — handles invalid start timestamp gracefully', () => {
  const result = parseEmpaticaSignalCsv('not_a_number\n1.0\n72.0', 'RESTING_HR', 'HR.csv');
  assert.equal(result.timeSeries.length, 0);
  assert.ok(result.invalidRows[0].reason.includes('Invalid start timestamp'));
});

// ── 11. Dataset limitations documented ───────────────────────────────────────
test('parseE4Session — session result includes clinicalLimitations array', () => {
  const csv = makeStandardCsv(BASE_TS, 1.0, [70, 72]);
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: csv } });

  assert.ok(Array.isArray(session.clinicalLimitations));
  assert.ok(session.clinicalLimitations.length >= 3);
  assert.ok(session.clinicalLimitations.some(l => l.toLowerCase().includes('multi-day')));
  assert.ok(session.clinicalLimitations.some(l => l.toLowerCase().includes('not a clinical')));
});

test('parseE4Session — unavailableSignals lists what is absent', () => {
  const csv = makeStandardCsv(BASE_TS, 1.0, [70]);
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: csv } });

  assert.ok(session.unavailableSignals.includes('SPO2'));
  assert.ok(session.unavailableSignals.includes('PAIN_SCORE'));
  assert.ok(session.unavailableSignals.includes('GAIT_VELOCITY'));
});

// ── 12. Stats accuracy ────────────────────────────────────────────────────────
test('parseEmpaticaSignalCsv — stats are correct for known HR values', () => {
  const values = [60, 65, 70, 75, 80];
  const csv = makeStandardCsv(BASE_TS, 1.0, values);
  const result = parseEmpaticaSignalCsv(csv, 'RESTING_HR', 'HR.csv');
  const s = result.metadata.stats;

  assert.equal(s.min, 60);
  assert.equal(s.max, 80);
  assert.equal(s.mean, 70);
  assert.equal(s.median, 70);
  assert.equal(s.count, 5);
});

// ── 13. Dataset source metadata ───────────────────────────────────────────────
test('parseE4Session — datasetSource includes DOI, licence, and URL', () => {
  const csv = makeStandardCsv(BASE_TS, 1.0, [70]);
  const session = parseE4Session({ subjectId: 'S1', sessionLabel: 'Final', signals: { HR: csv } });

  assert.ok(session.datasetSource.doi, 'DOI must be present');
  assert.ok(session.datasetSource.licence, 'Licence must be present');
  assert.ok(session.datasetSource.url.includes('physionet.org'), 'URL must reference PhysioNet');
  assert.equal(session.datasetSource.device, 'Empatica E4 wristband');
});
