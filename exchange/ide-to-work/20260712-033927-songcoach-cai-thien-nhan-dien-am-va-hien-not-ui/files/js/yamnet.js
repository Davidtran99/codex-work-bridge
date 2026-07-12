/**
 * yamnet.js — optional acoustic gate that tells GUITAR apart from voice/noise.
 *
 * The MPM pitch engine + ZCR gate already reject hiss and broadband noise, but
 * they cannot distinguish a sung/spoken vowel (which is harmonic, like a
 * string) from a real guitar note. YAMNet — Google's 521-class audio event
 * classifier — can: it recognises "Guitar / Plucked string / Musical
 * instrument" separately from "Speech / Singing / Conversation".
 *
 * This wrapper is OPTIONAL and lazy: nothing is downloaded until enable() is
 * called. It runs YAMNet a few times per second on the shared mic buffer and
 * exposes a rolling verdict (isGuitar / guitarScore / voiceScore) that the app
 * uses to gate scoring. If TF.js or the model fail to load, it degrades to a
 * no-op that always says "allow" so the app never breaks.
 *
 * Model files are vendored under /static/vendor/yamnet so it works offline.
 */

// Class indices from yamnet_class_map.csv (grouped).
// Guitar-specific classes: the strongest positive evidence.
const GUITAR_CLASSES = [136, 137, 138, 139, 140, 141]; // plucked string, guitar, e-guitar, bass, acoustic, steel
// Broader "instrument / music" umbrella: still counts as "playing", not talking.
const MUSIC_CLASSES = [132, 133, 134, 135, 142, 143, 144, 145, 146, 147]; // music, musical instrument, plucked...+ guitar techniques
// Voice classes: speech, conversation, singing, shouting, humming, chant, etc.
const VOICE_CLASSES = [0, 1, 2, 3, 4, 5, 6, 9, 10, 12, 24, 25, 26, 27, 29, 30, 31, 32];
const YAMNET_SAMPLE_RATE = 16000;
const YAMNET_WINDOW_SAMPLES = 15600; // ~0.975s, YAMNet's native frame

class GuitarGate {
    constructor(opts = {}) {
        this.modelUrl = opts.modelUrl || '/static/vendor/yamnet/model.json';
        this.tfUrl = opts.tfUrl || 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
        this.inferEveryMs = opts.inferEveryMs ?? 300; // throttle inference
        this.holdMs = opts.holdMs ?? 350;             // keep a positive verdict this long (short so talking is caught fast)
        // Decision is COMPARATIVE: sum the guitar/music evidence and compare it
        // to the voice evidence. "Guitar" wins only when it clearly beats voice.
        this.voiceRejectRatio = opts.voiceRejectRatio ?? 1.2; // reject if voice >= this * guitar
        this.minMusicScore = opts.minMusicScore ?? 0.03;      // need at least this much music evidence
        this.strongVoiceScore = opts.strongVoiceScore ?? 0.15;// any voice above this → reject outright

        this.enabled = false;      // user toggle
        this.ready = false;        // model loaded
        this.loading = false;
        this.available = true;     // false if load failed (permanent no-op)
        this.model = null;
        this.tf = null;

        this._lastInferT = 0;
        this._lastGuitarT = -Infinity;
        this._verdict = { isGuitar: true, guitarScore: 0, voiceScore: 0, ran: false };
        this.onStatus = opts.onStatus || (() => {});
    }

