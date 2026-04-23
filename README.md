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

- Audio graph: `speech → ChannelSplitter → [L chain | R chain] → ChannelMerger → master → destination`
- Each ear chain is eleven `BiquadFilterNode`s in series, type `peaking`, centered at
  125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, and 8000 Hz.
- Filter gain is **not** `-dB_HL` directly. dB HL is a threshold measurement;
  applying it as signal attenuation over-mutes speech. Instead:

    `effective_cut_dB = min(MAX, max(0, loss_dB − HEADROOM) × SCALE)`

  This is a practical sensation-level approximation. Defaults: `HEADROOM=15`,
  `SCALE=0.55`, `MAX=35`. The on-page **Sim intensity** slider scales `SCALE`
  live so you can match a reference simulator by ear.
- Background noise lives **outside** the webapp: the booth plays it from a
  separate pair of loudspeakers so speech and noise arrive from different
  directions.

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
4. Refresh the page.

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

If the EQ sounds too soft/sharp, adjust `PEAKING_Q` in `app.js` (default 1.0).
Lower Q = broader filters = smoother curve but more overlap between bands.
Higher Q = narrower but choppier. For bulk simulation intensity, use the
on-page `Sim intensity` slider — it scales the sensation-level mapping
live without touching code.

## Demo booth notes

The webapp drives the speech loudspeaker pair only. Background noise is
played from a separate pair of loudspeakers (traffic, sirens, engine
ambience, or whatever matches the scenario) so speech and noise arrive
from different directions — the way it does on an actual scene.

For unattended booth operation, check **Loop all day** in the controls.
The demo auto-restarts from stage 1 after the last stage finishes, with
a short pause at each loop boundary. On supported browsers, the page
also requests a screen wake-lock while running so the TV doesn't sleep.
One click on **Run full demo** in the morning is enough; no one has to
touch the computer for the rest of the day.
# pdp_gala_demo_website
