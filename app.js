// Hearing Loss Simulator — Aalto PdP
// Plain JS / Web Audio API. Booth flow: auto-loops male↔female voices through
// an active audiogram. Tapping an NFC card on the Teensy hot-swaps the active
// audiogram live. No session state, no logout.

// ============================================================
// 1. Audiogram profiles — used only to label incoming NFC data
//    with a friendly name when the values match a known pattern.
// ============================================================

const FREQS = [125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000];

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
// 2. Audio engine
// ============================================================

const AUDIO_PATHS = {
  male: "audio/male.wav",
  female: "audio/female.wav",
};

const PEAKING_Q = 1.0;

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
    this.playing = false;
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    const makeChain = () => {
      const chain = [];
      for (const f of FREQS) {
        const filter = this.ctx.createBiquadFilter();
        filter.type = "peaking";
        filter.frequency.value = f;
        filter.Q.value = PEAKING_Q;
        filter.gain.value = 0;
        chain.push(filter);
      }
      for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
      return chain;
    };

    this.filtersL = makeChain();
    this.filtersR = makeChain();

    this.speechGain = this.ctx.createGain();
    this.speechGain.gain.value = 0.9;
    this.speechGain.channelCount = 2;
    this.speechGain.channelCountMode = "explicit";
    this.speechGain.channelInterpretation = "speakers";

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8;

    this.splitter = this.ctx.createChannelSplitter(2);
    this.merger   = this.ctx.createChannelMerger(2);

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
        this.buffers[key] = await this.ctx.decodeAudioData(arr);
        results[key] = true;
      } catch (_) {
        this.buffers[key] = null;
      }
    };
    await Promise.all([tryLoad("male"), tryLoad("female")]);
    return results;
  }

  applyProfile(profile) {
    const t = this.ctx.currentTime;
    for (let i = 0; i < FREQS.length; i++) {
      this.filtersL[i].gain.setTargetAtTime(-lossToCutDb(profile.L[i]), t, 0.03);
      this.filtersR[i].gain.setTargetAtTime(-lossToCutDb(profile.R[i]), t, 0.03);
    }
  }

  playVoice(voice, profile, onEnded) {
    if (!this.buffers[voice]) {
      onEnded && onEnded({ reason: "missing" });
      return null;
    }
    this.stop();
    this.applyProfile(profile);

    this.speechSource = this.ctx.createBufferSource();
    this.speechSource.buffer = this.buffers[voice];
    this.speechSource.connect(this.speechGain);

    this.speechSource.onended = () => {
      if (!this.playing) return; // already stopped externally
      this.playing = false;
      onEnded && onEnded({ reason: "complete" });
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
  resume()  { return this.ctx.resume(); }
  suspend() { return this.ctx.suspend(); }
}

// ============================================================
// 3. Audiogram + EQ curve drawing
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

  const dbMin = -10, dbMax = 80;
  const yFor = (db) => padT + ((db - dbMin) / (dbMax - dbMin)) * plotH;

  const bands = [
    { from: -10, to: 25, color: "#e6f4ea" },
    { from: 25,  to: 40, color: "#e8f0fe" },
    { from: 40,  to: 55, color: "#eae6f7" },
    { from: 55,  to: 70, color: "#fff4e5" },
    { from: 70,  to: 80, color: "#fde8e8" },
  ];
  for (const b of bands) {
    ctx.fillStyle = b.color;
    ctx.fillRect(padL, yFor(b.from), plotW, yFor(b.to) - yFor(b.from));
  }

  ctx.strokeStyle = "#c9ced8";
  ctx.lineWidth = 1;
  ctx.font = "12px ui-sans-serif, system-ui";
  ctx.fillStyle = "#444";

  for (let db = 0; db <= 80; db += 10) {
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
    ctx.fillText(label, x, padT + plotH + 6);
  }

  ctx.strokeStyle = "#9aa3b2";
  ctx.strokeRect(padL, padT, plotW, plotH);

  ctx.save();
  ctx.translate(14, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center"; ctx.fillStyle = "#333";
  ctx.fillText("Hearing level (dB HL)", 0, 0);
  ctx.restore();

  ctx.fillStyle = "#333";
  ctx.textAlign = "center";
  ctx.fillText("Frequency (Hz)", padL + plotW / 2, cssH - 6);

  const plotSeries = (values, color, marker) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]); const y = yFor(db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 2;
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]); const y = yFor(db);
      if (marker === "x") {
        ctx.beginPath();
        ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6);
        ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6);
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    });
  };

  plotSeries(profile.L, "#2b6cff", "x");
  plotSeries(profile.R, "#e0334c", "o");

  ctx.font = "12px ui-sans-serif, system-ui";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const lx = padL + 8, ly = padT + 10;
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
    ctx.strokeStyle = "#e1e5ec"; ctx.stroke();
    const label = f >= 1000 ? (f / 1000) + "k" : String(f);
    ctx.fillStyle = "#444";
    ctx.fillText(label, x, padT + plotH + 4);
  }

  ctx.strokeStyle = "#9aa3b2";
  ctx.strokeRect(padL, padT, plotW, plotH);

  const plotGhost = (values, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]); ctx.globalAlpha = 0.4;
    ctx.beginPath();
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]); const y = yFor(-db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  };

  const plotAppliedGain = (values, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.beginPath();
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]); const y = yFor(-lossToCutDb(db));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = color;
    values.forEach((db, i) => {
      const x = xFor(FREQS[i]); const y = yFor(-lossToCutDb(db));
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    });
  };

  plotGhost(profile.L, "#2b6cff");
  plotGhost(profile.R, "#e0334c");
  plotAppliedGain(profile.L, "#2b6cff");
  plotAppliedGain(profile.R, "#e0334c");

  ctx.fillStyle = "#555";
  ctx.font = "11px ui-sans-serif, system-ui";
  ctx.textAlign = "right"; ctx.textBaseline = "bottom";
  ctx.fillText("solid = applied EQ · dashed = raw audiogram dB HL",
               cssW - padR - 2, padT + plotH - 4);
}

