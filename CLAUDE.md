# Note Trainer — project context

A React PWA that teaches **where the notes are on the fretboard**, played rather
than tapped. The ninth tool in the **Fretworks** toolbox (sibling to Chord
Trainer, Focused Chord Trainer, Triad Trainer, Circle of Fifths, Diatonic Chord
Trainer, Melodic Minor Trainer, Altered Scale Trainer). Single dev + end user: Zak.

Every other tool in the toolbox teaches **shapes** — chord grips, CAGED
positions, triad inversions, scale boxes. A shape is a way of navigating the neck
*without* knowing the notes on it. This tool closes that gap.

- Toolbox-wide conventions (git-dep workflow, multi-zone, single PWA,
  verify-in-prod, naming): the Fretworks root `CLAUDE.md`.

## The guitar is always in your hands

This is the central design decision and everything follows from it. The app names
a note, you find it on the **real neck** and play it, and the microphone grades
it. There is no screen-only mode.

The reason is the most damning review in this whole app category, on a rival:

> "I want to find the notes on my guitar, which, like every other guitar, does
> not have numbers on the fretboard. It makes it too easy to totally ignore the
> fretboard and just paint-by-number. Then to find the note on my actual guitar I
> have to do something you haven't trained me for."

Transfer-appropriate processing says the same thing formally: practise the
operation the real task demands. The real operation is *hear a note name → put a
finger on it*. Tapping a diagram is a different skill.

**Consequence worth knowing:** the most-praised use case in the review corpus is
practising *without* a guitar — at a bus stop, in a queue. A tap-to-answer mode
is deliberately **not built**, and is the first thing to reconsider if the app
goes unused. The drill engine would be shared; only the answer step differs.

## What the microphone can and cannot tell — do not "fix" this

**It grades note and octave, exactly. It cannot tell which string you played.**

This is arithmetic, not a detector limitation. In frets 0–12, **68 of 78
positions (87%)** sound a pitch that another string can also produce; over 0–15
it is 90%. `C on the G string` is C4 — equally A-15, D-10 and B-1.

So a string constraint is an instruction the player **honours**; the app checks
the note and the register. A wrong register *is* the wrong part of the neck,
which is the error people actually make. `verify.mjs` pins those percentages so
the honesty note in the Learn tab cannot drift from the truth.

Two invariants fall out, both asserted:

- **Where several positions sound the same accepted pitch, all are correct.** The
  lowest C is C3 at *both* E-8 and A-3. Marking either wrong marks a right answer
  wrong. `acceptedPositions()` returns all of them and the reveal shows all of them.
- **No sequence drill may ask for the same pitch twice.** Sounding one target
  would clear both — a shipped bug in a competing app. Impossible here by
  construction, asserted across every note and window.

**The partial exception.** `extremal` and `nearest` ask for a *pitch*, not a
pitch class, so the mic grades them outright. This was nearly overclaimed: a
*per-string* extremal does **not** disambiguate the string — 66 of 72 (92%) are
still reachable elsewhere. There is a test asserting that stays false.

## Two escape hatches for a flaky room

Both are settings, both off the critical path, and both exist because the
detector is the least reliable part of the app.

- **`ignoreWrong`** — anything that is not the answer is treated as a
  mis-detection: keep listening, do not stop the question, **do not grade it**.
  The card is only marked wrong if you tap Missed. Deliberately this swallows
  *genuine* mistakes too, including the right note in the wrong octave — Zak
  chose that explicitly. It is a workaround for a noisy room, not a grading
  model, so it is **off by default**; leaving it on makes accuracy optimistic.
  The heard note is still displayed ("Heard D♯3 — not it, still listening") so
  an ignored note never looks like a dead microphone.
- **`autoAdvance`** — a correct answer shows a tick and the time, then moves on
  after `ADVANCE_MS` without a tap. **On by default**: the whole point of the
  mic is not touching the screen, and tapping Next after every right answer
  undoes that. A *wrong* answer still waits for you, which is the point — that
  pause is when you look at where the note actually was.

  It lives in `commit()`, not in the mic listener, so it covers the self-graded
  path too. The timer is a ref and is cleared on unmount and on every answer, or
  it fires into a stale question.

**Sensitivity is an RMS threshold, so SMALLER is more sensitive.** The floor is
`MIN_SENS = 0.0005` — far below anything a clean amped signal needs, because a
quiet unplugged electric or a phone that is not next to the amp sits under
0.002. The slider maps on a square curve so the useful low end gets most of the
travel instead of being squeezed into the first few pixels.

## What the reveal draws

Two ring styles, and the distinction is load-bearing:

