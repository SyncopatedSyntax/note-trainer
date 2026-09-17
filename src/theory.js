// ── Fretboard note maths ─────────────────────────────────────────────────
// Pure: no React, no DOM, no storage. Everything the drills ask and everything
// the microphone is judged against resolves through this file, so that
// scripts/verify.mjs can re-derive the whole lot from first principles and
// check it. Nothing here may import from the app.
//
// OPEN_MIDI and DC come from @fretworks/design. Every other trainer redeclares
// them locally even though the package asks them not to; this one doesn't.

import { OPEN_MIDI } from '@fretworks/design';

export { OPEN_MIDI };

// 15 rather than 12. The 12th-fret repeat is a thing to *learn*, so the drill
// has to be able to ask above it; 15 reaches the upper inlays without pretending
// a 24-fret neck the player may not have.
export const MAX_FRET = 15;

// Index 0 = low E (thickest), 5 = high e. Matches OPEN_MIDI and the sideways
// diagram convention: string 0 is drawn at the BOTTOM.
export const STRINGS = ['E', 'A', 'D', 'G', 'B', 'e'];

// Two full spellings, deliberately, rather than the package's single mixed
// NOTE_NAMES (C, C#, D, Eb, …). Enharmonics are a feature here: a context-free
// question has no key and therefore no correct spelling, so both names must be
// accepted — and that is impossible with one name per pitch class.
export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export const NATURAL_PCS = [0, 2, 4, 5, 7, 9, 11];          // C D E F G A B
export const isNatural = pc => NATURAL_PCS.includes(pc);

export const pcOf = m => ((m % 12) + 12) % 12;
export const midiAt = (s, f) => OPEN_MIDI[s] + f;
export const pcAt = (s, f) => pcOf(midiAt(s, f));
export const octaveOf = m => Math.floor(m / 12) - 1;         // MIDI 60 -> 4

// Display name. `spelling` is 'sharp' | 'flat'; both are correct in the absence
// of a key, so this is a display choice and never a grading one.
export const nameOf = (pc, spelling = 'sharp') =>
  (spelling === 'flat' ? FLAT_NAMES : SHARP_NAMES)[pcOf(pc)];

