/**
 * @file health-intelligence-layer.js
 * @description Longitudinal Health Intelligence Layer Orchestrator.
 * Combines Baseline Engine, Deviation Detector, Contextual Signal Fuser, 
 * and Clinical Observation Generator into a unified, modular pipeline.
 */

import { BaselineEngine } from './baseline-engine.js';
import { DeviationDetector } from './deviation-detector.js';
import { ContextualSignalFuser } from './context-fuser.js';
import { ClinicalObservationGenerator } from './observation-generator.js';

export class LongitudinalHealthIntelligenceLayer {
  /**
   * @param {Object} [config]
   * @param {Object} [config.baselineOptions]
   * @param {Object} [config.deviationOptions]
   * @param {Object} [config.fuserOptions]
   * @param {Object} [config.observationOptions]
   */
  constructor(config = {}) {
    this.baselineEngine = new BaselineEngine(config.baselineOptions);
    this.deviationDetector = new DeviationDetector(config.deviationOptions);
    this.contextFuser = new ContextualSignalFuser(config.fuserOptions);
    this.observationGenerator = new ClinicalObservationGenerator(config.observationOptions);
  }

  /**
   * Analyzes longitudinal patient telemetry and clinical context to produce complete intelligence report.
   * @param {Object} input
   * @param {Object} input.patient - Patient demographics & clinical metadata
   * @param {string} input.patient.id
   * @param {string} input.patient.name
   * @param {number} [input.patient.postOpDay]
   * @param {string[]} [input.patient.medications]
   * @param {string[]} [input.patient.comorbidities]
   * @param {boolean} [input.patient.inActiveExercise]
   * @param {Object.<string, Array<{timestamp: string|Date, value: number}>>} input.telemetryData - Map of signal key -> time series
   * @param {Object.<string, number>} [input.latestReadings] - Map of signal key -> latest observed value
   * @returns {Object} Complete Longitudinal Intelligence Analysis
   */
  analyzePatient(input) {
    const { patient = {}, telemetryData = {}, latestReadings = {} } = input;
    
    const baselineProfiles = {};
    const detectedDeviations = {};
    const trends = {};

    // 1. Process each signal through Baseline Engine & Deviation Detector
    for (const [signalKey, timeSeries] of Object.entries(telemetryData)) {
      if (!timeSeries || timeSeries.length === 0) continue;

      // Build baseline profile (using all available history or window)
      const profile = this.baselineEngine.buildMetricBaselineProfile(timeSeries, {
        signalName: signalKey
      });
      baselineProfiles[signalKey] = profile;

      // Calculate recent trend slope (last 7 readings)
      const recentWindow = timeSeries.slice(-7);
      trends[signalKey] = this.deviationDetector.calculateTrendSlope(recentWindow);

      // Determine latest observed value (from latestReadings map or end of timeSeries)
      const latestVal = latestReadings[signalKey] !== undefined 
        ? latestReadings[signalKey] 
        : timeSeries[timeSeries.length - 1].value;

      // Detect acute deviation for latest value
      const latestTimestamp = timeSeries[timeSeries.length - 1]?.timestamp;
      const hourOfDay = latestTimestamp ? new Date(latestTimestamp).getUTCHours() : 12;
      const timeOfDay = hourOfDay < 6 ? 'NIGHT' : hourOfDay < 12 ? 'MORNING' : hourOfDay < 18 ? 'AFTERNOON' : 'EVENING';

      const acuteDev = this.deviationDetector.detectAcuteDeviation(latestVal, profile, timeOfDay);

      // Detect sustained multi-day shift
      const sustainedDev = this.deviationDetector.detectSustainedShift(recentWindow, profile);

      detectedDeviations[signalKey] = {
        ...acuteDev,
        sustainedShift: sustainedDev,
        trend: trends[signalKey]
      };

      // Also evaluate trajectory lag if post-op day is available
      if (patient.postOpDay) {
        const trajectoryEval = this.deviationDetector.evaluateTrajectoryLag(
          latestVal,
          patient.postOpDay,
          signalKey,
          this.baselineEngine
        );
        detectedDeviations[signalKey].trajectoryLag = trajectoryEval;
      }
    }

    // 2. Fuse all detected deviations with patient context
    const fuserReport = this.contextFuser.fuseSignalsAndContext({
      signalDeviations: detectedDeviations,
      patientContext: {
        postOpDay: patient.postOpDay,
        medications: patient.medications || [],
        comorbidities: patient.comorbidities || [],
        inActiveExercise: patient.inActiveExercise || false
      }
    });

    // 3. Generate Explainable Clinical Observation & Insights
    const clinicalObservation = this.observationGenerator.generateClinicalObservation(
      fuserReport,
      patient
    );

    return {
      patient,
      analysisTimestamp: new Date().toISOString(),
      baselineProfiles,
      detectedDeviations,
      trends,
      fuserReport,
      clinicalObservation
    };
  }
}
