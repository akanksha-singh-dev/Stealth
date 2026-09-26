/**
 * @file deviation-detector.js
 * @description Meaningful Deviation & Trend Detection Engine.
 * Detects acute spikes, sustained baseline shifts, trend slopes, 
 * trajectory lags, and filters artifact noise.
 */

export class DeviationDetector {
  /**
   * @param {Object} [options]
   * @param {number} [options.modifiedZWarning=2.5] - Modified Z threshold for Warning
   * @param {number} [options.modifiedZCritical=3.5] - Modified Z threshold for Critical
   * @param {number} [options.minSustainedDays=3] - Days required to declare sustained baseline shift
   */
  constructor(options = {}) {
    this.modifiedZWarning = options.modifiedZWarning || 2.5;
    this.modifiedZCritical = options.modifiedZCritical || 3.5;
    this.minSustainedDays = options.minSustainedDays || 3;
  }

  /**
   * Computes Modified Z-Score using Median Absolute Deviation (MAD).
   * Modified Z = 0.6745 * (x - median) / MAD
   * @param {number} value 
   * @param {number} median 
   * @param {number} mad 
   * @returns {number} Modified Z score
   */
  calculateModifiedZScore(value, median, mad) {
    if (!mad || mad === 0) {
      // Fallback if zero variance: use simple % difference or standard Z substitute
      const diff = value - median;
      if (Math.abs(diff) < 1e-5) return 0;
      return (diff / (Math.abs(median) * 0.05 || 1.0)) * 0.6745;
    }
    return (0.6745 * (value - median)) / mad;
  }

  /**
   * Evaluates if a single reading or latest observation is a physiological artifact or true anomaly.
   * @param {number} value 
   * @param {string} signalName 
   * @returns {boolean} True if artifact noise
   */
  isArtifactNoise(value, signalName) {
    if (value === null || value === undefined || isNaN(value)) return true;
    
    // Physiological sanity checks
    const bounds = {
      'RESTING_HR': { min: 25, max: 220 },
      'HRV': { min: 2, max: 250 },
      'SPO2': { min: 50, max: 100 },
      'TEMPERATURE': { min: 32.0, max: 43.0 },
      'SYSTOLIC_BP': { min: 40, max: 280 },
      'DIASTOLIC_BP': { min: 20, max: 160 },
      'KNEE_FLEXION_ROM': { min: -10, max: 160 },
      'PAIN_SCORE': { min: 0, max: 10 }
    };

    const normKey = Object.keys(bounds).find(k => signalName.toUpperCase().includes(k));
    if (normKey) {
      const b = bounds[normKey];
      if (value < b.min || value > b.max) return true;
    }
    return false;
  }

  /**
   * Detects acute deviation for a given reading against a baseline profile.
   * @param {number} value 
   * @param {Object} baselineProfile - Output from BaselineEngine.buildMetricBaselineProfile
   * @param {string} [timeOfDay] - 'NIGHT', 'MORNING', 'AFTERNOON', 'EVENING'
   * @returns {Object} Acute deviation report
   */
  detectAcuteDeviation(value, baselineProfile, timeOfDay = null) {
    if (this.isArtifactNoise(value, baselineProfile.signalName)) {
      return {
        isDeviation: false,
        severity: 'ARTIFACT_NOISE',
        direction: 'NONE',
        zScore: 0,
        message: `Reading ${value} rejected as non-physiological artifact.`,
        baselineValue: baselineProfile.stats.median,
        deviationValue: value
      };
    }

    // Determine baseline median & mad (circadian-adjusted if available)
    let median = baselineProfile.stats.median;
    let mad = baselineProfile.stats.mad;

    if (timeOfDay && baselineProfile.circadian && baselineProfile.circadian[timeOfDay] && baselineProfile.circadian[timeOfDay].count >= 3) {
      median = baselineProfile.circadian[timeOfDay].median;
      mad = baselineProfile.circadian[timeOfDay].mad;
    }

    const zScore = this.calculateModifiedZScore(value, median, mad);
    const absZ = Math.abs(zScore);

    let severity = 'NORMAL';
    let isDeviation = false;

    if (absZ >= this.modifiedZCritical) {
      severity = 'CRITICAL';
      isDeviation = true;
    } else if (absZ >= this.modifiedZWarning) {
      severity = 'WARNING';
      isDeviation = true;
    } else if (value < baselineProfile.normalRange.lowerBound || value > baselineProfile.normalRange.upperBound) {
      severity = 'MILD';
      isDeviation = true;
    }

    const direction = value > median ? 'HIGH' : value < median ? 'LOW' : 'STABLE';

    return {
      isDeviation,
      severity,
      direction,
      zScore: Number(zScore.toFixed(2)),
      deviationDelta: Number((value - median).toFixed(2)),
      percentChange: median !== 0 ? Number((((value - median) / median) * 100).toFixed(1)) : 0,
      baselineMedian: median,
      observedValue: value,
      normalRange: baselineProfile.normalRange,
      message: isDeviation 
        ? `${baselineProfile.signalName} is significantly ${direction.toLowerCase()} (${value} vs baseline ${median}, Z=${zScore.toFixed(1)})`
        : `${baselineProfile.signalName} within expected normal baseline.`
    };
  }

