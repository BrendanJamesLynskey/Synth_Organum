/**
 * Notre-Dame Organum Synthesis Engine — Selectable Vocal Synthesis
 *                                        in Pythagorean Just Intonation
 *
 * Organum was SUNG. The voices are produced by `vocal-voices.js`, a library of
 * interchangeable vocal-synthesis engines — switch between them live:
 *
 *   FOF        Fonction d'onde formantique (IRCAM CHANT) — overlapping formant
 *              grains, one burst per glottal pulse (AudioWorklet). Default.
 *   Formant    Source–filter: a glottal-pulse oscillator through parallel
 *              resonant band-pass formant filters.
 *   Additive   A sum of harmonics tracing the vowel's formant envelope (spectral).
 *   Vocal tract A Kelly–Lochbaum digital-waveguide model of the vocal tract, a
 *              ladder of cylindrical sections excited by a glottal pulse.
 *
 *   TUNING  : every pitch is a pure PYTHAGOREAN ratio — stacked 3:2 fifths reduced
 *             into the octave — so octaves/fifths/twelfths at each cadence are
 *             beatless and the voices lock and ring.
 *   TEXTURE : real Magnus liber organi practice —
 *             ORGANUM PURUM   an unmeasured tenor drone under upper voices built
 *                             from RHYTHMIC-MODE ORDINES (a modal foot repeated
 *                             2–4×, closed by the mode's rest) carrying Pérotin's
 *                             melodic figures: sequenced 2-note cells, neighbour
 *                             oscillations, circling figures, mode-6 cascades.
 *             DISCANT CLAUSULA the tenor itself gears into measured motion
 *                             (mode 5/1) beneath modal upper voices.
 *             VOICE EXCHANGE  duplum & triplum share one narrow band and swap
 *                             their figures ordo-by-ordo (stimmtausch), as in
 *                             Pérotin's tripla/quadrupla.
 *             CADENCES        double-leading-tone (ficta, a limma 256:243 below)
 *                             resolving onto the open 5th + octave.
 *   REPERTOIRE: real tenors from the Magnus liber — the "Viderunt omnes" and
 *             "Sederunt principes" gradual responds and an Easter "Alleluia"
 *             (chant pitches decoded from GregoBase gabc) — cycled per start().
 *
 * Plus the 8 church tones, the 6 rhythmic modes, and a ~7 s cathedral reverb.
 */