    async _loadScript(src) {
        if (typeof window.tf !== 'undefined') return window.tf;
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('tfjs load failed'));
            document.head.appendChild(s);
        });
        return window.tf;
    }

    /** Load TF.js + the vendored YAMNet graph model. Safe to call repeatedly. */
    async load() {
        if (this.ready || this.loading || !this.available) return this.ready;
        this.loading = true;
        this.onStatus({ state: 'loading' });
        try {
            this.tf = await this._loadScript(this.tfUrl);
            await this.tf.ready();
            this.model = await this.tf.loadGraphModel(this.modelUrl);
            this.ready = true;
            this.onStatus({ state: 'ready' });
        } catch (e) {
            this.available = false;   // never try again this session; act as no-op
            this.onStatus({ state: 'error', error: e.message });
        } finally {
            this.loading = false;
        }
        return this.ready;
    }

    async enable() {
        this.enabled = true;
        if (!this.ready && this.available) await this.load();
        return this.ready;
    }
    disable() { this.enabled = false; }

    /**
     * Resample a Float32 buffer (at srcRate) down to 16 kHz mono via linear
     * interpolation, returning exactly YAMNET_WINDOW_SAMPLES samples (padded or
     * cropped). Cheap and good enough for a classifier.
     */
    _resampleTo16k(buffer, srcRate) {
        const ratio = YAMNET_SAMPLE_RATE / srcRate;
        const outLen = Math.round(buffer.length * ratio);
        const out = new Float32Array(YAMNET_WINDOW_SAMPLES);
        const n = Math.min(outLen, YAMNET_WINDOW_SAMPLES);
        for (let i = 0; i < n; i++) {
            const srcPos = i / ratio;
            const i0 = Math.floor(srcPos);
            const i1 = Math.min(buffer.length - 1, i0 + 1);
            const frac = srcPos - i0;
            out[i] = buffer[i0] * (1 - frac) + buffer[i1] * frac;
        }
        return out;
    }

    /**
     * Feed a mono time-domain buffer. Throttled internally; returns the current
     * rolling verdict immediately (may be from a previous inference).
     * When disabled or unavailable, always returns isGuitar:true (no-op).
     */
    classify(buffer, srcRate, nowMs) {
        if (!this.enabled || !this.ready) return { isGuitar: true, guitarScore: 0, voiceScore: 0, ran: false, active: false };
        const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (t - this._lastInferT < this.inferEveryMs) {
            // throttled: return the held verdict, but mark ran=false so callers
            // can tell this frame did not run a fresh inference.
            return { ...this._verdict, ran: false, active: true };
        }
        this._lastInferT = t;
        try {
            const wave = this._resampleTo16k(buffer, srcRate);
            const scores = this.tf.tidy(() => {
                const input = this.tf.tensor1d(wave);
                const out = this.model.execute({ 'waveform:0': input }, ['Identity:0']);
                // out shape [frames, 521]; average over frames
                const mean = out.mean(0);
                return mean.dataSync();
            });
            // Guitar evidence = strong guitar classes + broader music umbrella.
            // Voice evidence = max over speech/singing classes.
            let gGuitar = 0, gMusic = 0, v = 0;
            for (const i of GUITAR_CLASSES) gGuitar = Math.max(gGuitar, scores[i]);
            for (const i of MUSIC_CLASSES) gMusic = Math.max(gMusic, scores[i]);
            for (const i of VOICE_CLASSES) v = Math.max(v, scores[i]);
            const g = Math.max(gGuitar, gMusic);
            // Reject when: strong voice present, OR voice dominates guitar, OR
            // there just isn't enough music-like evidence at all.
            const voiceDominates = v >= this.voiceRejectRatio * g;
            const tooLittleMusic = g < this.minMusicScore;
            const loudVoice = v >= this.strongVoiceScore && v > gGuitar;
            const isGuitar = !voiceDominates && !tooLittleMusic && !loudVoice;
            if (isGuitar) this._lastGuitarT = t;
            this._verdict = { isGuitar, guitarScore: +g.toFixed(3), voiceScore: +v.toFixed(3), ran: true };
        } catch (e) {
            // on any runtime error, fail open (allow) so scoring never stalls
            this._verdict = { isGuitar: true, guitarScore: 0, voiceScore: 0, ran: false };
        }
        return { ...this._verdict, active: true };
    }

    /** True if we saw guitar recently (within holdMs) — smooths brief dips. */
    isGuitarHeld(nowMs) {
        if (!this.enabled || !this.ready) return true;
        const t = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
        return (t - this._lastGuitarT) <= this.holdMs;
    }
}

if (typeof window !== 'undefined') { window.GuitarGate = GuitarGate; }
if (typeof module !== 'undefined' && module.exports) module.exports = { GuitarGate, GUITAR_CLASSES, MUSIC_CLASSES, VOICE_CLASSES, YAMNET_SAMPLE_RATE, YAMNET_WINDOW_SAMPLES };
