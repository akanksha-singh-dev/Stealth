/**
 * @file app.js
 * @description Interactive UI logic connecting Longitudinal Health Intelligence Layer to web view.
 */

import Chart from 'chart.js/auto';
import { LongitudinalHealthIntelligenceLayer } from '../core/health-intelligence-layer.js';
import { getPatientScenarios } from '../data/patient-scenarios.js';

class HealthIntelligenceDashboard {
  constructor() {
    this.intelligenceLayer = new LongitudinalHealthIntelligenceLayer();
    this.scenarios = getPatientScenarios();
    this.currentPatient = this.scenarios[0];
    this.currentActiveSignal = 'RESTING_HR';
    
    this.mainChart = null;
    this.radarChart = null;
    this.latestAnalysisResult = null;

    this.initUI();
  }

  initUI() {
    this.setupPatientSelector();
    this.setupEventListeners();
    this.runPatientAnalysis();
  }

  setupPatientSelector() {
    const selectEl = document.getElementById('patientSelect');
    if (!selectEl) return;

    selectEl.innerHTML = '';
    this.scenarios.forEach((p, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = `${p.name} (${p.condition})`;
      selectEl.appendChild(opt);
    });

    selectEl.addEventListener('change', (e) => {
      const selectedIndex = parseInt(e.target.value, 10);
      this.currentPatient = this.scenarios[selectedIndex];
      this.runPatientAnalysis();
    });
  }

  setupEventListeners() {
    // FHIR inspect modal
    const fhirBtn = document.getElementById('inspectFhirBtn');
    const modal = document.getElementById('fhirModal');
    const closeModal = document.getElementById('closeFhirModal');

    if (fhirBtn && modal) {
      fhirBtn.addEventListener('click', () => {
        if (this.latestAnalysisResult) {
          const fhirJson = this.latestAnalysisResult.clinicalObservation.fhirResource;
          document.getElementById('fhirJsonContent').textContent = JSON.stringify(fhirJson, null, 2);
          modal.classList.add('active');
        }
      });
    }

    if (closeModal && modal) {
      closeModal.addEventListener('click', () => {
        modal.classList.remove('active');
      });
    }

    // Interactive Sandbox Simulator
    const simBtn = document.getElementById('injectAnomalyBtn');
    if (simBtn) {
      simBtn.addEventListener('click', () => {
        this.injectSimulatedAnomaly();
      });
    }
  }

  runPatientAnalysis() {
    // Run longitudinal analysis through orchestrator
    this.latestAnalysisResult = this.intelligenceLayer.analyzePatient({
      patient: {
        id: this.currentPatient.id,
        name: this.currentPatient.name,
        postOpDay: this.currentPatient.postOpDay,
        medications: this.currentPatient.medications,
        comorbidities: this.currentPatient.comorbidities,
        inActiveExercise: this.currentPatient.inActiveExercise
      },
      telemetryData: this.currentPatient.telemetry
    });

    // Update UI components
    this.renderPatientHeader();
    this.renderMetricTabs();
    this.renderMainChart();
    this.renderRadarChart();
    this.renderClinicalObservationFeed();
    this.renderEvidenceTable();
  }

  renderPatientHeader() {
    const { patient, fuserReport, clinicalObservation } = this.latestAnalysisResult;
    
    document.getElementById('patientName').textContent = patient.name;
    document.getElementById('patientMetaDetails').textContent = 
      `${this.currentPatient.age} yrs • ${this.currentPatient.gender} • POD ${patient.postOpDay || 'N/A'} • ${this.currentPatient.condition}`;
    
    document.getElementById('patientScenarioDesc').textContent = `Scenario: ${this.currentPatient.scenarioDescription}`;

    const riskBadge = document.getElementById('riskBadge');
    riskBadge.textContent = fuserReport.riskLevel;
    riskBadge.className = `badge badge-${fuserReport.riskLevel.toLowerCase()}`;

    const scoreEl = document.getElementById('riskScoreNum');
    scoreEl.textContent = fuserReport.compositeRiskScore;
    
    const circle = document.getElementById('riskCircle');
    if (fuserReport.compositeRiskScore >= 75) circle.style.borderColor = '#f87171';
    else if (fuserReport.compositeRiskScore >= 50) circle.style.borderColor = '#fbbf24';
    else if (fuserReport.compositeRiskScore >= 25) circle.style.borderColor = '#818cf8';
    else circle.style.borderColor = '#34d399';
  }

  renderMetricTabs() {
    const tabsContainer = document.getElementById('metricTabs');
    if (!tabsContainer) return;

    tabsContainer.innerHTML = '';
    const signals = Object.keys(this.currentPatient.telemetry);
    
    if (!signals.includes(this.currentActiveSignal)) {
      this.currentActiveSignal = signals[0];
    }

    signals.forEach(sig => {
      const btn = document.createElement('button');
      btn.className = `tab-btn ${sig === this.currentActiveSignal ? 'active' : ''}`;
      btn.textContent = sig.replace(/_/g, ' ');
      btn.addEventListener('click', () => {
        this.currentActiveSignal = sig;
        this.renderMetricTabs();
        this.renderMainChart();
      });
      tabsContainer.appendChild(btn);
    });
  }