- **Solid** = the answer **to the question as asked**. When the prompt named a
  string, this is restricted to that string. Showing "G on the A string" as four
  rings across four strings answers a question nobody asked and buries the one
  that was.
- **Dashed** = the same *note* elsewhere in the window, on other strings.
  Context, never an answer.

`revealFor(prompt, lo, hi)` does the split, and `verify.mjs` asserts that the two
sets together are exactly every instance of that note in the window — nothing
duplicated, nothing silently dropped.

**The board is informational, not interactive.** The mic grades, so nothing is
tapped on it, which frees it from the 44px row minimum that used to size it. It
renders at `rowH={20}` capped to 168px — down from ~370px, which was pushing the
Next button off screen.

## Grading is three-way

`VERDICT.OK` / `OCTAVE` / `WRONG`. The middle one is not decoration: "right note,
wrong octave" is the most informative near-miss there is — you know the note and
not where it lives. Collapsing it into a plain miss throws that away.

**The correct answer is always shown after a miss.** Below roughly 50% retrieval
success there is no testing effect *without* feedback; an uncorrected miss is a
wasted repetition.

## The card is (string, note)

`cardId(s, pc)` → `"3|0"`. **72 cards.** The fret is not part of the card — it is
the answer. Register and fret window are per-rep variables, exactly as key is in
Triad and Altered Trainer. This is the toolbox's rule that the unit of mastery is
the thing you either know or don't.

## The ladder — block to acquire, interleave to keep

`src/ladder.js`. Nine stages. The ordering is what the teaching corpus agrees on
almost unanimously:

- **Naturals before accidentals.** 12→7, and accidentals are then ±1 from
  something you own. Teachers are near-unanimous that they are the easy part once
  naturals are solid — so **a long accidentals plateau would be this app's fault,
  not the material's.** Don't manufacture one by drilling naturals because the
  accuracy numbers look good.
- **Low E and A first.** Barre/CAGED roots live there; E and G shapes root on the
  6th, A and C on the 5th. And high e is low E two octaves up.
- **The B string gets its own late stage.** Every pattern-based method breaks at
  the major-third tuning kink, which is exactly why pattern-learners have a hole there.

A stage is **blocked** while it is new and joins the **interleaved** pool
permanently once acquired. Not a compromise — novices demonstrably cannot exploit
random practice, while interleaving wins on retention once material is in.

**There is deliberately no blocked-vs-mixed switch in the UI.** Learners
consistently *prefer* the schedule that teaches them less. The Drills tab picks
material, never schedule.

## Two gates per stage, and why speed is one of them

**Accuracy advances you. Speed is a separate badge and never blocks progress.**

Latency is the only honest mastery criterion here. The relative tricks — octave
shapes, the ±5 rule, marker interpolation — are real and useful, but they are
*computations*, and anything computed is not instant. Score only correctness and
you can octave-compute your way to 100% forever without ever becoming fluent.
"Under 2.5s, 9 times in 12" distinguishes recall from arithmetic; "90% correct"
does not.

Targets widen with the search space because time-to-play includes moving the
hand: one string 2.5s → all six 4.0s, accidentals +0.5s. Latency is recorded
**silently on every rep from stage one**, so the target has a real baseline.

Speed is per stage, not a terminal level: speed work improves retrieval for facts
*already recalled* — it does not install them — so it belongs right after each
stage's accuracy gate, not banked to the end.

## Spaced repetition, with one deviation

SM-2 copied **verbatim** from `triads-trainer/src/TriadTrainer.jsx:32-46`,
byte-identical to the copies in Altered, Diatonic, Chord and Focused Chord. A fix
in one is meant to be carried to all.

**The deviation:** spacing is strongly evidenced for facts but **null for motor
sequence learning** (piano study, replicated). This task is a hybrid — the
association "G string fret 5 is C" is a paired associate and schedules normally;
the *reach* is motor and does not. So the **schedule** spaces the facts and the
**session** supplies motor volume through within-session repetition. Don't assume
an interval that keeps the name alive keeps the hand fluent.

`seen`/`wrong` are written on every grade. **Never back-fill them** from reps/ef —
a guess dressed as a measurement is worse than a number that is briefly optimistic.

## Enharmonics

- **Both spellings are always accepted** when no key is given. A context-free
  question has no key, so it has no correct spelling; marking G♭ wrong at fret 2
  of the low E would be marking a right answer wrong.
- Sharps are the display default; `settings.spelling` is **display only**.
- Never print "F♯/G♭" together — it doubles the perceived item count.
- **Spelling becomes part of the answer only when the question supplies a key.**
  Not yet built; doing it properly needs B♯, C♭, E♯, F♭ and double accidentals,
  which is a feature, not a flag.

