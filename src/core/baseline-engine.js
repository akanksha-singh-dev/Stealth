/**
 * @file baseline-engine.js
 * @description Longitudinal Baseline Engine for learning individual patient normal patterns.
 * Computes robust statistical baselines, circadian time-of-day normal ranges, 
 * exponential moving averages, and expected recovery trajectory curves.
 */

export class BaselineEngine {
  /**
   * @param {Object} [options]
   * @param {number} [options.defaultWindowSize=14] - Default lookback window in days
   * @param {number} [options.madMultiplier=2.5] - Multiplier for MAD bounds (default ~98.7% normal range)
   * @param {number} [options.emaAlpha=0.2] - Weight for exponential moving average
   */
  constructor(options = {}) {
    this.defaultWindowSize = options.defaultWindowSize || 14;
    this.madMultiplier = options.madMultiplier || 2.5;
    this.emaAlpha = options.emaAlpha || 0.2;
  }

  /**
   * Calculates basic descriptive statistics (Mean, Median, StdDev, MAD, IQR) for an array of numbers.
   * @param {number[]} values 
   * @returns {Object} Statistical summary
   */
  calculateStats(values) {
    if (!values || values.length === 0) {
      return { count: 0, mean: 0, median: 0, stdDev: 0, mad: 0, iqr: 0, min: 0, max: 0 };
    }

    const cleanValues = values.filter(v => typeof v === 'number' && !isNaN(v) && isFinite(v));
    if (cleanValues.length === 0) {
      return { count: 0, mean: 0, median: 0, stdDev: 0, mad: 0, iqr: 0, min: 0, max: 0 };
    }

    const sorted = [...cleanValues].sort((a, b) => a - b);
    const count = sorted.length;
    
    // Mean
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const mean = sum / count;

    // Median
    const median = this._percentile(sorted, 50);

    // Standard Deviation
    const variance = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (count > 1 ? count - 1 : 1);
    const stdDev = Math.sqrt(variance);

    // Median Absolute Deviation (MAD)
    const absoluteDeviations = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = this._percentile(absoluteDeviations, 50);

    // IQR (Interquartile Range)
    const q1 = this._percentile(sorted, 25);
    const q3 = this._percentile(sorted, 75);
    const iqr = q3 - q1;

    return {
      count,
      mean: Number(mean.toFixed(2)),
      median: Number(median.toFixed(2)),
      stdDev: Number(stdDev.toFixed(2)),
      mad: Number(mad.toFixed(2)),
      iqr: Number(iqr.toFixed(2)),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p15: Number(this._percentile(sorted, 15).toFixed(2)),
      p85: Number(this._percentile(sorted, 85).toFixed(2))
    };
  }

  /**
   * Computes Exponential Moving Average (EMA) baseline over time-series data.
   * @param {Array<{timestamp: string|Date, value: number}>} timeSeries 
   * @param {number} [alpha] 
   * @returns {number[]} Array of EMA values matching timeSeries order
   */
  calculateEMA(timeSeries, alpha = this.emaAlpha) {
    if (!timeSeries || timeSeries.length === 0) return [];
    
    const emaValues = [];
    let currentEMA = timeSeries[0].value;
    
    for (let i = 0; i < timeSeries.length; i++) {
      const val = timeSeries[i].value;
      if (i === 0) {
        currentEMA = val;
      } else {
        currentEMA = (alpha * val) + ((1 - alpha) * currentEMA);
      }
      emaValues.push(Number(currentEMA.toFixed(2)));
    }
    
    return emaValues;
  }

  /**
   * Partitions data into circadian (time-of-day) buckets and computes separate baselines.
   * Buckets: NIGHT (00-06), MORNING (06-12), AFTERNOON (12-18), EVENING (18-24)
   * @param {Array<{timestamp: string|Date, value: number}>} readings 
   * @returns {Object.<string, Object>} Baseline stats per circadian slot
   */
  computeCircadianBaseline(readings) {
    const buckets = {
      NIGHT: [],
      MORNING: [],
      AFTERNOON: [],
      EVENING: []
    };

    readings.forEach(r => {
      const date = new Date(r.timestamp);
      const hour = date.getUTCHours();

      if (hour >= 0 && hour < 6) buckets.NIGHT.push(r.value);
      else if (hour >= 6 && hour < 12) buckets.MORNING.push(r.value);
      else if (hour >= 12 && hour < 18) buckets.AFTERNOON.push(r.value);
      else buckets.EVENING.push(r.value);
    });

    const result = {};
    for (const [slot, values] of Object.entries(buckets)) {
      result[slot] = this.calculateStats(values);
    }
    return result;
  }

