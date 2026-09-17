// ── The ladder ───────────────────────────────────────────────────────────
// Curriculum, not maths. The ordering is the one the teaching corpus agrees on
// almost unanimously:
//
//   * Naturals before accidentals — a 12→7 reduction, and accidentals are then
//     ±1 from a note you already own. Teachers are near-unanimous that they are
//     trivial once naturals are solid, which means a long accidentals plateau
//     would be this app's fault, not the material's.
//   * Low E and A first — barre and CAGED roots live there (E/G shapes root on
//     the 6th, A/C on the 5th), and string 1 is string 6 two octaves up, so the
//     6th very nearly gives you the 1st for free.
//   * The B string gets its own late stage. Every pattern-based method breaks at
//     the major-third tuning kink, which is precisely why pattern-learners have
//     a B-string hole.
//
// Each stage is BLOCKED while it is being acquired and then joins the
// interleaved pool permanently. That split is not a compromise: novices
// demonstrably cannot exploit random practice, while interleaving wins clearly
// on retention once the material is in. So: block to acquire, interleave to keep.

import { NATURAL_PCS, cardId } from './theory.js';
import { WINDOWS } from './theory.js';

const ACCIDENTAL_PCS = [1, 3, 6, 8, 10];
const cardsFor = (strings, pcs) =>
  strings.flatMap(s => pcs.map(pc => cardId(s, pc)));

// Speed targets widen with the search space, because time-to-play includes
// moving the hand — a jump across the neck is not the same task as a shift
// along one string. Accidentals carry a surcharge for the extra ±1 step.
const T = { one: 2.5, two: 3.0, four: 3.5, six: 4.0 };

export const STAGES = [
  { n: 1, name: 'Low E — naturals',        strings: [0],             pcs: NATURAL_PCS, blocked: true,  speed: T.one },
  { n: 2, name: 'A string — naturals',     strings: [1],             pcs: NATURAL_PCS, blocked: true,  speed: T.one },
  { n: 3, name: 'E + A — mixed',           strings: [0, 1],          pcs: NATURAL_PCS, blocked: false, speed: T.two },
  { n: 4, name: 'D and G — naturals',      strings: [2, 3],          pcs: NATURAL_PCS, blocked: true,  speed: T.two },
  { n: 5, name: 'B string — naturals',     strings: [4],             pcs: NATURAL_PCS, blocked: true,  speed: T.one },
  { n: 6, name: 'High e — naturals',       strings: [5],             pcs: NATURAL_PCS, blocked: true,  speed: T.one },
  { n: 7, name: 'All six — naturals',      strings: [0,1,2,3,4,5],   pcs: NATURAL_PCS, blocked: false, speed: T.six },
  { n: 8, name: 'Accidentals',             strings: [0,1,2,3,4,5],   pcs: ACCIDENTAL_PCS, blocked: false, speed: T.six + 0.5 },
  { n: 9, name: 'The whole neck',          strings: [0,1,2,3,4,5],   pcs: [...NATURAL_PCS, ...ACCIDENTAL_PCS].sort((a,b)=>a-b), blocked: false, speed: T.six + 0.5 },
].map(st => ({ ...st, cards: cardsFor(st.strings, st.pcs) }));

export const stageByN = n => STAGES.find(s => s.n === n) || STAGES[0];

// Everything introduced at or before this stage — the interleaved pool. A card
// never leaves once acquired; that is what stops the earlier strings quietly
// rotting while you work on the later ones.
export function poolThrough(n) {
  const ids = new Set();
  for (const st of STAGES) if (st.n <= n) for (const id of st.cards) ids.add(id);
  return [...ids];
}

// A stage is passed on ACCURACY. The speed badge is separate and optional and
// never blocks advancement — measure always, pressure optionally. A clock that
// gates progress is the thing the fluency literature warns about; a clock that
// reports is the only signal of automaticity once accuracy saturates.
export const ACC_PASS = 0.9;      // of the stage's last N reps
export const ACC_WINDOW = 12;
export const SPEED_WINDOW = 12;
export const SPEED_PASS = 9;      // N of the last SPEED_WINDOW under target

// The fret windows a stage draws from, easiest first. Narrowing the window is
// the first difficulty relief when accuracy drops below the ~85% setpoint.
export const STAGE_WINDOWS = [WINDOWS.low, WINDOWS.neck, WINDOWS.full];
