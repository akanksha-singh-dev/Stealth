/**
 * @file intelligence-layer.test.js
 * @description Comprehensive Unit Test Suite for Longitudinal Health Intelligence Layer
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BaselineEngine } from '../src/core/baseline-engine.js';
import { DeviationDetector } from '../src/core/deviation-detector.js';
import { ContextualSignalFuser } from '../src/core/context-fuser.js';
import { ClinicalObservationGenerator } from '../src/core/observation-generator.js';
import { LongitudinalHealthIntelligenceLayer } from '../src/core/health-intelligence-layer.js';

test('BaselineEngine - Statistical Calculations & Bounds', () => {
  const engine = new BaselineEngine({ madMultiplier: 2.0 });
  const sampleData = [62, 64, 63, 65, 62, 64, 63, 66, 62, 63, 90]; // includes outlier 90
  
  const stats = engine.calculateStats(sampleData);
  assert.equal(stats.count, 11);
  assert.equal(stats.median, 63);
  assert.ok(stats.mad >= 1.0);
  
  const profile = engine.buildMetricBaselineProfile(
    sampleData.map((v, i) => ({ timestamp: new Date(2026, 8, 1 + i).toISOString(), value: v })),
    { signalName: 'RESTING_HR', unit: 'bpm' }
  );

  assert.equal(profile.signalName, 'RESTING_HR');
  assert.ok(profile.normalRange.lowerBound < 63);
  assert.ok(profile.normalRange.upperBound > 63);
  assert.ok(profile.normalRange.upperBound < 90, 'Outlier should not blow up robust MAD bounds');
});

test('BaselineEngine - Circadian Rhythm Partitioning', () => {
  const engine = new BaselineEngine();
  const readings = [
    { timestamp: '2026-09-20T03:30:00Z', value: 55 }, // NIGHT
    { timestamp: '2026-09-20T08:30:00Z', value: 68 }, // MORNING
    { timestamp: '2026-09-20T14:30:00Z', value: 74 }, // AFTERNOON
    { timestamp: '2026-09-20T20:30:00Z', value: 62 }  // EVENING
  ];

  const circadian = engine.computeCircadianBaseline(readings);
  assert.equal(circadian.NIGHT.median, 55);
  assert.equal(circadian.MORNING.median, 68);
  assert.equal(circadian.AFTERNOON.median, 74);
  assert.equal(circadian.EVENING.median, 62);
});

test('DeviationDetector - Modified Z-Score & Anomaly Classification', () => {
  const detector = new DeviationDetector({ modifiedZWarning: 2.5, modifiedZCritical: 3.5 });
  
  // Normal value
  const zNormal = detector.calculateModifiedZScore(64, 63, 1.5);
  assert.ok(Math.abs(zNormal) < 1.0);

  // Critical spike value
  const zSpike = detector.calculateModifiedZScore(85, 63, 1.5);
  assert.ok(zSpike > 3.5, 'Spike of 85 vs median 63 should exceed modified Z critical threshold');

  const dummyBaselineProfile = {
    signalName: 'RESTING_HR',
    stats: { median: 63, mad: 1.5 },
    normalRange: { lowerBound: 58, upperBound: 68 }
  };

  const acuteResult = detector.detectAcuteDeviation(88, dummyBaselineProfile);
  assert.equal(acuteResult.isDeviation, true);
  assert.equal(acuteResult.severity, 'CRITICAL');
  assert.equal(acuteResult.direction, 'HIGH');
});

test('DeviationDetector - Physiological Artifact Rejection', () => {
  const detector = new DeviationDetector();
  const isNoise = detector.isArtifactNoise(250, 'RESTING_HR');
  assert.equal(isNoise, true, 'HR of 250 bpm should be flagged as non-physiological noise');

  const dummyBaselineProfile = {
    signalName: 'RESTING_HR',
    stats: { median: 65, mad: 2 },
    normalRange: { lowerBound: 60, upperBound: 70 }
  };

  const res = detector.detectAcuteDeviation(250, dummyBaselineProfile);
  assert.equal(res.severity, 'ARTIFACT_NOISE');
  assert.equal(res.isDeviation, false);
});

test('DeviationDetector - Trend Slope & Linear Regression', () => {
  const detector = new DeviationDetector();
  const timeSeries = [
    { timestamp: '2026-09-01T00:00:00Z', value: 70 },
    { timestamp: '2026-09-02T00:00:00Z', value: 72 },
    { timestamp: '2026-09-03T00:00:00Z', value: 74 },
    { timestamp: '2026-09-04T00:00:00Z', value: 76 },
    { timestamp: '2026-09-05T00:00:00Z', value: 78 }
  ];

  const trend = detector.calculateTrendSlope(timeSeries);
  assert.equal(trend.direction, 'INCREASING');
  assert.ok(trend.slope > 1.8 && trend.slope < 2.2, 'Slope should be approximately 2.0 / day');
  assert.ok(trend.rSquared > 0.95);
});

test('ContextualSignalFuser - Exercise Context Adjustment & Infection Synergy', () => {
  const fuser = new ContextualSignalFuser();

  const deviations = {
    'RESTING_HR': { isDeviation: true, severity: 'WARNING', direction: 'HIGH', observedValue: 92, baselineMedian: 64, deviationDelta: 28 },
    'TEMPERATURE': { isDeviation: true, severity: 'WARNING', direction: 'HIGH', observedValue: 38.2, baselineMedian: 36.6, deviationDelta: 1.6 },
    'HRV': { isDeviation: true, severity: 'WARNING', direction: 'LOW', observedValue: 22, baselineMedian: 48, deviationDelta: -26 }
  };

  // Case A: Resting Infection Pattern
  const infectionReport = fuser.fuseSignalsAndContext({
    signalDeviations: deviations,
    patientContext: { postOpDay: 7, inActiveExercise: false }
  });

  assert.equal(infectionReport.synergyIndices.infectionIndex.isFlagged, true);
  assert.equal(infectionReport.trajectoryClassification, 'SUBACUTE_DETERIORATION');
  assert.ok(infectionReport.compositeRiskScore >= 75);

  // Case B: Active Physical Therapy Exercise Context (HR spike reclassified)
  const exerciseReport = fuser.fuseSignalsAndContext({
    signalDeviations: {
      'RESTING_HR': { isDeviation: true, severity: 'WARNING', direction: 'HIGH', observedValue: 120, baselineMedian: 65, deviationDelta: 55 }
    },
    patientContext: { postOpDay: 7, inActiveExercise: true }
  });

  assert.equal(exerciseReport.normalizedDeviations['RESTING_HR'].adjustedSeverity, 'NORMAL_EXERCISE_RESPONSE');
  assert.equal(exerciseReport.riskLevel, 'LOW');
});

test('ClinicalObservationGenerator - Natural Language & FHIR R4 Bundle', () => {
  const generator = new ClinicalObservationGenerator();
  const dummyFuserReport = {
    compositeRiskScore: 82,
    riskLevel: 'CRITICAL',
    trajectoryClassification: 'SUBACUTE_DETERIORATION',
    primaryDriver: 'Systemic Infection / Inflammation Risk',
    summaryMessage: 'High priority alert: Cross-signal pattern indicates acute risk of infection.',
    synergyIndices: {
      infectionIndex: { isFlagged: true, score: 82, name: 'Systemic Infection / Inflammation Risk' },
      mechanicalJointIndex: { isFlagged: false, score: 10 },
      cardiacDecompIndex: { isFlagged: false, score: 0 },
      recoveryStallIndex: { isFlagged: false, score: 15 }
    },
    normalizedDeviations: {
      'TEMPERATURE': { observedValue: 38.4, baselineMedian: 36.6, deviationDelta: 1.8, zScore: 3.8, severity: 'CRITICAL', isDeviation: true },
      'RESTING_HR': { observedValue: 94, baselineMedian: 64, deviationDelta: 30, zScore: 4.1, severity: 'CRITICAL', isDeviation: true }
    },
    patientContext: { postOpDay: 8, medications: ['Acetaminophen'] }
  };

  const observation = generator.generateClinicalObservation(dummyFuserReport, { id: 'PAT-402', name: 'Jane Doe', postOpDay: 8 });

  assert.ok(observation.reportId.startsWith('OBS-PAT-402'));
  assert.ok(observation.headline.includes('CRITICAL'));
  assert.ok(observation.narrativeSummary.includes('Jane Doe') || observation.narrativeSummary.includes('TEMPERATURE'));
  assert.ok(observation.recommendedActions.some(a => a.category === 'DIAGNOSTIC_LABS'));
  assert.equal(observation.fhirResource.resourceType, 'RiskAssessment');
  assert.equal(observation.fhirResource.subject.reference, 'Patient/PAT-402');
});

test('LongitudinalHealthIntelligenceLayer - End to End Pipeline', () => {
  const layer = new LongitudinalHealthIntelligenceLayer();

  // Create mock 10-day telemetry series for a Post-Op TKA patient undergoing early infection flare
  const telemetryData = {
    'RESTING_HR': Array.from({ length: 14 }, (_, i) => ({
      timestamp: new Date(2026, 8, 1 + i, 8).toISOString(),
      value: i < 10 ? 62 + (i % 3) : 64 + (i - 9) * 8 // Days 11..14 spike from 64 to 96
    })),
    'TEMPERATURE': Array.from({ length: 14 }, (_, i) => ({
      timestamp: new Date(2026, 8, 1 + i, 8).toISOString(),
      value: i < 10 ? 36.5 + (i % 2) * 0.2 : 36.7 + (i - 9) * 0.5 // Days 11..14 spike to 38.7
    })),
    'HRV': Array.from({ length: 14 }, (_, i) => ({
      timestamp: new Date(2026, 8, 1 + i, 8).toISOString(),
      value: i < 10 ? 48 - (i % 3) : 45 - (i - 9) * 7 // Days 11..14 drop to 17 ms
    }))
  };

  const result = layer.analyzePatient({
    patient: {
      id: 'P-99',
      name: 'John Smith',
      postOpDay: 14,
      medications: ['Metoprolol']
    },
    telemetryData
  });

  assert.ok(result.baselineProfiles['RESTING_HR']);
  assert.equal(result.detectedDeviations['RESTING_HR'].isDeviation, true);
  assert.ok(result.fuserReport.compositeRiskScore > 70);
  assert.equal(result.clinicalObservation.patientId, 'P-99');
  assert.ok(result.clinicalObservation.recommendedActions.length > 0);
});