  /**
   * Computes individual baseline profile for a metric over a longitudinal dataset.
   * Provides bounds: [lowerBound, upperBound] using MAD (or IQR/StdDev fallback).
   * @param {Array<{timestamp: string|Date, value: number}>} readings 
   * @param {Object} [config]
   * @param {string} [config.signalName]
   * @param {string} [config.unit]
   * @returns {Object} Complete Baseline Profile
   */
  buildMetricBaselineProfile(readings, config = {}) {
    const stats = this.calculateStats(readings.map(r => r.value));
    
    // Robust bounds: median +/- (madMultiplier * MAD)
    // If MAD is zero (flat signal), fallback to 5% of median or stdDev
    const madBuffer = stats.mad > 0 ? (stats.mad * this.madMultiplier) : Math.max(stats.stdDev * 1.5, Math.abs(stats.median) * 0.05, 1);
    
    const lowerBound = Number(Math.max(0, stats.median - madBuffer).toFixed(2));
    const upperBound = Number((stats.median + madBuffer).toFixed(2));

    const circadian = this.computeCircadianBaseline(readings);
    const emaSeries = this.calculateEMA(readings);

    return {
      signalName: config.signalName || 'Unknown Metric',
      unit: config.unit || '',
      sampleCount: stats.count,
      stats,
      normalRange: {
        lowerBound,
        upperBound,
        median: stats.median,
        p15: stats.p15,
        p85: stats.p85
      },
      circadian,
      latestEMA: emaSeries.length > 0 ? emaSeries[emaSeries.length - 1] : stats.median,
      lastUpdated: readings.length > 0 ? readings[readings.length - 1].timestamp : null
    };
  }

  /**
   * Computes expected recovery baseline trajectory curve based on clinical protocol models.
   * e.g. Post-Op recovery: knee ROM increases over post-op days 1..14; pain score decreases.
   * @param {number} postOpDay 
   * @param {string} metricType - 'KNEE_FLEXION_ROM', 'GAIT_VELOCITY', 'PAIN_SCORE', 'DAILY_STEPS'
   * @returns {Object} Expected mean and acceptable variance range for that post-op day
   */
  getExpectedTrajectoryBaseline(postOpDay, metricType) {
    const day = Math.max(1, Math.min(90, postOpDay));
    
    switch (metricType) {
      case 'KNEE_FLEXION_ROM': {
        // Sigmoidal recovery from 60 deg on Day 1 to ~115 deg on Day 14+
        const expectedDeg = 65 + (50 / (1 + Math.exp(-0.35 * (day - 6))));
        const margin = Math.max(5, 15 - (day * 0.5));
        return {
          expected: Number(expectedDeg.toFixed(1)),
          lowerBound: Number((expectedDeg - margin).toFixed(1)),
          upperBound: Number((expectedDeg + margin).toFixed(1)),
          unit: 'degrees'
        };
      }
      case 'PAIN_SCORE': {
        // Exponential decrease from ~7 on Day 1 down to ~1.5 on Day 14
        const expectedPain = 1.5 + (6 * Math.exp(-0.25 * (day - 1)));
        return {
          expected: Number(expectedPain.toFixed(1)),
          lowerBound: 0,
          upperBound: Number(Math.min(10, expectedPain + 2.0).toFixed(1)),
          unit: 'NPRS (0-10)'
        };
      }
      case 'GAIT_VELOCITY': {
        // Recovery in m/s from 0.4 m/s to 1.1 m/s
        const expectedVel = 0.4 + (0.75 * (1 - Math.exp(-0.15 * day)));
        return {
          expected: Number(expectedVel.toFixed(2)),
          lowerBound: Number(Math.max(0.2, expectedVel - 0.18).toFixed(2)),
          upperBound: Number((expectedVel + 0.25).toFixed(2)),
          unit: 'm/s'
        };
      }
      case 'DAILY_STEPS': {
        // Step progression from 800 steps to 6000+ steps over 30 days
        const expectedSteps = 800 + (6000 * (1 - Math.exp(-0.08 * day)));
        return {
          expected: Math.round(expectedSteps),
          lowerBound: Math.round(Math.max(300, expectedSteps * 0.65)),
          upperBound: Math.round(expectedSteps * 1.45),
          unit: 'steps/day'
        };
      }
      default:
        return { expected: 0, lowerBound: 0, upperBound: 100, unit: 'units' };
    }
  }

  /**
   * Percentile helper (interpolated)
   * @private
   */
  _percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    if (sortedArr.length === 1) return sortedArr[0];
    const index = (p / 100) * (sortedArr.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (upper >= sortedArr.length) return sortedArr[sortedArr.length - 1];
    return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
  }
}
