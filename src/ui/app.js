/**
 * @file app.js
 * @description StealthEra Clinical Dashboard — dual-mode UI.
 *
 * MODE A — Demo Patients
 *   Four simulated rehabilitation scenarios with all signals available.
 *   Separate from real data — never mixed.
 *
 * MODE B — Real Dataset (PhysioNet Wearable Exam Stress Dataset)
 *   Source: Amin, Wickramasuriya, Faghih — PhysioNet, 2022  DOI: 10.13026/kvkb-aj90
 *   Device: Empatica E4 wristband
 *   Locally bundled: Subject S1 / Final exam session
 *
 *   Honest scope:
 *   • Signals: HR (RESTING_HR), Wrist Skin Temperature (TEMPERATURE), HRV (IBI-derived).
 *   • Each session is 1.5–3 hours — NOT multi-day monitoring.
 *   • Multi-day rehabilitation baselines and trends are NOT available.
 *   • ROM, gait, steps, SpO₂, pain score are absent and never fabricated.
 *   • Baseline only computed when >= 30 valid records are present.
 *   • Dataset source and limitations are displayed on every real-data view.
 *
 * IMPORTANT: The 4 demo patients are kept entirely separate from real data.
 *   No fictional metadata is injected into real recordings.
 */

import Chart from 'chart.js/auto';
import { LongitudinalHealthIntelligenceLayer } from '../core/health-intelligence-layer.js';
import { getPatientScenarios } from '../data/patient-scenarios.js';
import {
  importE4SessionFromFileList,
  sessionToIntelligencePipelineInput,
  buildSessionPatientObject,
  aggregateHourly,
  aggregateDaily,
  generateSessionReport,
  parseE4FilenameMetadata,
} from '../data/empatica-e4-adapter.js';
import {
  getCatalogueEntry,
  getBundledSessions,
  DATASET_LIMITATIONS,
  DATASET_SOURCE,
  assessBaselineSufficiency,
  buildSessionProvenance,
} from '../data/exam-stress-catalogue.js';

// ── Signal metadata ───────────────────────────────────────────────────────────
const SIGNAL_META = {
  'RESTING_HR': { label: 'Resting HR', unit: 'bpm', dir: 'neutral' },
  'TEMPERATURE': { label: 'Temperature', unit: '°C', dir: 'neutral' },
  'HRV': { label: 'HRV', unit: 'ms', dir: 'up_good' },
  'SPO2': { label: 'SpO₂', unit: '%', dir: 'up_good' },
  'BODY_WEIGHT': { label: 'Body Weight', unit: 'kg', dir: 'neutral' },
  'KNEE_FLEXION_ROM': { label: 'Knee Flexion ROM', unit: '°', dir: 'up_good' },
  'PAIN_SCORE': { label: 'Pain Score', unit: '/10', dir: 'down_good' },
  'DAILY_STEPS': { label: 'Daily Steps', unit: 'steps', dir: 'up_good' },
  'GAIT_VELOCITY': { label: 'Gait Velocity', unit: 'm/s', dir: 'up_good' },
  'SWELLING_SCORE': { label: 'Swelling Score', unit: '', dir: 'down_good' },
};

