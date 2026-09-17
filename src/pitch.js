// ── Pitch detection ──────────────────────────────────────────────────────
// The microphone is the grader, so this file decides whether the app works.
// Every choice here is a documented failure mode of something else:
//
//   * NOT FFT. At a standard fftSize the bin width is ~23 Hz, and low E is
//     82.41 Hz — the readout jumps between neighbouring notes because the
//     transform genuinely cannot separate them. Getting the resolution needs
//     fftSize 32768, which is ~0.68s of latency. So: time domain.
//   * MPM (McLeod) over a normalised square-difference function. Guitar signal
//     carries more energy in the 2nd and 3rd harmonics than in the fundamental,
//     especially through a pickup and an amp, which is exactly the case raw
//     autocorrelation gets wrong by reporting a harmonic.
//   * The search range is clamped to the instrument. Reported repeatedly as the
//     single change that removes most octave errors, because an out-of-band
//     harmonic can no longer win.
//   * echoCancellation / noiseSuppression / autoGainControl are turned OFF. They
//     default to true, they assume "human voice making words", and they actively
//     gate sustained tones. This is the highest-value line in the file.
//   * Onset gating and a silence gate between reps. Repeated identical notes are
//     a named detection failure in every competing app, because the previous
//     note's ring-out masks the next attack.

// Low E open (82.41 Hz) with headroom, up to the top of a 15-fret high e
// (G5, 784 Hz) with headroom for a bent or sharp note.
export const FMIN = 70;
export const FMAX = 1350;

export const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
export const centsOff = (hz, midi) => 1200 * Math.log2(hz / midiToHz(midi));

// ── MPM ──────────────────────────────────────────────────────────────────
// Returns { hz, clarity } or null. `clarity` is the NSDF peak height in 0..1 —
// a usable confidence measure, unlike a raw correlation score.
export function detectPitch(buf, sampleRate) {
  const n = buf.length;
  const tauMin = Math.max(2, Math.floor(sampleRate / FMAX));
  const tauMax = Math.min(n - 1, Math.ceil(sampleRate / FMIN));
  if (tauMax <= tauMin) return null;

  // Normalised square difference. r is the autocorrelation at lag tau; m is the
  // summed squared energy of the two overlapping halves. Dividing by m is what
  // keeps a decaying note from looking like a lower pitch.
  const nsdf = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let r = 0, m = 0;
    for (let i = 0; i + tau < n; i++) {
      const a = buf[i], b = buf[i + tau];
      r += a * b;
      m += a * a + b * b;
    }
    nsdf[tau] = m > 0 ? (2 * r) / m : 0;
  }

  // Key maxima: the peak of each positive run. Picking the global max would
  // choose tau≈0-ish lags and report a harmonic.
  const peaks = [];
  let tau = tauMin;
  while (tau < tauMax && nsdf[tau] > 0) tau++;      // skip the leading positive run
  while (tau < tauMax) {
    if (nsdf[tau] > 0 && nsdf[tau - 1] <= 0) {       // positive-going zero crossing
      let best = tau, t = tau;
      while (t < tauMax && nsdf[t] > 0) { if (nsdf[t] > nsdf[best]) best = t; t++; }
      peaks.push(best);
      tau = t;
    } else tau++;
  }
  if (!peaks.length) return null;

  // Take the FIRST peak within a fraction of the tallest, not the tallest
  // itself: the first qualifying peak is the fundamental, later ones are
  // sub-octaves. 0.9 is the usual MPM constant.
  const maxVal = Math.max(...peaks.map(p => nsdf[p]));
  if (maxVal < 0.5) return null;                     // nothing periodic enough
  const chosen = peaks.find(p => nsdf[p] >= 0.9 * maxVal);

  // Parabolic interpolation around the chosen lag for sub-sample precision —
  // without it, quantisation alone is worth tens of cents at guitar pitches.
  const y1 = nsdf[chosen - 1] ?? 0, y2 = nsdf[chosen], y3 = nsdf[chosen + 1] ?? 0;
  const denom = 2 * (2 * y2 - y1 - y3);
  const shift = denom !== 0 ? (y3 - y1) / denom : 0;
  const hz = sampleRate / (chosen + shift);
  if (!isFinite(hz) || hz < FMIN || hz > FMAX) return null;
  return { hz, clarity: y2 };
}

// ── The listener ─────────────────────────────────────────────────────────
// Wraps the stream, the analyser and the gating. Emits a MIDI note once, per
// attack, when it has been stable long enough to trust.

export const LISTEN_DEFAULTS = {
  clarityMin: 0.82,     // below this the frame is noise or a dying note
  stableFrames: 3,      // consecutive agreeing frames before a note is emitted
  centsTol: 55,         // how far from equal temperament still counts
  rearmRms: 0.012,      // level must fall below this before the next note counts
  bufSize: 4096,        // ~85ms at 48k — long enough for low E, short enough to feel live
};

export async function createListener(opts = {}) {
  const cfg = { ...LISTEN_DEFAULTS, ...opts };

  // The three constraints that matter. They default to true and would gate out
  // a sustained guitar note entirely.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // Never hardcode 44100 — iOS has historically pinned the context rate
  // regardless of the device, and a wrong rate is a transposed readout.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  if (ctx.state === 'suspended') await ctx.resume();

  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = cfg.bufSize * 2;               // only used for its time-domain buffer
  src.connect(analyser);

  const buf = new Float32Array(cfg.bufSize);
  let raf = 0, onNote = null, onLevel = null;
  let run = [], armed = true, lastEmitted = null;

  const rmsOf = b => { let s = 0; for (let i = 0; i < b.length; i++) s += b[i] * b[i]; return Math.sqrt(s / b.length); };

  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    const rms = rmsOf(buf);
    onLevel?.(rms);

    // Re-arm only once the previous note has actually decayed. Without this,
    // playing the same note twice reads as one long note — the failure every
    // competing app is reported to have.
    if (rms < cfg.rearmRms) { armed = true; run = []; lastEmitted = null; }

    const p = rms >= cfg.rearmRms ? detectPitch(buf, ctx.sampleRate) : null;
    if (p && p.clarity >= cfg.clarityMin) {
      const midi = Math.round(hzToMidi(p.hz));
      if (Math.abs(centsOff(p.hz, midi)) <= cfg.centsTol) {
        run = run.length && run[0] === midi ? [...run, midi] : [midi];
        if (armed && run.length >= cfg.stableFrames && midi !== lastEmitted) {
          armed = false; lastEmitted = midi;
          onNote?.({ midi, hz: p.hz, clarity: p.clarity, cents: centsOff(p.hz, midi) });
        }
      } else run = [];
    } else if (!p) run = [];

    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    sampleRate: ctx.sampleRate,
    onNote(fn) { onNote = fn; },
    onLevel(fn) { onLevel = fn; },
    // Force the next attack to count even if the string is still ringing —
    // used when advancing to the next question.
    rearm() { armed = true; run = []; lastEmitted = null; },
    async stop() {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach(t => t.stop());
      try { await ctx.close(); } catch { /* already closed */ }
    },
  };
}
