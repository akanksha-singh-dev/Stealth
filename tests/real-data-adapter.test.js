/**
 * @file real-data-adapter.test.js
 * @description Automated tests for Phase 6: real-data ingestion, normalisation,
 *   baseline calculations, trend analysis, report aggregation, mode isolation,
 *   and graceful handling of short/invalid recordings.
 *
 * Run with: node --test tests/real-data-adapter.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHRCsv,
  toIntelligencePipelineInput,
  buildRecordingPatientObject,
  aggregateHourly,
  aggregateDaily,
} from '../src/data/real-data-adapter.js';

import { BaselineEngine }    from '../src/core/baseline-engine.js';
import { DeviationDetector } from '../src/core/deviation-detector.js';
import { LongitudinalHealthIntelligenceLayer } from '../src/core/health-intelligence-layer.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Build minimal CSV text that mimics the actual HR.csv format:
 *   <unix_float>,<hr_float>
 * No header row.
 */
function makeCsvText(rows) {
  return rows.map(([ts, hr]) => `${ts},${hr}`).join('\n');
}

// Real-like base timestamp: 2021-12-03 04:09:53 UTC (actual recording start)
const BASE_UNIX = 1638504593.0;
const INTERVAL  = 5; // seconds between rows in test data

/** Generate N rows of valid HR data starting at BASE_UNIX */
function genRows(n, hrFn = (i) => 65.0 + Math.sin(i * 0.1) * 5) {
  return Array.from({ length: n }, (_, i) => [
    BASE_UNIX + i * INTERVAL,
    Number(hrFn(i).toFixed(1)),
  ]);
}

// ── Test Suite ───────────────────────────────────────────────────────────────

// ── 1. CSV Parsing ──────────────────────────────────────────────────────────
test('parseHRCsv — parses actual HR.csv format (unix_float,hr_float)', () => {
  const csv = makeCsvText([
    [1638504593.0297956, 69.0],
    [1638504598.0297956, 68.0],
    [1638504603.0297956, 67.0],
  ]);
  const result = parseHRCsv(csv, 'HR.csv');

  assert.equal(result.metadata.validCount, 3);
  assert.equal(result.metadata.invalidCount, 0);
  assert.equal(result.timeSeries.length, 3);
  assert.equal(result.rawRows.length, 3);
  assert.equal(result.metadata.filename, 'HR.csv');
  assert.equal(result.metadata.signalKey, 'RESTING_HR');
  assert.equal(result.metadata.unit, 'bpm');
  assert.equal(result.metadata.source, 'PhysioNet-Empatica-HR-CSV');
});

// ── 2. Timestamp generation ─────────────────────────────────────────────────
test('parseHRCsv — converts Unix timestamps to correct ISO-8601 UTC strings', () => {
  const ts = 1638504593.0297956;
  const csv = makeCsvText([[ts, 70.0]]);
  const result = parseHRCsv(csv);
  const rec = result.timeSeries[0];

  // Verify the ISO string round-trips to the same Unix epoch
  const reconverted = new Date(rec.timestamp).getTime() / 1000;
  assert.ok(Math.abs(reconverted - ts) < 1, `ISO round-trip error: got ${reconverted}, expected ${ts}`);

  // Verify the year is 2021 (actual date of recording)
  assert.ok(rec.timestamp.startsWith('2021-'), `Expected 2021 timestamp, got: ${rec.timestamp}`);

  // Verify it is NOT midnight (04:09 UTC is the recording start)
  assert.ok(!rec.timestamp.includes('T00:00:00'), 'Timestamp must not be midnight');
});

// ── 3. Sequential timestamps from interval data ─────────────────────────────
test('parseHRCsv — generates monotonically increasing timestamps', () => {
  const rows = genRows(10);
  const result = parseHRCsv(makeCsvText(rows));
  const times = result.timeSeries.map(r => r.unixTs);

  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], `Timestamp at index ${i} (${times[i]}) should be > ${times[i - 1]}`);
  }
});

