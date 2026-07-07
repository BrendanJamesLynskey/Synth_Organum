/**
 * Notre-Dame Organum Synthesis Engine — FOF (Formant-Wave-Function) Vocal Synthesis
 *                                        in Pythagorean Just Intonation
 *
 * Organum was SUNG. To get genuinely vocal — not "filtered-synth" — tone, this
 * engine uses FOF synthesis (fonction d'onde formantique), the IRCAM CHANT
 * technique behind the classic realistic synthetic-choir sounds.
 *
 *   - FOF VOICE : the voice is NOT an oscillator run through a filter. Instead,
 *                 once per glottal period a burst of damped formant "grains" is
 *                 fired — each formant is a sine at its centre frequency, wrapped
 *                 in an excitation envelope whose decay sets the formant bandwidth.
 *                 Overlapping these grains at the fundamental rate reconstructs a
 *                 true vocal spectrum with real formant peaks and a natural,
 *                 breathy, human timbre. This runs sample-accurately in an
 *                 AudioWorklet (`fof-voice`), loaded from an inline Blob so the
 *                 app stays self-contained. Each sung part is a small chorus of
 *                 detuned FOF singers with independent vibrato and pitch jitter.
 *   - TUNING    : every pitch is a pure PYTHAGOREAN ratio — stacked 3:2 fifths
 *                 reduced into the octave — so the octaves/fifths/twelfths at each
 *                 cadence are beatless and the voices lock and ring.
 *   - TEXTURE   : a dark sustained TENOR (cantus firmus) beneath florid melismatic
 *                 upper voices (duplum · triplum · quadruplum) cadencing onto
 *                 perfect consonances — the Pérotin "organum purum" texture.
 *
 * Plus the 8 church tones, the 6 rhythmic modes, and a ~7 s cathedral reverb.
 */

// ── FOF AudioWorklet processor (runs on the audio thread) ─────────────────────
const FOF_WORKLET_SRC = `
class FofVoiceProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'frequency', defaultValue: 130, minValue: 20, maxValue: 3000, automationRate: 'a-rate' },
            { name: 'level',     defaultValue: 0,   minValue: 0,  maxValue: 2,    automationRate: 'a-rate' }
        ];
    }
    constructor(options) {
        super();
        const o = (options && options.processorOptions) || {};
        this.sr = sampleRate;
        this.phase = 0;
        this.grains = [];                       // active glottal pulses (age in samples)
        this.formants = o.formants || [{f:600,a:1,bw:90},{f:1000,a:0.4,bw:100},{f:2500,a:0.2,bw:120},{f:2900,a:0.16,bw:130}];
        this.tex = o.tex || 0.004;              // excitation attack skirt (s)
        this.breath = (o.breath != null) ? o.breath : 0.06;
        this.jitter = (o.jitter != null) ? o.jitter : 0.03;
        this.vibRate = 4.4 + Math.random() * 1.4;
        this.vibDepth = (o.vibDepth != null) ? o.vibDepth : 0.006;
        this.vibPhase = Math.random() * 6.283;
        this.pruneAge = Math.floor(0.06 * this.sr);
        this.maxGrains = 24;
        this.port.onmessage = (e) => {
            if (e.data.formants) this.formants = e.data.formants;
            if (e.data.breath != null) this.breath = e.data.breath;
        };
    }
    process(inputs, outputs, params) {
        const out = outputs[0][0];
        if (!out) return true;
        const fArr = params.frequency, lArr = params.level;
        const n = out.length, TAU = 6.283185307179586;
        for (let i = 0; i < n; i++) {
            const level = lArr.length > 1 ? lArr[i] : lArr[0];
            let f0 = fArr.length > 1 ? fArr[i] : fArr[0];
            // gentle vibrato
            this.vibPhase += TAU * this.vibRate / this.sr;
            if (this.vibPhase > TAU) this.vibPhase -= TAU;
            f0 *= 1 + Math.sin(this.vibPhase) * this.vibDepth;

            // spawn a new glottal pulse each fundamental period
            this.phase += f0 / this.sr;
            if (this.phase >= 1) {
                this.phase -= 1;
                if (level > 0.0002 || this.grains.length) {
                    this.grains.push({ age: 0, amp: 1 + (Math.random() - 0.5) * this.jitter });
                    while (this.grains.length && this.grains[0].age > this.pruneAge) this.grains.shift();
                    if (this.grains.length > this.maxGrains) this.grains.shift();
                }
            }

            let s = 0;
            const F = this.formants, tex = this.tex;
            for (let g = 0; g < this.grains.length; g++) {
                const gr = this.grains[g];
                const t = gr.age / this.sr;
                let atk = 1;
                if (t < tex) atk = 0.5 * (1 - Math.cos(Math.PI * t / tex));
                for (let k = 0; k < F.length; k++) {
                    const fm = F[k];
                    const env = atk * Math.exp(-Math.PI * fm.bw * t);
                    if (env > 1e-4) s += gr.amp * fm.a * env * Math.sin(TAU * fm.f * t);
                }
                gr.age++;
            }
            if (this.breath > 0) s += (Math.random() * 2 - 1) * this.breath * (0.4 + 0.6 * Math.min(1, this.grains.length / 3));
            out[i] = s * level * 0.22;
        }
        return true;
    }
}
registerProcessor('fof-voice', FofVoiceProcessor);
`;

