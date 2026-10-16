/**
 * @file exam-stress-catalogue.js
 * @description Subject/session registry for the PhysioNet Wearable Exam Stress Dataset.
 *
 * SOURCE: "A Wearable Exam Stress Dataset for Predicting Cognitive Performance"
 *   Amin, Wickramasuriya, Faghih - PhysioNet, 2022  DOI: 10.13026/kvkb-aj90
 *   Licence: Open Data Commons Attribution License v1.0
 *   URL: https://physionet.org/content/wearable-exam-stress/1.0.0/
 *   Device: Empatica E4 wristband
 *
 * Only Subject S1 / Session "Final" files are bundled locally.
 * The full dataset has S1-S10 across Midterm1, Midterm2, Final sessions.
 *
 * HONEST LIMITATIONS (must be shown in the UI and all generated reports):
 *   - Each session is 1.5-3 hours -- NOT multi-day continuous monitoring.
 *   - Multi-day rehabilitation baselines CANNOT be derived from this data.
 *   - Dates are de-identified (date-shifted). Time-of-day order is preserved.
 *   - ROM, gait, steps, SpO2, pain score are NOT present in this dataset.
 *   - EDA is recorded but NOT mapped to any intelligence-layer signal.
 *   - Temperature readings below 25 C are device warm-up artefacts.
 *
 * REUSABILITY:
 *   The buildCatalogueEntry() factory and the provenance/sufficiency helpers
 *   are designed to be reused for future rehabilitation datasets without change.
 */

export const DATASET_SOURCE = {
  name:    'Wearable Exam Stress Dataset',
  shortId: 'PhysioNet-WearableExamStress-1.0.0',
  authors: 'Amin, Wickramasuriya, Faghih',
  year:    2022,
  doi:     '10.13026/kvkb-aj90',
  licence: 'Open Data Commons Attribution License v1.0',
  url:     'https://physionet.org/content/wearable-exam-stress/1.0.0/',
  device:  'Empatica E4 wristband',
  context: 'University exam-stress study (NOT a clinical or post-operative study)',
};

export const DATASET_LIMITATIONS = [
  'Exam-stress research dataset -- NOT a clinical rehabilitation dataset.',
  'Each session covers 1.5-3 hours. Multi-day rehabilitation baselines cannot be computed.',
  'Dates are de-identified (date-shifted). Time-of-day order is preserved.',
  'ROM, gait velocity, step count, SpO2, pain score, and body weight are absent.',
  'EDA (galvanic skin response) is recorded but not mapped to any intelligence signal.',
  'Temperature readings below 25 C are device warm-up artefacts and are excluded.',
  'Multi-day rehabilitation trend analysis is NOT available from this dataset.',
  'No clinical diagnosis or post-operative trajectory can be derived from this data.',
];

export const AVAILABLE_SIGNALS   = ['RESTING_HR', 'TEMPERATURE', 'HRV'];
export const UNAVAILABLE_SIGNALS = [
  'SPO2', 'PAIN_SCORE', 'DAILY_STEPS', 'GAIT_VELOCITY',
  'KNEE_FLEXION_ROM', 'SWELLING_SCORE', 'BODY_WEIGHT',
];

/** Minimum records needed before a session baseline is computed (≥30). */
export const MIN_RECORDS_FOR_BASELINE = 30;

/**
 * Build a normalised catalogue entry from a raw spec object.
 * This factory is the extension point for future rehabilitation datasets.
 *
 * @param {Object} spec - { subjectId, sessionLabel, displayName?, bundledLocally?, localBasePath? }
 * @returns {Object} SessionCatalogueEntry
 */
export function buildCatalogueEntry(spec) {
  const sid = spec.subjectId;
  const slabel = spec.sessionLabel;
  return {
    subjectId:          sid,
    sessionLabel:       slabel,
    sessionId:          `${sid}-${slabel}`,
    displayName:        spec.displayName || `Subject ${sid} -- ${slabel} Exam`,
    fileNames: {
      HR:   `${sid}_${slabel}_HR.csv`,
      TEMP: `${sid}_${slabel}_TEMP.csv`,
      IBI:  `${sid}_${slabel}_IBI.csv`,
      EDA:  `${sid}_${slabel}_EDA.csv`,
      BVP:  `${sid}_${slabel}_BVP.csv`,
      ACC:  `${sid}_${slabel}_ACC.csv`,
    },
    bundledLocally:     spec.bundledLocally ?? false,
    localBasePath:      spec.localBasePath  ?? null,
    availableSignals:   AVAILABLE_SIGNALS,
    unavailableSignals: UNAVAILABLE_SIGNALS,
    limitations:        DATASET_LIMITATIONS,
    datasetSource:      DATASET_SOURCE,
  };
}

