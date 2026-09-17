import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { AppHeader, TabBar, ProgressBackup } from '@fretworks/design';
import Fretboard from './Fretboard.jsx';
import {
  STRINGS, WINDOWS, NATURAL_PCS, MAX_FRET,
  nameOf, pcAt, midiAt, positionsOfPitch, allCards, cardId, parseCardId,
  windowAround, firstFretOf, positionsOf,
} from './theory.js';
import { buildPrompt, judge, VERDICT, DRILL_META, acceptedPositions } from './drills.js';
import { STAGES, stageByN, poolThrough, ACC_PASS, ACC_WINDOW, SPEED_WINDOW, SPEED_PASS } from './ladder.js';
import {
  todayStr, dayDiff, updateSRS, isLearned, dueOn, accOf, ri, shuffle,
  breakdown, srsStats, forecast, buildQueue, pushLatency, medianOf, WEAK_MIN_SEEN, WEAK_ACC,
} from './srs.js';
import { createListener } from './pitch.js';

const ACCENT = '#fb923c';
const TOOL = 'notes';
const PFX = 'nt_';

// Sync JSON storage. Grading runs inside a detection callback and the queue
// advances immediately, so an async write would race the next note.
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const DEFAULTS = { spelling: 'sharp', sessionN: 12, showSpeed: true, sensitivity: 0.012 };

