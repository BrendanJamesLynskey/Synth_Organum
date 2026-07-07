/**
 * Notre-Dame Organum Synthesis Engine — Vocal Polyphony in Pythagorean Just Intonation
 *
 * This engine recreates the sound of the Notre-Dame school (Léonin & Pérotin,
 * c. 1160–1250): the first great flowering of Western polyphony. Organum was
 * SUNG — unaccompanied voices ringing in the stone vault of the cathedral — so
 * every voice here is a synthesized human voice, not an instrument.
 *
 *   - VOICE    : source–filter (formant) vocal synthesis. A glottal-pulse source
 *                (a `PeriodicWave` rolling off ~12 dB/oct, like flow through the
 *                vocal folds) is shaped by a bank of parallel resonant formant
 *                band-pass filters that give each singer a Latin vowel (a o u e).
 *                The tenor sings a dark "oo/oh"; the upper voices open to "ah/eh".
 *   - TUNING   : every pitch is built from PURE PYTHAGOREAN ratios — stacked
 *                3:2 fifths reduced into the octave (1/1, 9/8, 81/64, 4/3, 3/2,
 *                27/16, 243/128, 2/1), NOT equal temperament. The perfect
 *                consonances between voices (octave 2/1, twelfth 3/1, double-
 *                octave 4/1) are therefore beatless — the voices lock and ring.
 *   - TEXTURE  : a TENOR (vox principalis) holds very long sustained notes from
 *                a plainchant cantus firmus, while florid melismatic upper voices
 *                (duplum · triplum · quadruplum) flower above it and cadence onto
 *                perfect consonances — the Pérotin "organum purum" texture.
 *
 * On top of that: the 8 medieval church tones (finalis / reciting tenor), the
 * 6 rhythmic modes (repeating long–short patterns the upper voices follow), and
 * a very long great-cathedral convolution reverb.
 */

class OrganumEngine {
    constructor() {
        this.ctx = null;
        this.isPlaying = false;
        this.currentMode = 1;
        this.rhythmicMode = 1;
        this.numVoices = 2;             // 2 duplum · 3 triplum · 4 quadruplum
        this.tempo = 46;                // pace of the melisma (beats/min-ish)
        this.tenorVolume = 0.85;        // vox principalis / cantus firmus
        this.upperVolume = 0.7;         // florid upper voices
        this.reverbMix = 0.62;

        this.voices = [];               // persistent voice objects (0 = tenor)
        this.cantusTimeout = null;
        this.activeNotes = [];

        this.masterGain = null;
        this.tenorBus = null;
        this.upperBus = null;
        this.reverbGain = null;
        this.dryGain = null;
        this.convolver = null;
        this.analyser = null;
        this.glottalWave = null;

        // Low, grounded pitch of scale-degree 0 (a dark tenor register, C3).
        this.basePitch = 130.81;

        // === Pure Pythagorean diatonic ratios (degrees 0..6; octave = ×2) ===
        // Stacked 3:2 fifths reduced into one octave.
        this.ratios = [1/1, 9/8, 81/64, 4/3, 3/2, 27/16, 243/128];

        // === The 8 medieval church tones ===
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

        // === The 6 rhythmic modes: repeating long–short duration patterns ===
        this.rhythmPatterns = {
            1: [2, 1], 2: [1, 2], 3: [3, 1, 2], 4: [1, 2, 3], 5: [3, 3], 6: [1, 1, 1]
        };

        // Cadence consonances above the tenor, per upper voice (pure ratios):
        //   duplum → octave (2), triplum → twelfth (3), quadruplum → double octave (4).
        this.cadenceRatios = [2, 3, 4];

        // === Sung-vowel formant tables (F1..F4 centre frequencies, Hz) ===
        this.vowels = {
            a: [700, 1220, 2600, 3300],
            e: [530, 1840, 2480, 3300],
            o: [430,  820, 2700, 3300],
            u: [350,  600, 2700, 3300]
        };
        // Each voice sings its own vowel; the tenor is darkest, upper voices open.
        this.voiceVowels = ['o', 'a', 'e', 'a'];

        this.cantus = [];
        this.cantusPos = 0;
    }