// ============================================================
// 4. Serial bridge — Teensy NFC reader over Web Serial API
// ============================================================
//
// Teensy emits line-terminated messages at 115200 baud:
//   READY,v1
//   LOGIN,<UID>,L:a/b/c/...,R:a/b/c/...   (11 values each)
//   ERROR,<reason>
//
// On LOGIN we hot-swap the active audiogram; on READY we just update the
// status pill.

class SerialBridge {
  constructor(handlers) {
    this.handlers = handlers;
    this.port = null;
    this.reader = null;
    this.buffer = "";
    this.connected = false;
  }

  // Teensy (PJRC) USB vendor ID — limits the picker so users can't
  // mis-pick an FTDI/CH340 dongle or a Bluetooth serial port.
  static FILTERS = [{ usbVendorId: 0x16C0 }];

  static supported() { return "serial" in navigator; }

  async connect(existingPort) {
    const port = existingPort || await navigator.serial.requestPort({
      filters: SerialBridge.FILTERS,
    });
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.connected = true;
    this.handlers.onStatus("connected");
    this._readLoop();
  }

  async disconnect() {
    this.connected = false;
    if (this.reader) { try { await this.reader.cancel(); } catch (_) {} }
    if (this.port)   { try { await this.port.close();   } catch (_) {} this.port = null; }
    this.handlers.onStatus("disconnected");
  }

  async _readLoop() {
    const decoder = new TextDecoderStream();
    const closed = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    try {
      while (this.connected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += value;
        let idx;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, idx).replace(/\r$/, "");
          this.buffer = this.buffer.slice(idx + 1);
          if (line) this._dispatch(line);
        }
      }
    } catch (e) {
      this.handlers.onError && this.handlers.onError(e.message || String(e));
    } finally {
      try { this.reader.releaseLock(); } catch (_) {}
      this.reader = null;
      await closed;
      this.connected = false;
      this.handlers.onStatus("disconnected");
    }
  }

  _dispatch(line) {
    console.log("[serial] <-", line);
    if (line.startsWith("LOGIN,")) {
      const m = /^LOGIN,([^,]+),L:([^,]+),R:(.+)$/.exec(line);
      if (m) {
        const toArr = (s) => s.split("/").map((n) => parseInt(n, 10));
        this.handlers.onLogin({ uid: m[1], L: toArr(m[2]), R: toArr(m[3]) });
      }
    } else if (line.startsWith("READY,")) {
      this.handlers.onReady && this.handlers.onReady();
    } else if (line.startsWith("ERROR,")) {
      this.handlers.onError && this.handlers.onError(line);
    }
  }
}

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function matchNamedProfile(L, R) {
  for (const [key, p] of Object.entries(PROFILES)) {
    if (arraysEqual(p.L, L) && arraysEqual(p.R, R)) return { key, label: p.label };
  }
  return null;
}

