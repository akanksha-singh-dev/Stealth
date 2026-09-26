/**
 * @file context-fuser.js
 * @description Multi-Signal & Contextual Fusion Engine.
 * Fuses multi-domain signals (vitals, functional mobility, PROMs, sleep) with 
 * patient context (post-op day, medications, comorbidities, exercise state) 
 * to generate holistic composite risk indices and clinical trajectory classifications.
 */

export class ContextualSignalFuser {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    this.clinicalDomain = options.clinicalDomain || 'REHABILITATION';
  }

  /**
   * Main multi-signal fusion entry point.
   * @param {Object} input
   * @param {Object} input.signalDeviations - Map of signal name -> acute/sustained deviation objects
   * @param {Object} input.patientContext - Patient clinical context metadata
   * @param {number} [input.patientContext.postOpDay]
   * @param {string[]} [input.patientContext.medications] - e.g. ['Metoprolol', 'Acetaminophen']
   * @param {string[]} [input.patientContext.comorbidities] - e.g. ['Diabetes Type 2', 'Hypertension']
   * @param {boolean} [input.patientContext.inActiveExercise=false]
   * @returns {Object} Fused multi-signal assessment report
   */
  fuseSignalsAndContext(input) {
    const { signalDeviations = {}, patientContext = {} } = input;

    // 1. Adjust for active exercise context (e.g. HR spike during active PT session is expected)
    const normalizedDeviations = this._adjustForContextualState(signalDeviations, patientContext);

    // 2. Evaluate Clinical Syndrome Synergy Indices
    const infectionIndex = this._evaluateInfectionSynergy(normalizedDeviations, patientContext);
    const mechanicalJointIndex = this._evaluateMechanicalSynergy(normalizedDeviations, patientContext);
    const cardiacDecompIndex = this._evaluateCardiacDecompSynergy(normalizedDeviations, patientContext);
    const recoveryStallIndex = this._evaluateRecoveryStallSynergy(normalizedDeviations, patientContext);

    // 3. Determine Overall Composite Risk Score (0 - 100)
    const compositeRisk = Math.min(100, Math.round(
      Math.max(
        infectionIndex.score,
        mechanicalJointIndex.score,
        cardiacDecompIndex.score,
        recoveryStallIndex.score
      )
    ));

    // 4. Determine Overall Trajectory Classification
    const trajectoryClassification = this._classifyTrajectory(compositeRisk, {
      infectionIndex,
      mechanicalJointIndex,
      cardiacDecompIndex,
      recoveryStallIndex
    });

    return {
      compositeRiskScore: compositeRisk,
      riskLevel: compositeRisk >= 75 ? 'CRITICAL' : compositeRisk >= 50 ? 'HIGH' : compositeRisk >= 25 ? 'MODERATE' : 'LOW',
      trajectoryClassification: trajectoryClassification.status,
      primaryDriver: trajectoryClassification.primaryDriver,
      summaryMessage: trajectoryClassification.summaryMessage,
      synergyIndices: {
        infectionIndex,
        mechanicalJointIndex,
        cardiacDecompIndex,
        recoveryStallIndex
      },
      normalizedDeviations,
      patientContext,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Adjusts deviation signals based on patient real-time context (e.g., active exercise, medication effects).
   * @private
   */
  _adjustForContextualState(signalDeviations, context) {
    const adjusted = { ...signalDeviations };

    // Medication Context: Beta-blockers (e.g. Metoprolol, Atenolol) blunt HR response
    const hasBetaBlocker = (context.medications || []).some(m => 
      /beta|metoprolol|atenolol|carvedilol|propranolol|bisoprolol/i.test(m)
    );

    // Active Exercise Context
    if (context.inActiveExercise) {
      if (adjusted['RESTING_HR'] || adjusted['HEART_RATE']) {
        const hrDev = adjusted['RESTING_HR'] || adjusted['HEART_RATE'];
        if (hrDev.severity === 'WARNING' || hrDev.severity === 'CRITICAL') {
          adjusted['RESTING_HR'] = {
            ...hrDev,
            contextAdjusted: true,
            adjustedSeverity: 'NORMAL_EXERCISE_RESPONSE',
            note: 'Elevated HR reclassified: Expected physiological response to active physical therapy.'
          };
        }
      }
    }

    // Beta Blocker Context Adjustment
    if (hasBetaBlocker) {
      // If HR is normal but HRV or Temp is spiking, increase sensitivity to autonomic/infection flags
      if (adjusted['RESTING_HR'] && !adjusted['RESTING_HR'].isDeviation) {
        adjusted['RESTING_HR'] = {
          ...adjusted['RESTING_HR'],
          contextAdjusted: true,
          note: 'Patient taking Beta-blocker: Tachycardia response may be blunted.'
        };
      }
    }

    return adjusted;
  }

  /**
   * Evaluates Infection / Systemic Inflammation Risk Synergy.
   * Combine: Temp + Resting HR + HRV Drop + Reduced Activity + Increased Pain
   * @private
   */
  _evaluateInfectionSynergy(deviations, context) {
    let score = 0;
    const contributingSignals = [];

    const temp = deviations['TEMPERATURE'];
    const hr = deviations['RESTING_HR'] || deviations['HEART_RATE'];
    const hrv = deviations['HRV'];
    const steps = deviations['DAILY_STEPS'];
    const pain = deviations['PAIN_SCORE'];

    // Temp elevated
    if (temp && temp.isDeviation && temp.direction === 'HIGH') {
      const pts = temp.severity === 'CRITICAL' ? 40 : 25;
      score += pts;
      contributingSignals.push(`Elevated Temp (${temp.observedValue}°C, +${temp.deviationDelta})`);
    }

    // Resting HR elevated (or blunted if beta-blocker)
    if (hr && hr.isDeviation && hr.direction === 'HIGH' && hr.adjustedSeverity !== 'NORMAL_EXERCISE_RESPONSE') {
      const pts = hr.severity === 'CRITICAL' ? 30 : 20;
      score += pts;
      contributingSignals.push(`Elevated Resting HR (${hr.observedValue} bpm)`);
    }

    // HRV drop (parasympathetic withdrawal)
    if (hrv && hrv.isDeviation && hrv.direction === 'LOW') {
      const pts = hrv.severity === 'CRITICAL' ? 20 : 15;
      score += pts;
      contributingSignals.push(`Suppressed HRV (${hrv.observedValue} ms)`);
    }

    // Sudden mobility drop
    if (steps && steps.isDeviation && steps.direction === 'LOW') {
      score += 15;
      contributingSignals.push(`Mobility Reduction (${steps.observedValue} steps/day)`);
    }

    // Pain flare
    if (pain && pain.isDeviation && pain.direction === 'HIGH') {
      score += 10;
      contributingSignals.push(`Increased Pain (${pain.observedValue}/10)`);
    }

    // Synergistic bonus: 3+ signals present simultaneously
    if (contributingSignals.length >= 3) {
      score *= 1.25; // 25% synergy multiplier for cross-domain alignment
    }

    return {
      score: Math.min(100, Math.round(score)),
      name: 'Systemic Infection / Inflammation Risk',
      contributingSignals,
      isFlagged: score >= 45
    };
  }

  /**
   * Evaluates Mechanical Joint / Post-Op Surgical Site Complication Synergy.
   * Combine: Decreased ROM + Increased Pain + Swelling + Mobility Reduction
   * @private
   */
  _evaluateMechanicalSynergy(deviations, context) {
    let score = 0;
    const contributingSignals = [];

    const rom = deviations['KNEE_FLEXION_ROM'] || deviations['JOINT_ROM'];
    const pain = deviations['PAIN_SCORE'];
    const swelling = deviations['SWELLING_SCORE'];
    const steps = deviations['DAILY_STEPS'];

    if (rom && (rom.isDeviation || (rom.status && rom.status.includes('LAG')))) {
      score += 35;
      contributingSignals.push(`Flexion ROM Deficit (${rom.observedValue || rom.deviationValue}°)`);
    }

    if (pain && pain.isDeviation && pain.direction === 'HIGH') {
      score += 25;
      contributingSignals.push(`Persistent Local Pain (${pain.observedValue}/10)`);
    }

    if (swelling && swelling.isDeviation && swelling.direction === 'HIGH') {
      score += 20;
      contributingSignals.push(`Joint Swelling Grade (${swelling.observedValue})`);
    }

    if (steps && steps.isDeviation && steps.direction === 'LOW') {
      score += 15;
      contributingSignals.push(`Avoidance / Weight-bearing Drop (${steps.observedValue} steps)`);
    }

    if (contributingSignals.length >= 3) {
      score *= 1.2;
    }

    return {
      score: Math.min(100, Math.round(score)),
      name: 'Mechanical Joint Impairment / Arthrofibrosis Risk',
      contributingSignals,
      isFlagged: score >= 45
    };
  }

  /**
   * Evaluates Cardiac / Fluid Overload Decompensation Synergy.
   * Combine: Weight Gain + SpO2 drop + HR increase + Fatigue/Dyspnea
   * @private
   */
  _evaluateCardiacDecompSynergy(deviations, context) {
    let score = 0;
    const contributingSignals = [];

    const weight = deviations['BODY_WEIGHT'];
    const spo2 = deviations['SPO2'];
    const hr = deviations['RESTING_HR'];
    const dyspnea = deviations['DYSPNEA_SCORE'];

    if (weight && weight.isDeviation && weight.direction === 'HIGH') {
      score += 35;
      contributingSignals.push(`Acute Weight Gain (+${weight.deviationDelta} kg)`);
    }

    if (spo2 && spo2.isDeviation && spo2.direction === 'LOW') {
      score += 30;
      contributingSignals.push(`Oxygen Desaturation (${spo2.observedValue}%)`);
    }

    if (hr && hr.isDeviation && hr.direction === 'HIGH') {
      score += 20;
      contributingSignals.push(`Resting Tachycardia (${hr.observedValue} bpm)`);
    }

    if (dyspnea && dyspnea.isDeviation && dyspnea.direction === 'HIGH') {
      score += 20;
      contributingSignals.push(`Exertional Dyspnea (Borg ${dyspnea.observedValue})`);
    }

    if (contributingSignals.length >= 2) {
      score *= 1.25;
    }

    return {
      score: Math.min(100, Math.round(score)),
      name: 'Cardiopulmonary Decompensation / Fluid Overload Risk',
      contributingSignals,
      isFlagged: score >= 45
    };
  }

  /**
   * Evaluates Recovery Stall / Sub-Optimal Progression Synergy.
   * Combine: Flat ROM trajectory + Low steps + High fatigue over 7+ days
   * @private
   */
  _evaluateRecoveryStallSynergy(deviations, context) {
    let score = 0;
    const contributingSignals = [];

    const romShift = deviations['KNEE_FLEXION_ROM_SHIFT'];
    const stepsShift = deviations['DAILY_STEPS_SHIFT'];
    const gaitSpeed = deviations['GAIT_VELOCITY'];

    if (romShift && romShift.hasSustainedShift && romShift.shiftType.includes('LOW')) {
      score += 30;
      contributingSignals.push(`Stalled ROM Plateau over 7 days`);
    }

    if (stepsShift && stepsShift.hasSustainedShift && stepsShift.shiftType.includes('LOW')) {
      score += 25;
      contributingSignals.push(`Sustained Low Activity Volume`);
    }

    if (gaitSpeed && gaitSpeed.isDeviation && gaitSpeed.direction === 'LOW') {
      score += 25;
      contributingSignals.push(`Sub-target Gait Velocity (${gaitSpeed.observedValue} m/s)`);
    }

    return {
      score: Math.min(100, Math.round(score)),
      name: 'Sub-Optimal Rehabilitation Trajectory / Recovery Stall',
      contributingSignals,
      isFlagged: score >= 40
    };
  }

  /**
   * Classifies final overall patient trajectory status.
   * @private
   */
  _classifyTrajectory(compositeRisk, indices) {
    if (compositeRisk >= 75) {
      const topIndex = Object.values(indices).reduce((prev, curr) => (curr.score > prev.score ? curr : prev));
      return {
        status: 'SUBACUTE_DETERIORATION',
        primaryDriver: topIndex.name,
        summaryMessage: `High priority alert: Cross-signal pattern indicates acute risk of ${topIndex.name}.`
      };
    }

    if (compositeRisk >= 50) {
      const topIndex = Object.values(indices).reduce((prev, curr) => (curr.score > prev.score ? curr : prev));
      return {
        status: 'MONITOR_WATCH',
        primaryDriver: topIndex.name,
        summaryMessage: `Moderate deviation: Patient showing multi-signal drift consistent with ${topIndex.name}.`
      };
    }

    if (compositeRisk >= 30) {
      return {
        status: 'RECOVERY_PLATEAU_STALLED',
        primaryDriver: 'Rehabilitation Progression',
        summaryMessage: `Patient recovery rate is lagging behind post-op protocol targets.`
      };
    }

    return {
      status: 'EXPECTED_RECOVERY',
      primaryDriver: 'Physiological Stability',
      summaryMessage: `Patient vital and functional metrics align cleanly with baseline expectations.`
    };
  }
}
