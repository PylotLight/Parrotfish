// Phonon speed: how a rate is split between Phonon's own duration_delta conditioner and a WSOLA
// time stretch. Ported from Surffish Read Aloud (src/shared/read-aloud-speed.ts), where it was
// measured with phonon-tts 0.4.0, q8, default voice:
//   delta  +0.3  +0.2   0   -0.2  -0.4   (beyond -1 it falls apart)
//   rate   0.87  0.90  1.00  1.15  1.25
// so Phonon is asked for at most 1.25x (delta -0.4) and the rest is a pitch-keeping stretch.

export const MIN_SPEED = 0.75;
export const MAX_SPEED = 3;
export const MODEL_MAX_RATE = 1.25;
export const MODEL_MIN_RATE = 0.87;

const CALIBRATION: ReadonlyArray<readonly [rate: number, delta: number]> = [
  [0.87, 0.3],
  [0.9, 0.2],
  [1, 0],
  [1.15, -0.2],
  [1.25, -0.4],
];

export function normalizeSpeed(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return fallback;
  return Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, value)) * 20) / 20;
}

/** Phonon's `duration_delta` for a model-native rate (clamped to what the model follows). */
export function rateToDurationDelta(rate: number): number {
  const target = Math.min(MODEL_MAX_RATE, Math.max(MODEL_MIN_RATE, rate));
  for (let index = 1; index < CALIBRATION.length; index += 1) {
    const [rateHigh, deltaHigh] = CALIBRATION[index]!;
    const [rateLow, deltaLow] = CALIBRATION[index - 1]!;
    if (target <= rateHigh) {
      const t = (target - rateLow) / (rateHigh - rateLow);
      return Math.round((deltaLow + t * (deltaHigh - deltaLow)) * 1000) / 1000;
    }
  }
  return CALIBRATION[CALIBRATION.length - 1]![1];
}

export interface SpeedSplit {
  speed: number;
  modelRate: number;
  durationDelta: number;
  /** Time-stretch factor applied to Phonon's audio (1 = none). */
  stretch: number;
}

/** `modelRate x stretch = speed`. 1x is untouched (delta 0, no stretch). */
export function splitSpeed(value: number): SpeedSplit {
  const speed = normalizeSpeed(value);
  const modelRate = Math.min(MODEL_MAX_RATE, Math.max(MODEL_MIN_RATE, speed));
  const stretch = Math.round((speed / modelRate) * 10_000) / 10_000;
  return {
    speed,
    modelRate,
    durationDelta: rateToDurationDelta(modelRate),
    stretch: Math.abs(stretch - 1) < 0.001 ? 1 : stretch,
  };
}
