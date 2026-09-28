/**
 * Microphone level meter, independent of transcription. It taps a stream someone
 * else owns and never stops its tracks, and never connects to `ctx.destination`
 * (that would feed the mic back through the speakers).
 */

/** RMS, not peak: a peak meter reads full scale on an inaudible click. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/** dBFS floor: speech sits near −30, room noise near −55. */
export const METER_FLOOR_DB = -60;

/** RMS to 0..1 on a dB scale; linear would keep normal speech in the bar's first eighth. */
export function meterLevel(level: number): number {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** Quantised so a 60 Hz frame loop only re-renders when the bar visibly moves. */
export const METER_STEPS = 24;

export function quantise(level: number, steps: number = METER_STEPS): number {
  return Math.round(Math.min(1, Math.max(0, level)) * steps) / steps;
}

/** Above a quiet room's noise floor, below usable speech. */
export const HEARING_DB = -40;

export function hearing(level: number): boolean {
  return level >= meterLevel(10 ** (HEARING_DB / 20));
}

export type LevelMeter = {
  /** Does not stop the stream. Safe to call twice. */
  stop: () => void;
};

/** `onLevel` fires only when the quantised value moves, and once with 0 at the start. */
export function createLevelMeter(stream: MediaStream, onLevel: (level: number) => void): LevelMeter {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  // ~21 ms at 48 kHz: tracks syllables while still averaging.
  analyser.fftSize = 1024;
  // Smoothing applies to frequency data only, not the time-domain window read here.
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  // Safari hands back a suspended context outside a gesture.
  void context.resume().catch(() => undefined);

  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  let last = -1;
  let stopped = false;

  const read = (): void => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    const level = quantise(meterLevel(rms(samples)));
    if (level !== last) {
      last = level;
      onLevel(level);
    }
    frame = requestAnimationFrame(read);
  };
  onLevel(0);
  frame = requestAnimationFrame(read);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // A context that closed under us.
      }
      // The stream belongs to the caller.
      void context.close().catch(() => undefined);
    },
  };
}
