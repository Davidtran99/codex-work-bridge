/**
 * app.js — Guitar Trainer controller (modern rewrite).
 *
 * Wires: mic -> PitchEngine -> Trainer -> FretboardView, plus a live pitch
 * readout. Everything is client-side; Flask only serves static files.
 */
(function () {
    const $ = (id) => document.getElementById(id);
    const els = {
        svg: $('fretboard'),
        modeNote: $('modeNote'),
        modeChord: $('modeChord'),
        modeExplore: $('modeExplore'),
        chordBar: $('chordBar'),
        noteBar: $('noteBar'),
        startBtn: $('startBtn'),
        micState: $('micState'),
        pitchNote: $('pitchNote'),
        pitchCents: $('pitchCents'),
        pitchNeedle: $('pitchNeedle'),
        target: $('targetLabel'),
        prompt: $('promptText'),
        hits: $('statHits'),
        misses: $('statMisses'),
        acc: $('statAcc'),
        progress: $('progressFill'),
        chordProg: $('chordProgress'),
        chordProgFill: $('chordProgressFill'),
        fretRange: $('fretRange'),
        fretRangeVal: $('fretRangeVal'),
        // calibration wizard
        calibBtn: $('calibBtn'),
        calibBadge: $('calibBadge'),
        calibModal: $('calibModal'),
        calibClose: $('calibClose'),
        calibStepIntro: $('calibStepIntro'),
        calibStepRec: $('calibStepRec'),
        calibStepResult: $('calibStepResult'),
        calibStart: $('calibStart'),
        calibCountdown: $('calibCountdown'),
        calibRing: $('calibRingFg'),
        calibTimer: $('calibTimer'),
        calibLevel: $('calibLevelFill'),
        calibWave: $('calibWave'),
        calibHint: $('calibHint'),
        calibResultBody: $('calibResultBody'),
        calibSave: $('calibSave'),
        calibRetry: $('calibRetry'),
        calibReset: $('calibReset'),
        gateToggle: $('gateToggle'),
        gateStatus: $('gateStatus'),
    };

    const model = new Theory.FretboardModel(22);
    const view = new FretboardView(els.svg, model, {
        onCellClick: (cell) => {
            // In explore mode, clicking a cell plays its name + sets a free target.
            if (mode === 'explore') {
                view.setTargets([{ string: cell.string, fret: cell.fret }]);
                els.prompt.textContent = `Ô: dây ${cell.string} · phím ${cell.fret} → ${cell.name}`;
            }
        },
    });
    const pitch = new PitchEngine();
    const guitarGate = new GuitarGate({
        onStatus: (st) => {
            if (!els.gateStatus) return;
            const map = { loading: 'đang tải mô hình…', ready: '✓ lọc tiếng đàn bật', error: 'không tải được mô hình' };
            els.gateStatus.textContent = map[st.state] || '';
            els.gateStatus.classList.toggle('on', st.state === 'ready');
            if (st.state === 'error') els.gateToggle && (els.gateToggle.checked = false);
        },
    });
    let gateVerdict = { isGuitar: true, guitarScore: 0, voiceScore: 0, active: false };
    const trainer = new Trainer({ view, model, theory: Theory }, {
        onProgress: renderProgress,
        onFeedback: renderFeedback,
    });

    let mode = 'note';
    let running = false;
    let rafId = null;
    let lastDet = null;
    const t0 = performance.now();
    function nowSec() { return (performance.now() - t0) / 1000; }

    // ── chord palette ──────────────────────────────────────────────────
    Theory.CHORD_NAMES.forEach((name) => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = name;
        b.dataset.chord = name;
        b.addEventListener('click', () => {
            document.querySelectorAll('#chordBar .chip').forEach(c => c.classList.remove('on'));
            b.classList.add('on');
            trainer.setFreeChord(name);
            els.prompt.textContent = `Hợp âm ${name} — bấm theo các chấm rồi gảy rải cả 6 dây.`;
        });
        els.chordBar.appendChild(b);
    });

    // ── note palette (open strings + common cells) ─────────────────────
    const NOTE_CHOICES = [
        { s: 6, f: 0 }, { s: 5, f: 0 }, { s: 4, f: 0 }, { s: 3, f: 0 }, { s: 2, f: 0 }, { s: 1, f: 0 },
    ];
    NOTE_CHOICES.forEach(({ s, f }) => {
        const cell = model.cell(s, f);
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = `${cell.name} (d${s})`;
        b.addEventListener('click', () => {
            document.querySelectorAll('#noteBar .chip').forEach(c => c.classList.remove('on'));
            b.classList.add('on');
            trainer.setFreeNote(s, f);
            els.prompt.textContent = `Gảy dây ${s} (${cell.name}). Sai cao độ → cần đàn sẽ rung.`;
        });
        els.noteBar.appendChild(b);
    });

    // ── mode switching ─────────────────────────────────────────────────
    function setMode(m) {
        mode = m;
        [els.modeNote, els.modeChord, els.modeExplore].forEach(x => x.classList.remove('on'));
        ({ note: els.modeNote, chord: els.modeChord, explore: els.modeExplore })[m].classList.add('on');
        els.noteBar.classList.toggle('hidden', m !== 'note');
        els.chordBar.classList.toggle('hidden', m !== 'chord');
        els.chordProg.classList.toggle('hidden', m !== 'chord');

        if (m === 'note') {
            trainer.startNoteDrill({ count: 12, minFret: 0, maxFret: parseInt(els.fretRange.value, 10) });
            els.prompt.textContent = 'Chế độ luyện nốt: chơi đúng ô đang sáng. Sai → rung cần đàn.';
        } else if (m === 'chord') {
            view.clear();
            els.prompt.textContent = 'Chọn một hợp âm để hiện thế bấm trên cần đàn.';
        } else {
            trainer.reset();
            view.clear();
            els.prompt.textContent = 'Chế độ khám phá: bấm vào ô bất kỳ để xem tên nốt.';
        }
    }
    els.modeNote.addEventListener('click', () => setMode('note'));
    els.modeChord.addEventListener('click', () => setMode('chord'));
    els.modeExplore.addEventListener('click', () => setMode('explore'));

    els.fretRange.addEventListener('input', () => {
        els.fretRangeVal.textContent = els.fretRange.value;
        if (mode === 'note') trainer.startNoteDrill({ count: 12, minFret: 0, maxFret: parseInt(els.fretRange.value, 10) });
    });

    // ── mic ────────────────────────────────────────────────────────────
    pitch.onPitch = (r) => { lastDet = r; };
    async function ensureMic() {
        if (pitch.running) return true;
        try {
            els.micState.textContent = 'Đang xin quyền mic…';
            await pitch.start();
            els.micState.textContent = '🎤 Mic đang nghe';
            els.micState.classList.add('on');
            return true;
        } catch (e) {
            els.micState.textContent = 'Không mở được mic: ' + e.message;
            return false;
        }
    }

    async function toggleRun() {
        if (running) { stopRun(); return; }
        if (!(await ensureMic())) return;
        running = true;
        els.startBtn.textContent = '⏹ Dừng';
        loop();
    }
    function stopRun() {
        running = false;
        els.startBtn.textContent = '▶ Bắt đầu nghe';
        cancelAnimationFrame(rafId);
    }
    els.startBtn.addEventListener('click', toggleRun);

    function loop() {
        const t = nowSec();

        // Optional acoustic gate: if enabled, only let the trainer score when
        // YAMNet says the recent audio is a guitar (not voice/other). We hold a
        // positive verdict briefly so a note's decay doesn't flicker it off.
        let det = lastDet;
        if (guitarGate.enabled) {
            if (guitarGate.ready) {
                const buf = pitch.getRecentBuffer(1.0);
                if (buf) gateVerdict = guitarGate.classify(buf, pitch.sampleRate, performance.now());
                updateGateStatus();
                if (!guitarGate.isGuitarHeld(performance.now())) {
                    // suppress detection so voice/noise can't score or shake
                    det = { frequency: -1, midi: null, cents: 0, rms: (lastDet && lastDet.rms) || 0 };
                }
            } else {
                // enabled but the model is still loading (or failed): don't score
                // yet, and make that visible instead of silently letting audio through.
                if (guitarGate.available) {
                    if (els.gateStatus) els.gateStatus.textContent = 'đang tải mô hình…';
                    det = { frequency: -1, midi: null, cents: 0, rms: (lastDet && lastDet.rms) || 0 };
                }
            }
        }

        trainer.update(t, det);
        updatePitchMeter(det);
        if (running) rafId = requestAnimationFrame(loop);
    }

    function updateGateStatus() {
        if (!els.gateStatus || !guitarGate.enabled || !guitarGate.ready) return;
        const v = gateVerdict;
        if (!v.active) return;
        els.gateStatus.textContent = v.isGuitar
            ? `🎸 tiếng đàn (${v.guitarScore})`
            : `🚫 không phải đàn (đàn ${v.guitarScore} · giọng ${v.voiceScore})`;
        els.gateStatus.classList.toggle('on', v.isGuitar);
    }

    function updatePitchMeter(det) {
        if (!det || det.frequency <= 0) {
            els.pitchNote.textContent = '—';
            els.pitchCents.textContent = '';
            els.pitchNeedle.style.transform = 'translateX(-50%) rotate(0deg)';
            els.pitchNote.style.color = '';
            return;
        }
        els.pitchNote.textContent = det.note;
        const cents = Math.round(det.cents);
        els.pitchCents.textContent = (cents >= 0 ? '+' : '') + cents + '¢';
        const clamp = Math.max(-50, Math.min(50, cents));
        els.pitchNeedle.style.transform = `translateX(-50%) rotate(${clamp * 0.9}deg)`;
        els.pitchNote.style.color = Math.abs(cents) <= 12 ? '#33e08a'
            : (Math.abs(cents) <= 30 ? '#ffe14d' : '#ff5c7a');
    }

    function renderProgress(p) {
        els.hits.textContent = p.hits;
        els.misses.textContent = p.misses;
        const done = p.hits + p.misses;
        els.acc.textContent = done ? Math.round(p.hits / done * 100) + '%' : '—';
        els.progress.style.width = p.total ? (p.index / p.total * 100) + '%' : '0%';

        if (p.current && p.current.type === 'note') {
            const c = p.current.cell;
            els.target.textContent = `${c.name}`;
            els.prompt.textContent = `Chơi dây ${c.string}, phím ${c.fret} (${c.name}).`;
        } else if (p.current && p.current.type === 'chord') {
            els.target.textContent = p.current.chord.name;
        } else if (p.finished) {
            els.target.textContent = '✓';
            els.prompt.textContent = `Xong! Đúng ${p.hits}/${p.total}.`;
        }
    }

    function renderFeedback(f) {
        if (f.kind === 'wrong') {
            els.prompt.textContent = `Chưa đúng — nghe thấy ${f.detectedPc}. Thử lại.`;
        } else if (f.kind === 'chord-progress') {
            els.chordProgFill.style.width = Math.round(f.ratio * 100) + '%';
        } else if (f.kind === 'chord-hit') {
            els.chordProgFill.style.width = '100%';
            els.prompt.textContent = `Hay! Hợp âm ${f.chord.name} vang đủ tiếng.`;
        } else if (f.kind === 'hit') {
            els.prompt.textContent = `Chuẩn! ${f.cell.name} ✓`;
        }
    }

    window.addEventListener('resize', () => view.resize());

    // ══════════════════════════════════════════════════════════════════
    // CALIBRATION WIZARD — record 15s, analyze, save a guitar profile
    // ══════════════════════════════════════════════════════════════════
    const recorder = new CalibrationRecorder({ durationSec: 15 });
    let calibrating = false;
    let lastProfile = null;      // freshly analyzed, awaiting save
    let waveCtx = null, waveData = [];

    const RING_CIRC = 2 * Math.PI * 52;  // r=52 in the svg below
    if (els.calibRing) els.calibRing.style.strokeDasharray = RING_CIRC;

    function openCalib() {
        showCalibStep('intro');
        els.calibModal.classList.remove('hidden');
    }
    function closeCalib() {
        if (calibrating) recorder.cancel();
        calibrating = false;
        els.calibModal.classList.add('hidden');
        if (!running) { pitch.onPitch = (r) => { lastDet = r; }; }
    }
    function showCalibStep(which) {
        els.calibStepIntro.classList.toggle('hidden', which !== 'intro');
        els.calibStepRec.classList.toggle('hidden', which !== 'rec');
        els.calibStepResult.classList.toggle('hidden', which !== 'result');
    }

    async function startCalibration() {
        if (!(await ensureMic())) { els.calibHint.textContent = 'Cần quyền mic để hiệu chỉnh.'; return; }
        showCalibStep('rec');
        calibrating = true;
        waveData = [];
        if (els.calibWave) waveCtx = els.calibWave.getContext('2d');
        recorder.sampleRate = pitch.sampleRate || null;

        // route detections into the recorder while calibrating
        pitch.onPitch = (r) => {
            lastDet = r;
            recorder.push(r);
            drawCalibFrame(r);
        };

        recorder.onTick = (elapsed) => {
            const remain = Math.max(0, recorder.durationSec - elapsed);
            els.calibTimer.textContent = remain.toFixed(1) + 's';
            const p = elapsed / recorder.durationSec;
            if (els.calibRing) els.calibRing.style.strokeDashoffset = RING_CIRC * (1 - p);
        };
        recorder.onDone = (profile, grade, err) => {
            calibrating = false;
            pitch.onPitch = (r) => { lastDet = r; };
            if (err || !profile) { showCalibResultError(err); return; }
            lastProfile = profile;
            showCalibResult(profile, grade);
        };
        recorder.start();
    }

    function drawCalibFrame(det) {
        // level meter
        const rms = det && det.rms ? det.rms : 0;
        const lvl = Math.min(100, Math.round(rms * 900));  // visual scale
        if (els.calibLevel) els.calibLevel.style.width = lvl + '%';
        // rolling waveform of rms
        waveData.push(rms);
        const maxN = 180;
        if (waveData.length > maxN) waveData.shift();
        if (!waveCtx) return;
        const W = els.calibWave.width, H = els.calibWave.height;
        waveCtx.clearRect(0, 0, W, H);
        const peak = Math.max(0.02, ...waveData);
        waveCtx.beginPath();
        waveData.forEach((v, i) => {
            const x = i / maxN * W;
            const y = H - (v / peak) * (H - 6) - 3;
            i ? waveCtx.lineTo(x, y) : waveCtx.moveTo(x, y);
        });
        waveCtx.strokeStyle = '#4dd97a';
        waveCtx.lineWidth = 2;
        waveCtx.stroke();
    }

    function showCalibResult(p, grade) {
        showCalibStep('result');
        const gcolor = { excellent: '#33e08a', good: '#7fe0a0', fair: '#ffe14d', poor: '#ff5c7a' }[grade.grade] || '#fff';
        const tuneWord = Math.abs(p.tuningOffsetCents) < 3 ? 'đúng chuẩn A440'
            : (p.tuningOffsetCents > 0 ? `cao hơn A440 ${p.tuningOffsetCents.toFixed(1)}¢` : `thấp hơn A440 ${Math.abs(p.tuningOffsetCents).toFixed(1)}¢`);
        els.calibResultBody.innerHTML = `
            <div class="cal-grade" style="color:${gcolor}">${grade.label}</div>
            <div class="cal-metrics">
              <div class="cal-metric"><span>Tỉ lệ tín hiệu/nhiễu</span><b>${p.snrDb} dB</b></div>
              <div class="cal-metric"><span>Độ rõ (clarity)</span><b>${p.medianClarity}</b></div>
              <div class="cal-metric"><span>Lên dây</span><b>${tuneWord}</b></div>
              <div class="cal-metric"><span>A4 tham chiếu</span><b>${p.a4Hz} Hz</b></div>
              <div class="cal-metric"><span>Dải nốt nghe được</span><b>${Math.round(p.observedFreqMinHz)}–${Math.round(p.observedFreqMaxHz)} Hz</b></div>
              <div class="cal-metric"><span>Khung có tiếng</span><b>${p.voicedFrames}/${p.framesAnalyzed}</b></div>
            </div>`;
    }
    function showCalibResultError(err) {
        showCalibStep('result');
        els.calibResultBody.innerHTML = `
            <div class="cal-grade" style="color:#ff5c7a">Chưa lấy được mẫu tốt</div>
            <p class="cal-err">${(err && err.message) || 'Không đủ tiếng đàn.'} Hãy gảy rõ từng dây trong 15 giây, ở nơi yên tĩnh, rồi thử lại.</p>`;
        lastProfile = null;
    }

    function applyProfile(profile) {
        if (!profile || !profile.config) return;
        pitch.configure(profile.config);
        updateCalibBadge(profile);
    }
    function updateCalibBadge(profile) {
        if (!els.calibBadge) return;
        if (profile && profile.config) {
            els.calibBadge.textContent = '✓ đã hiệu chỉnh';
            els.calibBadge.classList.add('on');
        } else {
            els.calibBadge.textContent = 'chưa hiệu chỉnh';
            els.calibBadge.classList.remove('on');
        }
    }

    async function saveProfile() {
        if (!lastProfile) return;
        els.calibSave.disabled = true;
        els.calibSave.textContent = 'Đang lưu…';
        try {
            const res = await fetch('/api/profile', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(lastProfile),
            });
            const j = await res.json();
            if (j.ok) { applyProfile(lastProfile); closeCalib(); }
            else { els.calibHint.textContent = 'Lưu lỗi: ' + (j.error || '?'); }
        } catch (e) {
            els.calibResultBody.insertAdjacentHTML('beforeend', `<p class="cal-err">Lưu thất bại: ${e.message}</p>`);
        } finally {
            els.calibSave.disabled = false;
            els.calibSave.textContent = '💾 Lưu hồ sơ đàn';
        }
    }

    async function loadProfile() {
        try {
            const res = await fetch('/api/profile');
            const j = await res.json();
            if (j.profile && j.profile.config) applyProfile(j.profile);
            else updateCalibBadge(null);
        } catch (e) { updateCalibBadge(null); }
    }

    async function resetProfile() {
        try { await fetch('/api/profile', { method: 'DELETE' }); } catch (e) {}
        lastProfile = null;
        // reset detector to defaults
        pitch.configure({ a4: 440, rmsGate: 0.006, rmsGateLow: 0.003,
            clarityThreshold: 0.60, clarityThresholdLow: 0.48, minFreq: 70, maxFreq: 1320 });
        updateCalibBadge(null);
        closeCalib();
    }

    // guitar-gate toggle: lazy-load YAMNet on first enable
    if (els.gateToggle) {
        els.gateToggle.addEventListener('change', async () => {
            if (els.gateToggle.checked) {
                els.gateStatus.textContent = 'đang tải mô hình…';
                const ok = await guitarGate.enable();
                if (!ok) { els.gateToggle.checked = false; }
            } else {
                guitarGate.disable();
                els.gateStatus.textContent = 'lọc tiếng đàn tắt';
                els.gateStatus.classList.remove('on');
            }
        });
    }

    if (els.calibBtn) els.calibBtn.addEventListener('click', openCalib);
    if (els.calibClose) els.calibClose.addEventListener('click', closeCalib);
    if (els.calibStart) els.calibStart.addEventListener('click', startCalibration);
    if (els.calibSave) els.calibSave.addEventListener('click', saveProfile);
    if (els.calibRetry) els.calibRetry.addEventListener('click', () => showCalibStep('intro'));
    if (els.calibReset) els.calibReset.addEventListener('click', resetProfile);

    // init
    els.fretRangeVal.textContent = els.fretRange.value;
    setMode('note');
    stopRun();
    loadProfile();
})();