## Pitch detection (`src/pitch.js`)

Every choice is a documented failure mode of something else:

- **Not FFT.** At standard `fftSize` the bin width is ~23 Hz and low E is
  82.41 Hz — the transform genuinely cannot separate it from its neighbours.
  Time-domain **MPM** over a normalised square-difference function, ~4096 samples.
- **Search range clamped to the instrument** (70–1350 Hz). Reported repeatedly as
  the single change that removes most octave errors.
- **`echoCancellation`, `noiseSuppression`, `autoGainControl` are all `false`.**
  They default to `true`, assume "human voice making words", and actively gate
  sustained tones. Highest-value line in the file.
- **Onset gating + N stable frames + a decay gate between reps.** Repeated
  identical notes are a named detection failure in *every* competing app, because
  the previous note's ring-out masks the next attack.
- **Read `ctx.sampleRate`.** iOS has historically pinned 44100 regardless of device.

`verify.mjs` tests the detector against synthesised tones including an
**adversarial electric profile where the fundamental is quieter than the 2nd and
3rd harmonics** — which is what a pickup actually produces and what makes naive
autocorrelation report an octave too high. All 96 positions, both sample rates,
under noise.

**Zak plays electric through an amp.** A clean tone detects far better than a
driven one; distortion adds harmonics that pull the detector off. The sensitivity
control and the always-visible input meter exist so it is never ambiguous whether
the app is deaf or the answer is wrong.

## iOS PWA traps (all live)

- `getUserMedia` in standalone mode works — WebKit bug 185448 was fixed in iOS
  13.4. AudioWorklet since 14.5.
- **Permission is revoked on hash change → never use hash routing.**
- **A real user gesture is required, and the getUserMedia grant does not count.**
  One explicit "Start listening" tap resumes the context *and* requests the mic.
- **Turning the mic on force-routes output to the phone speaker** — headphone
  playback breaks, and the speaker feeds back into the detector.
- **Backgrounding kills the stream** — handled via `visibilitychange`.
- Avoid `MediaRecorder` (breaks on second launch in standalone). We never record.

## Fretboard (`src/Fretboard.jsx`)

Sideways neck view, ported from `altered-trainer`. **Low E at the BOTTOM**,
string-line weight tapering thick→thin. Row 0 draws at the top so dots use
`cy = ry(5 - s)` — and labels must render `STRINGS[r]`, **never** `STRINGS[5-r]`,
or the letters invert relative to the dots (MelodicMinorTrainer has that bug).

- **The tap grid is the last child of the `<svg>`.** SVG has no z-index, so paint
  order decides hit-testing, and every tappable node carries an inline `cursor`.
- **Nothing is drawn during a question.** A rival's reviewer caught themselves
  "using the pattern now instead of learning the notes"; anything persistent invites it.

## Storage

Prefix **`nt_`**, load-bearing: `ProgressBackup` sweeps by prefix, so one backup
carries everything. Keys: `nt_srs`, `nt_lat`, `nt_stage`, `nt_settings`, `nt_placed`.

**Write every value as JSON.** `importProgress` always `JSON.stringify`s, so a
bare string round-trips back wrapped in quotes — this cost Altered Trainer its
`at_label`. Every persist effect is gated on a `loaded` ref, or the defaults
overwrite real progress before the load finishes.

## Fretworks integration

Vite `base: '/notes/'`, served as a Vercel zone. Registry key `notes`, accent
**orange `#fb923c`**, emoji 📍, path `/notes/`, placed **before Diatonic** in
`TOOLS` and `LEARNING_PATH`.

`@fretworks/design` is a git dep **pinned to an exact commit** in the lockfile and
Vercel builds from the lockfile — a design change is invisible until each consumer
repins. It fails quietly: build passes, feature absent. Verify with
`grep -c 'Note Trainer' node_modules/@fretworks/design/dist/index.js` → `1`.

This is the **first trainer to import `OPEN_MIDI` from `@fretworks/design`**
rather than redeclaring it, which the package has always asked for.

⚠️ **Still outstanding for this tool:** the shell's two `vercel.json` rewrites,
`notes` in `public/sw.js`'s `ZONE_RE`, a `CACHE` bump, `public/shots/notes.webp`,
and repinning the other consumers. Until the rewrites land, `/notes` falls through
to the shell's brochure — a click-loop.

## Before shipping any change

- `npm run verify` must pass — 3054 assertions, the correctness gate for the
  fretboard maths, the answer sets, the ambiguity numbers and the detector.
- `npm run build` must pass.
- Browser at **393px**.
- **A real session with the amp on.** Detection latency, repeated notes, and
  whether a driven tone breaks the detector are the things no headless run can judge.
