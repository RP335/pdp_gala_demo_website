# Hearing Loss Simulator

One-page webapp that simulates how speech sounds through different
hearing-loss profiles. Built for the Aalto Product Development Project on
hearing-aid algorithms for first responders — police, firefighters, and
other professionals who work in high-noise environments and can't wear
conventional hearing aids because of their duty headsets.

Runs entirely in the browser. No backend. Hostable on GitHub Pages.

## What it shows

For each stage, the same voice recording is played through a stereo
eleven-band EQ that matches a clinical audiogram. The four profiles are:

| Profile     | What it represents                                    |
|-------------|-------------------------------------------------------|
| Normal      | Baseline hearing (0 dB HL all bands, both ears)       |
| Moderate    | Age-typical mid/high-frequency loss                   |
| Severe      | Advanced loss with strong 3–8 kHz attenuation         |
| Asymmetric  | Right ear much worse than left (common with gunfire)  |

The sequence alternates a male voice and a female voice through all four
profiles — eight stages total. A live audiogram and the applied EQ curve
update per stage.

## How the DSP works

- Audio graph: `speech + noise → ChannelSplitter → [L chain | R chain] → ChannelMerger → master → destination`
- Each ear chain is eleven `BiquadFilterNode`s in series, type `peaking`, centered at
  125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, and 8000 Hz.
- Each filter's gain is set to the negative of the dB HL at that band, so
  e.g. 40 dB HL at 4 kHz means a 40 dB cut at 4 kHz.
- Background noise is either a user-supplied `audio/noise.wav` (loops
  under the speech) or generated pink noise as a fallback.

Limitation: this is a **spectral/loudness** simulation only. Real hearing
loss also changes temporal processing, recruitment, and cognitive load,
none of which a pure EQ captures. The demo is meant to communicate the
problem, not to replace a clinical test — there's a caveat on the page
that says so.

## Running locally

Safari, Chrome, Firefox — anything with Web Audio API.

```
# From the webapp/ directory
python3 -m http.server 8000
# then open http://localhost:8000
```

You need a local server (not `file://`) because `fetch()` is used to load
the WAVs.

## Getting audio files

1. Read `audio/README.md` — it has the script.
2. Generate with ElevenLabs (or record your own).
3. Save as `audio/male.wav` and `audio/female.wav`.
4. (Optional) Add `audio/noise.wav` for custom background noise.
5. Refresh the page.

The app loads audio on startup and shows which files it found in the
status line at the bottom of the controls panel. If a file is missing,
that stage is skipped during the auto-advance demo.

## Deploying to GitHub Pages

```
git init
git add .
git commit -m "Hearing loss simulator — initial demo"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

In the repo settings → Pages → deploy from `main` branch / `/` (root).
Site goes live at `https://<user>.github.io/<repo>/`.

## Files

```
index.html         UI layout
style.css          Dark theme, TV-friendly large type
app.js             Web Audio engine + audiogram/EQ canvas rendering
audio/             Drop-in WAVs (see audio/README.md)
reference_website.pdf  The audiogram reference used to build the profiles
```

## Tuning

The audiogram values live in `app.js` at the `PROFILES` constant. Edit
them to match different clinical cases. The canvas renders automatically
from whatever numbers are in there.

If the EQ sounds too soft/sharp, adjust `PEAKING_Q` in `app.js`. Lower Q
= broader filters = smoother curve but more overlap between bands.
Higher Q = narrower but choppier. Default 1.4 is a typical graphic-EQ
choice.

## Demo booth notes

At the booth, the webapp is intended to run on a TV with a pair of
speakers playing the processed speech. If a separate noise speaker is
available, set the in-app `Noise` slider to 0 and play `audio/noise.wav`
from the second speaker pair directly. That gives the audience a spatial
sense of "speech vs. noise" the way a real incident scene would sound.
# pdp_gala_demo_website