// Accepts either spelling, case-insensitively, plus unicode ♯/♭. Returns a
// pitch class or null. Used by the say-it-aloud and fallback paths.
export function parseNote(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = /^([A-Ga-g])([#b]?)$/.exec(t);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  return pcOf(base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0));
}

// ── Cards ────────────────────────────────────────────────────────────────
// The unit of mastery is (string, note) — the thing you either know or don't.
// The FRET is not part of the card: it is the answer. Register and fret window
// are per-rep variables, exactly as key is in the sibling trainers.
export const cardId = (s, pc) => `${s}|${pc}`;
export const parseCardId = id => {
  const [s, pc] = id.split('|').map(Number);
  return { s, pc };
};
export function allCards() {
  const out = [];
  for (let s = 0; s < 6; s++) for (let pc = 0; pc < 12; pc++) out.push({ id: cardId(s, pc), s, pc });
  return out;                                      // 72
}

// ── Windows ──────────────────────────────────────────────────────────────
export const WINDOWS = {
  open:  { lo: 0,  hi: 4,  label: 'frets 0–4' },
  low:   { lo: 0,  hi: 5,  label: 'frets 0–5' },
  mid:   { lo: 5,  hi: 9,  label: 'frets 5–9' },
  upper: { lo: 9,  hi: 12, label: 'frets 9–12' },
  neck:  { lo: 0,  hi: 12, label: 'frets 0–12' },
  full:  { lo: 0,  hi: MAX_FRET, label: `frets 0–${MAX_FRET}` },
};

// ── Windows that actually contain the answer ─────────────────────────────
// A fixed narrow window cannot ask about every note. In frets 0-5 the low E
// string only sounds E F F# G G# A — so "play C on the low E string, frets 0-5"
// has no answer at all. Three of the seven naturals were unanswerable on each of
// the first two stages before this existed.
//
// The fix is to keep the window narrow but SLIDE it to wherever the note is,
// which is also better pedagogy: a fret window is really a hand position, and
// positions I, V, VII and XII are how the classical and Berklee curricula teach
// reading. So the constraint becomes "this note, in this six-fret position"
// rather than "this note, if it happens to be near the nut".

// The lowest fret on this string that sounds `pc`. Always 0-11, always exists.
export const firstFretOf = (s, pc) => {
  for (let f = 0; f < 12; f++) if (pcAt(s, f) === pcOf(pc)) return f;
  return 0;                                        // unreachable in 12-TET
};

export const mkWindow = (lo, hi) => ({ lo, hi, label: `frets ${lo}\u2013${hi}` });

// A window of `span` frets guaranteed to contain `pc` on string `s`. Prefers the
// open position when the note lives there, since that is where a beginner looks
// first; otherwise centres the window on the note and clamps to the neck.
export function windowAround(s, pc, span = 6, maxFret = MAX_FRET) {
  const f = firstFretOf(s, pc);
  if (f <= span - 1) return mkWindow(0, Math.min(span - 1, maxFret));
  const lo = Math.min(Math.max(0, f - Math.floor((span - 1) / 2)), Math.max(0, maxFret - span + 1));
  return mkWindow(lo, Math.min(lo + span - 1, maxFret));
}

// ── Where a note lives ───────────────────────────────────────────────────
// Every (s,f) in the window that sounds pitch class `pc`.
export function positionsOf(pc, { strings = [0, 1, 2, 3, 4, 5], lo = 0, hi = MAX_FRET } = {}) {
  const out = [];
  for (const s of strings) for (let f = lo; f <= hi; f++) if (pcAt(s, f) === pcOf(pc)) out.push({ s, f });
  return out;
}

// Every (s,f) in the window sounding an EXACT pitch. This is the set the
// microphone cannot tell apart, so it is also the set that must all be accepted.
export function positionsOfPitch(midi, { strings = [0, 1, 2, 3, 4, 5], lo = 0, hi = MAX_FRET } = {}) {
  const out = [];
  for (const s of strings) {
    const f = midi - OPEN_MIDI[s];
    if (f >= lo && f <= hi && Number.isInteger(f)) out.push({ s, f });
  }
  return out;
}

// The lowest / highest sounding instance of a pitch class in a window.
// Returns the PITCH plus every position that sounds it — which may be more than
// one, and all of them are correct (the lowest C is C3, at both E-8 and A-3).
export function extremal(pc, dir = 'lowest', opts = {}) {
  const pos = positionsOf(pc, opts);
  if (!pos.length) return null;
  const midis = pos.map(p => midiAt(p.s, p.f));
  const midi = dir === 'highest' ? Math.max(...midis) : Math.min(...midis);
  return { midi, positions: pos.filter(p => midiAt(p.s, p.f) === midi) };
}

// From an anchor position, the nearest instance of `pc`.
//   sameString: search only the anchor's string (the unambiguous teaching form)
//   dir: 'up' | 'down' | 'either'
export function nearestFrom(pc, anchor, { sameString = true, dir = 'either', lo = 0, hi = MAX_FRET } = {}) {
  const from = midiAt(anchor.s, anchor.f);
  const pool = positionsOf(pc, { strings: sameString ? [anchor.s] : [0, 1, 2, 3, 4, 5], lo, hi })
    .filter(p => {
      const m = midiAt(p.s, p.f);
      if (m === from) return false;
      if (dir === 'up') return m > from;
      if (dir === 'down') return m < from;
      return true;
    });
  if (!pool.length) return null;
  let best = null, bestD = Infinity;
  for (const p of pool) {
    const d = Math.abs(midiAt(p.s, p.f) - from);
    if (d < bestD) { bestD = d; best = p; }
  }
  const midi = midiAt(best.s, best.f);
  return { midi, positions: pool.filter(p => midiAt(p.s, p.f) === midi) };
}
