/**
 * PitchEngine — real-time monophonic pitch detection for guitar.
 *
 * Uses the McLeod Pitch Method (MPM): the Normalised Square Difference
 * Function (NSDF) with parabolic peak interpolation. MPM is markedly more
 * stable than plain autocorrelation for plucked strings because it is
 * amplitude-independent and resists octave errors from strong harmonics.
 *
 * Reference: Philip McLeod & Geoff Wyvill, "A Smarter Way to Find Pitch" (2005).
 *
 * The engine is transport-only: it emits {frequency, clarity, rms} and never
 * touches the DOM, so it is unit-testable and reusable.
 */
class PitchEngine {
    constructor(opts = {}) {
        this.bufferSize = opts.bufferSize || 2048;
        this.minFreq = opts.minFreq || 70;     // below low-E (82 Hz) with margin
        this.maxFreq = opts.maxFreq || 1320;    // ~E6, covers high frets
        // Two-band gates: acoustic guitar's low strings (E2..A2) are quieter
        // through a laptop mic and their NSDF peak sits a hair lower than
        // shreddy high strings, so we relax the gates below B3. Numbers picked
        // to keep flute-like plate detection stable while catching thick lows.
        this.clarityThreshold = opts.clarityThreshold ?? 0.60; // was 0.68 (bright strings)
        this.clarityThresholdLow = opts.clarityThresholdLow ?? 0.48; // < ~200Hz
        this.rmsGate = opts.rmsGate ?? 0.006;                  // was 0.006
        this.rmsGateLow = opts.rmsGateLow ?? 0.003;            // low strings: half the noise floor
        this.lowFreqBoundary = opts.lowFreqBoundary ?? 200;    // Hz — G3 sits right above this
        this.smoothFrames = opts.smoothFrames ?? 3;    // was 5 (majority vote window) — cuts ~33ms latency
        this.releaseFrames = opts.releaseFrames ?? 6;  // hold note through pluck decay
        this.a4 = opts.a4 ?? 440;   // reference pitch; a calibrated guitar may sit off A440
        this.timbreGate = opts.timbreGate ?? true; // reject hiss/knocks (not a string)
        this.maxZcrRatio = opts.maxZcrRatio ?? 0.6;

        this.audioContext = null;
        this.analyser = null;
        this.stream = null;
        this.source = null;
        this.running = false;
        this._buf = new Float32Array(this.bufferSize);
        this._nsdf = new Float32Array(this.bufferSize);
        // Rolling ~1.2s history so an optional classifier (YAMNet) can inspect
        // a long window while pitch detection keeps using the short one.
        this._histLen = opts.historySamples || 0;   // set on start() from sampleRate
        this._hist = null;
        this._histWrite = 0;
        this._histFilled = 0;
        this.onPitch = null;      // (result) => void
        this._raf = null;
        this._recent = [];        // recent raw detections for stabilization
        this._held = null;        // last strong detection being held
        this._heldAge = 0;
    }

    /**
     * Apply a calibrated guitar profile's config block. Safe to call anytime;
     * only known numeric fields are copied and clamped to sane ranges.
     */
    configure(config = {}) {
        const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
        const set = (k, v, lo, hi) => { const n = num(v); if (n !== null) this[k] = Math.min(hi, Math.max(lo, n)); };
        set('a4', config.a4, 400, 480);
        set('rmsGate', config.rmsGate, 0.0005, 0.1);
        set('rmsGateLow', config.rmsGateLow, 0.0003, 0.1);
        set('clarityThreshold', config.clarityThreshold, 0.3, 0.9);
        set('clarityThresholdLow', config.clarityThresholdLow, 0.3, 0.9);
        set('minFreq', config.minFreq, 40, 400);
        set('maxFreq', config.maxFreq, 500, 2000);
        set('maxZcrRatio', config.maxZcrRatio, 0.2, 2.0);
        if (typeof config.timbreGate === 'boolean') this.timbreGate = config.timbreGate;
        return this;
    }