// ── 4. HR values and units ───────────────────────────────────────────────────
test('parseHRCsv — preserves HR values correctly', () => {
  const csv = makeCsvText([[BASE_UNIX, 72.0], [BASE_UNIX + 5, 73.5]]);
  const result = parseHRCsv(csv);
  assert.equal(result.timeSeries[0].value, 72.0);
  assert.equal(result.timeSeries[1].value, 73.5);
  assert.equal(result.metadata.unit, 'bpm');
  assert.equal(result.metadata.hrStats.min, 72.0);
  assert.equal(result.metadata.hrStats.max, 73.5);
});

// ── 5. Invalid and missing measurements ─────────────────────────────────────
test('parseHRCsv — rejects non-physiological HR values', () => {
  const csv = [
    `${BASE_UNIX},250.0`,        // above 220 bpm limit
    `${BASE_UNIX + 5},20.0`,     // below 25 bpm limit
    `${BASE_UNIX + 10},70.0`,    // valid
    `${BASE_UNIX + 15},-5.0`,    // negative
  ].join('\n');
  const result = parseHRCsv(csv);

  assert.equal(result.metadata.validCount, 1, 'Only the 70.0 reading is valid');
  assert.equal(result.metadata.invalidCount, 3, '3 readings should be rejected');
  assert.equal(result.timeSeries[0].value, 70.0);
  assert.ok(result.invalidRows.some(r => r.reason.includes('250') || r.reason.includes('physiological')));
});

test('parseHRCsv — rejects malformed rows (wrong column count)', () => {
  const csv = [
    `${BASE_UNIX},70.0`,    // valid
    `not_a_number,70.0`,   // bad timestamp
    `${BASE_UNIX + 5}`,    // missing HR column
    `,70.0`,               // empty timestamp
    `${BASE_UNIX + 10},bad_hr`, // bad HR
  ].join('\n');
  const result = parseHRCsv(csv);

  assert.equal(result.metadata.validCount, 1);
  assert.ok(result.metadata.invalidCount >= 4);
});

test('parseHRCsv — skips blank lines without treating them as invalid', () => {
  const csv = `${BASE_UNIX},70.0\n\n${BASE_UNIX + 5},72.0\n\n`;
  const result = parseHRCsv(csv);
  assert.equal(result.metadata.validCount, 2);
  assert.equal(result.metadata.invalidCount, 0, 'Blank lines should not be counted as invalid');
});

test('parseHRCsv — rejects future and epoch-zero timestamps', () => {
  const csv = [
    `0,70.0`,                       // epoch zero
    `9999999999,70.0`,              // year 2286 — out of range
    `${BASE_UNIX},68.0`,            // valid
  ].join('\n');
  const result = parseHRCsv(csv);
  assert.equal(result.metadata.validCount, 1);
  assert.equal(result.metadata.invalidCount, 2);
});

// ── 6. Metadata fields ──────────────────────────────────────────────────────
test('parseHRCsv — calculates correct duration and average interval', () => {
  const rows = genRows(11); // 11 rows, 10 intervals of INTERVAL seconds each
  const result = parseHRCsv(makeCsvText(rows));

  const expectedDuration = 10 * INTERVAL;
  assert.ok(Math.abs(result.metadata.durationSeconds - expectedDuration) < 0.5,
    `Duration should be ~${expectedDuration}s, got ${result.metadata.durationSeconds}`);
  assert.ok(Math.abs(result.metadata.avgIntervalSeconds - INTERVAL) < 0.5,
    `Avg interval should be ~${INTERVAL}s, got ${result.metadata.avgIntervalSeconds}`);
});

test('parseHRCsv — start and end ISO match first/last valid timestamps', () => {
  const rows = genRows(5);
  const result = parseHRCsv(makeCsvText(rows));
  const first = new Date(result.metadata.startISO).getTime() / 1000;
  const last  = new Date(result.metadata.endISO).getTime()  / 1000;
  assert.ok(Math.abs(first - rows[0][0]) < 1, 'startISO should match first timestamp');
  assert.ok(Math.abs(last  - rows[4][0]) < 1, 'endISO should match last timestamp');
});