    async init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.9;
        this.masterGain.connect(this.ctx.destination);

        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.85;
        this.masterGain.connect(this.analyser);

        await this.createReverb();

        this.tenorBus = this.ctx.createGain();
        this.tenorBus.gain.value = this.tenorVolume;
        this.upperBus = this.ctx.createGain();
        this.upperBus.gain.value = this.upperVolume;

        this.dryGain = this.ctx.createGain();
        this.dryGain.gain.value = 1 - this.reverbMix * 0.5;

        this.reverbGain = this.ctx.createGain();
        this.reverbGain.gain.value = this.reverbMix;

        for (const bus of [this.tenorBus, this.upperBus]) {
            bus.connect(this.dryGain);
            bus.connect(this.convolver);
        }
        this.dryGain.connect(this.masterGain);
        this.convolver.connect(this.reverbGain);
        this.reverbGain.connect(this.masterGain);

        this.buildGlottalWave();
    }

    /**
     * The glottal source: harmonics rolling off ~ -11 dB/oct. Rich enough that the
     * upper formants have partials to resonate, giving a full choral tone.
     */
    buildGlottalWave() {
        const n = 48;
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        for (let k = 1; k < n; k++) imag[k] = 1 / Math.pow(k, 1.1);
        this.glottalWave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    }

    /** Great cathedral — a very long ~7 s convolution tail with sparse reflections. */
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
                if (i < sr * 0.3) {
                    for (const d of reflections) {
                        if (i === Math.floor(d * sr)) data[i] += (Math.random() * 2 - 1) * 0.28;
                    }
                }
            }
        }
        this.convolver = this.ctx.createConvolver();
        this.convolver.buffer = impulse;
    }

    /** Absolute scale-degree → frequency, in pure Pythagorean intonation. */
    degToFreq(deg) {
        const idx = ((deg % 7) + 7) % 7;
        const oct = Math.floor(deg / 7);
        return this.basePitch * this.ratios[idx] * Math.pow(2, oct);
    }

    /**
     * Build one persistent SINGER: a vocal tract of four parallel formant band-pass
     * filters (tuned to this voice's vowel) fed from a source gain. Note oscillators
     * (the vocal folds) connect transiently into sourceGain; the tract persists.
     *
     *   sourceGain → [4 formant band-pass → formant gain] → voiceGain → bus
     */
    createVoice(index, total) {
        const now = this.ctx.currentTime;
        const role = index === 0 ? 'tenor' : 'upper';
        const bus = role === 'tenor' ? this.tenorBus : this.upperBus;

        const sourceGain = this.ctx.createGain();
        sourceGain.gain.value = 1.0;

        const voiceGain = this.ctx.createGain();
        const perVoice = role === 'tenor' ? 0.85 : [0.6, 0.5, 0.44][Math.min(index - 1, 2)];
        voiceGain.gain.setValueAtTime(0, now);
        voiceGain.gain.linearRampToValueAtTime(perVoice, now + 1.4 + index * 0.5);
        voiceGain.connect(bus);

        // Four parallel formant resonators for this voice's vowel.
        const vowel = this.voiceVowels[Math.min(index, this.voiceVowels.length - 1)];
        const centres = this.vowels[vowel];
        const formantGainsRel = [1.0, 0.5, 0.28, 0.16];
        const bandwidths = [80, 90, 120, 150];
        const formants = [];
        for (let f = 0; f < 4; f++) {
            const bp = this.ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = centres[f];
            bp.Q.value = centres[f] / bandwidths[f];
            const fg = this.ctx.createGain();
            fg.gain.value = formantGainsRel[f];
            sourceGain.connect(bp);
            bp.connect(fg);
            fg.connect(voiceGain);
            formants.push({ bp, fg, bandwidth: bandwidths[f] });
        }

        // A touch of the raw source bleeds through so consonants/edge stay audible.
        const bleed = this.ctx.createGain();
        bleed.gain.value = 0.12;
        sourceGain.connect(bleed);
        bleed.connect(voiceGain);

        // Two folds per note (a hair of detune) make each singer fuller; the pure
        // fundamental still dominates so inter-voice consonances stay beatless.
        const detunes = role === 'tenor' ? [0, 5] : [0, 7];

        return { role, index, sourceGain, voiceGain, formants, vowel, detunes };
    }

    setupVoices() {
        this.teardownVoices();
        for (let v = 0; v < this.numVoices; v++) {
            this.voices.push(this.createVoice(v, this.numVoices));
        }
    }

    teardownVoices() {
        const now = this.ctx ? this.ctx.currentTime : 0;
        for (const voice of this.voices) {
            try {
                voice.voiceGain.gain.cancelScheduledValues(now);
                voice.voiceGain.gain.setValueAtTime(voice.voiceGain.gain.value, now);
                voice.voiceGain.gain.linearRampToValueAtTime(0, now + 2.5);
            } catch (e) {}
        }
        this.voices = [];
    }

    // === Composition ===

    /** A slow plainchant cantus firmus for the tenor (degrees relative to finalis). */
    buildCantus() {
        const m = this.modes[this.currentMode];
        const t = m.tenor;
        const c = [];
        c.push({ deg: 0, len: 6 });
        c.push({ deg: Math.max(1, Math.round(t / 2)), len: 5 });
        c.push({ deg: t, len: 7 });
        c.push({ deg: t - 1, len: 5 });
        c.push({ deg: t, len: 6 });
        c.push({ deg: Math.max(0, t - 2), len: 5 });
        c.push({ deg: 1, len: 5 });
        c.push({ deg: 0, len: 8 });
        this.cantus = c;
        this.cantusPos = 0;
    }

    start() {
        this.isPlaying = true;
        this.buildCantus();
        this.scheduleTenorNote();
    }

    stop() {
        this.isPlaying = false;
        if (this.cantusTimeout) { clearTimeout(this.cantusTimeout); this.cantusTimeout = null; }
        const now = this.ctx ? this.ctx.currentTime : 0;
        for (const n of this.activeNotes) {
            try {
                n.gain.gain.cancelScheduledValues(now);
                n.gain.gain.setValueAtTime(n.gain.gain.value, now);
                n.gain.gain.linearRampToValueAtTime(0, now + 1.4);
                setTimeout(() => { try { n.oscs.forEach(o => o.stop()); } catch (e) {} }, 1700);
            } catch (e) {}
        }
        this.activeNotes = [];
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

        // Tenor: one long, dark, sustained "oo/oh" (vox principalis).
        if (this.voices[0]) this.playVoiceNote(this.voices[0], tenorFreq, dur, 0, { sustained: true });

        // Upper voices: florid melismas cadencing onto perfect consonances.
        for (let vi = 1; vi < this.voices.length; vi++) {
            this.scheduleMelisma(this.voices[vi], vi, tenorDeg, tenorFreq, dur, beat);
        }

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

        let cur = centerOffset;
        let lastFreq = null;
        segs.forEach((seg, i) => {
            let freq;
            if (i === segs.length - 1) {
                freq = tenorFreq * cadenceRatio;        // pure, beatless cadence
            } else {
                const step = [-2, -1, 1, 2, 1, -1][Math.floor(Math.random() * 6)];
                cur += step;
                if (cur > centerOffset + 3) cur = centerOffset + 2;
                if (cur < centerOffset - 2) cur = centerOffset - 1;
                freq = this.degToFreq(tenorDeg + cur);
            }
            this.playVoiceNote(voice, freq, seg.dur, seg.start, { slideFrom: i > 0 ? lastFreq : null });
            lastFreq = freq;
        });
    }

    /**
     * Sing one note on a voice: glottal-pulse fold oscillator(s) through a per-note
     * amplitude envelope into the singer's formant tract (voice.sourceGain). Long
     * tenor notes bloom with slow vibrato; melisma notes glide legato.
     */
    playVoiceNote(voice, freq, duration, delay, opts = {}) {
        if (!isFinite(freq) || freq <= 0) return;
        const t0 = this.ctx.currentTime + (delay || 0);

        const gain = this.ctx.createGain();
        const attack = opts.sustained ? Math.min(0.5, duration * 0.25) : Math.min(0.09, duration * 0.4);
        const release = opts.sustained ? Math.max(0.7, duration * 0.4) : Math.max(0.18, duration * 0.55);
        const peak = opts.sustained ? 0.85 : 0.7;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + attack);
        gain.gain.setValueAtTime(peak * 0.92, t0 + Math.max(attack, duration * 0.6));
        gain.gain.exponentialRampToValueAtTime(0.0008, t0 + duration + release);
        gain.connect(voice.sourceGain);

        const oscs = [];
        voice.detunes.forEach((cents, di) => {
            const osc = this.ctx.createOscillator();
            osc.setPeriodicWave(this.glottalWave);
            osc.detune.value = cents + (Math.random() - 0.5) * 4;   // tiny human jitter
            if (opts.slideFrom && isFinite(opts.slideFrom)) {
                osc.frequency.setValueAtTime(opts.slideFrom, t0);
                osc.frequency.exponentialRampToValueAtTime(freq, t0 + Math.min(0.12, duration * 0.4));
            } else {
                osc.frequency.setValueAtTime(freq, t0);
            }
            const copyGain = this.ctx.createGain();
            copyGain.gain.value = di === 0 ? 1.0 : 0.55;
            osc.connect(copyGain);
            copyGain.connect(gain);
            osc.start(t0);
            osc.stop(t0 + duration + release + 0.1);
            oscs.push(osc);
        });

        // Slow vibrato blooms on the long held notes (choral, not operatic).
        if (duration > 1.0) {
            const vib = this.ctx.createOscillator();
            vib.type = 'sine';
            vib.frequency.value = 4.6 + Math.random() * 0.9;
            const vibDepth = this.ctx.createGain();
            vibDepth.gain.value = freq * (opts.sustained ? 0.005 : 0.006);
            vib.connect(vibDepth);
            oscs.forEach(o => vibDepth.connect(o.frequency));
            vib.start(t0 + attack); vib.stop(t0 + duration + release);
        }

        const node = { oscs, gain };
        this.activeNotes.push(node);
        setTimeout(() => {
            const idx = this.activeNotes.indexOf(node);
            if (idx > -1) this.activeNotes.splice(idx, 1);
        }, (duration + release + 0.3 + (delay || 0)) * 1000);
    }

    // === Public transport / control ===

    async begin() {
        await this.init();
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this.setupVoices();
        setTimeout(() => { if (!this.isPlaying) this.start(); }, 1300);
    }

    end() { this.stop(); }

    setMode(mode) {
        this.currentMode = mode;
        if (this.isPlaying) this.buildCantus();
    }

    setRhythm(mode) { this.rhythmicMode = mode; }

    setVoices(count) {
        this.numVoices = count;
        if (this.voices.length) this.setupVoices();
    }

    setTenorVolume(v) {
        this.tenorVolume = v;
        if (this.tenorBus) this.tenorBus.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.2);
    }

    setUpperVolume(v) {
        this.upperVolume = v;
        if (this.upperBus) this.upperBus.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.2);
    }

    setReverbMix(v) {
        this.reverbMix = v;
        if (this.reverbGain && this.dryGain) {
            const now = this.ctx.currentTime;
            this.reverbGain.gain.linearRampToValueAtTime(v, now + 0.2);
            this.dryGain.gain.linearRampToValueAtTime(1 - v * 0.5, now + 0.2);
        }
    }

    setTempo(bpm) { this.tempo = bpm; }

    getAnalyserData() {
        if (!this.analyser) return null;
        const d = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteTimeDomainData(d);
        return d;
    }
    getFrequencyData() {
        if (!this.analyser) return null;
        const d = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(d);
        return d;
    }
}