    async start() {
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        this.sampleRate = this.audioContext.sampleRate;
        this._histLen = Math.round(this.sampleRate * 1.2);
        this._hist = new Float32Array(this._histLen);
        this._histWrite = 0; this._histFilled = 0;
        this.source = this.audioContext.createMediaStreamSource(this.stream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = this.bufferSize * 2;
        this.analyser.smoothingTimeConstant = 0;
        this.source.connect(this.analyser);
        this.running = true;
        this._loop();
        return true;
    }

    /** Return the most recent `seconds` of audio as a contiguous Float32Array. */
    getRecentBuffer(seconds = 1.0) {
        if (!this._hist || this._histFilled === 0) return null;
        const H = this._histLen;
        const want = Math.min(this._histFilled, Math.round((this.sampleRate || 44100) * seconds));
        const out = new Float32Array(want);
        // history ends at _histWrite (exclusive); walk back `want` samples
        let idx = (this._histWrite - want + H) % H;
        for (let i = 0; i < want; i++) { out[i] = this._hist[idx]; idx = (idx + 1) % H; }
        return out;
    }

    stop() {
        this.running = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this.stream) this.stream.getTracks().forEach(t => t.stop());
        if (this.audioContext) this.audioContext.close();
        this.audioContext = null;
    }

    _loop() {
        if (!this.running) return;
        this.analyser.getFloatTimeDomainData(this._buf);
        // push into the rolling history ring
        if (this._hist) {
            const H = this._histLen;
            for (let i = 0; i < this._buf.length; i++) {
                this._hist[this._histWrite] = this._buf[i];
                this._histWrite = (this._histWrite + 1) % H;
            }
            this._histFilled = Math.min(H, this._histFilled + this._buf.length);
        }
        const raw = PitchEngine.detect(this._buf, this.sampleRate, {
            minFreq: this.minFreq, maxFreq: this.maxFreq,
            clarityThreshold: this.clarityThreshold, rmsGate: this.rmsGate,
            clarityThresholdLow: this.clarityThresholdLow, rmsGateLow: this.rmsGateLow,
            lowFreqBoundary: this.lowFreqBoundary, a4: this.a4,
            timbreGate: this.timbreGate, maxZcrRatio: this.maxZcrRatio,
            nsdf: this._nsdf,
        });
        const result = this._stabilize(raw);
        // The ScoreEngine detects plucks from a rising energy envelope, so it
        // needs the *current* frame's rms/clarity even when _stabilize is
        // holding a decaying note. Overwrite with the live values.
        if (result) { result.rms = raw.rms; result.clarityLive = raw.clarity; }
        if (this.onPitch) this.onPitch(result);
        this._raf = requestAnimationFrame(() => this._loop());
    }

    /**
     * Stabilize noisy per-frame detections into a steady note.
     * 1) majority-vote the midi over a short window (kills flicker/octave jumps)
     * 2) briefly HOLD the last strong note through a pluck's decay so a single
     *    strum keeps matching while its volume drops below the clarity gate.
     */
    _stabilize(raw) {
        const good = raw && raw.frequency > 0;
        this._recent.push(good ? raw.midi : null);
        if (this._recent.length > this.smoothFrames) this._recent.shift();

        if (good) {
            // majority midi in the window
            const counts = new Map();
            for (const m of this._recent) {
                if (m == null) continue;
                counts.set(m, (counts.get(m) || 0) + 1);
            }
            let bestMidi = raw.midi, bestN = 0;
            for (const [m, n] of counts) if (n > bestN) { bestN = n; bestMidi = m; }
            // if the window agrees on a different octave-stable note, report it
            const info = PitchEngine.freqToNote(
                bestMidi === raw.midi ? raw.frequency : this.a4 * Math.pow(2, (bestMidi - 69) / 12), this.a4);
            const stable = { ...raw, midi: bestMidi, note: info.note,
                             noteFull: info.noteFull, cents: bestMidi === raw.midi ? raw.cents : info.cents };
            this._held = stable;
            this._heldAge = 0;
            return stable;
        }

        // no fresh detection: hold the previous strong note briefly
        if (this._held && this._heldAge < this.releaseFrames) {
            this._heldAge++;
            return { ...this._held, held: true };
        }
        this._held = null;
        return raw || { frequency: -1, clarity: 0, rms: 0 };
    }

