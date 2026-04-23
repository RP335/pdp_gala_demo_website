// Hearing Loss Simulator — Aalto PdP
// Plain-JS / Web Audio API. No build step. Hostable on GitHub Pages.

// ============================================================
// 1. Audiogram profiles (dB HL per band, per ear)
// ============================================================

const FREQS = [125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000];

// Hearing-loss profiles. Values are dB HL (positive = more loss).
// Symmetric profiles have L == R. Asymmetric mirrors real noise-induced loss
// from e.g. firearms training: one ear clearly worse than the other.
const PROFILES = {
  normal: {
    label: "Normal hearing",
    L: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    R: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  moderate: {
    label: "Moderate loss",
    L: [0, 0, 10, 15, 20, 25, 30, 30, 40, 30, 20],
    R: [0, 0, 10, 15, 20, 25, 30, 30, 40, 30, 20],
  },
  severe: {
    label: "Severe loss",
    L: [10, 10, 20, 20, 20, 30, 40, 50, 55, 60, 60],
    R: [10, 10, 20, 20, 20, 30, 40, 50, 55, 60, 60],
  },
  asymmetric: {
    label: "Asymmetric loss (right worse)",
    L: [0, 0, 5, 10, 15, 20, 25, 25, 30, 25, 20],
    R: [10, 10, 20, 20, 25, 35, 45, 55, 60, 60, 60],
  },
};

// ============================================================
// 2. Demo script + stages
// ============================================================

const TRANSCRIPTS = {
  male:
    "You will now hear me speaking. Depending on the hearing profile, my " +
    "voice will sound clear, muffled, or mostly unintelligible. This is " +
    "roughly what a police officer or firefighter hears when a command " +
    "comes over their headset in the field.",
  female:
    "Hearing loss is common among first responders because of years of " +
    "exposure to sirens, engines, and gunfire. Most do not wear hearing aids " +
    "— conventional aids don't fit under duty headsets, and stigma keeps " +
    "them away until the loss is severe. This demo shows why assistance " +
    "inside the headset matters.",
};

const STAGES = [
  { voice: "male",   profile: "normal",     durationSec: null },
  { voice: "male",   profile: "moderate",   durationSec: null },
  { voice: "male",   profile: "severe",     durationSec: null },
  { voice: "male",   profile: "asymmetric", durationSec: null },
  { voice: "female", profile: "normal",     durationSec: null },
  { voice: "female", profile: "moderate",   durationSec: null },
  { voice: "female", profile: "severe",     durationSec: null },
  { voice: "female", profile: "asymmetric", durationSec: null },
];

// ============================================================
// 3. Audio engine
// ============================================================

const AUDIO_PATHS = {
  male: "audio/male.wav",
  female: "audio/female.wav",
};

// Lower Q → broader, smoother peaking filters with less cumulative overlap
// between adjacent bands. 1.4 was too narrow+overlapping and piled up
// attenuation in the 3–8 kHz region of the severe profile.
const PEAKING_Q = 1.0;

// dB HL on an audiogram is a *threshold* measurement, not a signal
// attenuation. A listener with 40 dB HL at 4 kHz still hears conversational
// speech at 4 kHz — it's just above their raised threshold by ~20 dB of
// sensation level, not silent. Applying -loss_dB directly to the signal
// over-attenuates drastically.
//
// This is a practical approximation of the sensation-level model:
//   effective_cut = min(MAX, max(0, loss_dB - HEADROOM) * SCALE)
// The HEADROOM accounts for speech sitting well above normal threshold;
// SCALE compresses the residual loss into perceived attenuation; MAX caps
// the per-band cut to avoid unstable filters and cumulative overlap.
const SIM = {
  headroomDb: 15,
  scale: 0.55,
  maxCutDb: 35,
};

function lossToCutDb(lossDb) {
  const raw = Math.max(0, lossDb - SIM.headroomDb) * SIM.scale;
  return Math.min(SIM.maxCutDb, raw);
}

class Engine {
  constructor() {
    this.ctx = null;
    this.buffers = { male: null, female: null };
    this.speechSource = null;
    this.speechGain = null;
    this.masterGain = null;
    this.splitter = null;
    this.merger = null;
    this.filtersL = [];
    this.filtersR = [];
    this.activeProfile = PROFILES.normal;
    this.playing = false;
    this.currentVoice = null;
    this.onEnded = null;
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // One peaking biquad per band, per ear. All chained in series per side.
    const makeChain = (bands) => {
      const chain = [];
      for (const f of FREQS) {
        const filter = this.ctx.createBiquadFilter();
        filter.type = "peaking";
        filter.frequency.value = f;
        filter.Q.value = PEAKING_Q;
        filter.gain.value = 0;
        chain.push(filter);
      }
      // series wiring
      for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
      return chain;
    };

    this.filtersL = makeChain();
    this.filtersR = makeChain();

    // Force stereo with "speakers" interpretation so a mono WAV is
    // duplicated to L+R before the per-ear split. Without this, mono input
    // would leave the right channel silent.
    this.speechGain = this.ctx.createGain();
    this.speechGain.gain.value = 0.9;
    this.speechGain.channelCount = 2;
    this.speechGain.channelCountMode = "explicit";
    this.speechGain.channelInterpretation = "speakers";

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;

    // Speech → split to per-ear filter chains → merge.
    this.splitter = this.ctx.createChannelSplitter(2);
    this.merger = this.ctx.createChannelMerger(2);

    this.speechGain.connect(this.splitter);

    this.splitter.connect(this.filtersL[0], 0);
    this.splitter.connect(this.filtersR[0], 1);

    this.filtersL[this.filtersL.length - 1].connect(this.merger, 0, 0);
    this.filtersR[this.filtersR.length - 1].connect(this.merger, 0, 1);

    this.merger.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
  }

  async loadBuffers() {
    const results = { male: false, female: false };

    const tryLoad = async (key) => {
      try {
        const res = await fetch(AUDIO_PATHS[key]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arr = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(arr);
        this.buffers[key] = buf;
        results[key] = true;
      } catch (e) {
        this.buffers[key] = null;
        results[key] = false;
      }
    };

    await Promise.all([tryLoad("male"), tryLoad("female")]);
    return results;
  }

  applyProfile(profile) {
    this.activeProfile = profile;
    const t = this.ctx.currentTime;
    for (let i = 0; i < FREQS.length; i++) {
      // Map clinical dB HL → effective signal attenuation via the
      // sensation-level approximation (see SIM constants / lossToCutDb).
      const cutL = -lossToCutDb(profile.L[i]);
      const cutR = -lossToCutDb(profile.R[i]);
      this.filtersL[i].gain.setTargetAtTime(cutL, t, 0.03);
      this.filtersR[i].gain.setTargetAtTime(cutR, t, 0.03);
    }
  }

  playStage(voice, profile, onEnded) {
    if (!this.buffers[voice]) {
      onEnded && onEnded({ reason: "missing" });
      return null;
    }
    this.stop(); // stop any existing source
    this.applyProfile(profile);
    this.currentVoice = voice;
    this.onEnded = onEnded;

    this.speechSource = this.ctx.createBufferSource();
    this.speechSource.buffer = this.buffers[voice];
    this.speechSource.connect(this.speechGain);

    this.speechSource.onended = () => {
      if (!this.playing) return; // already stopped externally
      this.playing = false;
      const cb = this.onEnded;
      this.onEnded = null;
      cb && cb({ reason: "complete" });
    };

    this.speechSource.start(this.ctx.currentTime + 0.05);
    this.playing = true;
    return this.buffers[voice].duration;
  }

  stop() {
    this.playing = false;
    try { if (this.speechSource) this.speechSource.stop(); } catch (_) {}
    this.speechSource = null;
  }

  setSpeechGain(v) { this.speechGain && (this.speechGain.gain.value = v); }
  setMasterGain(v) { this.masterGain && (this.masterGain.gain.value = v); }

  resume() { return this.ctx.resume(); }
  suspend() { return this.ctx.suspend(); }
}

// ============================================================
// 4. Audiogram + EQ curve drawing
// ============================================================

function drawAudiogram(canvas, profile) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 50, padR = 20, padT = 20, padB = 36;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const minF = Math.log2(125);
  const maxF = Math.log2(8000);
  const xFor = (f) => padL + ((Math.log2(f) - minF) / (maxF - minF)) * plotW;

  const dbMin = -10;
  const dbMax = 80;
  const yFor = (db) => padT + ((db - dbMin) / (dbMax - dbMin)) * plotH;

  // dB severity bands (matches the reference audiogram shading)
  const bands = [
    { from: -10, to: 25, color: "#e6f4ea" }, // normal
    { from: 25,  to: 40, color: "#e8f0fe" }, // mild
    { from: 40,  to: 55, color: "#eae6f7" }, // moderate
    { from: 55,  to: 70, color: "#fff4e5" }, // moderately severe
    { from: 70,  to: 80, color: "#fde8e8" }, // severe
  ];
  for (const b of bands) {
    ctx.fillStyle = b.color;
    ctx.fillRect(padL, yFor(b.from), plotW, yFor(b.to) - yFor(b.from));
  }

  // grid
  ctx.strokeStyle = "#c9ced8";
  ctx.lineWidth = 1;
  ctx.font = "12px ui-sans-serif, system-ui";
  ctx.fillStyle = "#444";

  // horizontal (dB) grid
  for (let db = 0; db <= 80; db += 10) {
    const y = yFor(db);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.strokeStyle = db === 0 ? "#888" : "#d8dce3";
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(String(db), padL - 6, y);
  }

  // vertical (freq) grid
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const f of FREQS) {
    const x = xFor(f);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.strokeStyle = "#e1e5ec";
    ctx.stroke();
    const label = f >= 1000 ? (f / 1000) + "k" : String(f);
    ctx.fillStyle = "#444";
    ctx.fillText(label, x, padT + plotH + 6);
  }

  // frame
  ctx.strokeStyle = "#9aa3b2";
  ctx.strokeRect(padL, padT, plotW, plotH);

  // Axis titles
  ctx.save();
  ctx.translate(14, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#333";
  ctx.fillText("Hearing level (dB HL)", 0, 0);
  ctx.restore();

  ctx.fillStyle = "#333";
  ctx.textAlign = "center";
  ctx.fillText("Frequency (Hz)", padL + plotW / 2, cssH - 6);

  // plot left (blue X) and right (red O)
  const plotSeries = (values, color, marker) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]);
      const y = yFor(db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]);
      const y = yFor(db);
      if (marker === "x") {
        ctx.beginPath();
        ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6);
        ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
  };

  plotSeries(profile.L, "#2b6cff", "x");
  plotSeries(profile.R, "#e0334c", "o");

  // legend
  ctx.font = "12px ui-sans-serif, system-ui";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const lx = padL + 8;
  const ly = padT + 10;
  ctx.fillStyle = "#e0334c"; ctx.beginPath(); ctx.arc(lx + 4, ly, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#333"; ctx.fillText("Right ear (O)", lx + 16, ly);
  ctx.fillStyle = "#2b6cff";
  const lx2 = lx + 110;
  ctx.beginPath();
  ctx.moveTo(lx2 - 2, ly - 5); ctx.lineTo(lx2 + 10, ly + 5);
  ctx.moveTo(lx2 + 10, ly - 5); ctx.lineTo(lx2 - 2, ly + 5);
  ctx.stroke();
  ctx.fillStyle = "#333"; ctx.fillText("Left ear (X)", lx2 + 16, ly);
}