  /**
   * Performs Linear Regression to compute trend slope and direction over a window of readings.
   * @param {Array<{timestamp: string|Date, value: number}>} timeSeries 
   * @returns {Object} Linear trend details (slope, R-squared, direction)
   */
  calculateTrendSlope(timeSeries) {
    if (!timeSeries || timeSeries.length < 2) {
      return { slope: 0, rSquared: 0, direction: 'STABLE', changePerDay: 0 };
    }

    const validSeries = timeSeries.filter(d => typeof d.value === 'number' && !isNaN(d.value));
    if (validSeries.length < 2) return { slope: 0, rSquared: 0, direction: 'STABLE', changePerDay: 0 };

    const startTime = new Date(validSeries[0].timestamp).getTime();
    const points = validSeries.map(d => ({
      xDays: (new Date(d.timestamp).getTime() - startTime) / (1000 * 60 * 60 * 24),
      y: d.value
    }));

    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;

    points.forEach(p => {
      sumX += p.xDays;
      sumY += p.y;
      sumXY += (p.xDays * p.y);
      sumXX += (p.xDays * p.xDays);
      sumYY += (p.y * p.y);
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 1);
    const intercept = (sumY - slope * sumX) / n;

    // R-squared
    const yMean = sumY / n;
    const ssTot = points.reduce((acc, p) => acc + Math.pow(p.y - yMean, 2), 0);
    const ssRes = points.reduce((acc, p) => acc + Math.pow(p.y - (slope * p.xDays + intercept), 2), 0);
    const rSquared = ssTot > 0 ? Math.max(0, 1 - (ssRes / ssTot)) : 0;

    let direction = 'STABLE';
    if (Math.abs(slope) > 0.05) {
      direction = slope > 0 ? 'INCREASING' : 'DECREASING';
    }

    return {
      slope: Number(slope.toFixed(3)), // unit change per day
      intercept: Number(intercept.toFixed(2)),
      rSquared: Number(rSquared.toFixed(2)),
      direction,
      totalDays: Number(points[points.length - 1].xDays.toFixed(1)),
      changePerDay: Number(slope.toFixed(2))
    };
  }

  /**
   * Detects multi-day sustained baseline shifts or steady drift.
   * @param {Array<{timestamp: string|Date, value: number}>} recentReadings - Last N days (e.g. 7 days)
   * @param {Object} baselineProfile - Historic baseline
   * @returns {Object} Sustained shift details
   */
  detectSustainedShift(recentReadings, baselineProfile) {
    if (!recentReadings || recentReadings.length < this.minSustainedDays) {
      return { hasSustainedShift: false, shiftType: 'INSUFFICIENT_DATA' };
    }

    const trend = this.calculateTrendSlope(recentReadings);
    
    // Calculate how many recent readings consecutive out of bounds
    const median = baselineProfile.stats.median;
    const mad = baselineProfile.stats.mad;
    const lower = baselineProfile.normalRange.lowerBound;
    const upper = baselineProfile.normalRange.upperBound;

    let consecutiveHigh = 0;
    let consecutiveLow = 0;

    recentReadings.forEach(r => {
      if (r.value > upper) {
        consecutiveHigh++;
        consecutiveLow = 0;
      } else if (r.value < lower) {
        consecutiveLow++;
        consecutiveHigh = 0;
      } else {
        consecutiveHigh = 0;
        consecutiveLow = 0;
      }
    });

    const isSustainedHigh = consecutiveHigh >= this.minSustainedDays;
    const isSustainedLow = consecutiveLow >= this.minSustainedDays;
    const hasSustainedShift = isSustainedHigh || isSustainedLow || (trend.rSquared > 0.65 && Math.abs(trend.slope) > 0.1);

    const shiftType = isSustainedHigh ? 'SUSTAINED_HIGH_DRIFT' 
      : isSustainedLow ? 'SUSTAINED_LOW_DRIFT'
      : (trend.direction !== 'STABLE' && trend.rSquared > 0.65) ? `STEADY_${trend.direction}_TREND`
      : 'STABLE_VARIATION';

    return {
      hasSustainedShift,
      shiftType,
      trend,
      consecutiveOutOfBoundDays: Math.max(consecutiveHigh, consecutiveLow),
      baselineMedian: median,
      recentMedian: Number((recentReadings.reduce((a, b) => a + b.value, 0) / recentReadings.length).toFixed(2))
    };
  }

  /**
   * Detects trajectory lag/stall compared to post-op / rehabilitation recovery targets.
   * @param {number} observedValue 
   * @param {number} postOpDay 
   * @param {string} metricType 
   * @param {Object} baselineEngine 
   * @returns {Object} Trajectory analysis
   */
  evaluateTrajectoryLag(observedValue, postOpDay, metricType, baselineEngine) {
    const expected = baselineEngine.getExpectedTrajectoryBaseline(postOpDay, metricType);
    const delta = observedValue - expected.expected;
    const isBelowLower = observedValue < expected.lowerBound;
    const isAboveUpper = observedValue > expected.upperBound;

    let status = 'ON_TRACK';
    // For ROM / Steps / Velocity: below expected is negative lag
    // For Pain: above expected is negative lag
    if (metricType === 'PAIN_SCORE') {
      if (isAboveUpper) status = 'EXCESSIVE_PAIN_STALL';
      else if (observedValue <= expected.expected) status = 'OPTIMAL_PAIN_REDUCTION';
    } else {
      if (isBelowLower) status = 'RECOVERY_LAG_STALLED';
      else if (observedValue >= expected.upperBound) status = 'ACCELERATED_RECOVERY';
    }

    return {
      status,
      postOpDay,
      observedValue,
      expectedTarget: expected.expected,
      expectedBounds: [expected.lowerBound, expected.upperBound],
      deltaFromExpected: Number(delta.toFixed(2)),
      unit: expected.unit
    };
  }
}