// ── Microphone ───────────────────────────────────────────────────────────
// Kept in a hook so the stream's lifetime is tied to the screen that needs it.
// Started only from an explicit tap: Safari needs a real gesture, and the
// getUserMedia grant itself does not count as one.
function useMic(sensitivity) {
  const [state, setState] = useState('idle');   // idle | starting | on | denied | error
  const [level, setLevel] = useState(0);
  const ref = useRef(null);
  const noteCb = useRef(null);

  const start = useCallback(async () => {
    if (ref.current || state === 'starting') return;
    setState('starting');
    try {
      const l = await createListener({ rearmRms: sensitivity });
      l.onLevel(setLevel);
      l.onNote(n => noteCb.current?.(n));
      ref.current = l;
      setState('on');
    } catch (e) {
      setState(e?.name === 'NotAllowedError' ? 'denied' : 'error');
    }
  }, [sensitivity, state]);

  const stop = useCallback(async () => {
    const l = ref.current; ref.current = null;
    setState('idle'); setLevel(0);
    if (l) await l.stop();
  }, []);

  // iOS kills the stream on backgrounding rather than pausing it.
  useEffect(() => {
    const onVis = () => { if (document.hidden && ref.current) stop(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [stop]);
  useEffect(() => () => { ref.current?.stop(); }, []);

  return {
    state, level, start, stop,
    onNote: fn => { noteCb.current = fn; },
    rearm: () => ref.current?.rearm(),
  };
}

// ── Question generation ──────────────────────────────────────────────────
// A queue item is a card plus the per-rep variables: which drill asks it, which
// window it is asked in, and any anchor. Decided once, at build time, so
// nothing reshuffles under a half-answered question.
function makeItem(card, stage, settings) {
  const { s, pc } = parseCardId(card.id);
  const spelling = settings.spelling;
  // The window SLIDES to wherever this note is on this string rather than being
  // a fixed range the note may not be in. A fixed 0-5 made three of the seven
  // naturals unanswerable on each of the first two stages.
  const span = stage.n <= 2 ? 6 : stage.n <= 6 ? 9 : MAX_FRET + 1;
  const win = windowAround(s, pc, span);
  const roll = Math.random();

  // Early stages stay on the plain find drill — a novice cannot exploit variety,
  // and the point of a blocked stage is the one operation. Variety arrives with
  // the interleaved stages, on the axis that actually causes confusion.
  const spec =
    (stage.blocked || roll < 0.55) ? { kind: 'find', s, pc, window: win, spelling }
    : roll < 0.70 ? { kind: 'name', s, f: firstFretOf(s, pc), spelling }
    : roll < 0.85 ? { kind: 'extremal', pc, dir: Math.random() < 0.5 ? 'lowest' : 'highest', window: WINDOWS.full, spelling }
    : { kind: 'nearest', pc, window: WINDOWS.full, spelling,
        anchor: { s, f: ri(13) } };

  // Belt and braces: if a variant somehow has no answer, fall back to the find
  // drill, whose window is constructed to contain one.
  return { ...card, spec: buildPrompt(spec) ? spec : { kind: 'find', s, pc, window: win, spelling } };
}

// ════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState('practice');
  const [stageN, setStageN] = useState(1);
  const [srs, setSrs] = useState({});
  const [lat, setLat] = useState({});
  const [settings, setSettings] = useState(DEFAULTS);
  const [placed, setPlaced] = useState(true);   // assume placed until load says otherwise
  const loaded = useRef(false);

  useEffect(() => {
    setSrs(store.get(PFX + 'srs', {}));
    setLat(store.get(PFX + 'lat', {}));
    setStageN(store.get(PFX + 'stage', 1));
    setSettings({ ...DEFAULTS, ...store.get(PFX + 'settings', {}) });
    setPlaced(store.get(PFX + 'placed', false));
    loaded.current = true;
  }, []);
  // Every write waits for the load, or the defaults overwrite real progress.
  useEffect(() => { if (loaded.current) store.set(PFX + 'stage', stageN); }, [stageN]);
  useEffect(() => { if (loaded.current) store.set(PFX + 'settings', settings); }, [settings]);

  const stage = stageByN(stageN);
  const pool = useMemo(() => poolThrough(stageN).map(id => ({ id, ...parseCardId(id) })), [stageN]);
  const stageCards = useMemo(() => stage.cards.map(id => ({ id, ...parseCardId(id) })), [stage]);

  const grade = useCallback((id, correct, secs) => {
    setSrs(prev => {
      const next = { ...prev, [id]: {
        ...updateSRS(prev[id], correct),
        seen: (prev[id]?.seen || 0) + 1,
        wrong: (prev[id]?.wrong || 0) + (correct ? 0 : 1),
      } };
      store.set(PFX + 'srs', next);
      return next;
    });
    if (correct && secs != null) {
      setLat(prev => { const next = pushLatency(prev, id, secs); store.set(PFX + 'lat', next); return next; });
    }
  }, []);

  const TABS = [
    { id: 'practice', icon: '🎯', label: 'Practice' },
    { id: 'learn', icon: '📖', label: 'Learn' },
    { id: 'drills', icon: '🎛️', label: 'Drills' },
    { id: 'progress', icon: '📈', label: 'Progress' },
    { id: 'settings', icon: '⚙️', label: 'Settings' },
  ];

  // Page chrome. The shared header owns the top safe-area inset, so the root
  // must not add its own paddingTop.
  useEffect(() => {
    const st = document.createElement('style');
    st.textContent = `*{-webkit-tap-highlight-color:transparent}body{margin:0}
      input,select{font-size:16px}`;
    document.head.appendChild(st);
    const meta = (n, c) => { let m = document.querySelector(`meta[name="${n}"]`); if (!m) { m = document.createElement('meta'); m.name = n; document.head.appendChild(m); } m.content = c; };
    meta('theme-color', '#0f0e17');
    meta('apple-mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    meta('apple-mobile-web-app-title', 'Fretworks');
    let ml = document.querySelector('link[rel="manifest"]');
    if (!ml) { ml = document.createElement('link'); ml.rel = 'manifest'; document.head.appendChild(ml); }
    ml.href = '/manifest.webmanifest';
    // iOS standalone initialises scrollY to the safe-area inset, which offsets
    // every tap. Pin the page.
    window.scrollTo(0, 0);
    const lock = () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); };
    window.addEventListener('scroll', lock, { passive: true });
    return () => { window.removeEventListener('scroll', lock); st.remove(); };
  }, []);

  return (
    <div style={{
      background: '#0f0e17', height: '100dvh', width: '100%', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', color: '#fffffe',
      fontFamily: 'var(--font-body)', WebkitFontSmoothing: 'antialiased',
      '--accent': ACCENT, '--accent-ink': '#17130c',
    }}>
      <AppHeader toolKey={TOOL} />
      <TabBar toolKey={TOOL} tabs={TABS} active={tab} onChange={setTab} accent={ACCENT} />
      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'none' }}>
        <div style={{ paddingBottom: 'max(40px,env(safe-area-inset-bottom))', maxWidth: 560, margin: '0 auto' }}>
          {tab === 'practice' && (
            <PracticeTab {...{ stage, stageN, setStageN, pool, stageCards, srs, lat, settings, grade, placed, setPlaced }} />
          )}
          {tab === 'learn' && <LearnTab settings={settings} />}
          {tab === 'drills' && <DrillsTab {...{ pool, srs, settings, grade }} />}
          {tab === 'progress' && <ProgressTab {...{ pool, stage, srs, lat, settings }} />}
          {tab === 'settings' && <SettingsTab {...{ settings, setSettings, setSrs, setLat, setStageN, setPlaced }} />}
        </div>
      </div>
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────────────
const card = { background: '#13121f', border: '1px solid #1a1928', borderRadius: 12, padding: 12, marginBottom: 12 };
const h = { fontSize: 11, color: '#888', letterSpacing: '.5px', textTransform: 'uppercase', fontWeight: 800, marginBottom: 8 };
const primary = { width: '100%', background: ACCENT, color: '#17130c', border: 'none', borderRadius: 10, padding: 14, fontSize: 15, fontWeight: 800, cursor: 'pointer', minHeight: 48, touchAction: 'manipulation' };
const ghost = { width: '100%', background: 'transparent', color: '#aaa', border: '1px solid #2a2840', borderRadius: 9, padding: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', minHeight: 44, touchAction: 'manipulation', marginTop: 8 };
const pad = { padding: '14px 12px' };

// ── Input meter ──────────────────────────────────────────────────────────
// Always visible while listening. Without it there is no way to tell whether
// the app is deaf or you are wrong, which is the complaint that sinks every
// mic-based trainer.
function Meter({ state, level, onStart }) {
  if (state !== 'on') {
    const msg = state === 'denied' ? 'Microphone blocked — allow it in Safari settings, or use Tap instead.'
      : state === 'error' ? "Couldn't open the microphone."
      : state === 'starting' ? 'Starting…' : 'The app listens to your guitar.';
    return (
      <div style={{ ...card, borderColor: state === 'denied' ? '#ef444455' : '#1a1928', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: '#bbb', marginBottom: 10, lineHeight: 1.5 }}>{msg}</div>
        <button onClick={onStart} style={primary} disabled={state === 'starting'}>🎤 Start listening</button>
      </div>
    );
  }
  const pct = Math.min(100, level * 1400);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 10, color: '#666', whiteSpace: 'nowrap' }}>hearing</span>
      <div style={{ flex: 1, height: 6, background: '#1a1928', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct > 6 ? '#2ed573' : '#3a3852', transition: 'width .08s linear' }} />
      </div>
    </div>
  );
}