function drawEqCurve(canvas, profile) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 50, padR = 20, padT = 16, padB = 30;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const minF = Math.log2(125);
  const maxF = Math.log2(8000);
  const xFor = (f) => padL + ((Math.log2(f) - minF) / (maxF - minF)) * plotW;

  const dbMin = -70, dbMax = 10;
  const yFor = (db) => padT + ((dbMax - db) / (dbMax - dbMin)) * plotH;

  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(0, 0, cssW, cssH);

  // grid
  ctx.strokeStyle = "#d8dce3";
  ctx.fillStyle = "#444";
  ctx.font = "11px ui-sans-serif, system-ui";
  for (let db = -60; db <= 0; db += 20) {
    const y = yFor(db);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
    ctx.strokeStyle = db === 0 ? "#888" : "#d8dce3";
    ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(String(db), padL - 6, y);
  }

  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const f of FREQS) {
    const x = xFor(f);
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    ctx.strokeStyle = "#e1e5ec";
    ctx.stroke();
    const label = f >= 1000 ? (f / 1000) + "k" : String(f);
    ctx.fillStyle = "#444";
    ctx.fillText(label, x, padT + plotH + 4);
  }

  ctx.strokeStyle = "#9aa3b2";
  ctx.strokeRect(padL, padT, plotW, plotH);

  const plotAppliedGain = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]);
      const y = yFor(-lossToCutDb(db)); // applied cut (sensation-level mapped)
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]);
      const y = yFor(-lossToCutDb(db));
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    });
  };

  // Ghost line: raw audiogram dB (for comparison — shows how much the
  // sensation-level mapping compresses the clinical values).
  const plotGhost = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]);
      const y = yFor(-db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };

  plotGhost(profile.L, "#2b6cff");
  plotGhost(profile.R, "#e0334c");
  plotAppliedGain(profile.L, "#2b6cff");
  plotAppliedGain(profile.R, "#e0334c");

  // Small inline legend explaining the dashed ghost line.
  ctx.fillStyle = "#555";
  ctx.font = "11px ui-sans-serif, system-ui";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText("solid = applied EQ · dashed = raw audiogram dB HL",
               cssW - padR - 2, padT + plotH - 4);
}

