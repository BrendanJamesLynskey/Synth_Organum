# Synth Organum — Notre-Dame Polyphony Synthesizer

A web-based synthesizer that sings **Notre-Dame organum** in real time in the browser. Organum was *sung*, so every voice is now a **real recorded human voice**: the shared [`vocal-voices.js`](vocal-voices.js) library plays actual sung vowels from the [**VocalSet**](https://zenodo.org/records/1193957) corpus (CC BY 4.0), pitch-mapped with **formant-preserving** TD-PSOLA and tuned in pure **Pythagorean just intonation**.

> **Credit:** sampled voices derived from [**VocalSet**](https://zenodo.org/records/1193957) (Wilkins, Seetharaman, Wahl & Pardo, ISMIR 2018), CC BY 4.0.

**[Launch the app](https://brendanjameslynskey.github.io/Synth_Organum/)** — auto-detects your device and recommends desktop or mobile.

---

## The style

**Organum** is the earliest written Western polyphony — the practice of adding a voice to a plainchant. At the cathedral of **Notre-Dame in Paris** (c. 1160–1250) it reached its first great height. Over a **tenor** that sustains the notes of a borrowed chant in immensely long tones (the *vox principalis* / cantus firmus), one or more upper voices spin out florid melismas and meet the tenor, again and again, on the *perfect consonances* — unison, fourth, fifth and octave.

The two great masters were **Léonin**, of the two-voice *organum purum*, and **Pérotin**, who expanded it to three (*triplum*) and four (*quadruplum*) voices; their music was collected in the **Magnus Liber Organi**. The upper voices were ordered by the six **rhythmic modes** — repeating long–short patterns that first gave the West a notated, *measured* rhythm. This is the hinge on which all later Western polyphony turns.

## How it sounds high quality

Rather than equal-tempered tones, the engine builds every pitch and timbre from first principles:

- **Tuning** — pure **Pythagorean just intonation**: pitches are stacked 3:2 fifths reduced into the octave (`1/1, 9/8, 81/64, 4/3, 3/2, 27/16, 243/128, 2/1`). The octave (2/1), fifth (3/2), fourth (4/3) and twelfth (3/1) are *exact*, so the consonances at every cadence are **beatless** — the voices lock and the stone rings.
- **Voice** — **real recorded singing**, not synthesis: actual sung vowels from the **VocalSet** corpus, looped into seamless sustains and pitch-mapped across the range with **formant-preserving** TD-PSOLA (the formants stay put as the pitch moves, so a low tenor note still sounds like a voice and not a chipmunk). Each part is a small **chorus** of the sampled voice, slightly detuned and panned with independent vibrato and breath; the centre singer of each part stays exactly in tune so the inter-voice consonances remain beatless. Syllable onsets are articulated with procedural **consonants** (sibilants, plosives, nasals) so the chant text is pronounced, while the melismas flow on the vowel.
- **Texture** — a sustained **tenor cantus firmus** beneath **florid melismatic upper voices** (duplum · triplum · quadruplum) that move faster above it and cadence onto perfect consonances (fifth, octave, twelfth, double octave), stacking the open Pérotin sonority.
- **Rhythm** — the upper voices follow one of the six **rhythmic modes**.
- **Space** — a very long **great-cathedral convolution reverb** (~7 s tail) with sparse early reflections.

## Where it sits — the lineage of early Western music

Organum *is* plainsong with voices added — and the measured rhythm invented here is the seed of everything after:

```
Plainsong ──► Organum ──► Ars Nova ──► (Renaissance polyphony)
   │        (a 2nd voice   (rhythmic
   │         is added)      sophistication)
   │
   └── chant supplies the fixed cantus firmus the tenor holds
```

A parallel, secular, vernacular branch runs alongside it: **Troubadour** song → instrumental **Estampie** dances.

| App | Style | Synthesis technique |
|---|---|---|
| [Synth Gregorian](https://github.com/BrendanJamesLynskey/Synth_Gregorian) | Plainsong | Source–filter formant vocal synthesis |
| **Synth Organum** (this) | Notre-Dame polyphony | Real sampled voices in Pythagorean just intonation |
| [Synth Ars Nova](https://github.com/BrendanJamesLynskey/Synth_ArsNova) | 14th-c. isorhythm | Formant vocal synthesis + isorhythmic talea/color |
| [Synth Troubadour](https://github.com/BrendanJamesLynskey/Synth_Troubadour) | Secular monophony | Formant vocal melody over a subtractive drone |
| [Synth Estampie](https://github.com/BrendanJamesLynskey/Synth_Estampie) | Medieval dance | Physical modelling (instrumental dance) |

## Quick start

```bash
git clone https://github.com/BrendanJamesLynskey/Synth_Organum.git
cd Synth_Organum
python3 -m http.server 8080
```

Open <http://localhost:8080> and press **Begin Organum**. Any static file server works — there is no build step or dependency.

## Files

| File | Purpose |
|---|---|
| `index.html` | Landing page — detects device, links to desktop or mobile |
| `desktop.html` | Desktop web app |
| `style.css` | Stained-glass-themed styles (lapis blue, gold leading) |
| `vocal-voices.js` | Shared sampled-voice library — real VocalSet vowels, formant-preserving pitch-mapping, and procedural consonant articulation |
| `organum-engine.js` | Pythagorean-tuned polyphony engine driving `vocal-voices.js` (Web Audio API) |
| `app.js` | UI controller, rose-window visualizer, floating motes |
| `organum_mobile.html` | Self-contained mobile version (single file) |

## Controls

| Control | Description |
|---|---|
| **Mode** | One of the 8 church tones (Dorian → Hypomixolydian) — sets the finalis and reciting tenor |
| **Rhythmic Mode** | One of the 6 medieval rhythmic modes (long–short patterns) the upper voices follow |
| **Tenor** | Volume of the sustained cantus-firmus voice |
| **Upper Voices** | Volume of the florid melismatic voices |
| **Cathedral Reverb** | Wet/dry mix of the ~7 s great-cathedral convolution reverb |
| **Pace** | Speed of the melisma over the held tenor |
| **Voices** | Duplum (2 · Léonin), Triplum (3), or Quadruplum (4 · Pérotin) |

## License

MIT
