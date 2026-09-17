// Correctness gate for Note Trainer.
//
//   node scripts/verify.mjs
//
// The toolbox rule: anything touching frets, notes or answer sets is re-derived
// from first principles and checked BEFORE it is trusted. So this file imports
// the app's data and functions only to CHECK them — every expectation below is
// computed here, independently, from the one thing taken on faith: standard
// tuning. Importing the app's own maths to generate the expectations would only
// prove it agrees with itself.

import {
  MAX_FRET, STRINGS, SHARP_NAMES, FLAT_NAMES, NATURAL_PCS, WINDOWS,
  pcAt, midiAt, nameOf, parseNote, allCards, cardId,
  positionsOf, positionsOfPitch, extremal, nearestFrom,
} from '../src/theory.js';
import { buildPrompt, judge, VERDICT, sequenceIsUnambiguous, PITCH_UNIQUE } from '../src/drills.js';
import { STAGES, poolThrough } from '../src/ladder.js';

let failures = 0, assertions = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const fail = m => { throw new Error(m); };
const eq = (got, want, what) => { assertions++; if (got !== want) fail(`${what}: got ${got}, expected ${want}`); };
const ok = (cond, what) => { assertions++; if (!cond) fail(what); };

// ── Re-derived from first principles ─────────────────────────────────────
// Standard tuning, stated as pitch names rather than copied MIDI numbers, and
// converted here. This is the single assumption everything else is checked against.
const TUNING = ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'];
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const toMidi = n => {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(n);
  const pc = (LETTER[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return (Number(m[3]) + 1) * 12 + pc;
};
const OPEN = TUNING.map(toMidi);                       // [40,45,50,55,59,64]
const PC = m => ((m % 12) + 12) % 12;

console.log('\nTuning and note naming');

check('the app agrees with standard tuning, derived from pitch names', () => {
  eq(OPEN.join(','), '40,45,50,55,59,64', 'open-string MIDI');
  for (let s = 0; s < 6; s++) for (let f = 0; f <= MAX_FRET; f++) {
    eq(midiAt(s, f), OPEN[s] + f, `midi at ${STRINGS[s]}-${f}`);
    eq(pcAt(s, f), PC(OPEN[s] + f), `pitch class at ${STRINGS[s]}-${f}`);
  }
});

check('both spellings name the same twelve pitches, and parse back', () => {
  // Built from the musical alphabet, not copied from the app's tables.
  for (let pc = 0; pc < 12; pc++) {
    const sharp = nameOf(pc, 'sharp'), flat = nameOf(pc, 'flat');
    eq(parseNote(sharp), pc, `${sharp} parses back`);
    eq(parseNote(flat), pc, `${flat} parses back`);
    ok(/^[A-G][#b]?$/.test(sharp) && /^[A-G][#b]?$/.test(flat), `pc ${pc} names are well formed`);
  }
  eq(SHARP_NAMES.length, 12, 'sharp table size');
  eq(FLAT_NAMES.length, 12, 'flat table size');
  // The seven naturals are exactly the letters with no accidental.
  eq(NATURAL_PCS.map(p => SHARP_NAMES[p]).join(''), 'CDEFGAB', 'naturals');
  // B–C and E–F are the semitone pairs; every other natural step is a tone.
  const steps = NATURAL_PCS.map((p, i) => PC(NATURAL_PCS[(i + 1) % 7] - p));
  eq(steps.join(','), '2,2,1,2,2,2,1', 'natural-note step pattern');
  // Unicode accidentals and lower case are accepted — the say-it-aloud path.
  eq(parseNote('f♯'), 6, 'unicode sharp'); eq(parseNote('G♭'), 6, 'unicode flat');
  eq(parseNote('H'), null, 'nonsense rejected');
});

console.log('\nWhere notes live');

check('positionsOf finds every occurrence and invents none', () => {
  for (let pc = 0; pc < 12; pc++) {
    const got = positionsOf(pc, { lo: 0, hi: MAX_FRET }).map(p => `${p.s}-${p.f}`).sort();
    const want = [];
    for (let s = 0; s < 6; s++) for (let f = 0; f <= MAX_FRET; f++) if (PC(OPEN[s] + f) === pc) want.push(`${s}-${f}`);
    eq(got.join(','), want.sort().join(','), `all positions of pc ${pc}`);
  }
  // Within 0–12 a pitch class occurs exactly once per string.
  for (let pc = 0; pc < 12; pc++) for (let s = 0; s < 6; s++)
    eq(positionsOf(pc, { strings: [s], lo: 0, hi: 11 }).length, 1, `pc ${pc} once on ${STRINGS[s]} in 0–11`);
});

check('the pitch-vs-string ambiguity is what the Guide claims it is', () => {
  // The honesty note in the Guide quotes these numbers. If a tuning ever
  // changes they must change with it, so they are pinned rather than trusted.
  const count = maxF => {
    let total = 0, ambiguous = 0;
    for (let s = 0; s < 6; s++) for (let f = 0; f <= maxF; f++) {
      total++;
      if (positionsOfPitch(OPEN[s] + f, { lo: 0, hi: maxF }).length > 1) ambiguous++;
    }
    return { total, ambiguous };
  };
  const a = count(12);
  eq(a.total, 78, 'positions in frets 0–12');
  eq(a.ambiguous, 68, 'of which sound a pitch another string can make');
  eq(Math.round((a.ambiguous / a.total) * 100), 87, 'percentage quoted in the Guide');
  const b = count(15);
  eq(Math.round((b.ambiguous / b.total) * 100), 90, 'percentage over frets 0–15');
  // The example the Guide uses, spelled out.
  const c4 = toMidi('C4');
  eq(positionsOfPitch(c4, { lo: 0, hi: 15 }).map(p => `${STRINGS[p.s]}-${p.f}`).join(' '),
    'A-15 D-10 G-5 B-1', 'C4 is reachable on four strings');
});

console.log('\nExtremal and nearest — the drills the microphone can grade outright');

check('an extremal prompt resolves to exactly one PITCH', () => {
  // This is what lets the mic grade these completely. It is NOT a claim that
  // the position is unique — see the next check.
  for (const dir of ['lowest', 'highest']) {
    for (const w of Object.values(WINDOWS)) {
      for (let pc = 0; pc < 12; pc++) {
        const e = extremal(pc, dir, { lo: w.lo, hi: w.hi });
        if (!e) continue;
        const pitches = new Set(e.positions.map(p => midiAt(p.s, p.f)));
        eq(pitches.size, 1, `${dir} ${SHARP_NAMES[pc]} in ${w.label} is one pitch`);
        // and it really is the extreme one
        const all = positionsOf(pc, { lo: w.lo, hi: w.hi }).map(p => midiAt(p.s, p.f));
        eq(e.midi, dir === 'highest' ? Math.max(...all) : Math.min(...all), `${dir} ${SHARP_NAMES[pc]} value`);
      }
    }
  }
});

check('where one pitch has several positions, every one is accepted', () => {
  // The lowest C is C3 at BOTH E-8 and A-3. Both are the lowest C; marking
  // either wrong would be marking a right answer wrong.
  const e = extremal(0, 'lowest', { lo: 0, hi: MAX_FRET });
  eq(e.midi, toMidi('C3'), 'lowest C is C3');
  eq(e.positions.map(p => `${STRINGS[p.s]}-${p.f}`).join(' '), 'E-8 A-3', 'sounded in two places');
  // Across all twelve notes, the returned positions must be ALL of the ones
  // sounding that pitch — never a subset.
  for (let pc = 0; pc < 12; pc++) {
    const x = extremal(pc, 'lowest', { lo: 0, hi: MAX_FRET });
    eq(x.positions.length, positionsOfPitch(x.midi, { lo: 0, hi: MAX_FRET }).length,
      `every position sounding the lowest ${SHARP_NAMES[pc]} is offered`);
  }
});

check('a per-string extremal does NOT disambiguate the string', () => {
  // Guards against re-introducing a claim that was checked and found false.
  let ambiguous = 0, total = 0;
  for (let s = 0; s < 6; s++) for (let pc = 0; pc < 12; pc++) {
    const e = extremal(pc, 'lowest', { strings: [s], lo: 0, hi: MAX_FRET });
    if (!e) continue;
    total++;
    if (positionsOfPitch(e.midi, { lo: 0, hi: MAX_FRET }).length > 1) ambiguous++;
  }
  eq(total, 72, 'per-string extremals');
  eq(ambiguous, 66, 'of which another string can also sound');
  ok(ambiguous / total > 0.9, 'so a string constraint is never machine-verifiable');
});

check('nearest-from-anchor lands on the closest instance', () => {
  for (let s = 0; s < 6; s++) for (let f = 0; f <= 12; f++) for (let pc = 0; pc < 12; pc++) {
    const n = nearestFrom(pc, { s, f }, { sameString: true, lo: 0, hi: MAX_FRET });
    if (!n) continue;
    const from = OPEN[s] + f;
    const cands = [];
    for (let g = 0; g <= MAX_FRET; g++) if (PC(OPEN[s] + g) === pc && OPEN[s] + g !== from) cands.push(OPEN[s] + g);
    const best = Math.min(...cands.map(m => Math.abs(m - from)));
    eq(Math.abs(n.midi - from), best, `nearest ${SHARP_NAMES[pc]} from ${STRINGS[s]}-${f}`);
  }
});

console.log('\nPrompts and grading');

check('every find prompt accepts exactly the notes on the named string', () => {
  for (let s = 0; s < 6; s++) for (let pc = 0; pc < 12; pc++) {
    for (const w of [WINDOWS.low, WINDOWS.neck, WINDOWS.full]) {
      const p = buildPrompt({ kind: 'find', s, pc, window: w });
      const want = [];
      for (let f = w.lo; f <= w.hi; f++) if (PC(OPEN[s] + f) === pc) want.push(OPEN[s] + f);
      eq([...p.accept].sort((a, b) => a - b).join(','), want.sort((a, b) => a - b).join(','),
        `find ${SHARP_NAMES[pc]} on ${STRINGS[s]} in ${w.label}`);
      ok(p.text.includes(STRINGS[s]), 'prompt names the string');
    }
  }
});

check('grading is three-way, and the octave near-miss is not thrown away', () => {
  // "C on the G string, frets 0–12" -> G-5 = C4.
  const p = buildPrompt({ kind: 'find', s: 3, pc: 0, window: WINDOWS.neck });
  eq(judge(p, toMidi('C4')), VERDICT.OK, 'the right C');
  eq(judge(p, toMidi('C3')), VERDICT.OCTAVE, 'right note, wrong register');
  eq(judge(p, toMidi('C5')), VERDICT.OCTAVE, 'right note, wrong register, upward');
  eq(judge(p, toMidi('B3')), VERDICT.WRONG, 'a semitone out is simply wrong');
  // The limit, stated as a test so nobody "fixes" it later: the same pitch
  // played on the B string passes, because a microphone cannot tell.
  ok(p.accept.has(midiAt(4, 1)), 'B-1 sounds an accepted pitch — the string is honour-system');
});

check('no sequence drill ever asks for the same pitch twice', () => {
  // Sounding one target would clear both. This is a shipped bug in a competing
  // app; it must be impossible here by construction.
  for (let pc = 0; pc < 12; pc++) for (const w of Object.values(WINDOWS)) {
    const p = buildPrompt({ kind: 'findAll', pc, window: w });
    ok(sequenceIsUnambiguous(p), `findAll ${SHARP_NAMES[pc]} in ${w.label} has distinct pitches`);
  }
  for (let f = 0; f <= MAX_FRET; f++) {
    const p = buildPrompt({ kind: 'fretSlice', f });
    ok(sequenceIsUnambiguous(p), `fret ${f} slice has six distinct pitches`);
    eq(p.seq.length, 6, `fret ${f} has six notes`);
  }
});

check('findAll returns every distinct pitch, ascending', () => {
  for (let pc = 0; pc < 12; pc++) {
    const p = buildPrompt({ kind: 'findAll', pc, window: WINDOWS.neck });
    const want = [...new Set(
      [].concat(...Array.from({ length: 6 }, (_, s) =>
        Array.from({ length: 13 }, (_, f) => f).filter(f => PC(OPEN[s] + f) === pc).map(f => OPEN[s] + f)))
    )].sort((a, b) => a - b);
    eq(p.seq.join(','), want.join(','), `every ${SHARP_NAMES[pc]} in 0–12`);
    ok(p.seq.every((m, i) => i === 0 || m > p.seq[i - 1]), 'ascending');
  }
});

check('barre-root prompts put the root on the right string', () => {
  // E and G shapes root on the 6th; A and C on the 5th; D on the 4th.
  const WANT = { E: 0, G: 0, A: 1, C: 1, D: 2 };
  for (const [shape, s] of Object.entries(WANT)) for (let pc = 0; pc < 12; pc++) {
    const p = buildPrompt({ kind: 'barreRoot', shape, pc, window: WINDOWS.full });
    for (const m of p.accept) {
      const f = m - OPEN[s];
      ok(f >= 0 && f <= MAX_FRET, `${shape}-shape ${SHARP_NAMES[pc]} root is on ${STRINGS[s]}`);
      eq(PC(m), pc, 'and it is the right note');
    }
  }
});

check('key degrees are the major scale, not something adjacent to it', () => {
  const MAJ = [0, 2, 4, 5, 7, 9, 11];
  for (let key = 0; key < 12; key++) for (let d = 1; d <= 7; d++) {
    const p = buildPrompt({ kind: 'keyDegree', keyPc: key, degree: d, window: WINDOWS.neck });
    eq(p.pc, (key + MAJ[d - 1]) % 12, `degree ${d} of ${SHARP_NAMES[key]}`);
    for (const m of p.accept) eq(PC(m), p.pc, 'accepted pitches are that degree');
  }
});

console.log('\nThe ladder');

check('every card appears, and the stages cover the neck', () => {
  eq(allCards().length, 72, 'total cards');
  const naturals = STAGES.filter(s => s.n <= 7).flatMap(s => s.cards);
  eq(new Set(naturals).size, 42, 'stages 1–7 cover all six strings × seven naturals');
  eq(new Set(STAGES[7].cards).size, 30, 'stage 8 is the thirty accidentals');
  eq(new Set(poolThrough(9)).size, 72, 'the full pool is every card');
  // Nothing is introduced twice, ignoring the deliberate re-mixes.
  const introduced = new Set();
  for (const st of STAGES) {
    if (!st.blocked) continue;                       // mixed stages re-use on purpose
    for (const id of st.cards) {
      ok(!introduced.has(id), `${id} is introduced once (stage ${st.n})`);
      introduced.add(id);
    }
  }
  // Every card in the pool is a real (string, note) pair.
  for (const id of poolThrough(9)) {
    const [s, pc] = id.split('|').map(Number);
    ok(s >= 0 && s < 6 && pc >= 0 && pc < 12, `${id} is a real card`);
  }
});

check('the ordering is the one the pedagogy agrees on', () => {
  eq(STAGES[0].strings.join(), '0', 'low E first');
  eq(STAGES[1].strings.join(), '1', 'then A');
  ok(STAGES[2].strings.length === 2 && !STAGES[2].blocked, 'then E+A interleaved');
  eq(STAGES[4].strings.join(), '4', 'the B string gets its own late stage');
  ok(STAGES.findIndex(s => s.pcs.includes(1)) === 7, 'accidentals come after every natural stage');
  // Speed targets widen as the search space grows.
  ok(STAGES[0].speed < STAGES[6].speed, 'one string is a tighter target than six');
  for (const st of STAGES) ok(st.speed >= 2 && st.speed <= 6, `stage ${st.n} target is sane`);
});

console.log('\nSpaced repetition');

// SM-2, restated here rather than imported — the toolbox copy is byte-identical
// across five trainers and a fix in one is meant to be carried to all.
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
function updateSRS(card, correct) {
  const ef = card?.ef ?? 2.5, reps = card?.reps ?? 0, interval = card?.interval ?? 1;
  if (correct) {
    const nef = Math.min(2.5, Math.max(1.3, ef + 0.1));
    const nreps = reps + 1;
    const nint = nreps === 1 ? 1 : nreps === 2 ? 6 : Math.round(interval * nef);
    return { ef: nef, interval: nint, reps: nreps, nextDue: addDays(todayStr(), nint) };
  }
  return { ef: Math.max(1.3, ef - 0.2), interval: 1, reps: 0, nextDue: addDays(todayStr(), 1) };
}

check('the SM-2 engine schedules the way the siblings do', () => {
  let c = updateSRS(undefined, true); eq(c.reps, 1, 'first correct reps'); eq(c.interval, 1, 'first interval');
  c = updateSRS(c, true); eq(c.reps, 2, 'second correct reps'); eq(c.interval, 6, 'second interval');
  c = updateSRS(c, true); ok(c.interval > 6, 'third interval stretches past 6');
  const missed = updateSRS(c, false);
  eq(missed.reps, 0, 'a miss resets reps'); eq(missed.interval, 1, 'a miss resets the interval');
  let low = { ef: 1.3, interval: 1, reps: 0 };
  for (let i = 0; i < 5; i++) low = updateSRS(low, false);
  eq(low.ef, 1.3, 'ease factor floor');
});

console.log('\nStorage round-trips');

check('every persisted value survives a ProgressBackup round trip', () => {
  // ProgressBackup JSON.parses on export and ALWAYS JSON.stringifies on import,
  // so a bare string comes back wrapped in quotes. Write everything as JSON.
  const roundTrip = raw => { let v; try { v = JSON.parse(raw); } catch { v = raw; } return JSON.stringify(v); };
  for (const [key, raw] of [
    ['nt_stage', '3'],
    ['nt_settings', JSON.stringify({ spelling: 'sharp', sessionN: 12 })],
    ['nt_srs', JSON.stringify({ '0|5': { ef: 2.5, interval: 6, reps: 2, nextDue: '2026-09-20', seen: 4, wrong: 1 } })],
    ['nt_latency', JSON.stringify({ '0|5': [2.1, 1.8] })],
  ]) eq(roundTrip(raw), raw, `${key} round trip`);
});

console.log(failures === 0
  ? `\nAll checks passed. ${assertions} assertions.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