// ── 7. Baseline calculations using only available history ───────────────────
test('Baseline from HR recording — uses only available observations', () => {
  const rows = genRows(50, i => 65 + (i % 5)); // 50 valid rows
  const result = parseHRCsv(makeCsvText(rows));
  assert.equal(result.timeSeries.length, 50);

  const engine = new BaselineEngine({ madMultiplier: 2.5 });
  const profile = engine.buildMetricBaselineProfile(
    result.timeSeries,
    { signalName: 'RESTING_HR', unit: 'bpm' }
  );

  assert.ok(profile.normalRange.median >= 65, 'Median should reflect actual data');
  assert.ok(profile.normalRange.upperBound < 220, 'Upper bound should not blow up to physiological max');
  assert.ok(profile.normalRange.lowerBound > 25, 'Lower bound should not drop to physiological min');
  assert.equal(profile.stats.count, 50);
});

test('Baseline note reflects short recording window', () => {
  const rows = genRows(20); // < 24 hours of data
  const result = parseHRCsv(makeCsvText(rows));
  // Duration is only 20 * 5s = 100 seconds
  assert.ok(
    result.metadata.baselineNote.includes('less than one full day') ||
    result.metadata.baselineNote.includes('shorter than 1 hour') ||
    result.metadata.baselineNote.includes('Insufficient'),
    `Baseline note should acknowledge short window. Got: "${result.metadata.baselineNote}"`
  );
});

test('Baseline not claimed as 14-day if recording is shorter', () => {
  const rows = genRows(100); // ~8 minutes, certainly not 14 days
  const result = parseHRCsv(makeCsvText(rows));
  assert.ok(!result.metadata.baselineNote.includes('14-day'),
    'Should not claim 14-day baseline for a short recording');
});

// ── 8. Trend calculations using timestamped records ─────────────────────────
test('Trend calculation on HR time series with real timestamps', () => {
  // Create a clearly increasing trend: each 5s interval adds 0.5 bpm
  const rows = Array.from({ length: 14 }, (_, i) => [
    BASE_UNIX + i * 86400, // one per day (simulate longer span for trend)
    60 + i * 2,            // increases by 2/day
  ]);
  const result = parseHRCsv(makeCsvText(rows));

  const detector = new DeviationDetector();
  const trend    = detector.calculateTrendSlope(result.timeSeries);

  assert.equal(trend.direction, 'INCREASING');
  assert.ok(trend.slope > 1.5 && trend.slope < 2.5,
    `Slope should be ~2.0 bpm/day, got ${trend.slope}`);
  assert.ok(trend.rSquared > 0.95, `R² should be high for linear data, got ${trend.rSquared}`);
});

// ── 9. Daily and weekly report aggregation ──────────────────────────────────
test('aggregateHourly — groups records by UTC hour correctly', () => {
  // Build records across 3 different hours
  const hours = [4, 5, 6];
  const timeSeries = hours.flatMap(h =>
    Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2021, 11, 3, h, i * 5, 0)).toISOString(),
      value: 60 + h,
      unixTs: 0,
      lineNumber: 1,
    }))
  );
  const hourly = aggregateHourly(timeSeries);

  assert.equal(hourly.length, 3);
  assert.equal(hourly[0].count, 10);
  assert.equal(hourly[0].mean, 64);   // hour 4 → HR=64
  assert.equal(hourly[1].mean, 65);   // hour 5 → HR=65
  assert.equal(hourly[2].mean, 66);   // hour 6 → HR=66
});

test('aggregateDaily — groups records by UTC date correctly', () => {
  const dates = ['2021-12-03', '2021-12-04'];
  const timeSeries = dates.flatMap((d, di) =>
    Array.from({ length: 5 }, (_, i) => ({
      timestamp: `${d}T0${i}:00:00Z`,
      value: 70 + di * 10,
      unixTs: 0,
      lineNumber: 1,
    }))
  );
  const daily = aggregateDaily(timeSeries);

  assert.equal(daily.length, 2);
  assert.equal(daily[0].isoDate, '2021-12-03');
  assert.equal(daily[0].mean, 70);
  assert.equal(daily[1].isoDate, '2021-12-04');
  assert.equal(daily[1].mean, 80);
});

test('aggregateDaily — produces no entries for periods with no data', () => {
  // Sparse: only records on days 1 and 3 (not day 2)
  const timeSeries = [
    { timestamp: '2021-12-03T08:00:00Z', value: 65, unixTs: 0, lineNumber: 1 },
    { timestamp: '2021-12-05T08:00:00Z', value: 70, unixTs: 0, lineNumber: 2 },
  ];
  const daily = aggregateDaily(timeSeries);
  assert.equal(daily.length, 2, 'Should have exactly 2 days — no fabricated middle day');
  const dates = daily.map(d => d.isoDate);
  assert.ok(!dates.includes('2021-12-04'), 'Day 4 has no data and must not appear in report');
});