// ── A running session ────────────────────────────────────────────────────
function Session({ items, settings, grade, onDone, title }) {
  const mic = useMic(settings.sensitivity);
  const [qi, setQi] = useState(0);
  const [answer, setAnswer] = useState(null);
  const [tally, setTally] = useState({ ok: 0, miss: 0 });
  const askedAt = useRef(Date.now());

  const it = items[qi];
  const prompt = useMemo(() => (it ? buildPrompt(it.spec) : null), [it]);

  // buildPrompt returns null for a question with no correct answer. Callers are
  // supposed to filter those out before they reach here, so this is a backstop
  // rather than the fix — but a crash mid-session is a worse outcome than a skip.
  useEffect(() => { if (it && !prompt) setQi(i => i + 1); }, [it, prompt]);

  useEffect(() => { askedAt.current = Date.now(); mic.rearm(); }, [qi]);

  const commit = useCallback((verdict, secs) => {
    if (!it) return;
    const correct = verdict === VERDICT.OK;
    setAnswer({ verdict, secs });
    setTally(t => ({ ok: t.ok + (correct ? 1 : 0), miss: t.miss + (correct ? 0 : 1) }));
    grade(it.id, correct, secs);
  }, [it, grade]);

  mic.onNote(n => {
    if (answer || !prompt) return;
    commit(judge(prompt, n.midi), (Date.now() - askedAt.current) / 1000);
  });

  if (!it) {
    const total = tally.ok + tally.miss;
    const pct = Math.round((tally.ok / Math.max(1, total)) * 100);
    return (
      <div style={pad}>
        <div style={{ ...card, textAlign: 'center', padding: '24px 14px' }}>
          <div style={{ fontSize: 34, marginBottom: 6 }}>{pct >= 85 ? '⭐' : pct >= 60 ? '🎸' : '💪'}</div>
          <div style={{ fontSize: 22, fontWeight: 900 }}>{tally.ok} / {total}</div>
          <div style={{ fontSize: 12, color: '#999', marginTop: 6, lineHeight: 1.6 }}>
            Right now this number matters less than it feels like it should — what you
            remember at the start of the next session is the real measure.
          </div>
        </div>
        <button onClick={onDone} style={primary}>Done</button>
      </div>
    );
  }

  const reveal = answer ? acceptedPositions(prompt, prompt.window?.lo ?? 0, prompt.window?.hi ?? MAX_FRET) : [];
  const marks = answer
    ? reveal.map(p => ({ ...p, kind: answer.verdict === VERDICT.OK ? 'ok' : 'reveal' }))
    : [];
  const lo = prompt.window?.lo ?? 0, hi = Math.min(prompt.window?.hi ?? 12, MAX_FRET);

  return (
    <div style={pad}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button onClick={onDone} aria-label="End session" style={{ background: 'transparent', border: '1px solid #2a2840', color: '#aaa', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 700, cursor: 'pointer', minHeight: 44, minWidth: 44 }}>End</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: '#888' }}>{title} · {qi + 1} / {items.length}</div>
          <div style={{ height: 4, background: '#1a1928', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
            <div style={{ width: `${(qi / items.length) * 100}%`, height: '100%', background: ACCENT }} />
          </div>
        </div>
      </div>

      <Meter state={mic.state} level={mic.level} onStart={mic.start} />

      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.4 }}>{prompt.text}</div>
        {/* The fret range is half the question, not a footnote. It used to be
            11px grey under the prompt and was easy to miss entirely — so it is
            now a chip in the accent colour, and the board below is drawn to
            exactly this range, which says the same thing a second way. */}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 9,
          padding: '5px 12px', borderRadius: 14, background: ACCENT + '1e', border: `1px solid ${ACCENT}55` }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: ACCENT, fontFamily: 'var(--font-mono)' }}>
            {lo === 0 ? `frets ${lo}\u2013${hi}` : `frets ${lo}\u2013${hi}`}
          </span>
          <span style={{ fontSize: 10.5, color: '#8a8a9a' }}>
            {lo === 0 ? 'open position' : `${hi - lo + 1}-fret window`}
          </span>
        </div>
      </div>

      {/* Nothing is drawn on the neck during a question — a reviewer of a rival
          app caught themselves "using the pattern instead of learning the notes". */}
      <div style={{ margin: '0 -12px 10px' }}>
        <Fretboard lo={lo} hi={hi} marks={marks} anchor={prompt.anchor || null}
          dots={answer && prompt.kind === 'name' ? [] : []} />
      </div>

      {answer ? (
        <div style={{ ...card, borderColor: answer.verdict === VERDICT.OK ? '#2ed57355' : '#fbbf2455' }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: answer.verdict === VERDICT.OK ? '#2ed573' : answer.verdict === VERDICT.OCTAVE ? '#fbbf24' : '#ef4444' }}>
            {answer.verdict === VERDICT.OK ? (answer.secs != null ? `Yes — ${answer.secs.toFixed(1)}s` : 'Yes')
              : answer.verdict === VERDICT.OCTAVE ? 'Right note, wrong octave.'
              : 'Not that one.'}
          </div>
          {/* Always show the answer. A miss with no correction is a wasted rep. */}
          <div style={{ fontSize: 11.5, color: '#bbb', marginTop: 6, lineHeight: 1.6 }}>
            {reveal.map(p => `${STRINGS[p.s]} string, fret ${p.f}`).join('  ·  ')}
            {reveal.length > 1 && <span style={{ color: '#777' }}><br />Both sound the same pitch — either is correct.</span>}
          </div>
          <button onClick={() => { setAnswer(null); setQi(i => i + 1); }} style={primary}>Next ›</button>
        </div>
      ) : (
        <div style={{ ...card }}>
          <div style={{ fontSize: 11, color: '#777', textAlign: 'center', marginBottom: 8 }}>
            Play it on your guitar.
          </div>
          {/* The fallback. Keeps the session alive when the room is loud, the
              permission is denied, or the amp is fighting the detector. */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => commit(VERDICT.OK, null)}
              style={{ ...ghost, marginTop: 0, color: '#2ed573', borderColor: '#2ed57355' }}>Got it</button>
            <button onClick={() => commit(VERDICT.WRONG, null)}
              style={{ ...ghost, marginTop: 0 }}>Missed</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Practice ─────────────────────────────────────────────────────────────
function PracticeTab({ stage, stageN, setStageN, pool, stageCards, srs, lat, settings, grade, placed, setPlaced }) {
  const [session, setSession] = useState(null);

  const stats = useMemo(() => srsStats(stageCards, srs), [stageCards, srs]);
  const due = useMemo(() => pool.filter(c => dueOn(srs[c.id], todayStr())).length, [pool, srs]);
  const acc = useMemo(() => {
    const b = breakdown(stageCards, srs, () => 'all')[0];
    return b?.acc ?? null;
  }, [stageCards, srs]);
  const med = useMemo(() => {
    const all = stageCards.flatMap(c => lat[c.id] || []);
    return medianOf(all);
  }, [stageCards, lat]);

  const start = (cards, title, opts = {}) => {
    const q = buildQueue(cards, srs, settings.sessionN, opts);
    if (!q.length) return;
    setSession({ items: q.map(c => makeItem(c, stage, settings)), title });
  };

  if (session) return <Session {...session} settings={settings} grade={grade} onDone={() => setSession(null)} />;

  if (!placed) return <Placement stage={stage} settings={settings} onDone={(n) => {
    setStageN(n); setPlaced(true); store.set(PFX + 'placed', true);
  }} />;

  const accPassed = acc !== null && acc >= ACC_PASS && stats.solid >= Math.ceil(stage.cards.length * 0.7);
  const speedHits = stageCards.flatMap(c => (lat[c.id] || [])).slice(-SPEED_WINDOW).filter(s => s <= stage.speed).length;

  return (
    <div style={pad}>
      <div style={{ ...card, borderColor: due ? ACCENT + '77' : '#1a1928' }}>
        <div style={h}>Next up</div>
        <div style={{ fontSize: 15.5, fontWeight: 800, lineHeight: 1.4 }}>
          {due ? `${due} card${due > 1 ? 's' : ''} due`
            : stats.nw ? `${stats.nw} you haven't tried yet`
            : `Stage ${stage.n} — ${stage.name}`}
        </div>
        <div style={{ fontSize: 11.5, color: '#8a8a9a', lineHeight: 1.6, marginTop: 5, marginBottom: 11 }}>
          {due ? 'The schedule says these are about to slip.'
            : stats.nw ? 'Blocked practice while the material is new — that is the right order.'
            : 'Nothing owing. Practising early still counts.'}
        </div>
        <button onClick={() => start(due ? pool : stageCards, `Stage ${stage.n}`, { dueOnly: !!due })} style={primary}>
          ▶ {due ? "Review what's due" : `Practise stage ${stage.n}`}
        </button>
      </div>

      <div style={card}>
        <div style={h}>Stage {stage.n} · {stage.name}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {stage.strings.map(s => (
            <span key={s} style={{ fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 14, border: `1px solid ${ACCENT}55`, color: ACCENT }}>
              {STRINGS[s]} string
            </span>
          ))}
          <span style={{ fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 14, border: '1px solid #2a2840', color: '#888' }}>
            {stage.pcs.length === 7 ? 'naturals' : 'accidentals'}
          </span>
        </div>

        {/* Two gates, shown as two gates. Accuracy advances you; speed is the
            badge that says it is actually automatic. */}
        <Gate label="Accuracy" on={accPassed}
          detail={acc === null ? 'no attempts yet' : `${Math.round(acc * 100)}% · ${stats.solid} of ${stats.total} solid`} />
        <Gate label="Speed" on={speedHits >= SPEED_PASS} dim={!accPassed}
          detail={!accPassed ? `unlocks after accuracy · target ${stage.speed}s`
            : med === null ? `target ${stage.speed}s` : `${speedHits} of last ${SPEED_WINDOW} under ${stage.speed}s · median ${med.toFixed(1)}s`} />

        {accPassed && stage.n < STAGES.length && (
          <button onClick={() => setStageN(stage.n + 1)} style={{ ...primary, background: '#2ed573', marginTop: 10 }}>
            Move on to stage {stage.n + 1}
          </button>
        )}
        <button onClick={() => start(stageCards, `Stage ${stage.n}`)} style={ghost}>Practise this stage</button>
      </div>

      <div style={card}>
        <div style={h}>The ladder</div>
        {STAGES.map(st => (
          <div key={st.n} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 6px', borderRadius: 8, marginBottom: 4,
            border: `1px solid ${st.n === stage.n ? ACCENT : '#1f1e2e'}`, background: st.n === stage.n ? ACCENT + '11' : 'transparent' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800 }}>{st.n}. {st.name}</div>
              <div style={{ fontSize: 10, color: '#777', marginTop: 2 }}>
                {st.cards.length} cards · {st.blocked ? 'blocked' : 'interleaved'} · target {st.speed}s
              </div>
            </div>
            <button onClick={() => setStageN(st.n)} disabled={st.n === stage.n}
              style={{ background: 'transparent', border: `1px solid ${st.n === stage.n ? ACCENT : '#2a2840'}`, color: st.n === stage.n ? ACCENT : '#888', borderRadius: 8, padding: '0 10px', fontSize: 11, fontWeight: 700, cursor: st.n === stage.n ? 'default' : 'pointer', minHeight: 44, minWidth: 44 }}>
              {st.n === stage.n ? 'here' : 'go'}
            </button>
          </div>
        ))}
        <div style={{ fontSize: 10.5, color: '#666', lineHeight: 1.6, marginTop: 8 }}>
          Nothing is locked. A stage is blocked while the material is new, then joins
          the mixed pool and stays there — that is what stops the early strings rotting
          while you work on the later ones.
        </div>
      </div>
    </div>
  );
}

