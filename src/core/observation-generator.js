/**
 * @file observation-generator.js
 * @description Explainable Clinical Observation & Insight NLG Generator.
 * Constructs human-readable, evidence-backed clinical notes for care teams 
 * and formats standardized FHIR R4 RiskAssessment & Observation JSON bundles.
 */

export class ClinicalObservationGenerator {
  /**
   * @param {Object} [options]
   * @param {string} [options.organizationName='StealthEra Intelligence']
   */
  constructor(options = {}) {
    this.organizationName = options.organizationName || 'StealthEra Health Intelligence';
  }

  /**
   * Generates complete explainable clinical report object from fused health intelligence.
   * @param {Object} fuserReport - Output from ContextualSignalFuser
   * @param {Object} patientInfo - Patient metadata (id, name, age, gender, postOpDay)
   * @returns {Object} Structured Explainable Clinical Observation Report
   */
  generateClinicalObservation(fuserReport, patientInfo = {}) {
    const {
      compositeRiskScore,
      riskLevel,
      trajectoryClassification,
      primaryDriver,
      summaryMessage,
      synergyIndices,
      normalizedDeviations,
      patientContext
    } = fuserReport;

    const timestamp = new Date().toISOString();
    const patientId = patientInfo.id || 'PATIENT-001';
    const patientName = patientInfo.name || 'Anonymous Patient';
    const postOpDay = patientContext.postOpDay || patientInfo.postOpDay || 'N/A';

    // Build Executive Headline
    const headline = `POD ${postOpDay}: [${riskLevel}] ${trajectoryClassification.replace(/_/g, ' ')} - ${primaryDriver}`;

    // Build Natural Language Evidence Rationale
    const evidenceParagraphs = this._buildEvidenceRationale(fuserReport, patientInfo);

    // Build Recommended Action Items for Care Team
    const recommendedActions = this._buildRecommendedActions(fuserReport, patientInfo);

    // Build Structured Evidence Table Data
    const evidenceItems = this._extractEvidenceItems(normalizedDeviations);

    // Generate Standard FHIR R4 RiskAssessment Resource
    const fhirResource = this.generateFHIRRiskAssessment(fuserReport, patientInfo);

    return {
      reportId: `OBS-${patientId}-${Date.now().toString(36).toUpperCase()}`,
      patientId,
      patientName,
      postOpDay,
      timestamp,
      headline,
      riskLevel,
      compositeRiskScore,
      trajectoryClassification,
      primaryDriver,
      summaryMessage,
      narrativeSummary: evidenceParagraphs.join('\n\n'),
      evidenceItems,
      recommendedActions,
      patientContext,
      fhirResource,
      meta: {
        generatedBy: this.organizationName,
        algorithmVersion: 'Longitudinal-Intelligence-v1.0',
        explainabilityStandard: 'ANSI/AAMI HL7 Clinical Decision Support Auditability'
      }
    };
  }

  /**
   * Generates natural language paragraph explaining rationale and underlying evidence.
   * @private
   */
  _buildEvidenceRationale(fuserReport, patientInfo) {
    const paragraphs = [];
    const { synergyIndices, normalizedDeviations, patientContext } = fuserReport;

    // Paragraph 1: Overview
    const activeDriver = Object.values(synergyIndices).find(idx => idx.isFlagged || idx.score >= 40);
    if (activeDriver) {
      paragraphs.push(
        `Multi-signal analysis detected a significant composite shift evaluated at a score of ${fuserReport.compositeRiskScore}/100. ` +
        `The primary physiological driver is ${activeDriver.name} (Risk Score: ${activeDriver.score}/100).`
      );
    } else {
      paragraphs.push(
        `Longitudinal telemetry indicates stable recovery progress. Patient metrics remain within personalized normal baseline limits.`
      );
    }

    // Paragraph 2: Contributing Signals & Deviation Data
    const deviationDetails = [];
    for (const [key, dev] of Object.entries(normalizedDeviations)) {
      if (dev && (dev.isDeviation || dev.contextAdjusted)) {
        if (dev.contextAdjusted && dev.adjustedSeverity === 'NORMAL_EXERCISE_RESPONSE') {
          deviationDetails.push(`• ${key}: ${dev.note}`);
        } else if (dev.observedValue !== undefined) {
          deviationDetails.push(
            `• ${key}: Observed ${dev.observedValue} (Baseline Median: ${dev.baselineMedian || dev.baselineValue}, ` +
            `Shift: ${dev.deviationDelta > 0 ? '+' : ''}${dev.deviationDelta}, Z-Score: ${dev.zScore || 'N/A'}, Severity: ${dev.severity})`
          );
        } else if (dev.hasSustainedShift) {
          deviationDetails.push(
            `• ${key}: Sustained baseline shift detected (${dev.shiftType}, ${dev.consecutiveOutOfBoundDays} consecutive days out of normal range)`
          );
        }
      }
    }

    if (deviationDetails.length > 0) {
      paragraphs.push(
        `Key Signal Evidence:\n` + deviationDetails.join('\n')
      );
    }

    // Paragraph 3: Clinical Context & Modifiers
    const contextNotes = [];
    if (patientContext.medications && patientContext.medications.length > 0) {
      contextNotes.push(`Active Medications: ${patientContext.medications.join(', ')}`);
    }
    if (patientContext.inActiveExercise) {
      contextNotes.push(`State: Active Physical Therapy Session (Exercise-induced physiological variations expected)`);
    }
    if (patientContext.comorbidities && patientContext.comorbidities.length > 0) {
      contextNotes.push(`Comorbidities: ${patientContext.comorbidities.join(', ')}`);
    }

    if (contextNotes.length > 0) {
      paragraphs.push(`Patient Clinical Context:\n` + contextNotes.join('\n'));
    }

    return paragraphs;
  }