/** All known subjects and sessions in the v1.0.0 dataset. */
export const SUBJECT_SESSION_CATALOGUE = [
  buildCatalogueEntry({
    subjectId: 'S1', sessionLabel: 'Final',
    displayName: 'S1 -- Final Exam (Bundled)',
    bundledLocally: true,
    localBasePath: 'real-datasets/wearable-exam-stress',
  }),
  buildCatalogueEntry({ subjectId: 'S1',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S1',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S2',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S2',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S2',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S3',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S3',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S3',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S4',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S4',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S4',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S5',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S5',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S5',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S6',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S6',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S6',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S7',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S7',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S7',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S8',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S8',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S8',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S9',  sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S9',  sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S9',  sessionLabel: 'Final' }),
  buildCatalogueEntry({ subjectId: 'S10', sessionLabel: 'Midterm1' }),
  buildCatalogueEntry({ subjectId: 'S10', sessionLabel: 'Midterm2' }),
  buildCatalogueEntry({ subjectId: 'S10', sessionLabel: 'Final' }),
];

/** Lookup a catalogue entry by sessionId (e.g. 'S1-Final'). */
export function getCatalogueEntry(sessionId) {
  return SUBJECT_SESSION_CATALOGUE.find(e => e.sessionId === sessionId) ?? null;
}

/** Return only the locally bundled sessions. */
export function getBundledSessions() {
  return SUBJECT_SESSION_CATALOGUE.filter(e => e.bundledLocally);
}

/**
 * Validate session attribution -- guards against mixing subjects or sessions.
 * @param {Object} sessionResult  - from parseE4Session()
 * @param {Object} catalogueEntry - from SUBJECT_SESSION_CATALOGUE
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateSessionAttribution(sessionResult, catalogueEntry) {
  const issues = [];
  if (sessionResult.subjectId !== catalogueEntry.subjectId)
    issues.push(`Subject mismatch: got "${sessionResult.subjectId}", expected "${catalogueEntry.subjectId}".`);
  if (sessionResult.sessionLabel !== catalogueEntry.sessionLabel)
    issues.push(`Session mismatch: got "${sessionResult.sessionLabel}", expected "${catalogueEntry.sessionLabel}".`);
  if (sessionResult.sessionId !== catalogueEntry.sessionId)
    issues.push(`Session ID mismatch: got "${sessionResult.sessionId}", expected "${catalogueEntry.sessionId}".`);
  return { valid: issues.length === 0, issues };
}

/**
 * Assess per-signal baseline sufficiency (requires >= MIN_RECORDS_FOR_BASELINE).
 * @param {Object} sessionResult - from parseE4Session()
 * @returns {Object.<string, { sufficient: boolean, recordCount: number, note: string }>}
 */
export function assessBaselineSufficiency(sessionResult) {
  const result = {};
  for (const [signalKey, timeSeries] of Object.entries(sessionResult.parsedSignals || {})) {
    const n = timeSeries.length;
    const sufficient = n >= MIN_RECORDS_FOR_BASELINE;
    result[signalKey] = {
      sufficient,
      recordCount: n,
      note: sufficient
        ? `${n} valid records -- session baseline computable.`
        : `Only ${n} records -- fewer than ${MIN_RECORDS_FOR_BASELINE} required. Baseline suppressed.`,
    };
  }
  return result;
}

/**
 * Build a provenance block for reports and JSON exports.
 * Embeds dataset attribution, session identity, and honest scope limits.
 * Reusable for future rehabilitation datasets.
 *
 * @param {Object} catalogueEntry - from SUBJECT_SESSION_CATALOGUE
 * @param {Object} sessionResult  - from parseE4Session()
 * @returns {Object}
 */
export function buildSessionProvenance(catalogueEntry, sessionResult) {
  return {
    datasetSource:      catalogueEntry.datasetSource,
    subjectId:          catalogueEntry.subjectId,
    sessionLabel:       catalogueEntry.sessionLabel,
    sessionId:          catalogueEntry.sessionId,
    displayName:        catalogueEntry.displayName,
    limitations:        catalogueEntry.limitations,
    availableSignals:   sessionResult.availableSignals,
    unavailableSignals: catalogueEntry.unavailableSignals,
    sessionStartISO:    sessionResult.startISO,
    sessionEndISO:      sessionResult.endISO,
    durationHours:      sessionResult.durationHours,
    totalValidRecords:  sessionResult.totalValidRecords,
    generatedAt:        new Date().toISOString(),
    generatedBy:        'StealthEra -- Empatica E4 Adapter v2',
    reportCoverageNote: sessionResult.durationHours
      ? `Report covers the ${sessionResult.durationHours.toFixed(1)}-hour exam session only. Multi-day rehabilitation trends: NOT AVAILABLE.`
      : 'Report coverage: unknown duration. Multi-day rehabilitation trends: NOT AVAILABLE.',
    multiDayTrendsNote: 'UNAVAILABLE -- dataset sessions are <=3 hours each.',
    rehabilitationNote: 'UNAVAILABLE -- this is an exam-stress dataset, not a rehabilitation dataset.',
  };
}