function sigLabel(key) { return SIGNAL_META[key]?.label || key.replace(/_/g, ' '); }
function sigUnit(key) { return SIGNAL_META[key]?.unit || ''; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function severityChip(severity) {
  const s = (severity || '').toUpperCase();
  if (s === 'NORMAL' || s === 'NORMAL_EXERCISE_RESPONSE') return 'chip-normal';
  if (s === 'MILD') return 'chip-mild';
  if (s === 'WARNING') return 'chip-warning';
  if (s === 'CRITICAL') return 'chip-critical';
  if (s === 'ARTIFACT_NOISE' || s === 'ARTEFACT') return 'chip-artefact';
  if (s.includes('ADJUSTED') || s.includes('EXERCISE')) return 'chip-adjusted';
  return 'chip-normal';
}

function riskLevelClass(level) {
  switch ((level || '').toUpperCase()) {
    case 'LOW': return 'risk-low';
    case 'MODERATE': return 'risk-moderate';
    case 'HIGH': return 'risk-high';
    case 'CRITICAL': return 'risk-critical';
    default: return '';
  }
}

function scoreBarClass(score) {
  if (score >= 70) return 'fill-critical';
  if (score >= 45) return 'fill-warn';
  if (score >= 20) return 'fill-mod';
  return 'fill-low';
}

function gaugeClass(score) {
  if (score >= 75) return 'gauge-critical';
  if (score >= 50) return 'gauge-warn';
  if (score >= 25) return 'gauge-info';
  return 'gauge-ok';
}

function trajectoryClass(traj) {
  if (!traj) return '';
  const t = traj.toUpperCase();
  if (t.includes('DETERIORATION')) return 'traj-critical';
  if (t.includes('WATCH')) return 'traj-warn';
  if (t.includes('STALL') || t.includes('PLATEAU')) return 'traj-info';
  return 'traj-ok';
}

function fmt(v, digits = 1) {
  if (v === undefined || v === null || isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}

function fmtISO(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} UTC`;
  } catch { return iso; }
}

// ── Chart colours ─────────────────────────────────────────────────────────────
const C = {
  observed: '#486B58',
  observedFill: 'rgba(72,107,88,0.08)',
  baselineDash: 'rgba(82,111,131,0.7)',
  bandFill: 'rgba(72,107,88,0.07)',
  bandBorder: 'rgba(72,107,88,0.18)',
  anomaly: '#B64A45',
  gridLine: 'rgba(37,49,44,0.07)',
  tick: '#9BA5A0',
  tooltipBg: '#25312C',
  tooltipText: '#D8E4DC',
  radarGrid: 'rgba(37,49,44,0.08)',
  radar1: 'rgba(72,107,88,0.15)',
  radar1Border: '#486B58',
};

// ── Recording store (keeps all imported files separate) ───────────────────────
// Map<id, { sessionResult, catalogueEntry, patientObj, analysisResult }>
// sessionResult is the full output of parseE4Session() with HR + TEMP + HRV.
// catalogueEntry is from exam-stress-catalogue.js (null for user-imported files).
// The 4 demo patients are in a separate this.scenarios array — never mixed here.
const REAL_RECORDINGS = new Map();
let recordingIdCounter = 0;

// ── Main Dashboard Class ──────────────────────────────────────────────────────
class ClinicalDashboard {
  constructor() {
    this.engine = new LongitudinalHealthIntelligenceLayer();
    this.scenarios = getPatientScenarios();

    // Mode: 'demo' | 'real'
    this.mode = 'demo';

    // Demo state
    this.patient = this.scenarios[0];
    this.signal = Object.keys(this.scenarios[0].telemetry)[0];
    this.timeWindow = 14;
    this.result = null;
    this.simActive = false;
    this._origTelemetry = null;

    // Real-data state
    this.currentRecordingId = null;   // key into REAL_RECORDINGS

    // Chart instances
    this.mainChart = null;
    this.radarChart = null;

    this._initNav();
    this._initDemoSelector();
    this._initSourceModeToggle();
    this._initRealDataControls();
    this._initGlobalListeners();
    this._runDemoAnalysis();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════
  _initNav() {
    const pageMap = {
      navMonitoring: 'pageMonitoring',
      navPatientMonitoring: 'pageMonitoring',
      navTrends: 'pageTrends',
      navObservations: 'pageObservations',
      navReports: 'pageReports',
      navQuality: 'pageQuality',
      navFhir: 'pageFhir',
      navSettings: 'pageSettings',
    };
    const pageTitles = {
      pageMonitoring: 'Patient Monitoring',
      pageTrends: 'Longitudinal Trends',
      pageObservations: 'Clinical Observations',
      pageReports: 'Reports',
      pageQuality: 'Data Quality',
      pageFhir: 'FHIR / Integrations',
      pageSettings: 'Settings',
    };

    Object.entries(pageMap).forEach(([btnId, pageId]) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(el =>
          el.classList.remove('active', 'active-indicator'));
        btn.classList.add('active-indicator');
        document.querySelectorAll('.page-view').forEach(p => p.classList.remove('active'));
        const page = document.getElementById(pageId);
        if (page) page.classList.add('active');
        const el = document.getElementById('currentPageTitle');
        if (el) el.textContent = pageTitles[pageId] || '';

        if (pageId === 'pageTrends') this._renderTrendsPage();
        if (pageId === 'pageObservations') this._renderObservationsPage();
        if (pageId === 'pageReports') this._renderReportsPage();
        if (pageId === 'pageQuality') this._renderQualityPage();
        if (pageId === 'pageFhir') this._renderFhirPage();
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SOURCE MODE TOGGLE
  // ═══════════════════════════════════════════════════════════════════════════
  _initSourceModeToggle() {
    const btnDemo = document.getElementById('btnModeDemo');
    const btnReal = document.getElementById('btnModeReal');

    btnDemo?.addEventListener('click', () => {
      if (this.mode === 'demo') return;
      this.mode = 'demo';
      this.simActive = false;
      this._origTelemetry = null;
      btnDemo.classList.add('active');
      btnReal.classList.remove('active');
      btnDemo.setAttribute('aria-pressed', 'true');
      btnReal.setAttribute('aria-pressed', 'false');
      this._toggleModeUI();
      this._runDemoAnalysis();
    });

    btnReal?.addEventListener('click', () => {
      if (this.mode === 'real') return;
      this.mode = 'real';
      this.simActive = false;
      btnReal.classList.add('active');
      btnDemo.classList.remove('active');
      btnReal.setAttribute('aria-pressed', 'true');
      btnDemo.setAttribute('aria-pressed', 'false');
      this._toggleModeUI();
      if (this.currentRecordingId) {
        this._activateRealRecording(this.currentRecordingId);
      } else if (!this._bundledSessionLoading) {
        // Auto-load the bundled S1-Final session on first activation
        this._loadBundledSession();
      }
    });
  }

  _toggleModeUI() {
    const demoGroup = document.getElementById('demoSelectorGroup');
    const realGroup = document.getElementById('realSelectorGroup');
    const simPanel  = document.querySelector('.panel-flat');  // simulation panel
    const simBar    = document.getElementById('obsSimulationBar');
    const winLabel  = document.querySelector('#headerLastUpdated span');

    if (this.mode === 'demo') {
      demoGroup?.classList.remove('hidden');
      realGroup?.classList.add('hidden');
      simPanel?.classList.remove('hidden');
      document.getElementById('realDataBanner')?.classList.add('hidden');
      if (winLabel) winLabel.textContent = '14-day window';
    } else {
      demoGroup?.classList.add('hidden');
      realGroup?.classList.remove('hidden');
      simPanel?.classList.add('hidden');
      if (simBar) simBar.classList.add('hidden');
      if (winLabel) winLabel.textContent = 'Session window';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEMO PATIENT SELECTOR
  // ═══════════════════════════════════════════════════════════════════════════
  _initDemoSelector() {
    const sel = document.getElementById('patientSelect');
    if (!sel) return;
    sel.innerHTML = '';
    this.scenarios.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${p.name} — ${p.condition} [Demo]`;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', e => {
      this.patient = this.scenarios[parseInt(e.target.value, 10)];
      this.signal = Object.keys(this.patient.telemetry)[0];
      this.simActive = false;
      this._origTelemetry = null;
      this._runDemoAnalysis();
      this._syncSimState();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  REAL DATA CONTROLS
  // ═══════════════════════════════════════════════════════════════════════════
  _initRealDataControls() {
    const fileInput = document.getElementById('csvFileInput');
    fileInput?.addEventListener('change', async e => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      await this._importE4Files(files);
      fileInput.value = '';
    });

    // Quick-load the bundled S1-Final session (fetches from dev server)
    const btnBundled = document.getElementById('btnLoadBundled');
    btnBundled?.addEventListener('click', () => this._loadBundledSession());

    const recSel = document.getElementById('realRecordingSelect');
    recSel?.addEventListener('change', e => {
      const id = e.target.value;
      if (id && REAL_RECORDINGS.has(id)) {
        this.currentRecordingId = id;
        this._activateRealRecording(id);
      }
    });
  }

  /**
   * Import one or more E4 CSV files (HR.csv / TEMP.csv / IBI.csv or the
   * dataset-style S1_Final_HR.csv convention).  Builds a full multi-signal
   * session, runs the intelligence pipeline, and switches to Real mode.
   */
  async _importE4Files(files) {
    try {
      const sessionResult = await importE4SessionFromFileList(files);

      // Check we got at least some valid data
      const hrTS   = sessionResult.parsedSignals['RESTING_HR']  || [];
      const tempTS = sessionResult.parsedSignals['TEMPERATURE'] || [];
      const hrvTS  = sessionResult.parsedSignals['HRV']         || [];
      if (hrTS.length === 0 && tempTS.length === 0 && hrvTS.length === 0) {
        alert('No valid physiological records found in the uploaded files.');
        return;
      }

      const id = `real-${++recordingIdCounter}`;

      // Catalogue lookup for provenance enrichment
      const catalogueEntry = getCatalogueEntry(sessionResult.sessionId) || null;

      // Build pipeline input from all available signals
      const { telemetryData } = sessionToIntelligencePipelineInput(sessionResult);
      const patientObj        = buildSessionPatientObject(sessionResult, id);
      const analysisResult    = this.engine.analyzePatient({ patient: patientObj, telemetryData });

      REAL_RECORDINGS.set(id, { sessionResult, catalogueEntry, patientObj, analysisResult });
      this._refreshRealRecordingSelector(id);
      this.currentRecordingId = id;

      // Switch to real mode directly (avoids re-triggering the button click listener)
      if (this.mode !== 'real') {
        this.mode = 'real';
        this.simActive = false;
        document.getElementById('btnModeReal')?.classList.add('active');
        document.getElementById('btnModeDemo')?.classList.remove('active');
        document.getElementById('btnModeReal')?.setAttribute('aria-pressed', 'true');
        document.getElementById('btnModeDemo')?.setAttribute('aria-pressed', 'false');
        this._toggleModeUI();
      }

      this._activateRealRecording(id);
    } catch (err) {
      console.error('E4 import error:', err);
      alert(`Error importing files:\n${err.message}`);
    }
  }

  /** @deprecated kept for backward compatibility */
  async _importCSVFile(file) {
    return this._importE4Files([file]);
  }

  /**
   * Fetch and load the bundled PhysioNet S1-Final session.
   * Pulls HR, TEMP, and IBI CSVs from the public folder served by Vite
   * (real-datasets/wearable-exam-stress/) and passes them to _importE4Files().
   * A guard flag prevents concurrent invocations.
   */
  async _loadBundledSession() {
    // Guard against double-click / concurrent calls
    if (this._bundledSessionLoading) return;
    this._bundledSessionLoading = true;

    const btn = document.getElementById('btnLoadBundled');
    if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }

    const BASE = './real-datasets/wearable-exam-stress/';
    const FILES = [
      { path: `${BASE}S1_Final_HR.csv`,   name: 'S1_Final_HR.csv'   },
      { path: `${BASE}S1_Final_TEMP.csv`, name: 'S1_Final_TEMP.csv' },
      { path: `${BASE}S1_Final_IBI.csv`,  name: 'S1_Final_IBI.csv'  },
    ];

    try {
      const fileObjects = await Promise.all(FILES.map(async ({ path, name }) => {
        const resp = await fetch(path);
        if (!resp.ok) throw new Error(`Could not load ${name}: HTTP ${resp.status}`);
        const text = await resp.text();
        return new File([text], name, { type: 'text/csv' });
      }));
      await this._importE4Files(fileObjects);
    } catch (err) {
      console.error('Bundled session load error:', err);
      alert(
        `Failed to load the bundled S1-Final session:\n${err.message}\n\n` +
        `If you are running from a production build without the real-datasets/ folder, ` +
        `please use "Import CSV" to upload the files manually.`
      );
    } finally {
      this._bundledSessionLoading = false;
      if (btn) {
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Load S1-Final`;
        btn.disabled = false;
      }
    }
  }

  _refreshRealRecordingSelector(selectId) {
    const sel = document.getElementById('realRecordingSelect');
    if (!sel) return;
    sel.innerHTML = '';
    REAL_RECORDINGS.forEach((rec, id) => {
      const opt = document.createElement('option');
      opt.value = id;
      const sr = rec.sessionResult;
      const dtStr = sr.startISO ? new Date(sr.startISO).toUTCString().slice(0, 16) : 'Unknown date';
      const durStr = sr.durationHours ? `${sr.durationHours.toFixed(1)}h` : '?h';
      const sigStr = sr.availableSignals.join('+');
      opt.textContent = `${sr.sessionId} (${dtStr}, ${durStr}, ${sr.totalValidRecords} records, ${sigStr})`;
      sel.appendChild(opt);
    });
    sel.value = selectId;
  }

  _activateRealRecording(id) {
    const rec = REAL_RECORDINGS.get(id);
    if (!rec) return;

    const { sessionResult, catalogueEntry, patientObj, analysisResult } = rec;
    this.result = analysisResult;
    // Default to first available signal (prefer HR)
    this.signal = sessionResult.availableSignals.includes('RESTING_HR')
      ? 'RESTING_HR'
      : sessionResult.availableSignals[0] || 'RESTING_HR';
    this.patient = patientObj;

    this._renderRealDataBannerE4(sessionResult, catalogueEntry);
    this._renderSummaryBarRealE4(sessionResult, analysisResult);
    this._renderMetricTabsRealE4(sessionResult);
    this._renderMainChartRealE4(sessionResult);
    this._renderBaselinePanelRealE4(sessionResult, analysisResult);
    this._renderSyndromeScoresRealE4(sessionResult);
    this._renderObsPanelRealE4(sessionResult, analysisResult);
    this._renderEvidenceTableRealE4(sessionResult, analysisResult);
    this._renderHeaderStatusReal(analysisResult);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEMO ANALYSIS FLOW (unchanged logic)
  // ═══════════════════════════════════════════════════════════════════════════
  _runDemoAnalysis() {
    this.result = this.engine.analyzePatient({
      patient: {
        id: this.patient.id,
        name: this.patient.name,
        postOpDay: this.patient.postOpDay,
        medications: this.patient.medications,
        comorbidities: this.patient.comorbidities,
        inActiveExercise: this.patient.inActiveExercise,
      },
      telemetryData: this.patient.telemetry,
    });

    document.getElementById('realDataBanner')?.classList.add('hidden');
    this._renderSummaryBar();
    this._renderMetricTabs();
    this._renderMainChart();
    this._renderBaselinePanel();
    this._renderSyndromeScores();
    this._renderObsPanel();
    this._renderEvidenceTable();
    this._renderHeaderStatus();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GLOBAL LISTENERS
  // ═══════════════════════════════════════════════════════════════════════════
  _initGlobalListeners() {
    // FHIR modal
    const modal = document.getElementById('fhirModal');
    const closeModal = document.getElementById('closeFhirModal');
    document.getElementById('inspectFhirBtn')?.addEventListener('click', () => {
      if (this.result) {
        document.getElementById('fhirJsonContent').textContent =
          JSON.stringify(this.result.clinicalObservation.fhirResource, null, 2);
        modal?.classList.add('active');
      }
    });
    closeModal?.addEventListener('click', () => modal?.classList.remove('active'));
    modal?.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });

    // Copy obs
    document.getElementById('copyObsBtn')?.addEventListener('click', () => this._copyObservation());
    document.getElementById('copyObsBtn2')?.addEventListener('click', () => this._copyObservation());

    // Simulation (demo mode only)
    document.getElementById('injectAnomalyBtn')?.addEventListener('click', () => {
      if (this.mode === 'demo') this._injectAnomaly();
    });
    document.getElementById('resetSimulationBtn')?.addEventListener('click', () => {
      if (this.mode === 'demo') this._resetSimulation();
    });

    // Export
    document.getElementById('exportEvidenceBtn')?.addEventListener('click', () => this._exportEvidence());
    document.getElementById('exportReportBtn')?.addEventListener('click', () => this._exportReport());
    document.getElementById('copyFhirBtn')?.addEventListener('click', () => {
      if (this.result) {
        navigator.clipboard.writeText(
          JSON.stringify(this.result.clinicalObservation.fhirResource, null, 2)
        ).catch(() => { });
      }
    });

    // Time filter
    document.getElementById('timeFilterBar')?.addEventListener('click', e => {
      const btn = e.target.closest('.time-filter-btn');
      if (!btn) return;
      document.querySelectorAll('.time-filter-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      this.timeWindow = parseInt(btn.dataset.window, 10) || 14;
      if (this.mode === 'demo') {
        this._renderMainChart();
      } else if (this.currentRecordingId) {
        this._renderMainChartReal(REAL_RECORDINGS.get(this.currentRecordingId)?.adapterResult);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DEMO RENDERERS (original logic, unchanged)
  // ═══════════════════════════════════════════════════════════════════════════
  _renderHeaderStatus() {
    const { fuserReport } = this.result;
    const pill = document.getElementById('riskStatusPill');
    const text = document.getElementById('riskStatusText');
    if (!pill || !text) return;
    pill.className = `header-status-pill ${riskLevelClass(fuserReport.riskLevel)}`;
    text.textContent = `${fuserReport.riskLevel} — Score ${fuserReport.compositeRiskScore}/100`;
  }

  _renderSummaryBar() {
    const { patient, fuserReport, clinicalObservation } = this.result;
    const p = this.patient;
    document.getElementById('summaryPatientName').textContent = p.name;
    document.getElementById('summaryPathway').textContent = p.condition;
    document.getElementById('summaryPOD').textContent = patient.postOpDay ? `Day ${patient.postOpDay}` : 'N/A';
    document.getElementById('summaryWindow').textContent = `${Object.values(p.telemetry)[0]?.length || '—'} days`;
    document.getElementById('summaryRiskScore').textContent = `${fuserReport.compositeRiskScore}/100`;
    const findings = clinicalObservation.evidenceItems.filter(e => e.isAnomaly).length;
    document.getElementById('summaryFindings').textContent =
      findings > 0 ? `${findings} deviation${findings > 1 ? 's' : ''}` : 'None detected';
    const trajEl = document.getElementById('summaryTrajectory');
    const traj = fuserReport.trajectoryClassification?.replace(/_/g, ' ') || '—';
    trajEl.textContent = traj;
    trajEl.className = `summary-value summary-trajectory ${trajectoryClass(fuserReport.trajectoryClassification)}`;
  }

  _renderMetricTabs() {
    const container = document.getElementById('metricTabs');
    if (!container) return;
    container.innerHTML = '';
    const signals = Object.keys(this.patient.telemetry);
    if (!signals.includes(this.signal)) this.signal = signals[0];
    signals.forEach(sig => {
      const btn = document.createElement('button');
      btn.className = `metric-tab-btn${sig === this.signal ? ' active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.textContent = sigLabel(sig);
      btn.addEventListener('click', () => {
        this.signal = sig;
        this._renderMetricTabs();
        this._renderMainChart();
        this._renderBaselinePanel();
      });
      container.appendChild(btn);
    });
  }

  _renderMainChart() {
    const canvas = document.getElementById('mainTelemetryChart');
    if (!canvas) return;
    const allSeries = this.patient.telemetry[this.signal] || [];
    const windowSize = Math.min(this.timeWindow, allSeries.length);
    const series = allSeries.slice(-windowSize);
    const profile = this.result.baselineProfiles[this.signal];
    const unit = sigUnit(this.signal);
    const labels = series.map((d, i) => `Day ${allSeries.length - windowSize + i + 1}`);
    const values = series.map(d => d.value);
    const median = profile?.normalRange.median || 0;
    const lowerBound = profile?.normalRange.lowerBound || 0;
    const upperBound = profile?.normalRange.upperBound || 0;

    this._destroyMainChart();
    this.mainChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '_bandBase', data: values.map(() => lowerBound), borderWidth: 0, pointRadius: 0, fill: false, backgroundColor: 'transparent', borderColor: 'transparent' },
          { label: 'Normal Range', data: values.map(() => upperBound), borderWidth: 1, borderColor: C.bandBorder, borderDash: [3, 3], pointRadius: 0, fill: '-1', backgroundColor: C.bandFill },
          { label: 'Baseline Median', data: values.map(() => median), borderColor: C.baselineDash, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, fill: false },
          {
            label: `Observed (${unit})`, data: values,
            borderColor: C.observed, backgroundColor: C.observedFill, borderWidth: 2,
            tension: 0.3, fill: false, pointRadius: 4, pointHoverRadius: 6,
            pointBackgroundColor: ctx => (values[ctx.dataIndex] > upperBound || values[ctx.dataIndex] < lowerBound) ? C.anomaly : C.observed,
            pointBorderColor: ctx => (values[ctx.dataIndex] > upperBound || values[ctx.dataIndex] < lowerBound) ? 'rgba(182,74,69,0.3)' : 'rgba(72,107,88,0.3)',
            pointBorderWidth: 2,
          },
        ],
      },
      options: this._chartOptions(unit, lowerBound, upperBound, median),
    });
  }

  _renderBaselinePanel() {
    const container = document.getElementById('baselineGrid');
    if (!container) return;
    const profile = this.result.baselineProfiles[this.signal];
    const deviation = this.result.detectedDeviations[this.signal];
    const unit = sigUnit(this.signal);
    if (!profile) { container.innerHTML = '<div class="baseline-placeholder">No baseline data available.</div>'; return; }
    const { stats, normalRange } = profile;
    const cells = [
      { label: 'Baseline Median', value: fmt(stats.median), unit, desc: 'Historical median' },
      { label: 'Normal Range', value: `${fmt(normalRange.lowerBound)} – ${fmt(normalRange.upperBound)}`, unit, desc: 'MAD-based bounds' },
      { label: 'Std. Deviation', value: fmt(stats.stdDev), unit, desc: 'Population spread' },
      { label: 'MAD', value: fmt(stats.mad), unit, desc: 'Robust spread (MAD)' },
      { label: 'IQR', value: fmt(stats.iqr), unit, desc: 'Interquartile range' },
      { label: 'Adaptive EMA', value: fmt(profile.latestEMA), unit, desc: 'Exponential moving avg.' },
    ];
    container.innerHTML = cells.map(c => `
      <div class="baseline-stat">
        <div class="baseline-stat-label">${c.label}</div>
        <div class="baseline-stat-value">${c.value}<span class="baseline-stat-unit">${c.unit}</span></div>
        <div class="baseline-stat-desc">${c.desc}</div>
      </div>`).join('');
    if (deviation) {
      const displaySev = deviation.adjustedSeverity || deviation.severity;
      const devClass = displaySev === 'CRITICAL' ? 'dev-critical' : displaySev === 'WARNING' ? 'dev-warn' : 'dev-ok';
      const deviationRow = document.createElement('div');
      deviationRow.className = `baseline-deviation-row ${devClass}`;
      deviationRow.textContent = deviation.isDeviation
        ? `${sigLabel(this.signal)} is ${deviation.direction?.toLowerCase()} vs personal baseline — Z=${fmt(deviation.zScore, 2)}, Δ${deviation.deviationDelta >= 0 ? '+' : ''}${fmt(deviation.deviationDelta)} ${unit}`
        : `${sigLabel(this.signal)} is within the patient's established normal baseline.`;
      container.appendChild(deviationRow);
    }
  }

  _renderSyndromeScores() {
    const container = document.getElementById('syndromeRows');
    if (!container) return;
    const { synergyIndices, patientContext } = this.result.fuserReport;
    const rows = [
      synergyIndices.infectionIndex,
      synergyIndices.mechanicalJointIndex,
      synergyIndices.cardiacDecompIndex,
      synergyIndices.recoveryStallIndex,
    ];
    container.innerHTML = rows.map(idx => {
      const score = idx.score;
      const barClass = scoreBarClass(score);
      const labelClass = score >= 45 ? (score >= 70 ? 'score-critical' : 'score-flagged') : '';
      const sigs = idx.contributingSignals?.length ? idx.contributingSignals.join(' · ') : 'No contributing signals detected';
      return `
        <div class="syndrome-row">
          <div class="syndrome-header">
            <span class="syndrome-name">${idx.name}</span>
            <span class="syndrome-score-label ${labelClass}">${score}/100${idx.isFlagged ? ' ●' : ''}</span>
          </div>
          <div class="syndrome-bar-track"><div class="syndrome-bar-fill ${barClass}" style="width:${score}%"></div></div>
          <div class="syndrome-signals">${sigs}</div>
        </div>`;
    }).join('');

    const meta = document.getElementById('contextMetaBlock');
    if (!meta) return;
    const metaItems = [];
    if (patientContext.medications?.length) metaItems.push({ label: 'Medications', val: patientContext.medications.join(', ') });
    if (patientContext.comorbidities?.length) metaItems.push({ label: 'Comorbidities', val: patientContext.comorbidities.join(', ') });
    if (patientContext.inActiveExercise) metaItems.push({ label: 'Session State', val: 'Active physical therapy session' });
    if (patientContext.postOpDay) metaItems.push({ label: 'Post-Op Day', val: `Day ${patientContext.postOpDay}` });
    meta.innerHTML = metaItems.length ? metaItems.map(m =>
      `<div class="context-meta-item"><span class="context-meta-label">${m.label}</span><span>${m.val}</span></div>`
    ).join('') : '<div class="context-meta-item"><span class="context-meta-label">Context</span><span>No additional modifiers recorded</span></div>';
  }

  _renderObsPanel() {
    const obs = this.result.clinicalObservation;
    this._setEl('obsHeadline', obs.headline || '—');
    this._setEl('obsNarrative', obs.narrativeSummary || '—');
    this._renderActionsList('obsActionsList', obs.recommendedActions);
  }

  _renderEvidenceTable() {
    const tbody = document.getElementById('evidenceTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const items = this.result.clinicalObservation.evidenceItems;
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="td-muted" style="padding:16px;text-align:center">No signal evidence available.</td></tr>';
      return;
    }
    items.forEach(item => {
      const dev = item.observedValue - (item.baselineMedian || 0);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${sigLabel(item.metric)}</strong></td>
        <td class="td-mono">${fmt(item.observedValue)} ${sigUnit(item.metric)}</td>
        <td class="td-mono td-muted">${fmt(item.baselineMedian)} ${sigUnit(item.metric)}</td>
        <td class="td-mono td-muted">${item.normalRange || '—'}</td>
        <td class="td-mono ${item.isAnomaly ? 'delta-pos' : 'delta-ok'}">${dev >= 0 ? '+' : ''}${fmt(dev)} ${sigUnit(item.metric)}</td>
        <td class="td-mono td-muted">${item.zScore !== 'N/A' ? fmt(item.zScore, 2) : '—'}</td>
        <td><span class="status-chip ${severityChip(item.severity)}">${(item.severity || 'NORMAL').replace(/_/g, ' ')}</span></td>`;
      tbody.appendChild(tr);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  REAL-DATA RENDERERS  (E4 multi-signal)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Banner showing dataset attribution + session identity + honest scope limits.
   * Always present when Real Dataset mode is active.
   */
  _renderRealDataBannerE4(sessionResult, catalogueEntry) {
    const banner = document.getElementById('realDataBanner');
    if (!banner) return;
    banner.classList.remove('hidden');

    const src = sessionResult.datasetSource || {};
    const period = sessionResult.startISO && sessionResult.endISO
      ? `${fmtISO(sessionResult.startISO)} \u2192 ${fmtISO(sessionResult.endISO)}`
      : 'Unknown';
    const durStr = sessionResult.durationHours
      ? `${sessionResult.durationHours.toFixed(1)} h`
      : '—';
    const sigStr = (sessionResult.availableSignals || []).join(' \u00b7 ');
    const source  = catalogueEntry?.displayName || sessionResult.sessionId;

    this._setEl('rdbFilename', source);
    this._setEl('rdbSource', `${src.name || 'Wearable Exam Stress Dataset'} · DOI: ${src.doi || '10.13026/kvkb-aj90'} · Device: ${src.device || 'Empatica E4'}`);
    this._setEl('rdbRecords', `${sessionResult.totalValidRecords?.toLocaleString() || '—'} valid records`);
    this._setEl('rdbPeriod', `${period} · Duration: ${durStr}`);
    this._setEl('rdbInterval', `Signals: ${sigStr}`);
    this._setEl('rdbUnit', 'HR: bpm · Temp: °C · HRV: ms');
    this._setEl('rdbValidity', `Session: ${sessionResult.sessionId}`);
    this._setEl('rdbBaselineNote',
      'Session-specific baseline only. Multi-day rehabilitation baselines: NOT AVAILABLE from this dataset.');
  }

  _renderHeaderStatusReal(analysisResult) {
    const { fuserReport } = analysisResult;
    const pill = document.getElementById('riskStatusPill');
    const text = document.getElementById('riskStatusText');
    if (!pill || !text) return;
    pill.className = `header-status-pill ${riskLevelClass(fuserReport.riskLevel)}`;
    const sigCount = Object.keys(analysisResult.baselineProfiles || {}).length;
    text.textContent = `E4 Real Recording · ${sigCount} signal${sigCount !== 1 ? 's' : ''} · Score ${fuserReport.compositeRiskScore}/100`;
  }

  _renderSummaryBarRealE4(sessionResult, analysisResult) {
    const durH  = sessionResult.durationHours ? sessionResult.durationHours.toFixed(1) : '—';
    const sigs  = (sessionResult.availableSignals || []).join(', ') || '—';
    const dtStr = sessionResult.startISO
      ? new Date(sessionResult.startISO).toUTCString().slice(0, 16)
      : 'Unknown date';

    this._setEl('summaryPatientName', sessionResult.sessionId || 'Unknown Session');
    this._setEl('summaryPathway', `Exam Stress Dataset — Empatica E4 · ${sigs}`);
    this._setEl('summaryPOD', 'N/A (Research dataset)');
    this._setEl('summaryWindow', `${durH}h session · ${dtStr}`);
    this._setEl('summaryRiskScore', `${analysisResult.fuserReport.compositeRiskScore}/100`);
    this._setEl('summaryFindings', `${sessionResult.totalValidRecords?.toLocaleString() || '—'} records`);

    const trajEl = document.getElementById('summaryTrajectory');
    if (trajEl) {
      const traj = analysisResult.fuserReport.trajectoryClassification?.replace(/_/g, ' ') || '—';
      trajEl.textContent = traj;
      trajEl.className = `summary-value summary-trajectory ${trajectoryClass(analysisResult.fuserReport.trajectoryClassification)}`;
    }
  }

  /** Render one tab per available signal, clicking switches the chart signal. */
  _renderMetricTabsRealE4(sessionResult) {
    const container = document.getElementById('metricTabs');
    if (!container) return;
    container.innerHTML = '';

    const available = sessionResult.availableSignals || ['RESTING_HR'];

    available.forEach((sig, i) => {
      const btn = document.createElement('button');
      btn.className = `metric-tab-btn${i === 0 ? ' active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-signal', sig);
      btn.innerHTML = `${sigLabel(sig)} <span class="chart-real-badge">Real</span>`;
      btn.addEventListener('click', () => {
        container.querySelectorAll('.metric-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.signal = sig;
        const recId = this.currentRecordingId;
        const rec = REAL_RECORDINGS.get(recId);
        if (rec) this._renderMainChartRealE4(rec.sessionResult, sig);
      });
      container.appendChild(btn);
    });

    // Explicitly show unavailable signals as disabled buttons
    ['SPO2', 'PAIN_SCORE', 'DAILY_STEPS', 'GAIT_VELOCITY'].forEach(sig => {
      const btn = document.createElement('button');
      btn.className = 'metric-tab-btn';
      btn.setAttribute('disabled', 'true');
      btn.title = `${sigLabel(sig)} is not present in this dataset`;
      btn.style.opacity = '0.35';
      btn.style.cursor  = 'not-allowed';
      btn.innerHTML = `${sigLabel(sig)} <span class="chart-real-badge" style="background:#555">N/A</span>`;
      container.appendChild(btn);
    });
  }

  /** Chart for a given signal from the multi-signal session result. */
  _renderMainChartRealE4(sessionResult, signal = 'RESTING_HR') {
    const canvas = document.getElementById('mainTelemetryChart');
    if (!canvas) return;

    const timeSeries = sessionResult.parsedSignals?.[signal] || [];
    const meta       = sessionResult.signalMetadata?.[signal] || {};
    const unit       = sigUnit(signal);

    // Downsample for chart performance
    const MAX_POINTS = 500;
    let displayed = timeSeries;
    if (timeSeries.length > MAX_POINTS) {
      const step = Math.ceil(timeSeries.length / MAX_POINTS);
      displayed = timeSeries.filter((_, i) => i % step === 0);
    }

    const labels = displayed.map(r => {
      const d = new Date(r.timestamp);
      return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
    });
    const values = displayed.map(r => r.value);

    // Session-specific baseline (only if >= 30 records)
    const profile = this.result?.baselineProfiles?.[signal];
    const hasBaseline = !!profile && timeSeries.length >= 30;

    const median     = hasBaseline ? profile.normalRange.median     : null;
    const lowerBound = hasBaseline ? profile.normalRange.lowerBound : null;
    const upperBound = hasBaseline ? profile.normalRange.upperBound : null;

    const datasets = [];
    if (hasBaseline) {
      datasets.push(
        { label: '_bandBase', data: values.map(() => lowerBound), borderWidth: 0, pointRadius: 0, fill: false, backgroundColor: 'transparent', borderColor: 'transparent' },
        { label: 'Normal Range', data: values.map(() => upperBound), borderWidth: 1, borderColor: C.bandBorder, borderDash: [3, 3], pointRadius: 0, fill: '-1', backgroundColor: C.bandFill },
        { label: 'Session Baseline', data: values.map(() => median), borderColor: C.baselineDash, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, fill: false }
      );
    }

    const sigColorMap = { RESTING_HR: C.observed, TEMPERATURE: '#4fc3f7', HRV: '#aed581' };
    const sigColor = sigColorMap[signal] || C.observed;
    const sigFill  = sigColor + '1a';

    datasets.push({
      label: `${sigLabel(signal)} (${unit}) — Recorded`,
      data: values,
      borderColor: sigColor,
      backgroundColor: sigFill,
      borderWidth: 1.5,
      tension: 0.25,
      fill: false,
      pointRadius: displayed.length < 120 ? 3 : 0,
      pointHoverRadius: 5,
      pointBackgroundColor: ctx => {
        if (!hasBaseline) return sigColor;
        const v = values[ctx.dataIndex];
        return (v > upperBound || v < lowerBound) ? C.anomaly : sigColor;
      },
      pointBorderWidth: 0,
    });

    this._destroyMainChart();
    this.mainChart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: this._chartOptions(unit, lowerBound ?? 0, upperBound ?? 0, median ?? 0, true),
    });
  }

  /** Per-signal baseline grid + sufficiency check. */
  _renderBaselinePanelRealE4(sessionResult, analysisResult) {
    const container = document.getElementById('baselineGrid');
    if (!container) return;
    container.innerHTML = '';

    const available = sessionResult.availableSignals || [];

    if (available.length === 0) {
      container.innerHTML = `<div class="unavailable-panel" style="grid-column:1/-1">
        <div class="unavailable-panel-title">No Signals Available</div>
        No valid signal data was found in this session.
      </div>`;
      return;
    }

    // Per-signal baseline blocks
    available.forEach(sig => {
      const profile = analysisResult.baselineProfiles?.[sig];
      const ts      = sessionResult.parsedSignals?.[sig] || [];
      const meta    = sessionResult.signalMetadata?.[sig] || {};
      const unit    = sigUnit(sig);
      const label   = sigLabel(sig);
      const n       = ts.length;
      const hasBaseline = !!profile && n >= 30;

      const block = document.createElement('div');
      block.className = 'baseline-stat';
      block.style.gridColumn = '1 / -1';

      if (!hasBaseline) {
        block.innerHTML = `
          <div class="baseline-stat-label">${label}</div>
          <div class="baseline-stat-value" style="color:var(--text-muted)">Insufficient data</div>
          <div class="baseline-stat-desc">${n} record${n !== 1 ? 's' : ''} (min. 30 required for baseline)</div>`;
        container.appendChild(block);
        return;
      }

      const { stats, normalRange } = profile;
      block.style.gridColumn = '';
      // Render 2 stat cells for this signal
      const cells = [
        { label: `${label} Median`, value: fmt(stats.median), unit, desc: `From ${n} records` },
        { label: `${label} Range`, value: `${fmt(normalRange.lowerBound)} – ${fmt(normalRange.upperBound)}`, unit, desc: 'MAD-robust bounds' },
      ];
      block.innerHTML = cells.map(c => `
        <div class="baseline-stat-label">${c.label}</div>
        <div class="baseline-stat-value">${c.value}<span class="baseline-stat-unit"> ${c.unit}</span></div>
        <div class="baseline-stat-desc">${c.desc}</div>`).join('');
      container.appendChild(block);

      // Also show more detail cells
      const detailCells = [
        { label: `${label} Std Dev`, value: fmt(stats.stdDev), unit },
        { label: `${label} MAD`, value: fmt(stats.mad), unit },
        { label: `${label} Min/Max`, value: `${fmt(stats.min)} / ${fmt(stats.max)}`, unit },
        { label: `${label} EMA`, value: fmt(profile.latestEMA), unit },
      ];
      detailCells.forEach(c => {
        const d = document.createElement('div');
        d.className = 'baseline-stat';
        d.innerHTML = `
          <div class="baseline-stat-label">${c.label}</div>
          <div class="baseline-stat-value">${c.value}<span class="baseline-stat-unit"> ${c.unit}</span></div>
          <div class="baseline-stat-desc">Session record</div>`;
        container.appendChild(d);
      });

      // Deviation row
      const deviation = analysisResult.detectedDeviations?.[sig];
      if (deviation) {
        const displaySev = deviation.adjustedSeverity || deviation.severity;
        const devClass = displaySev === 'CRITICAL' ? 'dev-critical' : displaySev === 'WARNING' ? 'dev-warn' : 'dev-ok';
        const row = document.createElement('div');
        row.className = `baseline-deviation-row ${devClass}`;
        row.style.gridColumn = '1 / -1';
        row.textContent = deviation.isDeviation
          ? `${label}: latest is ${deviation.direction?.toLowerCase()} vs session baseline — Z=${fmt(deviation.zScore, 2)}, Δ${deviation.deviationDelta >= 0 ? '+' : ''}${fmt(deviation.deviationDelta)} ${unit}`
          : `${label}: within session baseline range.`;
        container.appendChild(row);
      }
    });

    // Honest note: session-only scope
    const scopeNote = document.createElement('div');
    scopeNote.className = 'baseline-deviation-row dev-ok';
    scopeNote.style.cssText = 'grid-column:1/-1;font-size:0.7rem;margin-top:4px;';
    scopeNote.textContent =
      'Baselines above are derived from this exam session only. ' +
      'Multi-day longitudinal baselines require >= 14 days of continuous recording and are NOT available from this dataset.';
    container.appendChild(scopeNote);
  }

  /**
   * Syndrome scores: show computed syndromes for available signals,
   * suppress and label ones that need missing signals.
   */
  _renderSyndromeScoresRealE4(sessionResult) {
    const container = document.getElementById('syndromeRows');
    if (!container) return;

    const available = sessionResult.availableSignals || [];
    const hasHR   = available.includes('RESTING_HR');
    const hasTemp = available.includes('TEMPERATURE');
    const hasHRV  = available.includes('HRV');
    const sigStr  = available.map(sigLabel).join(', ') || 'none';

    // If only HR is available, full suppress
    if (!hasTemp && !hasHRV) {
      container.innerHTML = `
        <div class="unavailable-panel">
          <div class="unavailable-panel-title">Multi-Signal Syndrome Assessment — Limited</div>
          Only Heart Rate is available in this session. Infection risk, cardiac decompensation,
          recovery-stall, and mechanical joint syndrome scores require Temperature and/or HRV signals.
          <br><br>Available: ${sigStr} · Missing: Temperature, HRV, SpO₂, ROM, Gait, Pain
        </div>`;
    } else {
      // HR + (TEMP and/or HRV): partial assessment may be meaningful
      container.innerHTML = `
        <div class="unavailable-panel" style="border-color:var(--accent-primary-subtle)">
          <div class="unavailable-panel-title">Syndrome Assessment — Partial (${available.length} of 7 signals)</div>
          Syndrome scores are computed from <strong>${sigStr}</strong> only.
          SpO₂, ROM, Gait Velocity, Pain Score, and Daily Steps are absent from this dataset
          and have not been fabricated. Syndrome indices relying on these signals are suppressed.
        </div>`;
    }

    const meta = document.getElementById('contextMetaBlock');
    if (meta) {
      const rows = [
        { label: 'Dataset', val: 'PhysioNet Wearable Exam Stress (exam context, not clinical rehabilitation)' },
        { label: 'Signal Coverage', val: sigStr || '—' },
        { label: 'Missing Signals', val: 'SpO₂, ROM, Gait, Pain Score, Steps — NOT present, NOT fabricated' },
        { label: 'Multi-Day Trends', val: 'NOT AVAILABLE — sessions are 1.5–3 hours each' },
      ];
      meta.innerHTML = rows.map(r => `
        <div class="context-meta-item">
          <span class="context-meta-label">${r.label}</span>
          <span>${r.val}</span>
        </div>`).join('');
    }
  }

  _renderObsPanelRealE4(sessionResult, analysisResult) {
    const obs     = analysisResult.clinicalObservation;
    const available = sessionResult.availableSignals || [];
    const sigStr  = available.map(sigLabel).join(', ') || 'unknown';
    const durStr  = sessionResult.durationHours
      ? `${sessionResult.durationHours.toFixed(1)} h`
      : '—';
    const dtStr = sessionResult.startISO
      ? new Date(sessionResult.startISO).toLocaleDateString()
      : 'unknown date';

    const headlineEl = document.getElementById('obsHeadline');
    if (headlineEl) {
      headlineEl.textContent = `Real Session (${sessionResult.sessionId}): ${obs.headline || '—'}`;
    }

    this._setEl('obsNarrative', obs.narrativeSummary || '—');
    this._renderActionsList('obsActionsList', obs.recommendedActions);

    const actionsEl = document.getElementById('obsActionsList');
    if (actionsEl) {
      const scopeNote = document.createElement('div');
      scopeNote.className = 'unavailable-panel';
      scopeNote.style.marginTop = '8px';
      scopeNote.innerHTML = `
        <div class="unavailable-panel-title">Clinical Scope — Exam Stress Dataset</div>
        Source: Wearable Exam Stress Dataset (PhysioNet, DOI: 10.13026/kvkb-aj90)<br>
        Signals available: <strong>${sigStr}</strong><br>
        Session duration: ${durStr} (recorded ${dtStr})<br>
        <strong>Multi-day rehabilitation trends: NOT AVAILABLE.</strong>
        Post-operative trajectory, SpO₂, ROM, Gait, Pain Score, and Steps are not present in this dataset.<br>
        This observation does not constitute a clinical assessment or diagnosis.`;
      actionsEl.appendChild(scopeNote);
    }

    document.getElementById('obsSimulationBar')?.classList.add('hidden');
  }

  /** Audit trail showing per-record evidence for all available signals. */
  _renderEvidenceTableRealE4(sessionResult, analysisResult) {
    const tbody = document.getElementById('evidenceTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const available = sessionResult.availableSignals || [];
    let hasAnyData  = false;

    available.forEach(sig => {
      const ts      = sessionResult.parsedSignals?.[sig] || [];
      const profile = analysisResult.baselineProfiles?.[sig];
      const unit    = sigUnit(sig);
      const label   = sigLabel(sig);

      if (ts.length === 0) return;
      hasAnyData = true;

      // Show the last 25 records per signal
      const auditSample = ts.slice(-25);
      auditSample.forEach(r => {
        const baseline = profile?.normalRange.median;
        const upper    = profile?.normalRange.upperBound;
        const lower    = profile?.normalRange.lowerBound;
        const dev      = baseline !== undefined ? r.value - baseline : null;
        const isAnom   = upper !== undefined && (r.value > upper || r.value < lower);
        const sev      = isAnom ? 'WARNING' : 'NORMAL';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${label}</strong></td>
          <td class="td-mono">${fmt(r.value)} ${unit}</td>
          <td class="td-mono td-muted">${baseline !== undefined ? `${fmt(baseline)} ${unit}` : '—'}</td>
          <td class="td-mono td-muted">${upper !== undefined ? `[${fmt(lower)}–${fmt(upper)}]` : 'Insufficient records'}</td>
          <td class="td-mono ${isAnom ? 'delta-pos' : 'delta-ok'}">${dev !== null ? `${dev >= 0 ? '+' : ''}${fmt(dev)} ${unit}` : '—'}</td>
          <td class="td-mono td-muted">—</td>
          <td><span class="status-chip ${severityChip(sev)}">${sev}</span></td>`;
        tbody.appendChild(tr);
      });

      // Signal summary row
      if (ts.length > 25) {
        const info = document.createElement('tr');
        info.innerHTML = `<td colspan="7" class="td-muted" style="padding:4px 12px;font-size:0.7rem">
          ${label}: showing last 25 of ${ts.length.toLocaleString()} records.
        </td>`;
        tbody.appendChild(info);
      }
    });

    if (!hasAnyData) {
      tbody.innerHTML = '<tr><td colspan="7" class="td-muted" style="padding:16px;text-align:center">No valid records in this session.</td></tr>';
    }

    // Dataset attribution footer
    const footer = document.createElement('tr');
    footer.innerHTML = `<td colspan="7" class="td-muted" style="padding:6px 12px;font-size:0.68rem;border-top:1px solid var(--border-secondary)">
      Source: Wearable Exam Stress Dataset · Amin, Wickramasuriya, Faghih · PhysioNet 2022 · DOI: 10.13026/kvkb-aj90 ·
      Session: ${sessionResult.sessionId} · Multi-day rehabilitation trends: NOT AVAILABLE.
    </td>`;
    tbody.appendChild(footer);
  }

  /** Show empty / import state when no recording is loaded yet */
  _renderRealNoDataState() {
    this._setEl('summaryPatientName', 'No recording loaded');
    this._setEl('summaryPathway', 'Import a CSV file to begin');
    this._setEl('summaryPOD', '—');
    this._setEl('summaryWindow', '—');
    this._setEl('summaryRiskScore', '—');
    this._setEl('summaryFindings', '—');

    const canvas = document.getElementById('mainTelemetryChart');
    if (canvas) {
      this._destroyMainChart();
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    const container = document.getElementById('metricTabs');
    if (container) container.innerHTML = '';

    document.getElementById('baselineGrid').innerHTML = `
      <div class="unavailable-panel" style="grid-column:1/-1">
        <div class="unavailable-panel-title">No Recording Loaded</div>
        Use the <strong>Import CSV</strong> button to load a PhysioNet-format HR CSV file.
        The file must contain two columns: Unix timestamp (float) and heart-rate value (float), one row per measurement.
      </div>`;

    document.getElementById('syndromeRows').innerHTML = `
      <div class="unavailable-panel">
        <div class="unavailable-panel-title">No Recording Loaded</div>
        Import a CSV file to view signal assessments.
      </div>`;

    document.getElementById('evidenceTableBody').innerHTML =
      '<tr><td colspan="7" class="td-muted" style="padding:16px;text-align:center">No data. Import a CSV file first.</td></tr>';

    this._setEl('obsHeadline', 'No recording loaded.');
    this._setEl('obsNarrative', 'Import a CSV file to generate clinical observations.');
    document.getElementById('obsActionsList').innerHTML = '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRENDS PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  _renderTrendsPage() {
    this._renderRadarChart();
    this._renderTrendTable();
    this._renderRiskGauge();
  }

  _renderRadarChart() {
    const canvas = document.getElementById('synergyRadarChart');
    if (!canvas) return;
    const indices = this.result?.fuserReport?.synergyIndices;
    if (!indices) return;

    const labels = ['Infection Risk', 'Mechanical Impairment', 'Cardiac Decomp.', 'Recovery Stall'];
    const scores = [
      indices.infectionIndex.score,
      indices.mechanicalJointIndex.score,
      indices.cardiacDecompIndex.score,
      indices.recoveryStallIndex.score,
    ];

    if (this.radarChart) { this.radarChart.destroy(); this.radarChart = null; }
    this.radarChart = new Chart(canvas, {
      type: 'radar',
      data: {
        labels,
        datasets: [{ label: 'Syndrome Index Score', data: scores, backgroundColor: C.radar1, borderColor: C.radar1Border, borderWidth: 1.5, pointBackgroundColor: C.radar1Border, pointBorderColor: 'rgba(72,107,88,0.3)', pointRadius: 3 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: '#9BA5A0', font: { family: "'Inter'", size: 11 }, boxWidth: 12 } },
          tooltip: { backgroundColor: C.tooltipBg, titleColor: C.tooltipText, padding: 10, cornerRadius: 4 },
        },
        scales: {
          r: {
            angleLines: { color: C.radarGrid }, grid: { color: C.radarGrid },
            pointLabels: { color: '#6B746F', font: { size: 11, family: "'Inter'" } },
            ticks: { display: false, backdropColor: 'transparent' }, suggestedMin: 0, suggestedMax: 100
          },
        },
      },
    });
  }

  _renderTrendTable() {
    const tbody = document.getElementById('trendTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const source = this.mode === 'real'
      ? REAL_RECORDINGS.get(this.currentRecordingId)?.adapterResult?.timeSeries
        ? { 'RESTING_HR': REAL_RECORDINGS.get(this.currentRecordingId).adapterResult.timeSeries }
        : {}
      : this.patient?.telemetry;

    if (!source || !this.result) return;
    Object.keys(source).forEach(sig => {
      const trend = this.result.trends?.[sig];
      const dev = this.result.detectedDeviations?.[sig];
      if (!trend) return;
      const dirArrow = trend.direction === 'INCREASING' ? '↑' : trend.direction === 'DECREASING' ? '↓' : '→';
      const sustained = dev?.sustainedShift;
      const sustLabel = sustained?.hasSustainedShift
        ? `<span class="status-chip chip-warning">${sustained.shiftType?.replace(/_/g, ' ')}</span>`
        : '<span class="status-chip chip-normal">STABLE</span>';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${sigLabel(sig)}</strong></td>
        <td>${dirArrow} ${trend.direction}</td>
        <td class="td-mono">${trend.changePerDay >= 0 ? '+' : ''}${fmt(trend.changePerDay, 2)} ${sigUnit(sig)}/day</td>
        <td class="td-mono">${fmt(trend.rSquared, 2)}</td>
        <td class="td-mono">${fmt(trend.totalDays, 0)} days</td>
        <td>${sustLabel}</td>`;
      tbody.appendChild(tr);
    });

    if (!tbody.children.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="td-muted" style="padding:16px;text-align:center">No trend data available.</td></tr>';
    }
  }

  _renderRiskGauge() {
    if (!this.result) return;
    const { compositeRiskScore, riskLevel } = this.result.fuserReport;
    this._setEl('riskGaugeNum', compositeRiskScore);
    this._setEl('riskGaugeSub', 'RISK INDEX');
    this._setEl('riskGaugeLevel', riskLevel);
    const outer = document.getElementById('riskGaugeOuter');
    if (outer) outer.className = `risk-gauge-outer ${gaugeClass(compositeRiskScore)}`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  OBSERVATIONS PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  _renderObservationsPage() {
    if (!this.result) return;
    const obs = this.result.clinicalObservation;
    this._setEl('obsHeadline2', obs.headline || '—');
    this._setEl('obsNarrative2', obs.narrativeSummary || '—');
    this._setEl('obsSummaryMsg', this.result.fuserReport.summaryMessage || '—');
    this._renderActionsList('obsActionsList2', obs.recommendedActions);
    const provLines = [
      `Report ID:          ${obs.reportId}`,
      `Subject/Session:    ${this.currentRecordingId ? REAL_RECORDINGS.get(this.currentRecordingId)?.sessionResult?.sessionId || '—' : obs.patientName}`,
      `Post-Op Day:        ${obs.postOpDay || 'N/A — research dataset'}`,
      `Analysis Timestamp: ${obs.timestamp}`,
      `Generated by:       ${obs.meta?.generatedBy}`,
      `Algorithm:          ${obs.meta?.algorithmVersion}`,
      `Standard:           ${obs.meta?.explainabilityStandard}`,
      `Risk Level:         ${obs.riskLevel} (${obs.compositeRiskScore}/100)`,
      this.mode === 'real'
        ? 'Mode: Real Dataset (Wearable Exam Stress · PhysioNet 2022 · DOI: 10.13026/kvkb-aj90)'
        : 'Mode: Demo Simulation',
    ];
    this._setEl('obsProvenance', provLines.join('\n'));

    if (this.mode === 'real') {
      const recId  = this.currentRecordingId;
      const sr     = recId ? REAL_RECORDINGS.get(recId)?.sessionResult : null;
      const sigs   = sr ? (sr.availableSignals || []).map(sigLabel).join(', ') : 'HR only';
      const sigNote = document.getElementById('obsSummaryMsg');
      if (sigNote) {
        sigNote.textContent +=
          `\n\nIMPORTANT: This observation is based on real wearable recordings from the PhysioNet Wearable Exam Stress Dataset ` +
          `(DOI: 10.13026/kvkb-aj90). Signals present: ${sigs}. ` +
          `Multi-day rehabilitation baselines, post-operative trajectory, and clinical syndrome scores requiring ` +
          `SpO\u2082, ROM, Gait, or Pain signals are NOT available and have not been fabricated. ` +
          `This observation does not constitute a clinical assessment or medical decision-making tool.`;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  REPORTS PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  _renderReportsPage() {
    if (this.mode === 'real' && this.currentRecordingId) {
      this._renderReportsPageReal();
    } else {
      this._renderReportsPageDemo();
    }
  }

  _renderReportsPageDemo() {
    const p = this.patient;
    const tel = p.telemetry;
    const sigs = Object.keys(tel);
    const firstDate = new Date(Object.values(tel)[0]?.[0]?.timestamp);
    const lastDate = new Date(Object.values(tel)[0]?.slice(-1)[0]?.timestamp);
    const periodStr = isNaN(firstDate) ? 'Unknown period' :
      `${firstDate.toLocaleDateString()} – ${lastDate.toLocaleDateString()}`;
    this._setEl('reportPeriodLabel', periodStr);
    const allPoints = sigs.reduce((acc, s) => acc + (tel[s]?.length || 0), 0);
    const metaGrid = document.getElementById('reportMetaGrid');
    if (metaGrid) {
      metaGrid.innerHTML = [
        { label: 'Patient', value: p.name },
        { label: 'Reporting Period', value: periodStr },
        { label: 'Signals Monitored', value: sigs.length },
        { label: 'Total Records', value: allPoints },
      ].map(c => `<div class="report-meta-cell"><div class="report-meta-label">${c.label}</div><div class="report-meta-value">${c.value}</div></div>`).join('');
    }
    const tbody = document.getElementById('reportTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const primarySig = sigs[0];
    const primarySeries = tel[primarySig] || [];
    const profile = this.result?.baselineProfiles?.[primarySig];
    const unit = sigUnit(primarySig);
    primarySeries.forEach((pt, i) => {
      const date = new Date(pt.timestamp).toLocaleDateString();
      const val = pt.value;
      const med = profile?.normalRange.median;
      const upper = profile?.normalRange.upperBound;
      const lower = profile?.normalRange.lowerBound;
      const delta = med !== undefined ? val - med : null;
      const status = upper !== undefined ? (val > upper ? 'chip-warning' : val < lower ? 'chip-mild' : 'chip-normal') : 'chip-normal';
      const statusLabel = upper !== undefined ? (val > upper ? 'ABOVE RANGE' : val < lower ? 'BELOW RANGE' : 'NORMAL') : 'UNKNOWN';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>Day ${i + 1}</td><td class="td-muted">${date}</td>
        <td>${sigLabel(primarySig)}</td><td class="td-mono">${fmt(val)} ${unit}</td>
        <td class="td-mono ${delta !== null && delta > 0 ? 'delta-pos' : delta !== null && delta < 0 ? 'delta-neg' : ''}">
          ${delta !== null ? `${delta >= 0 ? '+' : ''}${fmt(delta)} ${unit}` : '—'}</td>
        <td><span class="status-chip ${status}">${statusLabel}</span></td>`;
      tbody.appendChild(tr);
    });
    this._setEl('reportObsText', this.result?.clinicalObservation?.narrativeSummary);
  }

  _renderReportsPageReal() {
    const rec = REAL_RECORDINGS.get(this.currentRecordingId);
    if (!rec) return;
    const { sessionResult, analysisResult } = rec;

    const periodStr = sessionResult.startISO && sessionResult.endISO
      ? `${fmtISO(sessionResult.startISO)} \u2192 ${fmtISO(sessionResult.endISO)}`
      : 'Unknown';
    this._setEl('reportPeriodLabel', periodStr);

    const metaGrid = document.getElementById('reportMetaGrid');
    if (metaGrid) {
      const durH = sessionResult.durationHours ? sessionResult.durationHours.toFixed(1) : '—';
      const sigs = (sessionResult.availableSignals || []).join(', ') || '—';
      metaGrid.innerHTML = [
        { label: 'Session', value: sessionResult.sessionId || '—' },
        { label: 'Duration', value: `${durH} hours` },
        { label: 'Signals', value: sigs },
        { label: 'Valid Records', value: sessionResult.totalValidRecords?.toLocaleString() || '—' },
      ].map(c => `<div class="report-meta-cell"><div class="report-meta-label">${c.label}</div><div class="report-meta-value">${c.value}</div></div>`).join('');
    }

    const tbody = document.getElementById('reportTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Per-signal hourly rows for all available signals
    (sessionResult.availableSignals || []).forEach(sig => {
      const ts = sessionResult.parsedSignals?.[sig] || [];
      if (ts.length === 0) return;

      const hourly = aggregateHourly(ts);
      const unit   = sigUnit(sig);
      const label  = sigLabel(sig);
      const profile = analysisResult?.baselineProfiles?.[sig];
      const med     = profile?.normalRange.median;

      hourly.forEach(h => {
        const dtLabel = new Date(h.isoHour).toUTCString().slice(0, 22);
        const delta   = med !== undefined && h.mean !== null ? h.mean - med : null;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>—</td>
          <td class="td-muted">${dtLabel}</td>
          <td>${label}</td>
          <td class="td-mono">avg ${fmt(h.mean)} ${unit} (n=${h.count})</td>
          <td class="td-mono ${delta !== null && delta > 0 ? 'delta-pos' : delta !== null && delta < 0 ? 'delta-neg' : ''}">
            ${delta !== null ? `${delta >= 0 ? '+' : ''}${fmt(delta)} ${unit}` : '—'}</td>
          <td><span class="status-chip chip-normal">HOURLY</span></td>`;
        tbody.appendChild(tr);
      });
    });

    if (!tbody.children.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="td-muted" style="padding:16px;text-align:center">No signal data available for this session.</td></tr>';
    }

    const sigList = (sessionResult.availableSignals || []).map(sigLabel).join(', ');
    const durH = sessionResult.durationHours ? sessionResult.durationHours.toFixed(1) : '—';
    const obsText =
      `Session: ${sessionResult.sessionId}\n` +
      `Signals: ${sigList}\n` +
      `Duration: ${durH} hours (${new Date(sessionResult.startISO).toUTCString().slice(0, 16)})\n` +
      `Total valid records: ${sessionResult.totalValidRecords?.toLocaleString() || '—'}\n\n` +
      (sessionResult.clinicalLimitations || []).slice(0, 3).join('\n') +
      '\n\nMulti-day rehabilitation trends: NOT AVAILABLE from this dataset.';
    this._setEl('reportObsText', obsText);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATA QUALITY PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  _renderQualityPage() {
    if (this.mode === 'real' && this.currentRecordingId) {
      this._renderQualityPageReal();
    } else {
      this._renderQualityPageDemo();
    }
  }

  _renderQualityPageDemo() {
    const tel = this.patient?.telemetry;
    const sigs = Object.keys(tel || {});
    let totalRecords = 0, totalValid = 0;
    const tbody = document.getElementById('qualityTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    sigs.forEach(sig => {
      const series = tel[sig] || [];
      const total = series.length;
      const valid = series.filter(d => d.value !== null && !isNaN(d.value)).length;
      const coverage = total > 0 ? Math.round((valid / total) * 100) : 0;
      totalRecords += total; totalValid += valid;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${sigLabel(sig)}</strong></td>
        <td class="td-mono">${total}</td>
        <td class="td-mono text-ok">${valid}</td>
        <td class="td-mono">${total - valid}</td>
        <td class="td-mono">0</td>
        <td><div style="display:flex;align-items:center;gap:8px;"><div class="coverage-bar-track" style="width:60px"><div class="coverage-bar-fill" style="width:${coverage}%"></div></div><span class="td-mono">${coverage}%</span></div></td>
        <td><span class="status-chip ${coverage === 100 ? 'chip-normal' : 'chip-mild'}">SIM DATA</span></td>`;
      tbody.appendChild(tr);
    });
    const statsRow = document.getElementById('qualityStatsRow');
    if (statsRow) {
      statsRow.innerHTML = [
        { label: 'Total Records', val: totalRecords }, { label: 'Valid', val: totalValid },
        { label: 'Missing', val: totalRecords - totalValid }, { label: 'Signals', val: sigs.length },
      ].map(c => `<div class="quality-stat-cell"><div class="quality-stat-label">${c.label}</div><div class="quality-stat-value">${c.val}</div></div>`).join('');
    }
  }

  _renderQualityPageReal() {
    const rec = REAL_RECORDINGS.get(this.currentRecordingId);
    if (!rec) return;
    const { sessionResult } = rec;

    const tbody = document.getElementById('qualityTableBody');
    if (tbody) {
      tbody.innerHTML = '';
      let totalValid   = 0;
      let totalInvalid = 0;

      (sessionResult.availableSignals || []).forEach(sig => {
        const meta = sessionResult.signalMetadata?.[sig] || {};
        const ts   = sessionResult.parsedSignals?.[sig] || [];
        const n    = ts.length;
        const inv  = meta.invalidCount ?? 0;
        const coverage = meta.coveragePercent !== null && meta.coveragePercent !== undefined
          ? Math.round(meta.coveragePercent)
          : (n > 0 ? Math.round((n / (n + inv)) * 100) : 0);

        totalValid   += n;
        totalInvalid += inv;

        const label = sigLabel(sig);
        const unit  = sigUnit(sig);
        const sampleHz = meta.sampleHz ? `${meta.sampleHz} Hz` : '—';

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${label} (${sig})</strong><br><span class="td-muted" style="font-size:0.7rem">${unit} · ${sampleHz}</span></td>
          <td class="td-mono">${n + inv}</td>
          <td class="td-mono text-ok">${n}</td>
          <td class="td-mono">${inv}</td>
          <td class="td-mono ${inv > 0 ? 'text-warn' : ''}">
            ${inv > 0 ? `${inv} rejected (out-of-range / artefact)` : '0'}
          </td>
          <td><div style="display:flex;align-items:center;gap:8px;"><div class="coverage-bar-track" style="width:60px"><div class="coverage-bar-fill" style="width:${coverage}%"></div></div><span class="td-mono">${coverage}%</span></div></td>
          <td><span class="status-chip ${coverage >= 95 ? 'chip-normal' : coverage >= 80 ? 'chip-mild' : 'chip-warning'}">${coverage >= 95 ? 'GOOD' : coverage >= 80 ? 'PARTIAL' : 'DEGRADED'}</span></td>`;
        tbody.appendChild(tr);
      });

      // Row for each unavailable signal
      ['SPO2', 'PAIN_SCORE', 'DAILY_STEPS'].forEach(sig => {
        const tr = document.createElement('tr');
        tr.style.opacity = '0.45';
        tr.innerHTML = `
          <td><strong>${sigLabel(sig)}</strong></td>
          <td class="td-mono">—</td><td class="td-mono">—</td>
          <td class="td-mono">—</td><td class="td-mono">—</td>
          <td>—</td>
          <td><span class="status-chip" style="background:#333">NOT IN DATASET</span></td>`;
        tbody.appendChild(tr);
      });
    }

    const statsRow = document.getElementById('qualityStatsRow');
    if (statsRow) {
      const durH = sessionResult.durationHours ? sessionResult.durationHours.toFixed(1) : '—';
      const totalValid2 = sessionResult.totalValidRecords ?? 0;
      statsRow.innerHTML = [
        { label: 'Valid Records', val: totalValid2.toLocaleString() },
        { label: 'Signals', val: (sessionResult.availableSignals || []).length },
        { label: 'Session Duration', val: `${durH}h` },
        { label: 'Unavailable', val: 'SpO₂, ROM, Gait, Pain, Steps' },
      ].map(c => `<div class="quality-stat-cell"><div class="quality-stat-label">${c.label}</div><div class="quality-stat-value">${c.val}</div></div>`).join('');
    }

    // Quality notes
    const allNotes = [];
    (sessionResult.availableSignals || []).forEach(sig => {
      const notes = sessionResult.signalMetadata?.[sig]?.qualityNotes || [];
      allNotes.push(...notes);
    });
    allNotes.push(...(sessionResult.clinicalLimitations || []).slice(0, 2));

    if (allNotes.length) {
      const note = document.querySelector('.data-quality-note');
      if (note) note.textContent = allNotes.join(' · ');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FHIR PAGE
  // ═══════════════════════════════════════════════════════════════════════════
  _renderFhirPage() {
    if (!this.result) return;
    const obs = this.result.clinicalObservation;
    const fhir = obs.fhirResource;
    const display = document.getElementById('fhirJsonDisplay');
    if (display) display.textContent = JSON.stringify(fhir, null, 2);
    const summary = document.getElementById('fhirSummaryRows');
    if (summary) {
      const rows = [
        { label: 'Resource Type', val: fhir.resourceType },
        { label: 'Status', val: fhir.status },
        { label: 'Patient Ref', val: fhir.subject?.reference },
        { label: 'Patient Name', val: fhir.subject?.display },
        { label: 'Generated At', val: new Date(fhir.occurrenceDateTime).toLocaleString() },
        { label: 'Risk Level', val: this.result.fuserReport.riskLevel },
        { label: 'Risk Score', val: `${this.result.fuserReport.compositeRiskScore}/100` },
        { label: 'Data Mode', val: this.mode === 'real'
          ? `Real Dataset — E4 (${REAL_RECORDINGS.get(this.currentRecordingId)?.sessionResult?.sessionId || 'unknown session'})`
          : 'Demo Simulation' },
        { label: 'FHIR Standard', val: 'HL7 FHIR R4' },
      ];
      summary.innerHTML = rows.map(r =>
        `<div class="fhir-summary-row"><span class="fhir-summary-row-label">${r.label}</span><span class="fhir-summary-row-value">${r.val || '—'}</span></div>`
      ).join('');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SIMULATION (demo mode only)
  // ═══════════════════════════════════════════════════════════════════════════
  _injectAnomaly() {
    if (!this.simActive) this._origTelemetry = JSON.parse(JSON.stringify(this.patient.telemetry));
    const tel = this.patient.telemetry;
    if (tel['RESTING_HR']) tel['RESTING_HR'][tel['RESTING_HR'].length - 1].value += 22;
    if (tel['TEMPERATURE']) {
      const last = tel['TEMPERATURE'][tel['TEMPERATURE'].length - 1];
      last.value = Number((last.value + 1.4).toFixed(1));
    }
    if (tel['SPO2']) tel['SPO2'][tel['SPO2'].length - 1].value = Math.max(88, tel['SPO2'][tel['SPO2'].length - 1].value - 5);
    this.simActive = true;
    this._syncSimState();
    this._runDemoAnalysis();
  }

  _resetSimulation() {
    if (this._origTelemetry) { this.patient.telemetry = this._origTelemetry; this._origTelemetry = null; }
    this.simActive = false;
    this._syncSimState();
    this._runDemoAnalysis();
  }

  _syncSimState() {
    const bar = document.getElementById('obsSimulationBar');
    const btn = document.getElementById('injectAnomalyBtn');
    if (bar) bar.classList.toggle('hidden', !this.simActive);
    if (btn) {
      btn.innerHTML = this.simActive
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Re-inject Anomaly`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Simulate Acute Anomaly`;
      btn.className = `btn-primary-clinical${this.simActive ? ' sim-active' : ''}`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SHARED HELPERS
  // ═══════════════════════════════════════════════════════════════════════════
  _renderActionsList(containerId, actions) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    (actions || []).forEach(act => {
      const div = document.createElement('div');
      div.className = `obs-action-item priority-${act.priority}`;
      div.innerHTML = `<span class="obs-action-priority priority-chip-${act.priority}">${act.priority}</span><span class="obs-action-text">${act.action}</span>`;
      container.appendChild(div);
    });
  }

  _chartOptions(unit, lowerBound, upperBound, median, isReal = false) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: C.tooltipBg,
          titleColor: C.tooltipText,
          bodyColor: 'rgba(216,228,220,0.75)',
          borderColor: 'rgba(72,107,88,0.3)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 4,
          callbacks: {
            label: item => {
              if (item.dataset.label.startsWith('_') || item.dataset.label === 'Normal Range') return null;
              const v = item.parsed.y;
              let line = `${item.dataset.label}: ${fmt(v)} ${unit}`;
              if (!item.dataset.label.includes('Baseline') && upperBound > 0) {
                if (v > upperBound) line += ' ↑ above range';
                else if (v < lowerBound) line += ' ↓ below range';
                else line += ' — within range';
              }
              return line;
            },
            afterBody: () => median > 0
              ? [`Baseline: ${fmt(median)} ${unit}`, `Range: ${fmt(lowerBound)} – ${fmt(upperBound)} ${unit}`]
              : ['Baseline: Insufficient data'],
          },
          filter: item => !item.dataset.label.startsWith('_'),
        },
      },
      scales: {
        x: { grid: { color: C.gridLine, drawTicks: false }, border: { color: 'rgba(37,49,44,0.12)' }, ticks: { color: C.tick, font: { family: "'Inter'", size: 11 }, maxRotation: 0, maxTicksLimit: isReal ? 12 : 20 } },
        y: { grid: { color: C.gridLine, drawTicks: false }, border: { color: 'rgba(37,49,44,0.12)' }, ticks: { color: C.tick, font: { family: "'Inter'", size: 11 }, callback: v => `${fmt(v, 0)} ${unit}` } },
      },
    };
  }

  _destroyMainChart() {
    if (this.mainChart) { this.mainChart.destroy(); this.mainChart = null; }
  }

  _setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text ?? '—';
  }

  _copyObservation() {
    const obs = this.result?.clinicalObservation;
    if (!obs) return;
    const text = `${obs.headline}\n\n${obs.narrativeSummary}\n\nSuggested Actions:\n${obs.recommendedActions.map(a => `[${a.priority}] ${a.action}`).join('\n')}`;
    navigator.clipboard.writeText(text).catch(() => { });
  }

  _exportEvidence() {
    if (!this.result) return;
    const recId = this.currentRecordingId;
    let items;
    if (this.mode === 'real' && recId) {
      const rec = REAL_RECORDINGS.get(recId);
      // Export all parsedSignals time-series as evidence
      items = rec?.sessionResult?.parsedSignals || {};
    } else {
      items = this.result.clinicalObservation.evidenceItems;
    }
    this._downloadJSON(JSON.stringify(items, null, 2), `evidence-${Date.now()}.json`);
  }

  _exportReport() {
    if (!this.result) return;
    const recId = this.currentRecordingId;
    let data;
    if (this.mode === 'real' && recId) {
      const rec = REAL_RECORDINGS.get(recId);
      if (rec) {
        data = generateSessionReport(rec.sessionResult, rec.catalogueEntry);
        data.baselineProfiles  = this.result.baselineProfiles;
        data.fhirResource      = this.result.clinicalObservation.fhirResource;
        data.analysisTimestamp = this.result.clinicalObservation.timestamp;
      }
    } else {
      data = { patient: this.result.patient, baselineProfiles: this.result.baselineProfiles, observation: this.result.clinicalObservation };
    }
    this._downloadJSON(JSON.stringify(data, null, 2), `report-${Date.now()}.json`);
  }

  _downloadJSON(json, filename) {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { new ClinicalDashboard(); });