const Gate = ({ label, on, dim, detail }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', opacity: dim ? 0.55 : 1 }}>
    <span style={{ width: 9, height: 9, borderRadius: '50%', boxSizing: 'border-box', flexShrink: 0,
      background: on ? '#2ed573' : 'transparent', border: `1.5px solid ${on ? '#2ed573' : '#3a3852'}` }} />
    <span style={{ fontSize: 12, fontWeight: 700, width: 62 }}>{label}</span>
    <span style={{ fontSize: 10.5, color: '#888' }}>{detail}</span>
  </div>
);

// ── Placement ────────────────────────────────────────────────────────────
// Untimed, 24 questions sampled across every string and both note classes, so
// the ladder starts where you actually are instead of grinding low-E naturals
// you already own.
function Placement({ settings, onDone }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);

  const items = useMemo(() => {
    const picks = [];
    for (let s = 0; s < 6; s++) {
      const pcs = shuffle(NATURAL_PCS).slice(0, 3);
      for (const pc of pcs) picks.push({ id: cardId(s, pc), s, pc });
    }
    for (let i = 0; i < 6; i++) {
      const s = ri(6), pc = [1, 3, 6, 8, 10][ri(5)];
      picks.push({ id: cardId(s, pc), s, pc });
    }
    return shuffle(picks).map(c => ({ ...c, spec: { kind: 'find', s: c.s, pc: c.pc, window: WINDOWS.neck, spelling: settings.spelling } }));
  }, [settings.spelling]);

  const record = useCallback((id, correct) => setResults(r => [...r, { id, correct }]), []);

  if (running) {
    return <Session items={items} settings={settings} grade={record} title="Placement"
      onDone={() => {
        // Walk up while each stage's sampled cards were answered well.
        const byId = new Map(results.map(r => [r.id, r.correct]));
        let reached = 1;
        for (const st of STAGES) {
          const sampled = st.cards.filter(id => byId.has(id));
          if (!sampled.length) break;
          const right = sampled.filter(id => byId.get(id)).length;
          if (right / sampled.length >= 0.8) reached = st.n + 1; else break;
        }
        onDone(Math.min(STAGES.length, reached));
      }} />;
  }

  return (
    <div style={pad}>
      <div style={card}>
        <div style={h}>Before we start</div>
        <div style={{ fontSize: 15.5, fontWeight: 800, marginBottom: 6 }}>Where are you already?</div>
        <div style={{ fontSize: 12, color: '#bbb', lineHeight: 1.7, marginBottom: 12 }}>
          24 questions, no clock, about two minutes. It samples every string and a few
          accidentals, and starts you where you actually are rather than at the
          beginning. Guitar in hand — the app listens.
        </div>
        <button onClick={() => setRunning(true)} style={primary}>Start the placement</button>
        <button onClick={() => onDone(1)} style={ghost}>Skip — start from stage 1</button>
      </div>
    </div>
  );
}

