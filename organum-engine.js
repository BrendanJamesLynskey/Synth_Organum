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
        this.numVoices = 2;
        this.tempo = 46;
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

        this.basePitch = 130.81;                       // C3
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
                technique: this.technique, voice: 'auto', ensemble: 1,  // app already layers 3 detuned singers
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
        const m = this.modes[this.currentMode];
        const t = m.tenor;
        this.cantus = [
            { deg: 0, len: 6 }, { deg: Math.max(1, Math.round(t / 2)), len: 5 }, { deg: t, len: 7 },
            { deg: t - 1, len: 5 }, { deg: t, len: 6 }, { deg: Math.max(0, t - 2), len: 5 },
            { deg: 1, len: 5 }, { deg: 0, len: 8 }
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
        const m = this.modes[this.currentMode];
        const item = this.cantus[this.cantusPos];
        const beat = 60 / this.tempo;
        const dur = beat * item.len;
        const tenorDeg = m.finalis + item.deg;
        const tenorFreq = this.degToFreq(tenorDeg);

        if (this.voices[0]) this.playVoiceNote(this.voices[0], tenorFreq, dur, 0, { sustained: true });
        for (let vi = 1; vi < this.voices.length; vi++) this.scheduleMelisma(this.voices[vi], vi, tenorDeg, tenorFreq, dur, beat);

        this.cantusPos++;
        if (this.cantusPos >= this.cantus.length) this.buildCantus();
        this.cantusTimeout = setTimeout(() => this.scheduleTenorNote(), dur * 1000);
    }

    scheduleMelisma(voice, vi, tenorDeg, tenorFreq, dur, beat) {
        const pattern = this.rhythmPatterns[this.rhythmicMode];
        const unit = beat * 0.5;
        const cadenceRatio = this.cadenceRatios[Math.min(vi - 1, this.cadenceRatios.length - 1)];
        const centerOffset = cadenceRatio >= 4 ? 14 : cadenceRatio >= 3 ? 11 : 7;

        const segs = [];
        let tpos = 0, k = vi;
        while (tpos < dur - unit * 0.4) {
            let nd = pattern[k % pattern.length] * unit;
            if (tpos + nd > dur) nd = dur - tpos;
            segs.push({ start: tpos, dur: nd });
            tpos += nd; k++;
        }
        if (!segs.length) segs.push({ start: 0, dur });

        let cur = centerOffset, lastFreq = null;
        segs.forEach((seg, i) => {
            let freq;
            if (i === segs.length - 1) freq = tenorFreq * cadenceRatio;
            else {
                const step = [-2, -1, 1, 2, 1, -1][Math.floor(Math.random() * 6)];
                cur += step;
                if (cur > centerOffset + 3) cur = centerOffset + 2;
                if (cur < centerOffset - 2) cur = centerOffset - 1;
                freq = this.degToFreq(tenorDeg + cur);
            }
            this.playVoiceNote(voice, freq, seg.dur, seg.start, { slideFrom: i > 0 ? lastFreq : null, legato: i > 0 });
            lastFreq = freq;
        });
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