class OrganumEngine {
    constructor() {
        this.ctx = null;
        this.isPlaying = false;
        this.currentMode = 1;
        this.rhythmicMode = 1;
        this.numVoices = 3;             // tenor + duplum + triplum (the Pérotin sound)
        this.tempo = 88;                // perfections (dotted-quarter beats) per minute
        this.technique = 'sampler';   // real recorded voices (was 'fof')
        this.tenorVolume = 0.85;
        this.upperVolume = 0.7;
        this.reverbMix = 0.62;

        this.voices = [];
        this.cantusTimeout = null;

        this.masterGain = null;
        this.limiter = null;
        this.tenorBus = null;
        this.upperBus = null;
        this.reverbGain = null;
        this.dryGain = null;
        this.convolver = null;
        this.analyser = null;

        this.basePitch = 174.61;                       // F3 — final of the Viderunt (mode 5)
        // Pythagorean scale degrees from the F final: F(0) G(1) A(2) B(3) C(4) D(5) E(6).
        // Each PIECE supplies its own gamut (B♭ for the tritus graduals, B♮ tetrardus).
        this.ratios = [1/1, 9/8, 81/64, 4/3, 3/2, 27/16, 243/128];

        this.modes = {
            1: { name: "Dorian",        finalis: 1, tenor: 4, up: 8 },
            2: { name: "Hypodorian",    finalis: 1, tenor: 2, up: 6 },
            3: { name: "Phrygian",      finalis: 2, tenor: 5, up: 9 },
            4: { name: "Hypophrygian",  finalis: 2, tenor: 3, up: 7 },
            5: { name: "Lydian",        finalis: 3, tenor: 4, up: 9 },
            6: { name: "Hypolydian",    finalis: 3, tenor: 2, up: 7 },
            7: { name: "Mixolydian",    finalis: 4, tenor: 4, up: 9 },
            8: { name: "Hypomixolydian",finalis: 4, tenor: 3, up: 7 }
        };

        // ── The six RHYTHMIC MODES (Garlandia, De mensurabili musica) ──
        // Modal feet in tempora (1 perfection = 3 tempora): 1 trochaic L·B, 2 iambic B·L,
        // 3 dactylic L·B·B, 4 anapaestic B·B·L, 5 all perfect longs, 6 all breves.
        this.rhythmPatterns = { 1: [2, 1], 2: [1, 2], 3: [3, 1, 2], 4: [1, 2, 3], 5: [3], 6: [1, 1, 1] };
        // An ORDO = the foot repeated n×, closed by the mode's characteristic ending +
        // rest that completes the perfection (e.g. mode 1: L·B L·B … L | breve rest).
        this.ordoTails = {
            1: { extra: [2],    rest: 1 },   // …L | ␣(1)  — "perfect" mode-1 ordo
            2: { extra: [1],    rest: 2 },   // …B | ␣(2)
            3: { extra: [3],    rest: 3 },   // …L | ␣(3)
            4: { extra: [],     rest: 3 },
            5: { extra: [],     rest: 3 },   // L L L | ␣(3)
            6: { extra: [1, 1], rest: 1 }    // …B B | ␣(1)
        };
        // Perfect consonances over the tenor (scale-degree offsets): unison, 4th, 5th,
        // octave, 11th, 12th. Strong (foot-initial) notes are snapped onto these.
        this.perfectOffsets = [0, 3, 4, 7, 10, 11];
        // Pérotin's melodic vocabulary for one ordo (see figureOffset()).
        this.figures = ['neighborL', 'neighborU', 'descSeq', 'ascSeq', 'circle', 'cascade'];
        this.voiceVowels = ['o', 'a', 'e', 'a'];       // tenor dark; upper voices open

        // ── REPERTOIRE: real Magnus liber organi tenors ──
        // Chant pitches decoded from GregoBase gabc (the graduals' solo portions), as
        // scale degrees from the F final (deg 0 = F3; negative degrees reach below).
        // perf = how many perfections the tenor holds the note: long values = organum
        // purum (drone), short measured runs = discant clausulae.
        const RB_FLAT = [1/1, 9/8, 81/64, 4/3, 3/2, 27/16, 243/128];      // F G A B♭ C D E (tritus)
        const RB_NAT  = [1/1, 9/8, 81/64, 729/512, 3/2, 27/16, 243/128];  // F G A B♮ C D E (tetrardus)
        const P = (deg, perf) => ({ deg, perf });
        const D = (degs, perf) => degs.map((deg) => ({ deg, perf }));
        this.pieces = [
            {   // Pérotin, "Viderunt omnes" (gradual, Christmas — the 1198 quadruplum).
                // Tenor = the mode-V respond (GregoBase chant #1163): Vi(F) de(F)
                // runt(A·C), "o-" melisma C D C A C C C E D C, "-mnes"(C), then the
                // respond's closing "terra" melisma cadencing home to F.
                name: 'Viderunt omnes', ratios: RB_FLAT,
                sections: [
                    { style: 'purum',   uppers: 2, notes: [P(0, 26), P(0, 20), P(2, 20), P(4, 20)] },  // Vi–de–runt
                    { style: 'discant', uppers: 2, notes: D([4, 5, 4, 2, 4, 4, 4, 6, 5, 4], 2) },      // "o-" clausula
                    { style: 'purum',   uppers: 1, notes: [P(4, 22)] },                                // "-mnes" (duplum only)
                    { style: 'discant', uppers: 2, notes: [                                            // "…terra" melisma
                        ...D([0, 1, 0, 0, 2, 4, 0, 2, 4], 2), ...D([4, 3, 1, 0, 2, 1, 2, 1, 1], 1)] },
                    { style: 'purum',   uppers: 2, notes: [P(0, 30)] }                                 // final F — open 5th+8ve
                ]
            },
            {   // Pérotin, "Sederunt principes" (gradual, St Stephen — quadruplum).
                // Tenor from the gradual melody (GregoBase chant #13535): the famous
                // long D opening — Se(D·F·F) — then the "principes" melismas and the
                // respond's closing melisma cadencing to F.
                name: 'Sederunt principes', ratios: RB_FLAT,
                sections: [
                    { style: 'purum',   uppers: 2, notes: [P(-2, 30), P(0, 20), P(0, 20)] },           // Se–de–runt (the D wall)
                    { style: 'discant', uppers: 2, notes: D([2, 1, 2, 0, 1, 0], 2) },
                    { style: 'purum',   uppers: 1, notes: [P(0, 24)] },                                // prin- (duplum only)
                    { style: 'discant', uppers: 2, notes: D([1, 2, 2, 1, 2, 1, 0, 0, 2, 1, 0, 1, 0], 2) },
                    { style: 'purum',   uppers: 2, notes: [P(2, 22), P(4, 20)] },
                    { style: 'discant', uppers: 2, notes: D([4, 5, 4, 5, 4, 4, 2, 3, 2], 2) },
                    { style: 'discant', uppers: 2, notes: D([0, 2, 1, 4, 5, 4, 2, 0, 2, 1, 2, 2, 1, 1], 1) },  // closing melisma
                    { style: 'purum',   uppers: 2, notes: [P(0, 30)] }                                 // final F — open 5th+8ve
                ]
            },
            {   // "Alleluia. V. Haec dies" (Easter week; GregoBase chant #568) — sung
                // Léonin-style as organum duplum, the triplum joining for the jubilus
                // clausula. Ends on G; sung with the tetrardus B♮ gamut. (Léonin's own
                // Easter Alleluia was "Pascha nostrum"; this is a real sibling melody.)
                name: 'Alleluia (V. Haec dies)', ratios: RB_NAT,
                sections: [
                    { style: 'purum',   uppers: 1, notes: [P(0, 22), P(1, 22), P(2, 20)] },            // Al-(le): F G A
                    { style: 'discant', uppers: 1, notes: D([2, 1, 2, 3, 4, 3], 2) },                  // -le-
                    { style: 'purum',   uppers: 1, notes: [P(4, 24)] },                                // -lú- (C)
                    { style: 'discant', uppers: 2, notes: D([4, 5, 4, 2, 2], 2) },                     // -ia
                    { style: 'purum',   uppers: 1, notes: [P(1, 20)] },                                // …ia → G
                    { style: 'discant', uppers: 2, notes: D([3, 4, 1, 2, 1, 0, 2, 3, 4, 4, 3, 1, 4, 2, 3, 2, 2], 1) },  // jubilus (mode-5 tenor)
                    { style: 'purum',   uppers: 2, notes: [P(1, 28)] }                                 // final G — open 5th
                ]
            }
        ];
        this.pieceIndex = -1;           // start() cycles the repertoire

        this.cantus = [];
        this.cantusPos = 0;
        this.nextOpen = null;           // pending cadence resolutions for the upper voices
    }