// ── Drills ───────────────────────────────────────────────────────────────
function DrillsTab({ pool, srs, settings, grade }) {
  const [session, setSession] = useState(null);
  const [s, setS] = useState(0);
  const [winKey, setWinKey] = useState('neck');
  const [naturals, setNaturals] = useState(true);

  if (session) return <Session {...session} settings={settings} grade={grade} onDone={() => setSession(null)} />;

  const run = kind => {
    const picked = WINDOWS[winKey];
    const pcs = naturals ? NATURAL_PCS : [0,1,2,3,4,5,6,7,8,9,10,11];
    const cards = shuffle(pcs).map(pc => ({ id: cardId(s, pc), s, pc }));
    const items = cards.slice(0, settings.sessionN).map(c => {
      // A chosen window may not contain this note on this string — the A string
      // has no G below fret 10. Slide a window of the same width to where the
      // note is rather than asking something unanswerable.
      const span = picked.hi - picked.lo + 1;
      const win = positionsOf(c.pc, { strings: [s], lo: picked.lo, hi: picked.hi }).length
        ? picked : windowAround(s, c.pc, span);
      return {
        ...c,
        spec: kind === 'find' ? { kind: 'find', s, pc: c.pc, window: win, spelling: settings.spelling }
          : kind === 'extremal' ? { kind: 'extremal', pc: c.pc, dir: Math.random() < 0.5 ? 'lowest' : 'highest', window: WINDOWS.full, spelling: settings.spelling }
          : kind === 'findAll' ? { kind: 'findAll', pc: c.pc, window: picked, spelling: settings.spelling }
          : { kind: 'name', s, f: firstFretOf(s, c.pc), spelling: settings.spelling },
      };
    }).filter(i => buildPrompt(i.spec));
    if (!items.length) return;
    setSession({ items, title: DRILL_META[kind].short });
  };

  const chip = (on, label, onClick) => (
    <button key={label} onClick={onClick} style={{
      fontSize: 11.5, fontWeight: 700, padding: '0 12px', borderRadius: 14, minHeight: 44,
      background: 'transparent', cursor: 'pointer',
      border: `1px solid ${on ? ACCENT : '#2a2840'}`, color: on ? ACCENT : '#999',
    }}>{label}</button>
  );

  return (
    <div style={pad}>
      <div style={card}>
        <div style={h}>Pick what to drill</div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>String</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {STRINGS.map((name, i) => chip(s === i, name, () => setS(i)))}
        </div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Frets</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {['low', 'neck', 'full'].map(k => chip(winKey === k, WINDOWS[k].label, () => setWinKey(k)))}
        </div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Notes</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {chip(naturals, 'naturals', () => setNaturals(true))}
          {chip(!naturals, 'all twelve', () => setNaturals(false))}
        </div>
      </div>

      <div style={card}>
        <div style={h}>Drill</div>
        {['find', 'name', 'extremal', 'findAll'].map(k => (
          <button key={k} onClick={() => run(k)} style={{ ...ghost, marginTop: 6, textAlign: 'left', paddingLeft: 12 }}>
            <span style={{ color: '#fff', fontWeight: 800 }}>{DRILL_META[k].label}</span>
            <span style={{ color: '#777', fontWeight: 400 }}> — {DRILL_META[k].blurb}</span>
          </button>
        ))}
      </div>

      <div style={{ ...card, borderColor: '#1a1928' }}>
        <div style={{ fontSize: 10.5, color: '#666', lineHeight: 1.7 }}>
          This picks the <b>material</b>, not the schedule. There is deliberately no
          blocked-vs-mixed switch: given the choice, everyone picks the comfortable
          one, and in the studies the learners who preferred blocked practice
          consistently learned less from it.
        </div>
      </div>
    </div>
  );
}