class OrganumEngine {
    constructor() {
        this.ctx = null;
        this.isPlaying = false;
        this.currentMode = 1;
        this.rhythmicMode = 1;
        this.numVoices = 2;
        this.tempo = 46;
        this.tenorVolume = 0.85;
        this.upperVolume = 0.7;
        this.reverbMix = 0.62;

        this.voices = [];
        this.cantusTimeout = null;
        this.hasFOF = false;

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

        // === Sung-vowel FOF formant tables: {f: Hz, a: amp, bw: kHz-ish decay} ===
        // Bandwidths are in kHz for the FOF decay term (exp(-pi*bw*1000... )) — here
        // expressed directly so exp(-pi*bw*t) with bw in Hz. Rounder F1-dominant
        // balance keeps the tone vocal, not buzzy.
        this.vowels = {
            a: [{f:650,a:1,bw:80},   {f:1080,a:0.5,bw:90},  {f:2650,a:0.26,bw:120}, {f:2900,a:0.18,bw:130}],
            e: [{f:400,a:1,bw:70},   {f:1700,a:0.42,bw:100},{f:2500,a:0.3,bw:120},  {f:2900,a:0.2,bw:130}],
            o: [{f:400,a:1,bw:70},   {f:760,a:0.34,bw:80},  {f:2550,a:0.2,bw:120},  {f:2850,a:0.14,bw:130}],
            u: [{f:350,a:1,bw:65},   {f:600,a:0.26,bw:75},  {f:2400,a:0.16,bw:120}, {f:2800,a:0.1,bw:130}]
        };
        this.voiceVowels = ['o', 'a', 'e', 'a'];       // tenor dark; upper voices open

        this.cantus = [];
        this.cantusPos = 0;
        this._workletURL = null;
    }

    async init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.9;