// ============================================================
// 5. UI / state machine
// ============================================================

const els = {
  voiceLabel: document.getElementById("voiceLabel"),
  profileLabel: document.getElementById("profileLabel"),
  transcript: document.getElementById("transcript"),
  progressFill: document.getElementById("progressFill"),
  stageDots: document.getElementById("stageDots"),
  audiogram: document.getElementById("audiogram"),
  eqcurve: document.getElementById("eqcurve"),
  playBtn: document.getElementById("playBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  stopBtn: document.getElementById("stopBtn"),
  speechGain: document.getElementById("speechGain"),
  masterGain: document.getElementById("masterGain"),
  simIntensity: document.getElementById("simIntensity"),
  simIntensityVal: document.getElementById("simIntensityVal"),
  loopToggle: document.getElementById("loopToggle"),
  audioStatus: document.getElementById("audioStatus"),
};

const engine = new Engine();
let stageIdx = -1;
let running = false;          // "auto-advance through all stages"
let loopEnabled = false;      // wrap back to stage 0 after the last one
let progressTimer = null;
let stageStartTime = 0;
let stageDuration = 0;
let wakeLock = null;

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (_) { /* browser may refuse; safe to ignore */ }
}

// Re-acquire the wake lock when the tab becomes visible again — browsers
// release it automatically when a tab is backgrounded.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running) requestWakeLock();
});

