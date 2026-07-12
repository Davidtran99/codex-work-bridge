/**
 * theory.js — pure music-theory model for the guitar trainer.
 *
 * No DOM, no audio: just the maths of a fretboard so it is unit-testable.
 *
 *   • Standard tuning, 6 strings, configurable fret count (default 22).
 *   • String 6 = low E (thick, bottom of the neck as seen by a player),
 *     string 1 = high e (thin, top). This matches the rest of the project.
 *   • Every cell (string, fret) maps to a MIDI note and a note name.
 *   • A small chord library gives, per chord, the fretted cell on each string
 *     (or "mute"/"open"), the fingering, and the set of pitch classes so the
 *     detector can tell whether a played note belongs to the chord.
 */

// Open-string MIDI, string 6 (low E) .. string 1 (high e), standard tuning.
const OPEN_STRING_MIDI = { 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 };
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToName(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
function midiToPitchClass(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12];
}
/** MIDI produced by pressing `string` at `fret` (fret 0 = open). */
function cellMidi(string, fret) {
    return OPEN_STRING_MIDI[string] + fret;
}
function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * FretboardModel — knows every cell on the neck.
 */
class FretboardModel {
    constructor(fretCount = 22) {
        this.fretCount = fretCount;
        this.strings = [6, 5, 4, 3, 2, 1];  // render order handled by the view
        // Frets that carry a position inlay dot on a real guitar.
        this.singleDots = [3, 5, 7, 9, 15, 17, 19, 21];
        this.doubleDots = [12, 24];
    }

    /** All cells as a flat list of {string, fret, midi, name, pc}. */
    cells() {
        const out = [];
        for (const s of this.strings) {
            for (let f = 0; f <= this.fretCount; f++) {
                const midi = cellMidi(s, f);
                out.push({ string: s, fret: f, midi, name: midiToName(midi), pc: midiToPitchClass(midi) });
            }
        }
        return out;
    }

    cell(string, fret) {
        const midi = cellMidi(string, fret);
        return { string, fret, midi, name: midiToName(midi), pc: midiToPitchClass(midi) };
    }

    /** Every (string,fret) on the neck whose pitch class matches `pc`. */
    cellsForPitchClass(pc) {
        return this.cells().filter(c => c.pc === pc);
    }
}

/**
 * Chord library. Each shape lists, per string 6..1, either a fret number,
 * 'x' (muted) or 0 (open). Fingers is an optional per-string finger hint
 * (1=index..4=pinky, 0=open/none). Positions are open/first-position voicings.
 */
const CHORD_SHAPES = {
    // name: { frets: {6,5,4,3,2,1}, fingers: {...}, label }
    'C':   { label: 'C major',  frets: { 6: 'x', 5: 3, 4: 2, 3: 0, 2: 1, 1: 0 }, fingers: { 5: 3, 4: 2, 2: 1 } },
    'Cmaj7':{label: 'C major 7',frets: { 6: 'x', 5: 3, 4: 2, 3: 0, 2: 0, 1: 0 }, fingers: { 5: 3, 4: 2 } },
    'A':   { label: 'A major',  frets: { 6: 'x', 5: 0, 4: 2, 3: 2, 2: 2, 1: 0 }, fingers: { 4: 1, 3: 2, 2: 3 } },
    'Am':  { label: 'A minor',  frets: { 6: 'x', 5: 0, 4: 2, 3: 2, 2: 1, 1: 0 }, fingers: { 4: 2, 3: 3, 2: 1 } },
    'Am7': { label: 'A minor 7',frets: { 6: 'x', 5: 0, 4: 2, 3: 0, 2: 1, 1: 0 }, fingers: { 4: 2, 2: 1 } },
    'G':   { label: 'G major',  frets: { 6: 3, 5: 2, 4: 0, 3: 0, 2: 0, 1: 3 }, fingers: { 6: 2, 5: 1, 1: 3 } },
    'E':   { label: 'E major',  frets: { 6: 0, 5: 2, 4: 2, 3: 1, 2: 0, 1: 0 }, fingers: { 5: 2, 4: 3, 3: 1 } },
    'Em':  { label: 'E minor',  frets: { 6: 0, 5: 2, 4: 2, 3: 0, 2: 0, 1: 0 }, fingers: { 5: 2, 4: 3 } },
    'Em7': { label: 'E minor 7',frets: { 6: 0, 5: 2, 4: 0, 3: 0, 2: 0, 1: 0 }, fingers: { 5: 2 } },
    'D':   { label: 'D major',  frets: { 6: 'x', 5: 'x', 4: 0, 3: 2, 2: 3, 1: 2 }, fingers: { 3: 1, 1: 2, 2: 3 } },
    'Dm':  { label: 'D minor',  frets: { 6: 'x', 5: 'x', 4: 0, 3: 2, 2: 3, 1: 1 }, fingers: { 3: 2, 2: 3, 1: 1 } },
    'F':   { label: 'F major (barré)', frets: { 6: 1, 5: 3, 4: 3, 3: 2, 2: 1, 1: 1 }, fingers: { 6: 1, 5: 3, 4: 4, 3: 2, 2: 1, 1: 1 } },
};

/**
 * Resolve a chord name into rich per-string cells + the pitch-class set.
 * Returns { name, label, cells:[{string,fret,midi,name,pc,finger}], mutedStrings, pitchClasses:Set }.
 */
function resolveChord(name, model = new FretboardModel()) {
    const shape = CHORD_SHAPES[name];
    if (!shape) throw new Error('unknown chord: ' + name);
    const cells = [];
    const mutedStrings = [];
    const pitchClasses = new Set();
    for (const s of [6, 5, 4, 3, 2, 1]) {
        const f = shape.frets[s];
        if (f === 'x' || f === undefined) { mutedStrings.push(s); continue; }
        const c = model.cell(s, f);
        c.finger = (shape.fingers && shape.fingers[s]) || 0;
        cells.push(c);
        pitchClasses.add(c.pc);
    }
    return { name, label: shape.label, cells, mutedStrings, pitchClasses };
}

const CHORD_NAMES = Object.keys(CHORD_SHAPES);

const Theory = {
    OPEN_STRING_MIDI, NOTE_NAMES,
    midiToName, midiToPitchClass, cellMidi, midiToFreq,
    FretboardModel, CHORD_SHAPES, CHORD_NAMES, resolveChord,
};

if (typeof window !== 'undefined') window.Theory = Theory;
if (typeof module !== 'undefined' && module.exports) module.exports = Theory;
