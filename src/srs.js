// ── Spaced repetition ────────────────────────────────────────────────────
// SM-2, copied verbatim from triads-trainer/src/TriadTrainer.jsx:32-46, which is
// byte-identical to the copies in Altered, Diatonic, Chord and Focused Chord.
// Do not re-derive it; a fix in one is meant to be carried to all.
//
// One deliberate deviation from how the siblings use it. Spacing is strongly
// evidenced for facts (Cepeda et al., 839 effect sizes) but null for motor
// sequence learning (Wiseheart et al. 2017, piano, replicated). This task is a
// fact/motor hybrid: the association "G string, fret 5 is C" is a paired
// associate and schedules normally, but the reach — landing a finger there
// without looking — is motor and does not. So the SCHEDULE spaces the facts and
// the SESSION supplies the motor volume through within-session repetition.
// Don't assume an interval that keeps the name alive keeps the hand fluent.

export const todayStr = () => new Date().toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
export const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

export function updateSRS(card, correct) {
  const ef = card?.ef ?? 2.5, reps = card?.reps ?? 0, interval = card?.interval ?? 1;
  if (correct) {
    const nef = Math.min(2.5, Math.max(1.3, ef + 0.1));
    const nreps = reps + 1;
    const nint = nreps === 1 ? 1 : nreps === 2 ? 6 : Math.round(interval * nef);
    return { ef: nef, interval: nint, reps: nreps, nextDue: addDays(todayStr(), nint) };
  }
  return { ef: Math.max(1.3, ef - 0.2), interval: 1, reps: 0, nextDue: addDays(todayStr(), 1) };
}

export const isLearned = c => !!c && c.reps >= 2;
export const dueOn = (c, td) => !!c && dayDiff(td, c.nextDue) <= 0;

export const ri = n => Math.floor(Math.random() * n);
export const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = ri(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ── Accuracy ─────────────────────────────────────────────────────────────
// `seen` and `wrong` are written on every grade. Never back-fill them from
// reps/ef: a guess dressed as a measurement is worse than a number that is
// briefly optimistic.
export const accOf = c => {
  const seen = c?.seen ?? 0;
  return seen ? (seen - (c.wrong ?? 0)) / seen : null;
};

export const WEAK_MIN_SEEN = 4, WEAK_ACC = 0.8;

// ── Aggregation ──────────────────────────────────────────────────────────
// Cards carry their dimensions as top-level fields, which is what lets one
// breakdown function serve every axis — string, note class, register.
export function breakdown(cards, srs, dimOf) {
  const td = todayStr(), by = new Map();
  for (const c of cards) {
    const k = dimOf(c);
    const m = by.get(k) || { key: k, total: 0, nw: 0, learning: 0, solid: 0, due: 0, seen: 0, wrong: 0 };
    m.total++;
    const e = srs[c.id];
    if (!e) m.nw++;
    else {
      isLearned(e) ? m.solid++ : m.learning++;
      if (dueOn(e, td)) m.due++;
      m.seen += e.seen ?? 0; m.wrong += e.wrong ?? 0;
    }
    by.set(k, m);
  }
  return [...by.values()].map(m => ({ ...m, acc: m.seen ? (m.seen - m.wrong) / m.seen : null }));
}

export function srsStats(cards, srs) {
  const td = todayStr();
  let nw = 0, learning = 0, solid = 0, due = 0;
  for (const c of cards) {
    const e = srs[c.id];
    if (!e) { nw++; continue; }
    isLearned(e) ? solid++ : learning++;
    if (dueOn(e, td)) due++;
  }
  return { nw, learning, solid, due, total: cards.length };
}

// Never-reviewed cards go in `newCount` and in NO bucket. Dropping them is what
// made a sibling tool read "4 due now" over a bar of 1.
export function forecast(cards, srs, days = 7) {
  const td = todayStr();
  const buckets = Array.from({ length: days }, () => 0);
  let newCount = 0, dueToday = 0, soonest = null;
  for (const c of cards) {
    const e = srs[c.id];
    if (!e) { newCount++; continue; }
    const d = dayDiff(td, e.nextDue);
    if (d <= 0) dueToday++;
    if (soonest === null || d < soonest) soonest = d;
    buckets[Math.max(0, Math.min(days - 1, d))]++;
  }
  return { buckets, newCount, dueToday, soonest };
}

// ── The queue ────────────────────────────────────────────────────────────
// Three tiers: due, then never-seen, then not-yet-due. A stage deck can be as
// small as seven cards, so the pool cycles — which is also where the motor
// volume comes from, per the note at the top of this file.
//
// A NARROW pool gets a proportionate session rather than the full length: one
// note on one string padded to twelve questions is the same question twelve
// times over.
export const REPS_PER_CARD = 3;

export function buildQueue(cards, srs, count, { dueOnly = false } = {}) {
  const td = todayStr();
  const due = shuffle(cards.filter(c => dueOn(srs[c.id], td)));
  const nw = shuffle(cards.filter(c => !srs[c.id]));
  const rest = shuffle(cards.filter(c => srs[c.id] && !dueOn(srs[c.id], td)));
  const pool = dueOnly ? due : [...due, ...nw, ...rest];
  if (!pool.length) return [];
  const n = Math.min(count, dueOnly ? pool.length : pool.length * REPS_PER_CARD);
  const q = [];
  while (q.length < n) q.push(pool[q.length % pool.length]);
  return q;
}

// ── Latency ──────────────────────────────────────────────────────────────
// Recorded on every rep from stage one, silently, so the speed tier has a real
// baseline behind it rather than an invented target. Kept as a short rolling
// window per card — enough for a median, small enough to persist cheaply.
export const LAT_KEEP = 12;
export const pushLatency = (lat, id, secs) => ({
  ...lat, [id]: [...(lat[id] || []), secs].slice(-LAT_KEEP),
});
export const medianOf = xs => {
  if (!xs?.length) return null;
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