// ── Progress ─────────────────────────────────────────────────────────────
function ProgressTab({ pool, stage, srs, lat, settings }) {
  const byString = useMemo(() => breakdown(pool, srs, c => c.s), [pool, srs]);
  const byClass = useMemo(() => breakdown(pool, srs, c => (NATURAL_PCS.includes(c.pc) ? 'naturals' : 'accidentals')), [pool, srs]);
  const fc = useMemo(() => forecast(pool, srs), [pool, srs]);
  const weak = useMemo(() => byString.filter(b => b.seen >= WEAK_MIN_SEEN && b.acc !== null && b.acc < WEAK_ACC)
    .sort((a, b) => a.acc - b.acc), [byString]);

  const Row = ({ label, b }) => {
    const med = medianOf(pool.filter(c => (typeof b.key === 'number' ? c.s === b.key : true)).flatMap(c => lat[c.id] || []));
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', borderTop: '1px solid #1a1928' }}>
        <div style={{ width: 62, fontSize: 12, fontWeight: 700 }}>{label}</div>
        <div style={{ flex: 1, height: 8, background: '#1a1928', borderRadius: 4, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: `${(b.solid / b.total) * 100}%`, background: '#2ed573' }} />
          <div style={{ width: `${(b.learning / b.total) * 100}%`, background: '#74b9ff' }} />
        </div>
        <div style={{ fontSize: 10, color: '#888', width: 96, textAlign: 'right' }}>
          {b.acc === null ? 'untried' : `${Math.round(b.acc * 100)}%`}
          {med != null && ` · ${med.toFixed(1)}s`}
        </div>
      </div>
    );
  };

  return (
    <div style={pad}>
      <div style={card}>
        <div style={h}>By string</div>
        {byString.sort((a, b) => a.key - b.key).map(b => <Row key={b.key} label={`${STRINGS[b.key]} string`} b={b} />)}
        <div style={{ display: 'flex', gap: 12, fontSize: 10, marginTop: 9, paddingTop: 9, borderTop: '1px solid #1a1928' }}>
          <span style={{ color: '#2ed573' }}>● solid</span>
          <span style={{ color: '#74b9ff' }}>● started</span>
          <span style={{ color: '#666' }}>accuracy · median time</span>
        </div>
      </div>

      <div style={card}>
        <div style={h}>By note</div>
        {byClass.map(b => <Row key={b.key} label={b.key} b={b} />)}
      </div>

      {weak.length > 0 && (
        <div style={card}>
          <div style={h}>Weak spots</div>
          {weak.map(b => (
            <div key={b.key} style={{ fontSize: 12.5, fontWeight: 700, padding: '6px 0' }}>
              {STRINGS[b.key]} string
              <span style={{ color: '#888', fontWeight: 400, fontSize: 11 }}> — {b.seen - b.wrong} of {b.seen} right</span>
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: '#666', lineHeight: 1.6, marginTop: 6 }}>
            Counted once a string has at least {WEAK_MIN_SEEN} attempts. Fewer than that is noise.
          </div>
        </div>
      )}

      <div style={card}>
        <div style={h}>Coming up</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 56, marginBottom: 6 }}>
          {fc.buckets.map((n, i) => {
            const tallest = Math.max(1, ...fc.buckets);
            return (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ width: '100%', height: 44, display: 'flex', alignItems: 'flex-end' }}>
                  <div style={{ width: '100%', height: `${(n / tallest) * 100}%`, background: ACCENT, borderRadius: 2 }} />
                </div>
                <div style={{ fontSize: 9, color: '#666' }}>{i === 0 ? 'now' : `+${i}`}</div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: '#aaa', lineHeight: 1.7, paddingTop: 7, borderTop: '1px solid #1a1928' }}>
          {fc.dueToday ? `${fc.dueToday} due right now.`
            : fc.soonest === null ? 'Nothing scheduled yet.'
            : fc.soonest === 1 ? 'Next review tomorrow.' : `Next review in ${fc.soonest} days.`}
          {fc.newCount > 0 && ` ${fc.newCount} never tried.`}
        </div>
      </div>
    </div>
  );
}