  renderMainChart() {
    const canvas = document.getElementById('mainTelemetryChart');
    if (!canvas) return;

    const timeSeries = this.currentPatient.telemetry[this.currentActiveSignal] || [];
    const baselineProfile = this.latestAnalysisResult.baselineProfiles[this.currentActiveSignal];

    const labels = timeSeries.map((d, i) => `Day ${i + 1}`);
    const values = timeSeries.map(d => d.value);

    const median = baselineProfile ? baselineProfile.normalRange.median : 0;
    const lowerBound = baselineProfile ? baselineProfile.normalRange.lowerBound : 0;
    const upperBound = baselineProfile ? baselineProfile.normalRange.upperBound : 0;

    const medianLine = new Array(values.length).fill(median);
    const lowerLine = new Array(values.length).fill(lowerBound);
    const upperLine = new Array(values.length).fill(upperBound);

    if (this.mainChart) {
      this.mainChart.destroy();
    }

    this.mainChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Observed Telemetry',
            data: values,
            borderColor: '#38bdf8',
            backgroundColor: 'rgba(56, 189, 248, 0.1)',
            borderWidth: 3,
            tension: 0.3,
            fill: false,
            pointRadius: 6,
            pointBackgroundColor: (ctx) => {
              const val = values[ctx.dataIndex];
              if (val > upperBound || val < lowerBound) return '#f87171';
              return '#38bdf8';
            }
          },
          {
            label: 'Baseline Median',
            data: medianLine,
            borderColor: '#818cf8',
            borderWidth: 1.5,
            borderDash: [4, 4],
            pointRadius: 0
          },
          {
            label: 'Normal Upper Bound',
            data: upperLine,
            borderColor: 'rgba(255, 255, 255, 0.25)',
            borderWidth: 1,
            borderDash: [2, 2],
            pointRadius: 0
          },
          {
            label: 'Normal Lower Bound',
            data: lowerLine,
            borderColor: 'rgba(255, 255, 255, 0.25)',
            borderWidth: 1,
            borderDash: [2, 2],
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#9ca3af', font: { family: 'Inter', size: 11 } }
          },
          tooltip: {
            backgroundColor: '#162032',
            titleColor: '#fff',
            bodyColor: '#e5e7eb',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#9ca3af' }
          },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#9ca3af' }
          }
        }
      }
    });
  }

  renderRadarChart() {
    const canvas = document.getElementById('synergyRadarChart');
    if (!canvas) return;

    const indices = this.latestAnalysisResult.fuserReport.synergyIndices;

    const labels = [
      'Infection Risk',
      'Mechanical Impairment',
      'Cardiac Decomp.',
      'Recovery Stall'
    ];

    const dataScores = [
      indices.infectionIndex.score,
      indices.mechanicalJointIndex.score,
      indices.cardiacDecompIndex.score,
      indices.recoveryStallIndex.score
    ];

    if (this.radarChart) {
      this.radarChart.destroy();
    }

    this.radarChart = new Chart(canvas, {
      type: 'radar',
      data: {
        labels,
        datasets: [
          {
            label: 'Synergy Risk Index',
            data: dataScores,
            backgroundColor: 'rgba(248, 113, 113, 0.25)',
            borderColor: '#f87171',
            borderWidth: 2,
            pointBackgroundColor: '#f87171'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          r: {
            angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
            grid: { color: 'rgba(255, 255, 255, 0.1)' },
            pointLabels: { color: '#9ca3af', font: { size: 10 } },
            ticks: { display: false },
            suggestedMin: 0,
            suggestedMax: 100
          }
        }
      }
    });
  }

  renderClinicalObservationFeed() {
    const obs = this.latestAnalysisResult.clinicalObservation;

    document.getElementById('obsHeadline').textContent = obs.headline;
    document.getElementById('obsNarrative').textContent = obs.narrativeSummary;

    const actionsContainer = document.getElementById('obsActionsList');
    actionsContainer.innerHTML = '';

    obs.recommendedActions.forEach(act => {
      const item = document.createElement('div');
      item.className = `action-item ${act.priority}`;
      item.innerHTML = `
        <span class="action-priority">${act.priority}</span>
        <span class="action-text">${act.action}</span>
      `;
      actionsContainer.appendChild(item);
    });
  }

  renderEvidenceTable() {
    const tbody = document.getElementById('evidenceTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const items = this.latestAnalysisResult.clinicalObservation.evidenceItems;

    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${item.metric}</strong></td>
        <td>${item.observedValue}</td>
        <td>${item.baselineMedian}</td>
        <td>${item.normalRange}</td>
        <td><span class="badge badge-${item.isAnomaly ? 'critical' : 'low'}">${item.severity}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }

  injectSimulatedAnomaly() {
    // Inject acute HR + Temp spike to active telemetry
    const tel = this.currentPatient.telemetry;
    if (tel['RESTING_HR']) {
      const last = tel['RESTING_HR'][tel['RESTING_HR'].length - 1];
      last.value += 20;
    }
    if (tel['TEMPERATURE']) {
      const last = tel['TEMPERATURE'][tel['TEMPERATURE'].length - 1];
      last.value = Number((last.value + 1.2).toFixed(1));
    }
    
    this.runPatientAnalysis();
  }
}

// Instantiate dashboard on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  new HealthIntelligenceDashboard();
});
