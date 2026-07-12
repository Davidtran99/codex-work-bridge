/**
 * calibration.js — "Guitar Profile" calibration.
 *
 * Records ~15s of the player's guitar through the mic, then derives a profile
 * that makes the monophonic detector honest for THIS guitar + mic + room:
 *
 *   • noiseFloorRms   — RMS of the quiet gaps between plucks (the real room floor)
 *   • signalRms       — median RMS of the loud (plucked) frames
 *   • medianClarity   — how periodic/clean this guitar reads (sets clarity gate)
 *   • a4Hz            — reference pitch derived from the player's tuning so the
 *                       whole app follows a slightly flat/sharp instrument
 *   • tuningOffsetCents — how far off A440 the guitar sits (info + a4Hz)
 *   • freqMinHz/freqMaxHz — observed pitch span (+margin) to bound the search
 *   • rmsGate/rmsGateLow/clarityThreshold/clarityThresholdLow — derived gates
 *
 * The heavy analysis is a pure function (analyzeFrames) so it is unit-testable
 * without a mic. The recorder is a thin Web-Audio wrapper around PitchEngine.
 */

// ── pure helpers ─────────────────────────────────────────────────────
function _median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _percentile(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[idx];
}
/** cents of a frequency relative to the nearest equal-tempered semitone (A440). */
function _centsFromNearestSemitone(freq, a4 = 440) {
    const midiFloat = 69 + 12 * Math.log2(freq / a4);
    return (midiFloat - Math.round(midiFloat)) * 100;
}

/**
 * Analyze recorded per-frame detections into a guitar profile.
 * @param {Array} frames [{rms, clarity, frequency}] (frequency<=0 when unvoiced)
 * @param {object} opts { sampleRate }
 * @returns {object} profile
 */
function analyzeFrames(frames, opts = {}) {
    if (!Array.isArray(frames) || frames.length < 10) {
        throw new Error('need at least 10 frames to calibrate');
    }
    const rmsAll = frames.map(f => f.rms || 0);
    const maxRms = Math.max(...rmsAll);
    if (maxRms <= 0) throw new Error('no signal recorded — check the mic');

    // Voiced = frames with a real pitch AND meaningful energy (loud enough to be
    // a pluck, not the room). Threshold relative to this session's own peak.
    const loudCut = Math.max(0.02 * maxRms, _percentile(rmsAll, 55));
    const voiced = frames.filter(f => f.frequency > 0 && f.rms >= loudCut);
    const quiet = frames.filter(f => f.rms < loudCut);

    if (voiced.length < 5) throw new Error('too few plucked notes detected — play single notes across the strings');

    // Noise floor = the genuinely quiet tail of the recording. A plucked note
    // decays for a long time, so "any frame below the loud cut" wrongly counts
    // decaying notes as silence. Instead take a LOW percentile of *all* RMS —
    // the real room floor lives in the quietest ~15% of frames.
    const noiseFloorRms = Math.max(_percentile(rmsAll, 15), 1e-4);
    const signalRms = _median(voiced.map(f => f.rms));
    const medianClarity = _median(voiced.map(f => f.clarity || 0));

    // Tuning: for each voiced frame, cents from the nearest semitone. The MODE
    // of that (via median of a tight cluster) is the guitar's global offset.
    const centsList = voiced
        .map(f => _centsFromNearestSemitone(f.frequency, 440))
        // ignore frames that are basically between two semitones (bends/noise)
        .filter(c => Math.abs(c) < 45);
    const tuningOffsetCents = centsList.length ? _median(centsList) : 0;
    const a4Hz = 440 * Math.pow(2, tuningOffsetCents / 1200);

    // Observed pitch span with a musical margin (a semitone below/above).
    const freqs = voiced.map(f => f.frequency).sort((a, b) => a - b);
    const fLo = _percentile(freqs, 3);
    const fHi = _percentile(freqs, 97);
    // A 6-string guitar in standard tuning spans low-E (E2 ≈ 82 Hz) up to the
    // high frets (well past E5 ≈ 660 Hz). Calibration must NEVER shrink the
    // search band below this — if the player only strummed a few low strings
    // during the 15s clip, we still keep the full neck detectable. We only ever
    // WIDEN the band when the player actually played beyond the standard range.
    const GUITAR_MIN_HZ = 78;    // a hair below E2, covers a slightly flat low-E
    const GUITAR_MAX_HZ = 700;   // ~E5/F5, high frets on the high-e string
    const freqMinHz = Math.min(GUITAR_MIN_HZ, Math.max(60, fLo * Math.pow(2, -2 / 12)));
    const freqMaxHz = Math.max(GUITAR_MAX_HZ, Math.min(1600, fHi * Math.pow(2, 3 / 12)));

    // Derived gates. The single most important rule: the RMS gate must sit a
    // clear margin ABOVE the measured room noise floor, or quiet room sounds
    // (fan, mains hum, distant voices) trip the detector when you are NOT
    // playing. We floor BOTH gates at a safe multiple of the noise floor and
    // only then consider the signal level.
    const NOISE_MARGIN = 4.0;      // gate must beat the floor by this factor
    const NOISE_MARGIN_LOW = 3.0;  // low strings: a touch looser, still safe
    const rmsGate = Math.max(
        noiseFloorRms * NOISE_MARGIN,        // safety above the room
        Math.min(signalRms * 0.30, 0.012),   // but below real playing
        0.006                                // absolute floor
    );
    // Low-string gate: quieter than high strings, but still a firm margin over
    // the noise floor so silence never reads as a note.
    const rmsGateLow = Math.max(
        noiseFloorRms * NOISE_MARGIN_LOW,
        rmsGate * 0.7,
        0.004
    );
    // Clarity: a plucked note is very periodic; keep the bar reasonably high so
    // semi-periodic room noise doesn't pass. Never go below 0.55.
    const clarityThreshold = Math.min(0.75, Math.max(0.55, medianClarity - 0.08));
    const clarityThresholdLow = Math.max(0.45, clarityThreshold - 0.12);

    const snrDb = noiseFloorRms > 0 ? 20 * Math.log10(signalRms / noiseFloorRms) : 40;

    return {
        version: 1,
        createdAt: new Date().toISOString(),
        sampleRate: opts.sampleRate || null,
        framesAnalyzed: frames.length,
        voicedFrames: voiced.length,
        // measured
        noiseFloorRms: +noiseFloorRms.toFixed(5),
        signalRms: +signalRms.toFixed(5),
        snrDb: +snrDb.toFixed(1),
        medianClarity: +medianClarity.toFixed(3),
        tuningOffsetCents: +tuningOffsetCents.toFixed(1),
        a4Hz: +a4Hz.toFixed(2),
        observedFreqMinHz: +fLo.toFixed(1),
        observedFreqMaxHz: +fHi.toFixed(1),
        // derived config the detector consumes
        config: {
            a4: +a4Hz.toFixed(2),
            rmsGate: +rmsGate.toFixed(5),
            rmsGateLow: +rmsGateLow.toFixed(5),
            clarityThreshold: +clarityThreshold.toFixed(3),
            clarityThresholdLow: +clarityThresholdLow.toFixed(3),
            minFreq: +freqMinHz.toFixed(1),
            maxFreq: +freqMaxHz.toFixed(1),
        },
    };
}

