// ── Drills: what gets asked, and what counts as right ────────────────────
// Every prompt resolves to a SET OF ACCEPTABLE MIDI PITCHES, because that is
// the only thing a microphone can actually report. Two consequences run through
// this whole file:
//
//   1. A pitch cannot identify a string. In frets 0–12, 87% of positions sound a
//      pitch that another string can also produce. So a string constraint is an
//      instruction the player honours, never something the app verifies. What
//      the app DOES verify is note and register, and a wrong register is the
//      same thing as the wrong part of the neck — which is the common real error.
//
//   2. Where several positions sound the same accepted pitch, ALL of them are
//      correct. The lowest C is C3 at both E-8 and A-3. Marking one wrong would
//      be marking a right answer wrong.
//
// The one thing to never do is put two same-pitch targets in a single question:
// the player sounds one and both clear. That is a shipped bug in a competing app
// and verify.mjs asserts we cannot reproduce it.

import {
  MAX_FRET, STRINGS, WINDOWS, NATURAL_PCS, isNatural,
  pcOf, midiAt, pcAt, nameOf, octaveOf,
  positionsOf, positionsOfPitch, extremal, nearestFrom, cardId,
} from './theory.js';

export const DRILLS = ['find', 'name', 'findAll', 'fretSlice', 'extremal', 'nearest', 'barreRoot', 'keyDegree'];

export const DRILL_META = {
  find:      { label: 'Find it',      short: 'Find',    blurb: 'A note and a string. Play it.' },
  name:      { label: 'Name it',      short: 'Name',    blurb: 'A dot on the neck. Play it and say the name.' },
  findAll:   { label: 'Find them all',short: 'All',     blurb: 'Every one of that note, low to high.' },
  fretSlice: { label: 'Across a fret',short: 'Slice',   blurb: 'All six notes at one fret, low to high.' },
  extremal:  { label: 'Lowest/highest',short: 'Extreme',blurb: 'The lowest or highest one on the neck.' },
  nearest:   { label: 'Nearest',      short: 'Nearest', blurb: 'From where you are, the closest one.' },
  barreRoot: { label: 'Barre root',   short: 'Root',    blurb: 'The root of a barre chord shape.' },
  keyDegree: { label: 'In a key',     short: 'Key',     blurb: 'A scale degree of a given key.' },
};

// Blank-neck by nature: the board shows nothing that could leak the answer.
// (A reviewer of a competing app caught themselves "using the pattern now
// instead of learning the notes" — anything drawn during a question invites it.)
export const SHOWS_TARGET = new Set(['name']);

// Which drills pin an exact pitch, so the mic grades them outright rather than
// accepting a whole register-class. These are the "checked" drills.
export const PITCH_UNIQUE = new Set(['extremal', 'nearest', 'name']);

const uniq = xs => [...new Set(xs)];

// ── Building a prompt ────────────────────────────────────────────────────
// Returns { kind, text, accept:Set<midi>, positions:[{s,f}], seq?:[midi] }
// `accept` is what the microphone is judged against. `positions` is only for
// the reveal after an answer.

