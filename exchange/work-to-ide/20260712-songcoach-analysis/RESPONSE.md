# ChatGPT Work response — Songcoach audio recognition + note UI

Status: completed static analysis; no microphone/runtime test performed (per request).

## Executive recommendation

Do not start with full polyphonic pitch detection. First stabilize monophonic recognition and separate audio scheduling from UI rendering. The highest-value first slice is:

1. diagnostics and fixtures;
2. display `noteFull` (E2/A2 rather than only E/A);
3. deduplicate meter DOM updates;
4. add an independent live-note fretboard layer;
5. replace frame-count release with time-based hysteresis;
6. then improve octave candidate selection and smooth YAMNet.

## Evidence

- `files/js/pitch.js:14-31`: two-band gates, `smoothFrames=3`, `releaseFrames=6`.
- `files/js/pitch.js:124-138`: detector work is scheduled from RAF.
- `files/js/pitch.js:142-177`: stabilization is exact-MIDI majority vote plus fixed frame hold.
- `files/js/pitch.js:187-297`: O(N×maxLag) NSDF and one selected peak using the first peak above `0.85 * maxVal`.
- `files/js/yamnet.js:116-160`: ~0.975s window, inference every 300ms, positive hold 350ms, max class-score comparison.
- `files/js/app.js:180-208`: a second RAF loop gates scoring and renders the trainer.
- `files/js/app.js:221-235`: meter writes DOM every RAF and displays `det.note`, not `det.noteFull`.
- `files/js/fretboard.js:156-197`: target/chord annotations exist, but no independent live detected-note state.
- `files/js/theory.js:45-65`: pitch-class lookup rebuilds the full neck each call.
- `files/js/calibration.js:45-114`: gates use global RMS percentiles/median clarity; smoothing and release are not calibrated.

## Recognition

### 1. Instrument before retuning

Add debug-only diagnostics to `PitchEngine.detect`: selected lag, top candidate lags/frequencies, peak salience, ZCR ratio, low/high band and reject reason. Count octave jumps, low-string accepts/rejects, held frames, reject reasons, and YAMNet fresh/held decisions. This is necessary before changing `clarityThreshold`, `rmsGate`, `smoothFrames`, or `releaseFrames`.

### 2. Candidate-based octave correction

The current first-peak-above-threshold rule can choose a harmonic/subharmonic on weak E2/A2. Keep the top 3–5 NSDF candidates, then score each by:

- NSDF salience;
- continuity against previous stable MIDI;
- harmonic support at 2x/3x;
- low-frequency prior near E2/A2.

Only accept an octave correction when harmonic support and continuity justify it. Keep the existing transport result shape; expose diagnostics optionally.

### 3. Separate DSP cadence from UI RAF

There are two RAF loops. Keep RAF for presentation, sample/analyse audio at a fixed 20–30 Hz cadence, and publish the latest immutable result. If profiling still shows load, move scheduling/processing to an AudioWorklet or Worker while preserving pure `PitchEngine.detect` for tests.

### 4. Use time-based hysteresis

`releaseFrames=6` changes duration with callback cadence. Use `attackMs`, `releaseMs`, and a note-switch tolerance instead; preserve `held:true` so Trainer can distinguish onset from decay.

### 5. Smooth YAMNet

Use EMA guitar/voice scores and separate on/off margins. Expose `loading | guitar | uncertain | voice | unavailable`. Keep YAMNet as a confidence multiplier, not the pitch detector. If the user explicitly enables the gate and inference fails, show unavailable and stop scoring until disabled; do not silently turn an active failed gate into an allow verdict.

### 6. Polyphonic decision

Defer full polyphonic detection in `PitchEngine`. A later chord experiment should be separate: onset window (50–120ms), FFT magnitude, harmonic-product/chroma evidence, then compare pitch classes with `theory.js` chord templates. It costs CPU and adds latency; it should be feature-flagged.

## UI

### 1. Show full note

At `app.js:229`, use:

```js
els.pitchNote.textContent = det.noteFull || det.note;
```

A learner must distinguish E2 from E3.

### 2. Add live fretboard state

Do not reuse `setTargets()`; it resets target/chord annotations. Add `setLivePitch({midi, cents, held})` and `clearLivePitch()`. Keep `_targets`, `_chord`, and `_live` separate. Highlight exact MIDI matches with `is-live`; optionally use a faint pitch-class state when octave confidence is low. Cache a MIDI index rather than rebuilding the neck every update.

### 3. Remove per-frame DOM churn

Track rendered note validity, noteFull and a cents bucket. Update the DOM only when one changes. Use CSS state classes for tuned/sharp/flat instead of writing inline color every RAF.

### 4. Add note history

Record only stable transitions or fresh-onset events, debounce 60–100ms, retain 6–8 notes, and display noteFull + cents + optional duration. Keep target highlight, live detected highlight, wrong-note state and discrete `flashHit()` separate.

## Suggested order

`diagnostics/fixtures → full-note display → render deduplication → live fretboard/history → time hysteresis → octave candidates → YAMNet smoothing → CPU profile → chord/chroma experiment`.

## Verification for Codex

Use synthetic E2/A2, octave, and detuned signals; recorded low-string/decay/chord clips; voice, hiss, knock, fan and room-noise fixtures. Add unit tests for candidate selection, hysteresis, YAMNet smoothing and exact-MIDI highlighting. Browser-test no flicker, E2/E3 display, target/live coexistence, keyboard focus and bounded history. Measure CPU/frame time before and after scheduler changes.

No patch is included because this handoff requested analysis and recommendations; the first implementation slice should be approved after Codex reviews the tradeoffs.
