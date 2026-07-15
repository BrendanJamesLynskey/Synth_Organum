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
 *   TEXTURE : a dark sustained TENOR (cantus firmus) beneath florid melismatic
 *             upper voices (duplum · triplum · quadruplum) cadencing onto perfect
 *             consonances — the Pérotin "organum purum" texture.
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
        // Pythagorean F-mode scale degrees: F(0) G(1) A(2) B♭(3) C(4) D(5) E(6)
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
        this.rhythmPatterns = { 1:[2,1], 2:[1,2], 3:[3,1,2], 4:[1,2,3], 5:[3,3], 6:[1,1,1] };
        this.cadenceRatios = [2, 3, 4];
        this.voiceVowels = ['o', 'a', 'e', 'a'];       // tenor dark; upper voices open

        this.cantus = [];
        this.cantusPos = 0;
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
                technique: this.technique, voice: 'male', ensemble: 1,  // narrow male band; app layers 3 detuned singers
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

    buildCantus() {
        // The REAL tenor of the "Viderunt omnes" gradual (F-mode; the chant Pérotin set),
        // as scale degrees  F=0 G=1 A=2 B♭=3 C=4 D=5 E=6.  A long held note = *organum
        // purum* (the tenor is an unmeasured drone under a florid upper melisma); a run of
        // short notes = a *discant clausula* (the tenor itself moves in measured mode 5).
        // `perf` = number of perfections (the ternary long-short beat) the tenor note lasts.
        this.cantus = [
            { deg: 0, perf: 20, style: 'purum' },   // "Vi—"  the famous immense opening F
            { deg: 0, perf: 12, style: 'purum' },   // "de—"
            { deg: 2, perf: 16, style: 'purum' },   // "runt"  A
            { deg: 4, perf: 16, style: 'purum' },   //         C
            // discant clausula on the following melisma — the tenor gears into measured motion
            { deg: 4, perf: 2, style: 'discant' }, { deg: 5, perf: 2, style: 'discant' },
            { deg: 4, perf: 2, style: 'discant' }, { deg: 2, perf: 2, style: 'discant' },
            { deg: 4, perf: 2, style: 'discant' }, { deg: 6, perf: 2, style: 'discant' },
            { deg: 5, perf: 2, style: 'discant' }, { deg: 4, perf: 3, style: 'discant' },
            { deg: 0, perf: 22, style: 'purum' }    // return to F — the vast closing open-fifth
        ];
        this.cantusPos = 0;
    }

    start() { this.isPlaying = true; this.buildCantus(); this.scheduleTenorNote(); }

    stop() {
        this.isPlaying = false;
        if (this.cantusTimeout) { clearTimeout(this.cantusTimeout); this.cantusTimeout = null; }
        this.teardownVoices();
    }

    scheduleTenorNote() {
        if (!this.isPlaying || !this.voices.length) return;
        const item = this.cantus[this.cantusPos];
        const perfDur = 60 / this.tempo;                 // one perfection (dotted-quarter beat)
        const dur = item.perf * perfDur;
        const tenorDeg = item.deg;                        // Viderunt tenor, F-mode
        const tenorFreq = this.degToFreq(tenorDeg);

        // The tenor: a huge sustained drone (purum) or a measured note (discant).
        if (this.voices[0]) this.playVoiceNote(this.voices[0], tenorFreq, dur, 0, { sustained: item.style === 'purum' });

        // Florid upper voice(s) run over the tenor note in modal rhythm.
        for (let vi = 1; vi < this.voices.length; vi++) {
            const notes = this.genUpper(tenorDeg, vi, dur, perfDur, item.style);
            notes.forEach(nn => this.playVoiceNote(this.voices[vi], this.degToFreq(nn.deg), nn.dur, nn.start,
                { slideFrom: nn.legato ? this.degToFreq(nn.prev) : null, legato: nn.legato }));
        }

        this.cantusPos = (this.cantusPos + 1) % this.cantus.length;
        this.cantusTimeout = setTimeout(() => this.scheduleTenorNote(), dur * 1000);
    }

    /**
     * Generate one upper voice's melisma over a single tenor note. Authentic Notre-Dame
     * traits: rhythmic mode 1 (LONG–breve trochaic swing) with occasional mode-6 runs,
     * short ordo cells punctuated by rests (breathing every 2–4 perfections), the line
     * circling stepwise around the perfect consonances above the tenor (unison/4th/5th/
     * octave), and CADENCING onto an open 5th/octave before the tenor moves. Returns a
     * list of { deg, start, dur, prev, legato } (deg = absolute scale degree).
     */
    genUpper(tenorDeg, vi, dur, perfDur, style) {
        const stable = [0, 3, 4, 7];                     // unison, 4th, 5th, octave above the tenor
        const topDeg = 9;                                // never above ~A4 → stays in the male band
        const lo = 0, hi = Math.max(2, topDeg - tenorDeg);
        const clamp = (x) => Math.max(lo, Math.min(hi, x));
        const nearestStable = (x) => { let b = stable[0], bd = 99; for (const s of stable) if (s <= hi && Math.abs(s - x) < bd) { bd = Math.abs(s - x); b = s; } return b; };

        const notes = [];
        let t = 0, cur = clamp(4 + (vi - 1) * 2), prev = cur, perfCount = 0;   // higher voice starts higher
        const push = (rel, ndur) => { notes.push({ deg: tenorDeg + rel, start: t, dur: ndur, prev: tenorDeg + prev, legato: notes.length > 0 }); prev = rel; t += ndur; };

        while (t < dur - perfDur * 0.55) {
            // cadence: the last perfection lands on a perfect consonance (open sonority)
            if (dur - t <= perfDur * 1.25) { const cad = Math.min(hi, (vi === 1 ? 7 : 4)); push(cad, dur - t); break; }
            // ordo: breathe (short rest) every 2–4 perfections
            if (perfCount > 0 && (perfCount % (2 + (perfCount % 3)) === 0)) t += perfDur * 0.45;
            if (t >= dur - perfDur * 0.55) break;
            if (style === 'purum' && perfCount % 4 === 3) {
                // mode 6 flourish — three running breves
                for (let b = 0; b < 3 && t < dur - perfDur * 0.4; b++) push(clamp(cur + [-1, 1, -1][b]), perfDur / 3), cur = prev;
            } else {
                // mode 1 — LONG on a stable consonance, breve passing tone
                cur = clamp(nearestStable(cur)); push(cur, perfDur * 2 / 3);
                cur = clamp(cur + (Math.random() < 0.5 ? 1 : -1)); push(cur, perfDur / 3);
            }
            perfCount++;
        }
        if (!notes.length) push(Math.min(hi, vi === 1 ? 7 : 4), dur);
        return notes;
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