// ── Learn ────────────────────────────────────────────────────────────────
function LearnTab({ settings }) {
  const [open, setOpen] = useState(0);
  const S = [
    { icon: '🎤', title: 'How this works, and what the mic can tell', body:
`Guitar in hand, always. The app names a note, you find it on the real neck and play it, and it listens. That is deliberate: the most common complaint about fretboard apps is that you get good at the app. "To find the note on my actual guitar I have to do something you haven't trained me for."

What the microphone can tell: the note, and the octave. Both exactly.

What it cannot tell: which string you played it on. This is not a limitation of the detector, it is arithmetic. In frets 0–12, 87% of positions sound a pitch that another string can also produce. C on the G string is C4 — which is equally A-15, D-10 and B-1. One pitch, four places.

So when a question says "on the G string", that part is on you. The app checks the note and the register, and a wrong register is the wrong part of the neck, which is the mistake people actually make.

The lowest/highest drills are the exception: they name one pitch, so those are graded outright.` },

    { icon: '🔤', title: 'The alphabet, and the two places it closes up', body:
`Seven letters, A to G, then round again. Between every pair there is a sharp/flat — except B→C and E→F, which are already only one fret apart.

On any string: consecutive naturals are two frets apart, except B→C and E→F, which are one.

That single rule plus one note you know generates the entire string. It is worth being able to say it without thinking, because everything else here is built on it.` },

    { icon: '📍', title: 'Anchors — and why they are scaffolding', body:
`Fret 12 is your open string an octave up. Everything above 12 repeats.

The markers at 3, 5, 7, 9 and 12 are navigation, not decoration. Learn the low E at those five and you can interpolate the rest.

The ±5 rule: the same note is five frets up on the next string down, five frets back on the next string up — except across G→B, where it is four.

Octave shapes: two strings over and two frets up, except when you cross the B string, where it is three.

All of these are genuinely useful and all of them are a computation. They are how you acquire coverage cheaply and how you repair a gap — they are not the destination. Anything computed is not instant, which is why a stage is only "solid" once you are fast, not just correct.` },

    { icon: '♯', title: 'Sharps, flats, and when the difference matters', body:
`F# and Gb are the same pitch. The name carries the function, not the sound.

With no key in the question there is no correct spelling, so this app accepts both. Calling Gb wrong on fret 2 of the low E would be marking a right answer wrong.

Spelling only becomes part of the answer when a key is named — "the 4th of C# major" is F#, and only F#. Which is also the real musical rule.

The display setting is just a display setting.` },

    { icon: '🪜', title: 'Why the stages are in this order', body:
`Naturals first. Seven notes instead of twelve, and the accidentals are then one fret from something you already own. Teachers are close to unanimous that they are the easy part once the naturals are solid.

Low E and A first, because that is where barre and CAGED roots live — E and G shapes root on the 6th, A and C on the 5th. And the high e is the low E two octaves up, so you get most of it free.

The B string gets its own late stage. Every pattern-based method breaks at the B string, because it is tuned a major third from G rather than a fourth. That is exactly why pattern-learners have a hole there.

Each stage is blocked while it is new, then joins the mixed pool permanently. Blocked first because beginners cannot exploit random practice; mixed afterwards because that is what makes it stick.` },
  ];
  return (
    <div style={pad}>
      {S.map((s, i) => (
        <div key={i} style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <button onClick={() => setOpen(open === i ? -1 : i)} style={{
            width: '100%', background: 'transparent', border: 'none', color: '#fff',
            padding: '13px 12px', fontSize: 13.5, fontWeight: 800, textAlign: 'left',
            cursor: 'pointer', display: 'flex', gap: 9, alignItems: 'center', minHeight: 48,
          }}>
            <span>{s.icon}</span><span style={{ flex: 1 }}>{s.title}</span>
            <span style={{ color: '#666' }}>{open === i ? '−' : '+'}</span>
          </button>
          {open === i && (
            <div style={{ padding: '0 12px 13px', fontSize: 12.5, color: '#bbb', lineHeight: 1.75, whiteSpace: 'pre-line' }}>
              {s.body}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────
function SettingsTab({ settings, setSettings, setSrs, setLat, setStageN, setPlaced }) {
  const [confirm, setConfirm] = useState(false);
  const set = p => setSettings(s => ({ ...s, ...p }));
  const opt = (on, label, onClick) => (
    <button key={label} onClick={onClick} style={{
      fontSize: 12, fontWeight: 700, padding: '0 13px', borderRadius: 9, minHeight: 44,
      background: 'transparent', cursor: 'pointer',
      border: `1px solid ${on ? ACCENT : '#2a2840'}`, color: on ? ACCENT : '#999',
    }}>{label}</button>
  );
  return (
    <div style={pad}>
      <div style={card}>
        <div style={h}>Accidentals</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          {opt(settings.spelling === 'sharp', 'Sharps (F♯)', () => set({ spelling: 'sharp' }))}
          {opt(settings.spelling === 'flat', 'Flats (G♭)', () => set({ spelling: 'flat' }))}
        </div>
        <div style={{ fontSize: 10.5, color: '#666', lineHeight: 1.6 }}>
          Display only. With no key in the question both names are correct, and both are accepted.
        </div>
      </div>

      <div style={card}>
        <div style={h}>Questions per session</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[8, 12, 20].map(n => opt(settings.sessionN === n, String(n), () => set({ sessionN: n })))}
        </div>
      </div>

      <div style={card}>
        <div style={h}>Microphone sensitivity</div>
        <input type="range" min="0.004" max="0.04" step="0.002" value={settings.sensitivity}
          onChange={e => set({ sensitivity: Number(e.target.value) })}
          style={{ width: '100%', accentColor: ACCENT }} />
        <div style={{ fontSize: 10.5, color: '#666', lineHeight: 1.6, marginTop: 4 }}>
          Lower if quiet playing is being missed; raise it if a noisy room triggers answers
          on its own. A clean amp tone detects far better than a driven one — distortion adds
          harmonics that pull the detector an octave off.
        </div>
      </div>

      <div style={card}>
        <div style={h}>Progress</div>
        <ProgressBackup toolKey={TOOL} prefix={PFX} />
        <button onClick={() => {
          if (!confirm) { setConfirm(true); return; }
          setSrs({}); setLat({}); setStageN(1); setPlaced(false);
          store.set(PFX + 'srs', {}); store.set(PFX + 'lat', {});
          store.set(PFX + 'stage', 1); store.set(PFX + 'placed', false);
          setConfirm(false);
        }} style={{ ...ghost, color: confirm ? '#ef4444' : '#aaa', borderColor: confirm ? '#ef444455' : '#2a2840' }}>
          {confirm ? 'Tap again to erase everything' : 'Reset progress'}
        </button>
      </div>
    </div>
  );
}