    async init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.9;

        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -8; this.limiter.knee.value = 8;
        this.limiter.ratio.value = 6; this.limiter.attack.value = 0.004; this.limiter.release.value = 0.25;
        this.masterGain.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);

        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.85;
        this.limiter.connect(this.analyser);

        await this.createReverb();

        this.tenorBus = this.ctx.createGain(); this.tenorBus.gain.value = this.tenorVolume;
        this.upperBus = this.ctx.createGain(); this.upperBus.gain.value = this.upperVolume;
        this.dryGain = this.ctx.createGain(); this.dryGain.gain.value = 1 - this.reverbMix * 0.5;
        this.reverbGain = this.ctx.createGain(); this.reverbGain.gain.value = this.reverbMix;
        for (const bus of [this.tenorBus, this.upperBus]) { bus.connect(this.dryGain); bus.connect(this.convolver); }
        this.dryGain.connect(this.masterGain);
        this.convolver.connect(this.reverbGain);
        this.reverbGain.connect(this.masterGain);

        // Load the vocal-synthesis worklets (FOF, vocal tract) once.
        await VocalVoices.init(this.ctx);
    }

    async createReverb() {
        const sr = this.ctx.sampleRate;
        const length = Math.floor(sr * 7);
        const impulse = this.ctx.createBuffer(2, length, sr);
        const reflections = [0.013, 0.029, 0.047, 0.068, 0.091, 0.118, 0.151, 0.187, 0.229, 0.281];
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                const t = i / sr;
                const env = Math.exp(-t * 0.5) * 0.32 + Math.exp(-t * 0.22) * 0.4 + Math.exp(-t * 0.1) * 0.28;
                data[i] = (Math.random() * 2 - 1) * env;
                if (i < sr * 0.3) for (const d of reflections) if (i === Math.floor(d * sr)) data[i] += (Math.random() * 2 - 1) * 0.28;
            }
        }
        this.convolver = this.ctx.createConvolver();
        this.convolver.buffer = impulse;
    }

    degToFreq(deg) {
        const idx = ((deg % 7) + 7) % 7;
        const oct = Math.floor(deg / 7);
        return this.basePitch * this.ratios[idx] * Math.pow(2, oct);
    }

    /**
     * Build one SUNG PART as a chorus of detuned vocal-synthesis singers sharing a
     * note-envelope gain: [singer ×3] → noteGain → voiceGain(persistent) → bus.
     * The tenor stays on the male sample bank (G2–F♯4); the upper voices use 'auto'
     * so notes above F♯4 pick the treble bank — everything stays within G2–F♯5.
     */
    createVoice(index) {
        const now = this.ctx.currentTime;
        const role = index === 0 ? 'tenor' : 'upper';
        const bus = role === 'tenor' ? this.tenorBus : this.upperBus;
        const vowel = this.voiceVowels[Math.min(index, this.voiceVowels.length - 1)];

        const voiceGain = this.ctx.createGain();
        const perVoice = role === 'tenor' ? 0.9 : [0.62, 0.52, 0.46][Math.min(index - 1, 2)];
        voiceGain.gain.setValueAtTime(0, now);
        voiceGain.gain.linearRampToValueAtTime(perVoice, now + 1.4 + index * 0.5);
        voiceGain.connect(bus);

        const noteGain = this.ctx.createGain();
        noteGain.gain.value = 0.0001;
        noteGain.connect(voiceGain);

        const detunes = role === 'tenor' ? [0, -6, 6] : [0, -8, 9];
        const singers = detunes.map((cents, di) => {
            const voice = VocalVoices.create(this.ctx, {
                technique: this.technique,
                voice: role === 'tenor' ? 'male' : 'auto',   // tenor dark & low; upper voices may cross F♯4
                ensemble: 1,                                  // narrow band; app layers 3 detuned singers
                vowel, detuneCents: cents,
                breath: role === 'tenor' ? 0.05 : 0.07,
                vibDepth: (role === 'tenor' ? 0.005 : 0.007) + di * 0.001
            });
            const sg = this.ctx.createGain();
            sg.gain.value = di === 0 ? 1.0 : 0.7;
            voice.output.connect(sg); sg.connect(noteGain);
            return voice;
        });

        return { role, index, vowel, voiceGain, noteGain, singers };
    }

    setupVoices() {
        this.teardownVoices();
        for (let v = 0; v < this.numVoices; v++) this.voices.push(this.createVoice(v));
    }

    teardownVoices() {
        const now = this.ctx ? this.ctx.currentTime : 0;
        for (const voice of this.voices) {
            try {
                voice.voiceGain.gain.cancelScheduledValues(now);
                voice.voiceGain.gain.setValueAtTime(voice.voiceGain.gain.value, now);
                voice.voiceGain.gain.linearRampToValueAtTime(0, now + 2.2);
                const singers = voice.singers;
                setTimeout(() => { singers.forEach(s => { try { s.dispose(); } catch (e) {} }); }, 2600);
            } catch (e) {}
        }
        this.voices = [];
    }

    // === Composition ===

    /**
     * Flatten the current piece into a tenor cantus. Each item carries its section's
     * style (purum/discant), how many upper voices sing (uppers), whether it opens a
     * section (first → the big held perfect sonority), its index in the section (idx →
     * anchor rotation in discant), and — on the last note of a discant clausula that
     * arrives on a sustained sonority — cadTo: the tenor degree the DOUBLE-LEADING-TONE
     * cadence resolves onto (open 5th + octave).
     */
    buildCantus() {
        const piece = this.pieces[Math.max(0, this.pieceIndex)];
        this.ratios = piece.ratios;
        this.cantus = [];
        piece.sections.forEach((sec) => {
            sec.notes.forEach((n, i) => this.cantus.push({
                deg: n.deg, perf: n.perf, style: sec.style, uppers: sec.uppers,
                first: i === 0, idx: i, cadTo: null
            }));
        });
        for (let i = 0; i < this.cantus.length - 1; i++) {
            const cur = this.cantus[i], nxt = this.cantus[i + 1];
            if (cur.style === 'discant' && nxt.style === 'purum' && nxt.first) cur.cadTo = nxt.deg;
        }
        this.cantusPos = 0;
        this.nextOpen = null;
    }

    start() {
        this.isPlaying = true;
        this.pieceIndex = (this.pieceIndex + 1) % this.pieces.length;   // cycle the repertoire
        this.buildCantus();
        this.scheduleTenorNote();
    }

    stop() {
        this.isPlaying = false;
        if (this.cantusTimeout) { clearTimeout(this.cantusTimeout); this.cantusTimeout = null; }
        this.nextOpen = null;
        this.teardownVoices();
    }

    scheduleTenorNote() {
        if (!this.isPlaying || !this.voices.length) return;
        const item = this.cantus[this.cantusPos];
        const perfDur = 60 / this.tempo;                 // one perfection (3 tempora)
        const dur = item.perf * perfDur;
        const tenorFreq = this.degToFreq(item.deg);      // the real chant pitch, sung low

        // The tenor: a huge sustained drone (purum) or a measured note (discant).
        if (this.voices[0]) this.playVoiceNote(this.voices[0], tenorFreq, dur, 0, { sustained: item.style === 'purum' });

        // The upper voices are generated TOGETHER so they can exchange material.
        const upperCount = Math.max(0, Math.min(this.voices.length - 1, item.uppers));
        const lines = this.genUpperLines(item, dur, perfDur, upperCount);
        lines.forEach((notes, li) => {
            const voice = this.voices[li + 1]; if (!voice) return;
            notes.forEach((nn) => {
                let freq = this.degToFreq(nn.deg);
                if (nn.ficta) freq *= 243 / 256;         // ficta leading tone: a limma below its resolution
                if (freq > 739) freq /= 2;               // hard cap: nothing above F♯5 (the sample bank's top)
                this.playVoiceNote(voice, freq, nn.dur, nn.start,
                    { slideFrom: nn.legato ? this.degToFreq(nn.prev) : null, legato: nn.legato });
            });
        });

        this.cantusPos = (this.cantusPos + 1) % this.cantus.length;
        this.cantusTimeout = setTimeout(() => this.scheduleTenorNote(), dur * 1000);
    }

    /** One ordo's rhythm: the modal foot ×nFeet + the mode's closing note(s) + rest. */
    buildOrdoRhythm(mode, nFeet) {
        const feet = this.rhythmPatterns[mode] || [2, 1];
        const tail = this.ordoTails[mode] || { extra: [], rest: 3 };
        const notes = [];
        for (let f = 0; f < nFeet; f++) feet.forEach((t, j) => notes.push({ t, strong: j === 0 }));
        tail.extra.forEach((t, j) => notes.push({ t, strong: j === 0 }));
        const tempora = notes.reduce((s, n) => s + n.t, 0) + tail.rest;
        return { notes, rest: tail.rest, tempora };
    }

    /** Pérotin's melodic vocabulary: scale-step offset of note i from the ordo's anchor. */
    figureOffset(fig, i) {
        switch (fig) {
            case 'neighborL': return (i % 2) ? -1 : 0;                        // oscillating lower neighbour
            case 'neighborU': return (i % 2) ? 1 : 0;                         // oscillating upper neighbour
            case 'descSeq':   return -Math.floor(i / 2) - (i % 2);            // 2-note cell sequenced down a step
            case 'ascSeq':    return Math.floor(i / 2) + (i % 2);             // …sequenced up a step
            case 'circle':    return [0, 1, 0, -1][i % 4];                    // circulatio around the anchor
            case 'cascade':   return -(i % 3) - Math.floor(i / 3);            // 3-note cells cascading down
            default:          return 0;
        }
    }

    /**
     * Generate ALL upper-voice lines over one tenor note, together, so the voices can
     * genuinely EXCHANGE material (Pérotin's stimmtausch). Returns an array of note
     * lists ({ deg, start, dur, prev, legato, ficta }), one per upper voice.
     *
     *  PURUM   — successive modal ORDINES, each carrying one figure at one consonant
     *            anchor; consecutive ordines re-use the same figure pool ROTATED one
     *            voice over — a true voice exchange in a shared narrow band. Strong
     *            (foot-initial) notes snap to perfect consonances over the tenor; each
     *            tenor note ends converging onto the open 5th/octave.
     *  DISCANT — one modal foot-group per short tenor note; the triplum may run mode 6
     *            (fractio modi) against the duplum's mode 1; anchors rotate per note.
     *  CADENCE — a cadTo note holds ficta penults (a limma below) that resolve, at the
     *            next tenor note, onto the open 5th + octave (double leading tone).
     */
    genUpperLines(item, dur, perfDur, upperCount) {
        const lines = []; for (let v = 0; v < upperCount; v++) lines.push([]);
        if (!upperCount) return lines;

        const tempus = perfDur / 3;
        const tDeg = item.deg;
        const bandLo = Math.max(tDeg + 3, 1), bandHi = 11;    // shared upper band, always over the tenor, ≤ C5
        const inBand = (d) => Math.max(bandLo, Math.min(bandHi, d));
        const snap = (d) => {                                  // nearest perfect consonance over the tenor
            let best = d, bd = 99;
            for (const o of this.perfectOffsets) {
                const c = tDeg + o; if (c < bandLo || c > bandHi) continue;
                const dist = Math.abs(c - d); if (dist < bd) { bd = dist; best = c; }
            }
            return best;
        };
        // consonant anchors in the band, octave & fifth first
        const anchors = this.perfectOffsets.map(o => tDeg + o).filter(d => d >= bandLo && d <= bandHi);
        anchors.sort((a, b) => {
            const rank = (x) => ({ 7: 0, 4: 1, 11: 2, 10: 3, 3: 4 }[x - tDeg] ?? 5);
            return rank(a) - rank(b);
        });
        if (!anchors.length) anchors.push(inBand(tDeg + 7));

        const state = lines.map(() => ({ t: 0, prev: null }));
        const emit = (v, deg, durSec, ficta) => {
            const st = state[v];
            lines[v].push({ deg, start: st.t, dur: durSec, prev: st.prev == null ? deg : st.prev, legato: st.prev != null, ficta: !!ficta });
            st.prev = deg; st.t += durSec;
        };
        const rest = (v, durSec) => { state[v].t += durSec; state[v].prev = null; };
        const cadTargets = (arr) => [arr + 7, arr + 4, arr + 11];

        // A pending cadence resolves HERE: each voice opens holding its target
        // (open 5th + octave over the arrival tenor).
        if (this.nextOpen) {
            for (let v = 0; v < upperCount; v++) emit(v, inBand(this.nextOpen[v % this.nextOpen.length]), Math.min(perfDur * 2, dur * 0.4));
            this.nextOpen = null;
        } else if (item.first && item.style === 'purum') {
            // Section opening: the great held perfect sonority (octave + fifth [+ 12th]).
            const open = [tDeg + 7, tDeg + 4, tDeg + 11];
            for (let v = 0; v < upperCount; v++) emit(v, snap(inBand(open[v] != null ? open[v] : tDeg + 7)), Math.min(perfDur * 2, dur * 0.4));
        }

        if (item.style === 'purum') {
            const tail = perfDur;                              // reserved for convergence / cadence
            let pool = null, rot = 0;
            while (true) {
                const mode = Math.random() < 0.22 ? 6
                    : (this.rhythmicMode >= 1 && this.rhythmicMode <= 3 ? this.rhythmicMode : 1);
                const nFeet = 2 + Math.floor(Math.random() * 3);
                const ordo = this.buildOrdoRhythm(mode, nFeet);
                const len = ordo.tempora * tempus;
                const t0 = Math.max(...state.map(s => s.t));
                if (t0 + len > dur - tail) break;
                if (!pool) {                                   // fresh figure pool for an exchange pair
                    pool = []; rot = 0;
                    for (let v = 0; v < upperCount; v++) pool.push({
                        fig: this.figures[Math.floor(Math.random() * this.figures.length)],
                        anchor: anchors[(v + (Math.random() < 0.3 ? 1 : 0)) % anchors.length]
                    });
                } else rot = 1;                                // second ordo: same pool, voices swapped
                for (let v = 0; v < upperCount; v++) {
                    state[v].t = t0;                           // ordines stay aligned across the voices
                    const slot = pool[(v + rot) % pool.length];
                    ordo.notes.forEach((n, i) => {
                        let d = inBand(slot.anchor + this.figureOffset(slot.fig, i));
                        if (n.strong) d = snap(d);
                        emit(v, d, n.t * tempus);
                    });
                    rest(v, ordo.rest * tempus);
                }
                if (rot === 1) pool = null;                    // exchange complete — draw a new pool
            }
            // Convergence (or double-leading-tone penult) filling the reserved tail.
            const targets = item.cadTo != null ? cadTargets(item.cadTo) : cadTargets(tDeg);
            for (let v = 0; v < upperCount; v++) {
                const remain = dur - state[v].t;
                if (remain <= 0.05) continue;
                if (item.cadTo != null) emit(v, inBand(targets[Math.min(v, 2)]), remain, true);
                else emit(v, snap(inBand(targets[Math.min(v, 2)])), remain);
            }
            if (item.cadTo != null) this.nextOpen = targets.slice(0, upperCount).map(inBand);
        } else {
            // DISCANT — the tenor is measured; upper voices ride it foot by foot.
            if (item.cadTo != null) {
                // Clausula end: hold the ficta penults through the whole tenor note and
                // resolve on the arrival — the double-leading-tone cadence.
                const targets = cadTargets(item.cadTo);
                for (let v = 0; v < upperCount; v++) emit(v, inBand(targets[Math.min(v, 2)]), dur, true);
                this.nextOpen = targets.slice(0, upperCount).map(inBand);
                return lines;
            }
            for (let v = 0; v < upperCount; v++) {
                // duplum: trochaic mode 1 (or the user's mode 2); triplum sometimes
                // breaks into running mode-6 breves against it (fractio modi).
                const mode = (v >= 1 && Math.random() < 0.45) ? 6 : (this.rhythmicMode === 2 ? 2 : 1);
                const feet = this.rhythmPatterns[mode];
                const anchor = anchors[(item.idx + v) % Math.min(anchors.length, Math.max(1, upperCount + 1))];
                const fig = this.figures[(item.idx + v) % this.figures.length];
                let i = 0;
                while (state[v].t < dur - 0.02) {
                    for (let j = 0; j < feet.length && state[v].t < dur - 0.02; j++) {
                        const durSec = Math.min(feet[j] * tempus, dur - state[v].t);
                        let d = inBand(anchor + this.figureOffset(fig, i));
                        if (j === 0) d = snap(d);              // foot-initial notes are consonant
                        emit(v, d, durSec); i++;
                    }
                }
            }
        }
        return lines;
    }

    /** Steer each singer's pitch and re-shape the shared note-envelope. */
    playVoiceNote(voice, freq, duration, delay, opts = {}) {
        if (!isFinite(freq) || freq <= 0) return;
        const t0 = this.ctx.currentTime + (delay || 0);
        const attack = opts.sustained ? Math.min(0.55, duration * 0.3) : (opts.legato ? Math.min(0.08, duration * 0.4) : Math.min(0.12, duration * 0.4));
        const release = opts.sustained ? Math.max(0.7, duration * 0.4) : Math.max(0.16, duration * 0.5);
        const peak = opts.sustained ? 0.92 : 0.72;

        const g = voice.noteGain.gain;
        g.cancelScheduledValues(t0);
        g.setValueAtTime(Math.max(0.0001, g.value), t0);
        g.linearRampToValueAtTime(peak, t0 + attack);
        g.setValueAtTime(peak * 0.92, t0 + Math.max(attack, duration * 0.62));
        g.exponentialRampToValueAtTime(0.0008, t0 + duration + release);

        const glide = (opts.slideFrom && opts.legato) ? Math.min(0.13, duration * 0.4) : 0;
        voice.singers.forEach(s => {
            if (glide > 0 && isFinite(opts.slideFrom)) s.setFrequency(opts.slideFrom, t0, 0), s.setFrequency(freq, t0, glide);
            else s.setFrequency(freq, t0, 0);
            s.setLevel(1, t0);
        });
    }

    // === Public transport / control ===

    async begin() {
        await this.init();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this.setupVoices();
        setTimeout(() => { if (!this.isPlaying) this.start(); }, 1300);
    }

    end() { this.stop(); }

    setMode(mode) { this.currentMode = mode; if (this.isPlaying) this.buildCantus(); }
    setRhythm(mode) { this.rhythmicMode = mode; }
    setVoices(count) { this.numVoices = count; if (this.voices.length) this.setupVoices(); }

    /** Switch the vocal-synthesis technique live ('vocoder'|'formant'|'klatt'|'tract'|'lpc'|'fof'|'additive'|'ddsp'). */
    setTechnique(t) {
        this.technique = t;
        if (this.voices.length) this.setupVoices();
    }

    setTenorVolume(v) { this.tenorVolume = v; if (this.tenorBus) this.tenorBus.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.2); }
    setUpperVolume(v) { this.upperVolume = v; if (this.upperBus) this.upperBus.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.2); }
    setReverbMix(v) {
        this.reverbMix = v;
        if (this.reverbGain && this.dryGain) {
            const now = this.ctx.currentTime;
            this.reverbGain.gain.linearRampToValueAtTime(v, now + 0.2);
            this.dryGain.gain.linearRampToValueAtTime(1 - v * 0.5, now + 0.2);
        }
    }
    setTempo(bpm) { this.tempo = bpm; }

    getAnalyserData() { if (!this.analyser) return null; const d = new Uint8Array(this.analyser.frequencyBinCount); this.analyser.getByteTimeDomainData(d); return d; }
    getFrequencyData() { if (!this.analyser) return null; const d = new Uint8Array(this.analyser.frequencyBinCount); this.analyser.getByteFrequencyData(d); return d; }
}