function buildDots() {
  els.stageDots.innerHTML = "";
  STAGES.forEach((_, i) => {
    const d = document.createElement("div");
    d.className = "dot";
    d.title = `${STAGES[i].voice} · ${PROFILES[STAGES[i].profile].label}`;
    els.stageDots.appendChild(d);
  });
}

function updateDots() {
  [...els.stageDots.children].forEach((d, i) => {
    d.classList.toggle("current", i === stageIdx);
    d.classList.toggle("done", i < stageIdx);
  });
}

function updateStageUi(stage) {
  const profile = PROFILES[stage.profile];
  els.voiceLabel.textContent =
    (stage.voice === "male" ? "Male voice" : "Female voice");
  els.profileLabel.textContent = profile.label;
  els.transcript.textContent = TRANSCRIPTS[stage.voice];
  drawAudiogram(els.audiogram, profile);
  drawEqCurve(els.eqcurve, profile);
  updateDots();
}

function setStatus(text, cls) {
  els.audioStatus.textContent = text;
  els.audioStatus.className = "status" + (cls ? " " + cls : "");
}

function startProgress(duration) {
  stopProgress();
  stageStartTime = performance.now();
  stageDuration = duration * 1000;
  progressTimer = setInterval(() => {
    const pct = Math.min(
      100,
      ((performance.now() - stageStartTime) / stageDuration) * 100
    );
    els.progressFill.style.width = pct + "%";
  }, 80);
}

function stopProgress() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

