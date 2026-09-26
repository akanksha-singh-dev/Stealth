/**
 * @file patient-scenarios.js
 * @description Mock clinical dataset generator for 4 longitudinal scenarios.
 */

export function getPatientScenarios() {
  const dates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(2026, 8, 1 + i, 9, 0, 0);
    return d.toISOString();
  });

  return [
    {
      id: 'PAT-TKA-101',
      name: 'Sarah Jenkins',
      age: 62,
      gender: 'Female',
      condition: 'Post-Op Right Total Knee Arthroplasty (TKA)',
      postOpDay: 10,
      medications: ['Acetaminophen 1000mg', 'Rivaroxaban 10mg'],
      comorbidities: ['Osteoarthritis'],
      inActiveExercise: false,
      scenarioDescription: 'Early Surgical Site Infection Flare (POD 7..10 Tachycardia + Fever + ROM Drop)',
      telemetry: {
        'RESTING_HR': dates.map((t, i) => ({
          timestamp: t,
          value: i < 6 ? 64 + (i % 3) : 66 + Math.round((i - 5) * 7.5) // 64 -> 96 bpm
        })),
        'TEMPERATURE': dates.map((t, i) => ({
          timestamp: t,
          value: Number((i < 6 ? 36.5 + (i % 2) * 0.2 : 36.6 + (i - 5) * 0.45).toFixed(1)) // 36.5 -> 38.4°C
        })),
        'HRV': dates.map((t, i) => ({
          timestamp: t,
          value: i < 6 ? 48 - (i % 2) * 2 : Math.max(14, 46 - (i - 5) * 7) // 48 -> 18 ms
        })),
        'KNEE_FLEXION_ROM': dates.map((t, i) => ({
          timestamp: t,
          value: i < 6 ? 65 + i * 4 : 85 - (i - 5) * 3 // Progressed to 85°, then dropped to 68° due to swelling
        })),
        'PAIN_SCORE': dates.map((t, i) => ({
          timestamp: t,
          value: i < 6 ? Math.max(2, 6 - i * 0.7) : 3 + (i - 5) * 1.2 // Pain flared up to 8/10
        })),
        'DAILY_STEPS': dates.map((t, i) => ({
          timestamp: t,
          value: i < 6 ? 1200 + i * 350 : Math.max(400, 3100 - (i - 5) * 600) // Steps dropped
        }))
      }
    },
    {
      id: 'PAT-STROKE-202',
      name: 'Robert Vance',
      age: 71,
      gender: 'Male',
      condition: 'Post-Stroke Left Hemiparesis (Gait & Upper Limb Rehab)',
      postOpDay: 21,
      medications: ['Aspirin 81mg', 'Atorvastatin 40mg', 'Lisinopril 10mg'],
      comorbidities: ['Hypertension', 'Type 2 Diabetes'],
      inActiveExercise: false,
      scenarioDescription: 'Rehabilitation Trajectory Stall / Severe Flexion Stiffness',
      telemetry: {
        'RESTING_HR': dates.map((t, i) => ({
          timestamp: t,
          value: 68 + (i % 4)
        })),
        'GAIT_VELOCITY': dates.map((t, i) => ({
          timestamp: t,
          value: Number((0.45 + (i < 5 ? i * 0.02 : 0.08)).toFixed(2)) // Stalled at 0.53 m/s (expected 0.85+)
        })),
        'KNEE_FLEXION_ROM': dates.map((t, i) => ({
          timestamp: t,
          value: i < 4 ? 70 + i * 2 : 78 // Plateaued at 78°
        })),
        'PAIN_SCORE': dates.map((t, i) => ({
          timestamp: t,
          value: 5 + (i % 2)
        })),
        'DAILY_STEPS': dates.map((t, i) => ({
          timestamp: t,
          value: 1500 + (i % 3) * 100
        }))
      }
    },
    {
      id: 'PAT-HF-303',
      name: 'Elena Rostova',
      age: 68,
      gender: 'Female',
      condition: 'Heart Failure Post-Discharge Tele-Rehab',
      postOpDay: 14,
      medications: ['Metoprolol Succinate 50mg', 'Furosemide 20mg', 'Sacubitril/Valsartan'],
      comorbidities: ['Heart Failure with Reduced EF (HFrEF)'],
      inActiveExercise: false,
      scenarioDescription: 'Beta-Blocker Medicated Tachycardia Masking with Fluid Overload (Weight + SpO2 drop)',
      telemetry: {
        'RESTING_HR': dates.map((t, i) => ({
          timestamp: t,
          value: 62 + (i % 3) // Normal HR because Metoprolol blunts tachycardia!
        })),
        'BODY_WEIGHT': dates.map((t, i) => ({
          timestamp: t,
          value: Number((72.0 + (i < 7 ? 0 : (i - 6) * 0.6)).toFixed(1)) // 72kg -> 76.2kg sudden weight gain
        })),
        'SPO2': dates.map((t, i) => ({
          timestamp: t,
          value: i < 7 ? 97 : Math.max(90, 97 - (i - 6) * 1.2) // Desaturation down to 90%
        })),
        'HRV': dates.map((t, i) => ({
          timestamp: t,
          value: i < 7 ? 42 : Math.max(18, 42 - (i - 6) * 4)
        })),
        'DAILY_STEPS': dates.map((t, i) => ({
          timestamp: t,
          value: i < 7 ? 2400 : Math.max(600, 2400 - (i - 6) * 300)
        }))
      }
    },
    {
      id: 'PAT-EX-404',
      name: 'Marcus Chen',
      age: 48,
      gender: 'Male',
      condition: 'Post-ACL Reconstruction Rehab',
      postOpDay: 14,
      medications: ['Ibuprofen 400mg PRN'],
      comorbidities: [],
      inActiveExercise: true,
      scenarioDescription: 'Active PT Session Context (HR = 125 bpm Reclassified as Normal Exercise Response)',
      telemetry: {
        'RESTING_HR': dates.map((t, i) => ({
          timestamp: t,
          value: i === 13 ? 125 : 65 + (i % 3) // HR spike to 125 bpm on Day 14 during active exercise session
        })),
        'KNEE_FLEXION_ROM': dates.map((t, i) => ({
          timestamp: t,
          value: 90 + i * 2.5 // Excellent ROM progression to 122°
        })),
        'PAIN_SCORE': dates.map((t, i) => ({
          timestamp: t,
          value: Math.max(1, 4 - i * 0.25)
        })),
        'DAILY_STEPS': dates.map((t, i) => ({
          timestamp: t,
          value: 3000 + i * 400
        }))
      }
    }
  ];
}
