/**
 * fretboard.js — modern SVG fretboard renderer.
 *
 * Draws the WHOLE neck: nut, every fret wire, all six strings, position
 * inlays, and a clickable/annotatable dot for every single cell. Overlays:
 *   • target cells (what to press now) — pulsing highlight,
 *   • chord shapes — coloured dots + finger numbers + muted-string marks,
 *   • live-hit feedback — a green ring when the right note sounds,
 *   • a shake class the trainer toggles on a wrong note.
 *
 * Rendering is declarative: call setTargets()/setChord()/flashHit() and the
 * view re-derives what to show. Uses inline SVG (crisp at any zoom, no canvas
 * scaling headaches) with CSS custom properties for theming.
 */
const SVGNS = 'http://www.w3.org/2000/svg';

class FretboardView {
    /**
     * @param {SVGElement} svg root <svg>
     * @param {FretboardModel} model
     * @param {object} opts
     */
    constructor(svg, model, opts = {}) {
        this.svg = svg;
        this.model = model;
        this.firstFret = opts.firstFret ?? 0;         // window start (0 = nut)
        this.visibleFrets = opts.visibleFrets ?? model.fretCount; // show all by default
        this.onCellClick = opts.onCellClick || null;
        // Layout metrics in SVG user units.
        this.padL = 64; this.padR = 28; this.padT = 34; this.padB = 30;
        this.stringColors = ['#ff5c7a', '#ffb648', '#ffe14d', '#4dd97a', '#4db8ff', '#b06bff'];
        // display order top->bottom: high e (1) at top .. low E (6) at bottom
        this.rowStrings = [1, 2, 3, 4, 5, 6];
        this.stringLabels = { 1: 'e', 2: 'B', 3: 'G', 4: 'D', 5: 'A', 6: 'E' };
        this._targets = [];   // [{string,fret}]
        this._chord = null;   // resolveChord result
        this._cellEls = new Map(); // "s-f" -> {group, dot, label}
        this._build();
    }

    key(s, f) { return s + '-' + f; }

    _dims() {
        const box = this.svg.viewBox.baseVal;
        const W = box && box.width ? box.width : (this.svg.clientWidth || 1000);
        const H = box && box.height ? box.height : (this.svg.clientHeight || 320);
        return { W, H };
    }

    _fretX(f) {
        // Linear spacing across the visible window (readability > physical scale).
        const { W } = this._dims();
        const lastFret = this.firstFret + this.visibleFrets;
        const usable = W - this.padL - this.padR;
        const t = (f - this.firstFret) / (lastFret - this.firstFret);
        return this.padL + usable * t;
    }
    /** X centre of the cell between fret f-1 and f (where a finger presses). */
    _cellX(f) {
        if (f === 0) return this.padL - 24; // open-string marker sits left of the nut
        return (this._fretX(f - 1) + this._fretX(f)) / 2;
    }
    _stringY(s) {
        const { H } = this._dims();
        const usable = H - this.padT - this.padB;
        const row = this.rowStrings.indexOf(s);   // 0..5 top->bottom
        return this.padT + usable * (row / (this.rowStrings.length - 1));
    }

    _el(tag, attrs = {}, parent = null) {
        const e = document.createElementNS(SVGNS, tag);
        for (const k in attrs) e.setAttribute(k, attrs[k]);
        (parent || this.svg).appendChild(e);
        return e;
    }