async function runStage(idx, { autoAdvance }) {
  if (idx < 0 || idx >= STAGES.length) return;
  stageIdx = idx;
  const stage = STAGES[idx];
  updateStageUi(stage);

  await engine.resume();

  const duration = engine.playStage(stage.voice, PROFILES[stage.profile], (info) => {
    stopProgress();
    els.progressFill.style.width = "100%";
    if (info.reason === "missing") {
      setStatus(
        `Audio file not found: audio/${stage.voice}.wav — drop in a WAV to play this voice.`,
        "warn"
      );
      if (autoAdvance && running) {
        const nextIdx = idx + 1 < STAGES.length ? idx + 1
                      : loopEnabled ? 0 : -1;
        if (nextIdx >= 0) {
          setTimeout(() => runStage(nextIdx, { autoAdvance: true }), 200);
        } else {
          running = false;
          els.playBtn.textContent = "▶ Run full demo";
        }
      }
      return;
    }
    if (autoAdvance && running) {
      const isLast = idx + 1 >= STAGES.length;
      if (!isLast) {
        setTimeout(() => runStage(idx + 1, { autoAdvance: true }), 400);
      } else if (loopEnabled) {
        // Longer pause at the loop boundary so the last stage's "100%" is
        // visible and the restart doesn't feel frantic to a new viewer.
        setTimeout(() => runStage(0, { autoAdvance: true }), 1500);
      } else {
        running = false;
        els.playBtn.textContent = "▶ Run full demo";
      }
    }
  });

  if (duration) startProgress(duration);
}

function bindUi() {
  els.playBtn.addEventListener("click", async () => {
    if (running) {
      running = false;
      engine.stop();
      stopProgress();
      els.playBtn.textContent = "▶ Run full demo";
      return;
    }
    running = true;
    els.playBtn.textContent = "⏸ Stop demo";
    requestWakeLock();
    runStage(0, { autoAdvance: true });
  });

  els.pauseBtn.addEventListener("click", async () => {
    if (!engine.ctx) return;
    if (engine.ctx.state === "running") {
      await engine.suspend();
      els.pauseBtn.textContent = "▶ Resume";
    } else {
      await engine.resume();
      els.pauseBtn.textContent = "⏸ Pause";
    }
  });

  els.stopBtn.addEventListener("click", () => {
    running = false;
    engine.stop();
    stopProgress();
    els.progressFill.style.width = "0%";
    els.playBtn.textContent = "▶ Run full demo";
  });

  document.querySelectorAll("button[data-stage]").forEach((b) => {
    b.addEventListener("click", async () => {
      running = false;
      els.playBtn.textContent = "▶ Run full demo";
      const idx = parseInt(b.dataset.stage, 10);
      runStage(idx, { autoAdvance: false });
    });
  });

  els.speechGain.addEventListener("input", (e) =>
    engine.setSpeechGain(parseFloat(e.target.value))
  );
  els.masterGain.addEventListener("input", (e) =>
    engine.setMasterGain(parseFloat(e.target.value))
  );

  els.loopToggle.addEventListener("change", (e) => {
    loopEnabled = e.target.checked;
  });

  // Simulation intensity: live-updates the sensation-level scale. Re-applies
  // the current profile so the change is audible mid-playback, and redraws
  // the EQ curve so the viz matches.
  els.simIntensity.addEventListener("input", (e) => {
    SIM.scale = parseFloat(e.target.value);
    els.simIntensityVal.textContent = SIM.scale.toFixed(2);
    if (stageIdx >= 0) {
      const profile = PROFILES[STAGES[stageIdx].profile];
      engine.applyProfile(profile);
      drawEqCurve(els.eqcurve, profile);
    } else {
      drawEqCurve(els.eqcurve, PROFILES.normal);
    }
  });

  window.addEventListener("resize", () => {
    const profile = stageIdx >= 0 ? PROFILES[STAGES[stageIdx].profile] : PROFILES.normal;
    drawAudiogram(els.audiogram, profile);
    drawEqCurve(els.eqcurve, profile);
  });
}

async function main() {
  buildDots();
  bindUi();
  drawAudiogram(els.audiogram, PROFILES.normal);
  drawEqCurve(els.eqcurve, PROFILES.normal);

  await engine.init();
  setStatus("Loading audio…", "warn");
  const loaded = await engine.loadBuffers();

  const missing = [];
  if (!loaded.male) missing.push("audio/male.wav");
  if (!loaded.female) missing.push("audio/female.wav");

  if (missing.length === 0) {
    setStatus("Audio: male + female ready", "ok");
  } else {
    setStatus(
      `Audio: missing ${missing.join(", ")} — drop WAV files in /audio/ and refresh.`,
      "warn"
    );
  }
}

main();