/** A human-facing quality grade for the recording. */
function gradeProfile(p) {
    if (p.snrDb >= 25 && p.voicedFrames >= 60) return { grade: 'excellent', label: 'Rất tốt' };
    if (p.snrDb >= 15 && p.voicedFrames >= 30) return { grade: 'good', label: 'Tốt' };
    if (p.snrDb >= 8) return { grade: 'fair', label: 'Tạm được' };
    return { grade: 'poor', label: 'Nhiễu nhiều — thử lại nơi yên tĩnh hơn' };
}

/**
 * CalibrationRecorder — captures ~durationSec of frames from a PitchEngine.
 * It does not own the mic graph; the app feeds it detections (so mic access
 * stays in one place), OR it can drive a PitchEngine directly via attach().
 */
class CalibrationRecorder {
    constructor(opts = {}) {
        this.durationSec = opts.durationSec ?? 15;
        this.frames = [];
        this.recording = false;
        this._startT = 0;
        this.onTick = null;    // (elapsedSec, lastDet) => void
        this.onDone = null;    // (profile, grade) => void
        this.sampleRate = opts.sampleRate || null;
    }

    start() {
        this.frames = [];
        this.recording = true;
        this._startT = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    }

    /** Feed one detection per animation frame while recording. */
    push(det) {
        if (!this.recording) return;
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const elapsed = (now - this._startT) / 1000;
        if (det) this.frames.push({ rms: det.rms || 0, clarity: det.clarityLive ?? det.clarity ?? 0, frequency: det.frequency || -1 });
        if (this.onTick) this.onTick(Math.min(elapsed, this.durationSec), det);
        if (elapsed >= this.durationSec) this.finish();
    }

    cancel() { this.recording = false; this.frames = []; }

    finish() {
        if (!this.recording) return null;
        this.recording = false;
        let profile, grade;
        try {
            profile = analyzeFrames(this.frames, { sampleRate: this.sampleRate });
            grade = gradeProfile(profile);
        } catch (e) {
            if (this.onDone) this.onDone(null, null, e);
            return null;
        }
        if (this.onDone) this.onDone(profile, grade, null);
        return profile;
    }
}

const Calibration = { analyzeFrames, gradeProfile, CalibrationRecorder };
if (typeof window !== 'undefined') { window.Calibration = Calibration; window.CalibrationRecorder = CalibrationRecorder; }
if (typeof module !== 'undefined' && module.exports) module.exports = Calibration;