    _build() {
        while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
        const { W, H } = this._dims();
        const lastFret = this.firstFret + this.visibleFrets;

        // wood/neck background
        this._el('rect', { x: this.padL - 6, y: this.padT - 14, width: (W - this.padL - this.padR) + 12,
            height: (H - this.padT - this.padB) + 28, rx: 12, class: 'fb-neck' });

        // inlays (position dots) behind everything
        for (let f = this.firstFret + 1; f <= lastFret; f++) {
            const cx = (this._fretX(f - 1) + this._fretX(f)) / 2;
            const midY = (this._stringY(1) + this._stringY(6)) / 2;
            if (this.model.doubleDots.includes(f)) {
                const y1 = (this._stringY(2) + this._stringY(3)) / 2;
                const y2 = (this._stringY(4) + this._stringY(5)) / 2;
                this._el('circle', { cx, cy: y1, r: 7, class: 'fb-inlay' });
                this._el('circle', { cx, cy: y2, r: 7, class: 'fb-inlay' });
            } else if (this.model.singleDots.includes(f)) {
                this._el('circle', { cx, cy: midY, r: 7, class: 'fb-inlay' });
            }
        }

        // frets (vertical wires); nut is thicker
        for (let f = this.firstFret; f <= lastFret; f++) {
            const x = this._fretX(f);
            this._el('line', { x1: x, y1: this._stringY(1) - 12, x2: x, y2: this._stringY(6) + 12,
                class: f === 0 ? 'fb-nut' : 'fb-fret' });
            // fret number under the neck
            if (f > 0) {
                const cx = (this._fretX(f - 1) + this._fretX(f)) / 2;
                this._el('text', { x: cx, y: H - 8, class: 'fb-fretnum', 'text-anchor': 'middle' }).textContent = f;
            }
        }

        // strings (horizontal); thicker toward low E
        for (const s of this.rowStrings) {
            const y = this._stringY(s);
            const thickness = 1 + (6 - s) * 0.45;
            this._el('line', { x1: this._fretX(this.firstFret), y1: y, x2: this._fretX(lastFret), y2: y,
                class: 'fb-string', 'stroke-width': thickness });
            // string label on the far left
            const t = this._el('text', { x: 16, y, class: 'fb-strlabel', 'text-anchor': 'middle',
                'dominant-baseline': 'central', fill: this.stringColors[s - 1] });
            t.textContent = this.stringLabels[s];
        }

        // interactive cell dots (hidden until annotated)
        this._cellEls.clear();
        for (const s of this.rowStrings) {
            for (let f = this.firstFret; f <= lastFret; f++) {
                const g = this._el('g', { class: 'fb-cell', 'data-s': s, 'data-f': f });
                const cx = this._cellX(f), cy = this._stringY(s);
                // large invisible hit target for clicks/hover
                const hit = this._el('circle', { cx, cy, r: 15, class: 'fb-hit', fill: 'transparent' }, g);
                const dot = this._el('circle', { cx, cy, r: 13, class: 'fb-dot' }, g);
                const label = this._el('text', { x: cx, y: cy, class: 'fb-dotlabel',
                    'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
                if (this.onCellClick) {
                    hit.style.cursor = 'pointer';
                    hit.addEventListener('click', () => this.onCellClick(this.model.cell(s, f)));
                }
                this._cellEls.set(this.key(s, f), { group: g, dot, label });
            }
        }

        // ring layer for live-hit flashes (added on top)
        this._flashLayer = this._el('g', { class: 'fb-flash-layer' });
        this._applyAnnotations();
    }

    resize() { this._build(); }

    setWindow(firstFret, visibleFrets) {
        this.firstFret = firstFret;
        this.visibleFrets = visibleFrets;
        this._build();
    }

    /** Highlight a set of cells to press now. targets: [{string,fret}] */
    setTargets(targets) {
        this._targets = targets || [];
        this._applyAnnotations();
    }
    setChord(chord) {
        this._chord = chord;   // resolveChord() result or null
        this._applyAnnotations();
    }
    clear() { this._targets = []; this._chord = null; this._applyAnnotations(); }

    _applyAnnotations() {
        // reset all
        for (const { group, dot, label } of this._cellEls.values()) {
            group.classList.remove('is-target', 'is-chord', 'is-open', 'is-root');
            dot.removeAttribute('style');
            label.textContent = '';
        }
        // chord shape (coloured dots + finger numbers)
        if (this._chord) {
            for (const c of this._chord.cells) {
                const cell = this._cellEls.get(this.key(c.string, c.fret));
                if (!cell) continue;
                cell.group.classList.add('is-chord');
                if (c.fret === 0) cell.group.classList.add('is-open');
                cell.dot.style.fill = this.stringColors[c.string - 1];
                cell.label.textContent = c.finger ? String(c.finger) : (c.fret === 0 ? '○' : '');
            }
            this._renderMutes(this._chord.mutedStrings);
        } else {
            this._renderMutes([]);
        }
        // explicit single-note targets (take priority visually)
        for (const t of this._targets) {
            const cell = this._cellEls.get(this.key(t.string, t.fret));
            if (!cell) continue;
            cell.group.classList.add('is-target');
            if (t.fret === 0) cell.group.classList.add('is-open');
            const c = this.model.cell(t.string, t.fret);
            cell.label.textContent = t.fret === 0 ? '○' : c.name.replace(/\d+$/, '');
        }
    }

    _renderMutes(mutedStrings) {
        // remove old mute marks
        this.svg.querySelectorAll('.fb-mute').forEach(e => e.remove());
        for (const s of mutedStrings) {
            const x = 16, y = this._stringY(s);
            const t = this._el('text', { x, y, class: 'fb-mute', 'text-anchor': 'middle',
                'dominant-baseline': 'central' });
            t.textContent = '✕';
        }
    }

    /** Green ring pulse on a correctly played cell. */
    flashHit(string, fret, good = true) {
        const cx = this._cellX(fret), cy = this._stringY(string);
        const ring = this._el('circle', { cx, cy, r: 13,
            class: good ? 'fb-ring-good' : 'fb-ring-bad', fill: 'none' }, this._flashLayer);
        ring.addEventListener('animationend', () => ring.remove());
        // fallback cleanup
        setTimeout(() => ring.remove(), 700);
    }

    /** brief shake of the whole board (wrong note/string). */
    shake() {
        this.svg.classList.remove('shake');
        // force reflow so the animation restarts even on rapid repeats
        void this.svg.getBoundingClientRect();
        this.svg.classList.add('shake');
        setTimeout(() => this.svg.classList.remove('shake'), 420);
    }
}

if (typeof window !== 'undefined') window.FretboardView = FretboardView;
if (typeof module !== 'undefined' && module.exports) module.exports = { FretboardView };