// ── 10. Pipeline input conversion ───────────────────────────────────────────
test('toIntelligencePipelineInput — produces RESTING_HR telemetry map only', () => {
  const rows = genRows(30);
  const adapter = parseHRCsv(makeCsvText(rows));
  const { telemetryData, availableSignals } = toIntelligencePipelineInput(adapter);

  assert.ok('RESTING_HR' in telemetryData, 'telemetryData must have RESTING_HR key');
  assert.equal(availableSignals.length, 1, 'Only one signal should be listed as available');
  assert.equal(availableSignals[0], 'RESTING_HR');
  assert.equal(telemetryData['RESTING_HR'].length, 30);

  // Verify schema: each record has timestamp and value
  telemetryData['RESTING_HR'].forEach((r, i) => {
    assert.ok('timestamp' in r, `Record ${i} must have timestamp`);
    assert.ok('value' in r, `Record ${i} must have value`);
    assert.ok(typeof r.value === 'number', `Record ${i} value must be a number`);
    assert.ok(!isNaN(new Date(r.timestamp).getTime()), `Record ${i} timestamp must be valid ISO`);
  });
});

test('toIntelligencePipelineInput — does not include Temperature, HRV, or other signals', () => {
  const rows = genRows(10);
  const adapter = parseHRCsv(makeCsvText(rows));
  const { telemetryData } = toIntelligencePipelineInput(adapter);

  const FABRICATED_SIGNALS = ['TEMPERATURE', 'HRV', 'SPO2', 'PAIN_SCORE', 'GAIT_VELOCITY',
    'DAILY_STEPS', 'KNEE_FLEXION_ROM', 'SWELLING_SCORE', 'BODY_WEIGHT'];
  FABRICATED_SIGNALS.forEach(sig => {
    assert.ok(!(sig in telemetryData), `Signal ${sig} must NOT be fabricated in HR-only pipeline input`);
  });
});

// ── 11. Demo/Real isolation — one recording must not contaminate another ─────
test('Multiple recordings are stored and retrieved independently', () => {
  const csv1 = makeCsvText(genRows(20, () => 60.0));
  const csv2 = makeCsvText(genRows(20, () => 90.0));

  const rec1 = parseHRCsv(csv1, 'recording1.csv');
  const rec2 = parseHRCsv(csv2, 'recording2.csv');

  // Verify they have separate, non-overlapping data
  const vals1 = rec1.timeSeries.map(r => r.value);
  const vals2 = rec2.timeSeries.map(r => r.value);

  assert.ok(vals1.every(v => v === 60.0), 'Recording 1 should have only HR=60');
  assert.ok(vals2.every(v => v === 90.0), 'Recording 2 should have only HR=90');
  assert.equal(rec1.metadata.filename, 'recording1.csv');
  assert.equal(rec2.metadata.filename, 'recording2.csv');

  // Verify baselines are separate
  const engine = new BaselineEngine();
  const profile1 = engine.buildMetricBaselineProfile(rec1.timeSeries, { signalName: 'RESTING_HR', unit: 'bpm' });
  const profile2 = engine.buildMetricBaselineProfile(rec2.timeSeries, { signalName: 'RESTING_HR', unit: 'bpm' });

  assert.ok(profile1.normalRange.median < 70, 'Rec1 baseline should reflect HR ~60');
  assert.ok(profile2.normalRange.median > 80, 'Rec2 baseline should reflect HR ~90');
  assert.ok(profile1.normalRange.median !== profile2.normalRange.median,
    'Baselines from different recordings must not be identical');
});

// ── 12. Graceful handling of short recordings ───────────────────────────────
test('parseHRCsv — handles single-row recording gracefully', () => {
  const csv = `${BASE_UNIX},70.0`;
  const result = parseHRCsv(csv);

  assert.equal(result.metadata.validCount, 1);
  assert.equal(result.metadata.durationSeconds, 0);
  assert.equal(result.metadata.avgIntervalSeconds, null);
  assert.ok(result.metadata.baselineNote.includes('Insufficient'));
});