export function buildPrompt(spec) {
  const { kind } = spec;
  const win = spec.window || WINDOWS.neck;
  const sp = spec.spelling || 'sharp';
  const B = (text, positions, extra = {}) => {
    const accept = new Set(positions.map(p => midiAt(p.s, p.f)));
    return { ...spec, kind, text, positions, accept, ...extra };
  };

  if (kind === 'find') {
    const pos = positionsOf(spec.pc, { strings: [spec.s], lo: win.lo, hi: win.hi });
    return B(`Play ${nameOf(spec.pc, sp)} on the ${STRINGS[spec.s]} string`, pos, { hint: win.label });
  }

  if (kind === 'name') {
    // The app names the position; the player sounds it and says the name.
    const pos = [{ s: spec.s, f: spec.f }];
    return B(`Play and name: ${STRINGS[spec.s]} string, fret ${spec.f}`, pos,
      { answerPc: pcAt(spec.s, spec.f) });
  }

  if (kind === 'extremal') {
    const strings = spec.s === undefined ? undefined : [spec.s];
    const e = extremal(spec.pc, spec.dir || 'lowest', { strings, lo: win.lo, hi: win.hi });
    if (!e) return null;
    const where = spec.s === undefined ? 'on the neck' : `on the ${STRINGS[spec.s]} string`;
    return B(`Play the ${spec.dir || 'lowest'} ${nameOf(spec.pc, sp)} ${where}`, e.positions);
  }

  if (kind === 'nearest') {
    const n = nearestFrom(spec.pc, spec.anchor, {
      sameString: spec.sameString !== false, dir: spec.dir || 'either', lo: win.lo, hi: win.hi,
    });
    if (!n) return null;
    const a = spec.anchor;
    const dirWord = spec.dir === 'up' ? ' above it' : spec.dir === 'down' ? ' below it' : '';
    return B(`You're on ${STRINGS[a.s]} string fret ${a.f} — play the nearest ${nameOf(spec.pc, sp)}${dirWord}`,
      n.positions, { anchor: a });
  }

  if (kind === 'barreRoot') {
    // E/G shapes root on the low E; A/C shapes on the A; D shape on the D.
    const s = { E: 0, G: 0, A: 1, C: 1, D: 2 }[spec.shape];
    const pos = positionsOf(spec.pc, { strings: [s], lo: win.lo, hi: win.hi });
    return B(`Play the root of ${nameOf(spec.pc, sp)} with an ${spec.shape}-shape barre`, pos,
      { s, hint: `${spec.shape} shape roots on the ${STRINGS[s]} string` });
  }

  if (kind === 'keyDegree') {
    const MAJ = [0, 2, 4, 5, 7, 9, 11];
    const pc = pcOf(spec.keyPc + MAJ[spec.degree - 1]);
    const strings = spec.s === undefined ? undefined : [spec.s];
    const pos = positionsOf(pc, { strings, lo: win.lo, hi: win.hi });
    const ORD = ['', 'root', '2nd', '3rd', '4th', '5th', '6th', '7th'];
    const where = spec.s === undefined ? '' : ` on the ${STRINGS[spec.s]} string`;
    return B(`In ${nameOf(spec.keyPc, sp)}: play the ${ORD[spec.degree]}${where}`, pos, { pc });
  }

  // ── Sequence drills ────────────────────────────────────────────────────
  // Graded as an ordered run of pitches rather than a single one.
  if (kind === 'findAll') {
    const pos = positionsOf(spec.pc, { lo: win.lo, hi: win.hi })
      .sort((a, b) => midiAt(a.s, a.f) - midiAt(b.s, b.f));
    const seq = uniq(pos.map(p => midiAt(p.s, p.f)));
    return { ...spec, kind, text: `Play every ${nameOf(spec.pc, sp)}, low to high`,
      positions: pos, seq, accept: new Set(seq), hint: win.label };
  }

  if (kind === 'fretSlice') {
    const pos = [0, 1, 2, 3, 4, 5].map(s => ({ s, f: spec.f }));
    const seq = pos.map(p => midiAt(p.s, p.f));
    return { ...spec, kind, text: `Fret ${spec.f} — play and name all six, low to high`,
      positions: pos, seq, accept: new Set(seq),
      answerPcs: pos.map(p => pcAt(p.s, p.f)) };
  }

  return null;
}

// ── Grading a heard pitch ────────────────────────────────────────────────
// Three-way, deliberately. "Right note, wrong octave" is its own verdict because
// it is the single most informative near-miss: the player knows the note and
// not where it lives. Treating it as a flat miss throws that away.
export const VERDICT = { OK: 'ok', OCTAVE: 'octave', WRONG: 'wrong' };

export function judge(prompt, heardMidi) {
  if (prompt.accept.has(heardMidi)) return VERDICT.OK;
  const wantPcs = new Set([...prompt.accept].map(pcOf));
  if (wantPcs.has(pcOf(heardMidi))) return VERDICT.OCTAVE;
  return VERDICT.WRONG;
}

// Every position that sounds an accepted pitch — all correct, all revealed.
export function acceptedPositions(prompt, lo = 0, hi = MAX_FRET) {
  return [...prompt.accept].flatMap(m => positionsOfPitch(m, { lo, hi }));
}

// The invariant that keeps us out of the Guitar Blast bug: a sequence drill must
// never ask for the same pitch twice, or sounding it once clears both.
export function sequenceIsUnambiguous(prompt) {
  if (!prompt?.seq) return true;
  return new Set(prompt.seq).size === prompt.seq.length;
}