  /**
   * Generates actionable clinical recommendations based on risk classification.
   * @private
   */
  _buildRecommendedActions(fuserReport, patientInfo) {
    const actions = [];
    const { riskLevel, synergyIndices } = fuserReport;

    if (synergyIndices.infectionIndex.isFlagged) {
      actions.push({
        priority: 'URGENT',
        category: 'DIAGNOSTIC_LABS',
        action: 'Order Complete Blood Count (CBC w/ differential), CRP, and ESR lab panel to screen for early surgical site infection.'
      });
      actions.push({
        priority: 'HIGH',
        category: 'TELEHEALTH_VIRTUAL',
        action: 'Initiate targeted video check-in to perform physical visual assessment of wound site for localized erythema or discharge.'
      });
    }

    if (synergyIndices.mechanicalJointIndex.isFlagged) {
      actions.push({
        priority: 'HIGH',
        category: 'PHYSICAL_THERAPY',
        action: 'Schedule in-person physical therapy evaluation to assess knee range of motion, patellar mobility, and soft-tissue tightness.'
      });
      actions.push({
        priority: 'MEDIUM',
        category: 'PAIN_MANAGEMENT',
        action: 'Review pain medication compliance and timing relative to scheduled home exercise sessions.'
      });
    }

    if (synergyIndices.cardiacDecompIndex.isFlagged) {
      actions.push({
        priority: 'URGENT',
        category: 'CARDIOLOGY_REVIEW',
        action: 'Contact patient immediately to check for peripheral pitting edema, orthopnea, or worsening shortness of breath.'
      });
      actions.push({
        priority: 'HIGH',
        category: 'MEDICATION_ADJUSTMENT',
        action: 'Review diuretic regimen (e.g. Furosemide) and fluid intake log with attending cardiologist.'
      });
    }

    if (synergyIndices.recoveryStallIndex.isFlagged && actions.length === 0) {
      actions.push({
        priority: 'MEDIUM',
        category: 'REHAB_REPLANNING',
        action: 'Modify home exercise program (HEP) progression steps; evaluate patient motivation and pain barriers.'
      });
    }

    if (actions.length === 0) {
      actions.push({
        priority: 'ROUTINE',
        category: 'CONTINUED_MONITORING',
        action: 'Continue passive longitudinal wearable monitoring according to standard recovery protocol.'
      });
    }

    return actions;
  }

  /**
   * Formats raw evidence items for tabular presentation.
   * @private
   */
  _extractEvidenceItems(normalizedDeviations) {
    const items = [];
    for (const [key, dev] of Object.entries(normalizedDeviations)) {
      if (dev && dev.observedValue !== undefined) {
        items.push({
          metric: key,
          observedValue: dev.observedValue,
          baselineMedian: dev.baselineMedian || dev.baselineValue,
          normalRange: dev.normalRange ? `[${dev.normalRange.lowerBound} - ${dev.normalRange.upperBound}]` : 'N/A',
          zScore: dev.zScore !== undefined ? dev.zScore : 'N/A',
          severity: dev.adjustedSeverity || dev.severity || 'NORMAL',
          isAnomaly: !!dev.isDeviation
        });
      }
    }
    return items;
  }

  /**
   * Generates HL7 FHIR R4 RiskAssessment JSON resource bundle.
   * @param {Object} fuserReport 
   * @param {Object} patientInfo 
   * @returns {Object} FHIR R4 RiskAssessment Resource
   */
  generateFHIRRiskAssessment(fuserReport, patientInfo = {}) {
    const patientId = patientInfo.id || 'PATIENT-001';

    return {
      resourceType: 'RiskAssessment',
      id: `risk-assessment-${patientId}-${Date.now()}`,
      status: 'final',
      subject: {
        reference: `Patient/${patientId}`,
        display: patientInfo.name || 'Patient'
      },
      occurrenceDateTime: new Date().toISOString(),
      performer: {
        display: this.organizationName
      },
      prediction: [
        {
          outcome: {
            coding: [
              {
                system: 'http://snomed.info/sct',
                code: fuserReport.riskLevel === 'CRITICAL' ? '418363000' : '271594007',
                display: fuserReport.trajectoryClassification
              }
            ],
            text: fuserReport.primaryDriver
          },
          probabilityDecimal: Number((fuserReport.compositeRiskScore / 100).toFixed(2)),
          qualitativeRisk: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/risk-probability',
                code: fuserReport.riskLevel.toLowerCase(),
                display: fuserReport.riskLevel
              }
            ]
          },
          rationale: fuserReport.summaryMessage
        }
      ],
      note: [
        {
          text: `Longitudinal Multi-Signal Intelligence Risk Assessment. Composite Score: ${fuserReport.compositeRiskScore}/100.`
        }
      ]
    };
  }
}