test('parseHRCsv — handles empty CSV gracefully', () => {
  const result = parseHRCsv('');
  assert.equal(result.metadata.validCount, 0);
  assert.equal(result.metadata.invalidCount, 0);
  assert.equal(result.timeSeries.length, 0);
  assert.equal(result.metadata.startISO, null);
  assert.equal(result.metadata.endISO, null);
});

test('parseHRCsv — handles all-invalid CSV gracefully (no valid rows)', () => {
  const csv = ['999,999.0', '-1,70.0', 'garbage'].join('\n');
  const result = parseHRCsv(csv);
  assert.equal(result.metadata.validCount, 0);
  assert.ok(result.metadata.invalidCount >= 2);
});

// ── 13. Pipeline integration with HR-only data ──────────────────────────────
test('Intelligence pipeline runs on HR-only recording without crashing', () => {
  const rows = genRows(50, i => 65 + (i % 10));
  const adapter = parseHRCsv(makeCsvText(rows));
  const { telemetryData } = toIntelligencePipelineInput(adapter);
  const patientObj = buildRecordingPatientObject(adapter.metadata, 'TEST-001');

  const layer = new LongitudinalHealthIntelligenceLayer();
  let result;
  assert.doesNotThrow(() => {
    result = layer.analyzePatient({ patient: patientObj, telemetryData });
  });

  assert.ok(result.baselineProfiles['RESTING_HR'], 'Baseline profile for RESTING_HR must exist');
  assert.ok(result.detectedDeviations, 'Deviations must be computed');
  assert.ok(result.clinicalObservation, 'Clinical observation must be generated');
  assert.ok(result.fuserReport, 'Fuser report must be generated');

  // Verify no fabricated signals appear in results
  const baselineKeys = Object.keys(result.baselineProfiles);
  assert.equal(baselineKeys.length, 1, 'Only one baseline profile should exist for HR-only recording');
  assert.equal(baselineKeys[0], 'RESTING_HR');
});

test('buildRecordingPatientObject — does not fabricate clinical data', () => {
  const rows = genRows(10);
  const adapter = parseHRCsv(makeCsvText(rows));
  const obj = buildRecordingPatientObject(adapter.metadata, 'REAL-1');

  assert.equal(obj.postOpDay, null, 'postOpDay must be null for real recording');
  assert.deepEqual(obj.medications, [], 'medications must be empty — not fabricated');
  assert.deepEqual(obj.comorbidities, [], 'comorbidities must be empty — not fabricated');
  assert.equal(obj.inActiveExercise, false);
  assert.equal(obj.isRealRecording, true);
  assert.ok(obj.recordingMeta, 'recordingMeta must be included');
});

// ── 14. Quality notes ────────────────────────────────────────────────────────
test('parseHRCsv — quality notes are honest about short recordings', () => {
  const rows = genRows(10); // short recording
  const result = parseHRCsv(makeCsvText(rows));
  const notes = result.metadata.qualityNotes;
  const hasShortNote = notes.some(n => n.includes('24 hours') || n.includes('60 valid'));
  assert.ok(hasShortNote, `Quality notes should mention short recording. Got: ${JSON.stringify(notes)}`);
});

test('parseHRCsv — quality notes report rejections accurately', () => {
  const csv = [
    `${BASE_UNIX},70.0`,      // valid
    `${BASE_UNIX + 5},999.0`, // invalid — above physiological max
    `${BASE_UNIX + 10},65.0`, // valid
  ].join('\n');
  const result = parseHRCsv(csv);
  assert.ok(result.metadata.qualityNotes.some(n => n.includes('1 row') || n.includes('rejected')),
    'Quality notes must report the rejected row');
});

// ── 15. Statistics accuracy ──────────────────────────────────────────────────
test('parseHRCsv — hrStats are correct for known values', () => {
  const values = [60, 65, 70, 75, 80];
  const rows   = values.map((v, i) => [BASE_UNIX + i * 5, v]);
  const result = parseHRCsv(makeCsvText(rows));
  const s = result.metadata.hrStats;

  assert.equal(s.min, 60);
  assert.equal(s.max, 80);
  assert.equal(s.mean, 70);
  assert.equal(s.median, 70);
  assert.equal(s.count, 5);
});