        // Soft limiter so overlapping grains never clip the vault.
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -8;
        this.limiter.knee.value = 8;
        this.limiter.ratio.value = 6;
        this.limiter.attack.value = 0.004;
        this.limiter.release.value = 0.25;
        this.masterGain.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);

        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.85;
        this.limiter.connect(this.analyser);

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

        // Load the FOF worklet from an inline Blob (keeps the app self-contained).
        try {
            const blob = new Blob([FOF_WORKLET_SRC], { type: 'application/javascript' });
            this._workletURL = URL.createObjectURL(blob);
            await this.ctx.audioWorklet.addModule(this._workletURL);
            this.hasFOF = true;
        } catch (e) {
            this.hasFOF = false;                       // fall back to source–filter
            this.buildGlottalWave();
        }
    }

    /** Fallback source (only used if AudioWorklet is unavailable). */
    buildGlottalWave() {
        const n = 40, real = new Float32Array(n), imag = new Float32Array(n);
        for (let k = 1; k < n; k++) imag[k] = 1 / Math.pow(k, 1.3);
        this.glottalWave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
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

    degToFreq(deg) {
        const idx = ((deg % 7) + 7) % 7;
        const oct = Math.floor(deg / 7);
        return this.basePitch * this.ratios[idx] * Math.pow(2, oct);
    }

    /**
     * Build one SUNG PART as a small chorus of detuned FOF singers sharing a
     * note-envelope gain: [FOF ×3] → noteGain → voiceGain(persistent fade) → bus.
     * The centre singer is exactly in tune so inter-voice consonances stay pure.
     */
    createVoice(index, total) {
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

        const singers = [];               // {node|osc, detuneFactor, freqParam}
        const detunes = role === 'tenor' ? [0, -6, 6] : [0, -8, 9];

        if (this.hasFOF) {
            const formants = this.vowels[vowel];
            detunes.forEach((cents, di) => {
                const node = new AudioWorkletNode(this.ctx, 'fof-voice', {
                    numberOfInputs: 0, outputChannelCount: [1],
                    processorOptions: {
                        formants,
                        breath: role === 'tenor' ? 0.05 : 0.07,
                        jitter: 0.03 + di * 0.01,
                        vibDepth: (role === 'tenor' ? 0.005 : 0.007) + di * 0.001,
                        tex: 0.004
                    }
                });
                const sg = this.ctx.createGain();
                sg.gain.value = di === 0 ? 1.0 : 0.7;
                node.connect(sg); sg.connect(noteGain);
                singers.push({ node, freqParam: node.parameters.get('frequency'),
                               levelParam: node.parameters.get('level'),
                               detuneFactor: Math.pow(2, cents / 1200) });
            });
        }

        return { role, index, vowel, voiceGain, noteGain, singers, detunes };
    }

    setupVoices() {
        this.teardownVoices();
        for (let v = 0; v < this.numVoices; v++) this.voices.push(this.createVoice(v, this.numVoices));
    }

    teardownVoices() {
        const now = this.ctx ? this.ctx.currentTime : 0;
        for (const voice of this.voices) {
            try {
                voice.voiceGain.gain.cancelScheduledValues(now);
                voice.voiceGain.gain.setValueAtTime(voice.voiceGain.gain.value, now);
                voice.voiceGain.gain.linearRampToValueAtTime(0, now + 2.2);
                setTimeout(() => {
                    try { voice.singers.forEach(s => { s.levelParam && s.levelParam.setValueAtTime(0, this.ctx.currentTime); s.node.disconnect(); }); } catch (e) {}
                }, 2600);
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

    start() {
        this.isPlaying = true;
        this.buildCantus();
        this.scheduleTenorNote();
    }

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

        let cur = centerOffset, lastFreq = null;
        segs.forEach((seg, i) => {
            let freq;
            if (i === segs.length - 1) {
                freq = tenorFreq * cadenceRatio;
            } else {
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

    /**
     * Sing one note on a part: steer each FOF singer's frequency (pure centre +
     * detuned neighbours) and re-shape the shared note-envelope. Melisma notes
     * glide legato; the tenor swells slowly.
     */
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

        if (this.hasFOF) {
            voice.singers.forEach(s => {
                const target = freq * s.detuneFactor;
                if (opts.slideFrom && isFinite(opts.slideFrom)) {
                    s.freqParam.cancelScheduledValues(t0);
                    s.freqParam.setValueAtTime(opts.slideFrom * s.detuneFactor, t0);
                    s.freqParam.exponentialRampToValueAtTime(target, t0 + Math.min(0.13, duration * 0.4));
                } else {
                    s.freqParam.cancelScheduledValues(t0);
                    s.freqParam.setValueAtTime(target, t0);
                }
                s.levelParam.cancelScheduledValues(t0);
                s.levelParam.setValueAtTime(1, t0);
            });
        } else {
            this.playFallbackNote(voice, freq, duration, delay, opts, t0);
        }
    }

    /** Minimal source–filter note if the worklet could not load. */
    playFallbackNote(voice, freq, duration, delay, opts, t0) {
        if (!voice._formant) {
            const centres = this.vowels[voice.vowel];
            voice._src = this.ctx.createGain();
            voice._formant = centres.map((fm) => {
                const bp = this.ctx.createBiquadFilter();
                bp.type = 'bandpass'; bp.frequency.value = fm.f; bp.Q.value = fm.f / (fm.bw * 3);
                const fg = this.ctx.createGain(); fg.gain.value = fm.a;
                voice._src.connect(bp); bp.connect(fg); fg.connect(voice.noteGain);
                return bp;
            });
        }
        voice.detunes.forEach((cents, di) => {
            const osc = this.ctx.createOscillator();
            osc.setPeriodicWave(this.glottalWave);
            osc.detune.value = cents;
            osc.frequency.setValueAtTime(freq, t0);
            const og = this.ctx.createGain(); og.gain.value = di === 0 ? 1 : 0.6;
            osc.connect(og); og.connect(voice._src);
            osc.start(t0); osc.stop(t0 + duration + 1.0);
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