    /**
     * Pure detection (no audio graph) — testable in isolation.
     * Returns {frequency, note, midi, cents, clarity, rms} or {frequency:-1,...}.
     */
    static detect(buffer, sampleRate, opts = {}) {
        const minFreq = opts.minFreq || 70;
        const maxFreq = opts.maxFreq || 1320;
        const clarityThreshold = opts.clarityThreshold ?? 0.60;
        const clarityThresholdLow = opts.clarityThresholdLow ?? clarityThreshold * 0.8;
        const rmsGate = opts.rmsGate ?? 0.006;
        const rmsGateLow = opts.rmsGateLow ?? rmsGate * 0.5;
        const lowFreqBoundary = opts.lowFreqBoundary ?? 200;
        const a4 = opts.a4 ?? 440;
        // Timbre gate: tell a plucked STRING apart from hiss / fricatives /
        // key-clicks / broadband noise. We use the zero-crossing rate: a
        // periodic tone crosses ~2x per period, while hiss and 'ss/ff' sounds
        // cross far more often. (Broadband noise is already killed by the
        // clarity gate above; this catches the hissy-but-semi-periodic cases.)
        // Voiced vowels ("aah") are genuinely harmonic and CANNOT be separated
        // from a string by a single mic — that is a known physical limit.
        const timbreGate = opts.timbreGate ?? true;
        const maxZcrRatio = opts.maxZcrRatio ?? 0.6;   // allowed excess over ideal 2/period
        const N = buffer.length;

        // Remove DC / very-slow drift: subtract the mean so the autocorrelation
        // is centred. This markedly stabilises thick low strings on a mic.
        let mean = 0;
        for (let i = 0; i < N; i++) mean += buffer[i];
        mean /= N;

        let rms = 0;
        for (let i = 0; i < N; i++) { const v = buffer[i] - mean; rms += v * v; }
        rms = Math.sqrt(rms / N);
        // Use the low-band gate up-front (we don't know pitch yet); high-band
        // over-tightening is done post-hoc against the estimated frequency.
        if (rms < rmsGateLow) return { frequency: -1, clarity: 0, rms };

        const maxLag = Math.min(N - 1, Math.floor(sampleRate / minFreq));
        const minLag = Math.max(1, Math.floor(sampleRate / maxFreq));
        const nsdf = opts.nsdf && opts.nsdf.length >= maxLag + 1
            ? opts.nsdf : new Float32Array(maxLag + 1);

        // NSDF via the MPM definition: n(tau) = 2*r(tau) / m(tau)
        for (let tau = 0; tau <= maxLag; tau++) {
            let acf = 0, m = 0;
            for (let i = 0; i < N - tau; i++) {
                const a = buffer[i] - mean;
                const b = buffer[i + tau] - mean;
                acf += a * b;
                m += a * a + b * b;
            }
            nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
        }

        // Pick peaks: first positively-sloped zero crossing → local maxima.
        const peaks = [];
        let pos = false;
        let curMaxIdx = -1;
        for (let tau = minLag; tau <= maxLag; tau++) {
            if (nsdf[tau] > 0 && nsdf[tau - 1] <= 0) { pos = true; curMaxIdx = tau; }
            else if (nsdf[tau] <= 0 && nsdf[tau - 1] > 0) {
                if (curMaxIdx >= 0) peaks.push(curMaxIdx);
                pos = false; curMaxIdx = -1;
            }
            if (pos && curMaxIdx >= 0 && nsdf[tau] > nsdf[curMaxIdx]) curMaxIdx = tau;
        }
        if (pos && curMaxIdx >= 0) peaks.push(curMaxIdx);
        if (peaks.length === 0) return { frequency: -1, clarity: 0, rms };

        // Highest peak amplitude → threshold at k * that → first peak above it.
        let maxVal = 0;
        for (const p of peaks) if (nsdf[p] > maxVal) maxVal = nsdf[p];
        const k = 0.85;
        let chosen = peaks[0];
        for (const p of peaks) { if (nsdf[p] >= k * maxVal) { chosen = p; break; } }

        // Parabolic interpolation around the chosen lag for sub-sample accuracy.
        const x0 = chosen > 0 ? chosen - 1 : chosen;
        const x2 = chosen < maxLag ? chosen + 1 : chosen;
        const y0 = nsdf[x0], y1 = nsdf[chosen], y2 = nsdf[x2];
        const denom = (y0 - 2 * y1 + y2);
        const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
        const trueLag = chosen + (Math.abs(shift) < 1 ? shift : 0);
        const clarity = y1;

        const frequency = sampleRate / trueLag;
        if (frequency < minFreq || frequency > maxFreq) return { frequency: -1, clarity, rms };
        // Band-aware clarity + rms gate: thick low strings pass a looser bar,
        // bright high strings must still be crisp to avoid octave errors.
        const isLow = frequency < lowFreqBoundary;
        const clarityBar = isLow ? clarityThresholdLow : clarityThreshold;
        const rmsBar = isLow ? rmsGateLow : rmsGate;
        if (clarity < clarityBar || rms < rmsBar) return { frequency: -1, clarity, rms };

        // ── Timbre gate: reject hissy / broadband sounds via zero-crossings.
        // For a periodic tone at `frequency`, the ideal count is ~2 crossings
        // per period. Hiss, fricatives and key-clicks cross far more often, so
        // a large excess over the ideal means "this is not a plucked string".
        let zcrRatio = 0;
        if (timbreGate) {
            let zc = 0;
            let prev = buffer[0] - mean;
            for (let i = 1; i < N; i++) {
                const v = buffer[i] - mean;
                if ((v >= 0) !== (prev >= 0)) zc++;
                prev = v;
            }
            const expectedZc = 2 * frequency * (N / sampleRate);   // 2 per period
            zcrRatio = expectedZc > 0 ? zc / (expectedZc + 1e-9) : 999;
            // Only reject a genuine EXCESS (ratio well above 1), so clean tones
            // with tiny counting jitter always pass.
            if (zcrRatio > (1 + maxZcrRatio)) {
                return { frequency: -1, clarity, rms, zcrRatio, rejected: 'hiss' };
            }
        }

        const info = PitchEngine.freqToNote(frequency, a4);
        return { frequency, clarity, rms, zcrRatio, ...info };
    }

    /** frequency → {note, midi, cents} using a configurable reference A4 (default 440). */
    static freqToNote(freq, a4 = 440) {
        const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const midiFloat = 69 + 12 * Math.log2(freq / a4);
        const midi = Math.round(midiFloat);
        const cents = Math.round((midiFloat - midi) * 100);
        const name = NAMES[((midi % 12) + 12) % 12];
        const octave = Math.floor(midi / 12) - 1;
        return { note: name, noteFull: name + octave, midi, cents };
    }

    /** note name (e.g. "E2", "A#3") → midi number. */
    static noteToMidi(noteFull) {
        const NAMES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
        const m = /^([A-G]#?)(-?\d+)$/.exec(noteFull);
        if (!m) return null;
        return NAMES[m[1]] + (parseInt(m[2], 10) + 1) * 12;
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { PitchEngine };
if (typeof window !== 'undefined') window.PitchEngine = PitchEngine;
