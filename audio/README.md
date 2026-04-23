# Audio files

Drop WAV files here with these exact names:

- `male.wav`    — male voice reading the script below
- `female.wav`  — female voice reading the script below
- `noise.wav`   — *optional*. Background noise, ideally multi-talker babble or
  ambient traffic/sirens. Looped under the speech. If missing, the app
  generates pink noise as a fallback.

All three files should be mono or stereo WAV, 16-bit PCM, 44.1 kHz or 48 kHz.

## Recording script

Keep each voice to ~15–20 seconds. The same recording plays through all four
profiles (normal, moderate, severe, asymmetric), so the listener compares
*processing differences*, not *content differences*. Use the same script for
both voices if you want maximum parity, or the two scripts below if you want
some variety.

### Male voice

> You will now hear me speaking while background noise is mixed in.
> Depending on the hearing profile, my voice will sound clear, muffled,
> or mostly unintelligible. This is roughly what a police officer or
> firefighter hears when a command comes over their headset in the field.

### Female voice

> Hearing loss is common among first responders because of years of
> exposure to sirens, engines, and gunfire. Most do not wear hearing aids —
> conventional aids don't fit under duty headsets, and stigma keeps them
> away until the loss is severe. This demo shows why assistance inside the
> headset matters.

## Generating with ElevenLabs

1. Pick a natural-sounding male voice and female voice.
2. Paste the corresponding script.
3. Export as WAV (not MP3 — MP3 works but WAV avoids codec artifacts).
4. Save to `audio/male.wav` / `audio/female.wav`.
5. Commit and push.

If the file is named differently or in a different directory, update
`AUDIO_PATHS` at the top of `../app.js`.