function shortUid(uid) {
  if (!uid) return "";
  if (uid.length <= 8) return uid;
  return uid.slice(0, 4) + "…" + uid.slice(-4);
}

// ============================================================
// 5. App state + continuous playback loop
// ============================================================

const els = {
  voiceLabel:     document.getElementById("voiceLabel"),
  profileLabel:   document.getElementById("profileLabel"),
  progressFill:   document.getElementById("progressFill"),
  audiogram:      document.getElementById("audiogram"),
  eqcurve:        document.getElementById("eqcurve"),
  pauseBtn:       document.getElementById("pauseBtn"),
  speechGain:     document.getElementById("speechGain"),
  masterGain:     document.getElementById("masterGain"),
  simIntensity:   document.getElementById("simIntensity"),
  simIntensityVal:document.getElementById("simIntensityVal"),
  audioStatus:    document.getElementById("audioStatus"),
  serialBtn:      document.getElementById("serialBtn"),
  serialStatus:   document.getElementById("serialStatus"),
};

const engine = new Engine();

let activeProfile = {
  label: PROFILES.normal.label,
  L: PROFILES.normal.L,
  R: PROFILES.normal.R,
};
let currentVoice   = "male";
let playbackRunning = false;
let progressTimer  = null;
let stageStartTime = 0;
let stageDuration  = 0;
let wakeLock       = null;
let serial         = null;

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (_) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && playbackRunning) requestWakeLock();
});

function startProgress(duration) {
  stopProgress();
  stageStartTime = performance.now();
  stageDuration = duration * 1000;
  progressTimer = setInterval(() => {
    const pct = Math.min(100,
      ((performance.now() - stageStartTime) / stageDuration) * 100);
    els.progressFill.style.width = pct + "%";
  }, 80);
}
function stopProgress() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function updateUiForCurrent() {
  els.voiceLabel.textContent   = currentVoice === "male" ? "Male voice" : "Female voice";
  els.profileLabel.textContent = activeProfile.label;
  drawAudiogram(els.audiogram, activeProfile);
  drawEqCurve(els.eqcurve, activeProfile);
}

async function startPlayback() {
  if (playbackRunning) return;
  playbackRunning = true;
  await engine.resume();
  requestWakeLock();
  playNext();
}

function playNext() {
  if (!playbackRunning) return;
  updateUiForCurrent();

  if (!engine.buffers[currentVoice]) {
    const other = currentVoice === "male" ? "female" : "male";
    if (!engine.buffers[other]) return; // nothing to play
    currentVoice = other;
    setTimeout(playNext, 300);
    return;
  }

  const duration = engine.playVoice(currentVoice, activeProfile, (info) => {
    stopProgress();
    els.progressFill.style.width = "100%";
    if (!playbackRunning) return;
    if (engine.buffers[currentVoice === "male" ? "female" : "male"]) {
      currentVoice = currentVoice === "male" ? "female" : "male";
    }
    setTimeout(() => { if (playbackRunning) playNext(); }, 600);
  });
  if (duration) startProgress(duration);
}

function applyCardAudiogram({ uid, L, R }) {
  const match = matchNamedProfile(L, R);
  const baseLabel = match ? match.label : "Custom audiogram";
  activeProfile = { label: `${baseLabel} · ${shortUid(uid)}`, L, R };
  engine.applyProfile(activeProfile);           // hot-swap mid-voice
  updateUiForCurrent();
  setSerialStatus(`Last card: ${shortUid(uid)} — ${baseLabel}`, "ok");
}

function applyNamedProfile(key) {
  const p = PROFILES[key];
  if (!p) return;
  activeProfile = { label: `${p.label} (manual)`, L: p.L, R: p.R };
  engine.applyProfile(activeProfile);
  updateUiForCurrent();
}

