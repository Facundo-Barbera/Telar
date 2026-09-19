/**
 * IS THIS MICROPHONE HEARING ME — ANSWERED WITHOUT TRANSCRIBING ANYTHING (#643).
 *
 * ── WHY THE METER IS NOT PART OF THE DICTATION ──────────────────────────────
 * "Dictation does not work" is two questions wearing one coat: the microphone is
 * dead, or the transcription is. A single indicator cannot tell a person which
 * half is broken, and which half is broken is the entire reason they opened the
 * pane. So this taps the audio and nothing else — no token, no socket, no
 * provider, no spend. A muted input is visibly dead on a Mac with no key pasted
 * and no network, which is exactly the case a combined indicator is useless for.
 *
 * ── ONE STREAM, TAPPED — NEVER A SECOND PIPELINE ────────────────────────────
 * This does not open a microphone and must not: it is handed a `MediaStream`
 * somebody else owns and it never stops its tracks. While the live demo is
 * running, the stream it is tapping is the SAME one going up to the provider, so
 * the bar and the words are two readings of one microphone rather than two
 * microphones that could disagree.
 *
 * ── AND IT IS NEVER CONNECTED TO THE SPEAKERS ───────────────────────────────
 * `source.connect(analyser)` and there it ends. An `AnalyserNode` pulls audio
 * without being routed to a destination; connecting the chain to `ctx.destination`
 * would play the microphone back through the speakers into the microphone, which
 * is feedback and is how a settings pane starts screaming.
 *
 * ── THE MATHS IS PURE AND THE PLUMBING IS THIN ──────────────────────────────
 * `rms` and `meterLevel` are ordinary functions over numbers, so the scale a
 * person reads is checked without WebAudio, a microphone or a DOM.
 * `createLevelMeter` is the ten lines that cannot be: a real `AudioContext`, a
 * real stream and a frame loop.
 */

/**
 * Root mean square of one window of samples — the loudness of that slice.
 *
 * NOT PEAK. A peak meter is dominated by single-sample clicks and reads full
 * scale on a pop that nobody heard; RMS is what a level meter shows and what
 * tracks the sensation of "it is picking me up".
 *
 * `getFloatTimeDomainData` hands over −1..1, so digital silence is exactly zero
 * and answers zero here.
 */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * The floor of the scale, in dBFS. Speech at a normal distance from a laptop mic
 * sits around −30, and room noise around −55, so a bar that started at −60 shows
 * both the difference between speaking and not and enough headroom above to see
 * "too loud".
 */
export const METER_FLOOR_DB = -60;

/**
 * An RMS turned into the 0..1 a bar is drawn from, on a dB scale.
 *
 * LINEAR WOULD LOOK BROKEN, which is the whole reason this function exists.
 * Ordinary speech is an RMS of roughly 0.02–0.15 — drawn linearly that is a bar
 * that never leaves the first eighth, and a person would read a working
 * microphone as a dead one and go looking for a bug. dB is the scale ears use
 * and the scale every meter is drawn on.
 */
export function meterLevel(level: number): number {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/**
 * HOW MANY STEPS THE BAR HAS, and why it has steps at all.
 *
 * The loop below runs on every animation frame — about 60 a second — and each
 * report is a React state change and a re-render of the pane. A meter does not
 * need 60 distinct widths; it needs to look alive. Quantising to 24 steps means
 * a state change only when the bar would actually move by a visible amount,
 * which turns a 60 Hz re-render into a handful.
 */
export const METER_STEPS = 24;

export function quantise(level: number, steps: number = METER_STEPS): number {
  return Math.round(Math.min(1, Math.max(0, level)) * steps) / steps;
}

/**
 * WHERE "A ROOM" BECOMES "SOMEBODY TALKING", in dBFS.
 *
 * −40 is above a quiet room's noise floor and below any speech a recogniser
 * could use, so it separates the two cases the pane has to distinguish without
 * calling a fan or a fridge a voice.
 */
export const HEARING_DB = -40;

/** Whether the bar's current level is somebody talking rather than a room. The
 *  pane says this in words beside the bar, so "it is hearing you" is stated
 *  rather than left to be inferred from a width. */
export function hearing(level: number): boolean {
  return level >= meterLevel(10 ** (HEARING_DB / 20));
}

export type LevelMeter = {
  /** Release the analyser and the audio context. Does NOT stop the stream —
   *  see the header. Safe to call twice. */
  stop: () => void;
};

/**
 * Tap a stream and report its level until `stop`.
 *
 * `onLevel` IS CALLED ONLY WHEN THE QUANTISED VALUE MOVES, so a silent room is
 * one call and not sixty a second. It is called once with 0 at the start, which
 * is what draws an empty bar the moment the meter is armed rather than leaving
 * the last dictation's width on screen.
 */
export function createLevelMeter(stream: MediaStream, onLevel: (level: number) => void): LevelMeter {
  // `webkitAudioContext` IS NOT REACHED FOR. Every browser that has
  // `MediaRecorder` and `getUserMedia` — the two facts dictation already
  // requires — has the unprefixed constructor.
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  // 1024 samples is ~21 ms at 48 kHz: short enough that the bar tracks syllables,
  // long enough that one is a meaningful average rather than a single cycle.
  analyser.fftSize = 1024;
  // THE ANALYSER'S OWN SMOOTHING IS OFF. It applies to the frequency data, not
  // the time-domain window this reads, so leaving it at the default would be a
  // setting with no effect — the bar's smoothing is the quantisation above.
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  // AND NOTHING CONNECTS TO `context.destination` — see the header.

  // Safari hands back a suspended context when it was not created inside a
  // gesture. Both surfaces that build one of these do it from a press, so this
  // is belt and braces rather than the load-bearing path.
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
        // Already disconnected — a context that closed under us.
      }
      // THE STREAM IS NOT TOUCHED. It belongs to the caller, and during the live
      // demo it is the one going up to the provider.
      void context.close().catch(() => undefined);
    },
  };
}