function setStatus(text, cls) {
  els.audioStatus.textContent = text;
  els.audioStatus.className = "status" + (cls ? " " + cls : "");
}
function setSerialStatus(text, cls) {
  els.serialStatus.textContent = text;
  els.serialStatus.className = "status" + (cls ? " " + cls : "");
}

const bridgeHandlers = {
  onStatus: (s) => {
    if (s === "connected") {
      els.serialBtn.textContent = "Disconnect reader";
      setSerialStatus("Reader: waiting for card", "ok");
    } else {
      els.serialBtn.textContent = "🔌 Connect card reader";
      setSerialStatus("Reader: not connected", "warn");
      serial = null;
    }
  },
  onReady:  () => setSerialStatus("Reader: waiting for card", "ok"),
  onLogin:  (data) => applyCardAudiogram(data),
  onError:  (msg)  => setSerialStatus(`Reader: ${msg}`, "err"),
};

async function toggleSerial() {
  console.log("[app] connect-reader clicked; supported =", SerialBridge.supported());
  if (!SerialBridge.supported()) {
    setSerialStatus("Reader: Web Serial not supported — use Chrome or Edge", "err");
    return;
  }
  if (serial && serial.connected) {
    await serial.disconnect();
    return;
  }
  serial = new SerialBridge(bridgeHandlers);
  try {
    await serial.connect();
  } catch (e) {
    const msg = e.message || String(e);
    const hint = msg.includes("Failed to open")
      ? "port busy — close Arduino IDE's Serial Monitor, then unplug & replug the Teensy"
      : msg;
    setSerialStatus(`Reader: ${hint}`, "warn");
    serial = null;
  }
}

async function tryAutoReconnect() {
  if (!SerialBridge.supported()) return;
  try {
    const ports = await navigator.serial.getPorts();
    // Only auto-reconnect to a Teensy — avoids silently opening a wrong
    // USB-serial port that was granted permission during a mis-pick.
    const teensy = ports.find((p) => {
      try { return p.getInfo().usbVendorId === 0x16C0; } catch (_) { return false; }
    });
    if (!teensy) return;
    serial = new SerialBridge(bridgeHandlers);
    await serial.connect(teensy);
  } catch (e) {
    console.log("[serial] auto-reconnect failed:", e);
    serial = null;
  }
}

function bindUi() {
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

  els.speechGain.addEventListener("input", (e) =>
    engine.setSpeechGain(parseFloat(e.target.value)));
  els.masterGain.addEventListener("input", (e) =>
    engine.setMasterGain(parseFloat(e.target.value)));

  els.simIntensity.addEventListener("input", (e) => {
    SIM.scale = parseFloat(e.target.value);
    els.simIntensityVal.textContent = SIM.scale.toFixed(2);
    engine.applyProfile(activeProfile);
    drawEqCurve(els.eqcurve, activeProfile);
  });

  els.serialBtn.addEventListener("click", toggleSerial);
  if (!SerialBridge.supported()) {
    els.serialBtn.disabled = true;
    setSerialStatus("Reader: Web Serial not supported — use Chrome or Edge", "warn");
  }

  document.querySelectorAll("button[data-profile]").forEach((b) => {
    b.addEventListener("click", () => applyNamedProfile(b.dataset.profile));
  });

  window.addEventListener("resize", () => {
    drawAudiogram(els.audiogram, activeProfile);
    drawEqCurve(els.eqcurve, activeProfile);
  });
}

async function main() {
  console.log("[app] main starting");
  bindUi();
  updateUiForCurrent();

  await engine.init();
  setStatus("Loading audio…", "warn");
  const loaded = await engine.loadBuffers();

  if (!loaded.male && !loaded.female) {
    setStatus("Both audio files missing — drop WAVs into /audio/.", "err");
    return;
  }

  const missing = [];
  if (!loaded.male)   missing.push("male.wav");
  if (!loaded.female) missing.push("female.wav");
  setStatus(
    missing.length
      ? `Audio: missing ${missing.join(", ")} — looping available voice.`
      : "Audio: male + female ready",
    missing.length ? "warn" : "ok"
  );

  if (!loaded[currentVoice]) currentVoice = loaded.male ? "male" : "female";

  tryAutoReconnect();
  startPlayback();
}

main();
