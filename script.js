/* Wave2Bit — Pulse Code Modulation, browser version.
 *
 * Same pipeline as wave2bit.c:
 *   Voice / Demo -> Sampling -> Quantization -> PCM Encoding -> Noise -> Received
 */

(function () {
  "use strict";

  var WAVE_POINTS = 240;   // resolution of the demo signal (same as the C version)
  var TABLE_ROWS = 10;     // encoding table rows shown
  var RECORD_MS = 3000;    // ~3 seconds of voice
  var PCM_PLAY_RATE = 8000; // telephone-style rate used for audible PCM playback

  var state = {
    signal: null,          // Float32Array, amplitude in [-1, 1]
    signalRate: null,      // native sample rate of state.signal (Hz)
    duration: 2,           // seconds
    source: null,          // "demo" | "voice"
    demoBuffer: null,      // decoded demo.wav, reused for playback
    sampleCount: 24,
    levels: 8,
    noise: 0,
    samples: [],           // { v, q, code }
    txCodes: [],
    rxCodes: [],
    errors: 0,
    totalBits: 0,
    recordedBlob: null
  };

  var els = {};
  var audioCtx = null;
  var demoCache = null;   // decoded demo voice, reused across clicks
  var demoPromise = null;

  var playback = null;
  var media = { stream: null, recorder: null, chunks: [], timer: null, ticker: null, started: 0 };

  /* ---------------------------------------------------------------- helpers */

  function $(id) { return document.getElementById(id); }

  function bitsPerSample(levels) {
    // 4 -> 2, 8 -> 3, 16 -> 4
    var b = 0, p = 1;
    while (p < levels) { p *= 2; b++; }
    return b < 1 ? 1 : b;
  }

  function encodePcm(index, levels) {
    var bits = bitsPerSample(levels);
    var out = "";
    for (var i = bits - 1; i >= 0; i--) {
      out += ((index >> i) & 1) ? "1" : "0";
    }
    return out;
  }

  /* SAMPLING: pick values at regular intervals (linear interpolation). */
  function sampleAt(sig, s, count) {
    var n = sig.length;
    var pos = ((s + 0.5) / count) * (n - 1);
    var i0 = Math.floor(pos);
    var i1 = i0 + 1;
    var f = pos - i0;
    if (i1 >= n) i1 = n - 1;
    if (i0 < 0) i0 = 0;
    return sig[i0] * (1 - f) + sig[i1] * f;
  }

  /* QUANTIZATION: amplitude [-1,1] -> [0,1] -> nearest level 0..L-1. */
  function quantize(v, levels) {
    var norm = (v + 1) / 2;
    var q = Math.round(norm * (levels - 1));
    if (q < 0) q = 0;
    if (q > levels - 1) q = levels - 1;
    return q;
  }

  /* Amplitude represented by a quantization level. */
  function levelAmplitude(q, levels) {
    return (q / (levels - 1)) * 2 - 1;
  }

  /* Demo signal: two/three sine waves + amplitude envelope, peak-normalized. */
  function makeDemoSignal(n) {
    var sig = new Float32Array(n);
    var peak = 0, i;
    for (i = 0; i < n; i++) {
      var t = i / n;
      var env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t + 0.6);
      var v = Math.sin(2 * Math.PI * 5 * t) * 0.55
            + Math.sin(2 * Math.PI * 11 * t + 1.1) * 0.28
            + Math.sin(2 * Math.PI * 23 * t + 0.4) * 0.12;
      sig[i] = v * env;
      if (Math.abs(sig[i]) > peak) peak = Math.abs(sig[i]);
    }
    if (peak > 0.001) {
      for (i = 0; i < n; i++) sig[i] = (sig[i] / peak) * 0.95;
    }
    return sig;
  }

  function normalizeSignal(sig) {
    var peak = 0, i;
    for (i = 0; i < sig.length; i++) {
      if (Math.abs(sig[i]) > peak) peak = Math.abs(sig[i]);
    }
    if (peak > 0.0001) {
      for (i = 0; i < sig.length; i++) sig[i] = (sig[i] / peak) * 0.95;
    }
    return sig;
  }

  /* ------------------------------------------------------------ computation */

  function compute() {
    var count = state.sampleCount;
    var levels = state.levels;
    var sig = state.signal;

    state.samples = [];
    state.txCodes = [];
    state.rxCodes = [];
    state.errors = 0;
    state.totalBits = 0;

    if (!sig || !sig.length) return;

    var s, i;
    for (s = 0; s < count; s++) {
      var v = sampleAt(sig, s, count);
      var q = quantize(v, levels);
      var code = encodePcm(q, levels);
      state.samples.push({ v: v, q: q, code: code });
      state.txCodes.push(code);
    }

    // NOISE: each bit independently flips with probability noise/100.
    var noise = state.noise;
    for (s = 0; s < state.txCodes.length; s++) {
      var code = state.txCodes[s];
      var rx = "";
      for (i = 0; i < code.length; i++) {
        var b = code.charAt(i);
        if (noise > 0 && Math.random() * 100 < noise) {
          rx += (b === "0") ? "1" : "0";
          state.errors++;
        } else {
          rx += b;
        }
        state.totalBits++;
      }
      state.rxCodes.push(rx);
    }
  }

  /* --------------------------------------------------------------- painting */

  function fitCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, rect.width);
    var h = Math.max(1, rect.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function box(w, h) {
    var pad = 14;
    return { x: pad, y: pad, w: w - pad * 2, h: h - pad * 2, mid: pad + (h - pad * 2) / 2 };
  }

  function drawGrid(ctx, b) {
    ctx.save();
    ctx.strokeStyle = "#f0f0f0";
    ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var y = b.y + (b.h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(b.x, y);
      ctx.lineTo(b.x + b.w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#dddddd";
    ctx.beginPath();
    ctx.moveTo(b.x, b.mid);
    ctx.lineTo(b.x + b.w, b.mid);
    ctx.stroke();
    ctx.restore();
  }

  function drawEmpty(canvas, text) {
    var c = fitCanvas(canvas);
    var b = box(c.w, c.h);
    drawGrid(c.ctx, b);
    c.ctx.save();
    c.ctx.fillStyle = "#aaaaaa";
    c.ctx.font = "13px Arial, Helvetica, sans-serif";
    c.ctx.textAlign = "center";
    c.ctx.textBaseline = "middle";
    c.ctx.fillText(text, c.w / 2, b.mid - 18);
    c.ctx.restore();
  }

  function drawSignalPath(ctx, b, sig) {
    var n = sig.length;
    if (n < 2) return;
    // Decimate long recordings: a 2 s clip is 16k-48k points, far more than
    // the pixels available, and drawing them all is wasted work.
    var step = Math.max(1, Math.floor(n / 1500));
    var xScale = b.w / (n - 1);
    var amp = (b.h / 2) * 0.94;

    ctx.beginPath();
    ctx.moveTo(b.x, b.mid - sig[0] * amp);
    for (var i = step; i < n; i += step) {
      ctx.lineTo(b.x + i * xScale, b.mid - sig[i] * amp);
    }
    ctx.lineTo(b.x + b.w, b.mid - sig[n - 1] * amp);
    ctx.stroke();
  }

  function drawAnalog() {
    var canvas = els.analog;
    if (!state.signal) { drawEmpty(canvas, "Use the demo signal or record your voice."); return; }
    var c = fitCanvas(canvas);
    var b = box(c.w, c.h);
    drawGrid(c.ctx, b);
    c.ctx.save();
    c.ctx.strokeStyle = "#1a73e8";
    c.ctx.lineWidth = 1.6;
    c.ctx.lineJoin = "round";
    drawSignalPath(c.ctx, b, state.signal);
    c.ctx.restore();
  }

  function drawSamples() {
    var canvas = els.samples;
    if (!state.samples.length) { drawEmpty(canvas, "Samples appear here."); return; }
    var c = fitCanvas(canvas);
    var b = box(c.w, c.h);
    var ctx = c.ctx;
    drawGrid(ctx, b);

    ctx.save();
    ctx.strokeStyle = "#cfdcf3";
    ctx.lineWidth = 1.2;
    drawSignalPath(ctx, b, state.signal);

    var count = state.samples.length;
    var stepX = b.w / count;
    for (var s = 0; s < count; s++) {
      var x = b.x + (s + 0.5) * stepX;
      var y = b.mid - state.samples[s].v * (b.h / 2) * 0.94;
      ctx.strokeStyle = "#9dbdf0";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, b.mid);
      ctx.lineTo(x, y);
      ctx.stroke();

      ctx.fillStyle = "#1a73e8";
      ctx.beginPath();
      ctx.arc(x, y, Math.min(3.4, Math.max(1.8, stepX * 0.18)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawQuant() {
    var canvas = els.quant;
    if (!state.samples.length) { drawEmpty(canvas, "Quantized levels appear here."); return; }
    var c = fitCanvas(canvas);
    var b = box(c.w, c.h);
    var ctx = c.ctx;
    var levels = state.levels;

    drawGrid(ctx, b);

    // Faint horizontal guide line per quantization level.
    ctx.save();
    ctx.strokeStyle = "#f3f5f9";
    ctx.lineWidth = 1;
    for (var q = 0; q < levels; q++) {
      var gy = b.mid - levelAmplitude(q, levels) * (b.h / 2) * 0.94;
      ctx.beginPath();
      ctx.moveTo(b.x, gy);
      ctx.lineTo(b.x + b.w, gy);
      ctx.stroke();
    }
    ctx.restore();

    var count = state.samples.length;
    var stepX = b.w / count;

    // Light reference: the original continuous signal.
    ctx.save();
    ctx.strokeStyle = "#d9e2f2";
    ctx.lineWidth = 1;
    drawSignalPath(ctx, b, state.signal);
    ctx.restore();

    // Quantized, sample-and-hold staircase.
    ctx.save();
    ctx.strokeStyle = "#1a73e8";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (var s = 0; s < count; s++) {
      var y = b.mid - levelAmplitude(state.samples[s].q, levels) * (b.h / 2) * 0.94;
      var x0 = b.x + s * stepX;
      var x1 = x0 + stepX;
      if (s === 0) ctx.moveTo(x0, y);
      else ctx.lineTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();

    // Markers at each quantized value.
    for (var t = 0; t < count; t++) {
      var qy = b.mid - levelAmplitude(state.samples[t].q, levels) * (b.h / 2) * 0.94;
      ctx.fillStyle = "#155fc0";
      ctx.beginPath();
      ctx.arc(b.x + (t + 0.5) * stepX, qy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------- text views */

  function renderTable() {
    var body = els.encodingBody;
    body.innerHTML = "";

    if (!state.samples.length) {
      var row = document.createElement("tr");
      var cell = document.createElement("td");
      cell.colSpan = 3;
      cell.className = "empty";
      cell.textContent = "No signal yet.";
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    var show = Math.min(state.samples.length, TABLE_ROWS);
    for (var i = 0; i < show; i++) {
      var s = state.samples[i];
      var tr = document.createElement("tr");
      [String(i + 1), String(s.q), s.code].forEach(function (text) {
        var td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }

    if (state.samples.length > show) {
      var note = document.createElement("tr");
      var td2 = document.createElement("td");
      td2.colSpan = 3;
      td2.className = "empty";
      td2.textContent = "Showing first " + show + " of " + state.samples.length + " samples.";
      note.appendChild(td2);
      body.appendChild(note);
    }
  }

  function renderStreams() {
    if (!state.txCodes.length) {
      els.binarySpaced.textContent = "\u2014";
      els.binaryFlat.textContent = "\u2014";
      return;
    }
    els.binarySpaced.textContent = state.txCodes.join(" ");
    els.binaryFlat.textContent = state.txCodes.join("");
  }

  function renderReceived() {
    if (!state.rxCodes.length) {
      els.rxTx.textContent = "\u2014";
      els.rxRx.textContent = "\u2014";
      els.bitErrors.textContent = "0";
      els.ber.textContent = "0%";
      return;
    }

    els.rxTx.textContent = state.txCodes.join(" ");
    els.rxRx.innerHTML = "";

    var frag = document.createDocumentFragment();
    for (var s = 0; s < state.rxCodes.length; s++) {
      if (s > 0) frag.appendChild(document.createTextNode(" "));
      var tx = state.txCodes[s];
      var rx = state.rxCodes[s];
      for (var i = 0; i < rx.length; i++) {
        var span = document.createElement("span");
        span.className = "bit" + (rx.charAt(i) !== tx.charAt(i) ? " changed" : "");
        span.textContent = rx.charAt(i);
        frag.appendChild(span);
      }
    }
    els.rxRx.appendChild(frag);

    els.bitErrors.textContent = String(state.errors);
    var rate = state.totalBits ? (state.errors / state.totalBits) * 100 : 0;
    els.ber.textContent = rate.toFixed(2) + "%";
  }

  function paint() {
    drawAnalog();
    drawSamples();
    drawQuant();
    renderTable();
    renderStreams();
    renderReceived();
  }

  function recompute() {
    compute();
    paint();
  }

  /* ---------------------------------------------------------------- sources */

  function loadDemoAudio() {
    if (demoCache) return Promise.resolve(demoCache);
    if (demoPromise) return demoPromise;

    var ctx = getAudioContext();
    demoPromise = fetch("demo.wav", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then(function (bytes) {
        return ctx.decodeAudioData(bytes);
      })
      .then(function (decoded) {
        demoCache = {
          signal: normalizeSignal(mixToMono(decoded)),
          rate: decoded.sampleRate,
          duration: decoded.duration,
          buffer: decoded
        };
        demoPromise = null;
        return demoCache;
      })
      .catch(function (err) {
        demoPromise = null;
        throw err;
      });

    return demoPromise;
  }

  function loadDemo() {
    stopPlayback();
    els.recordStatus.textContent = "Loading demo voice\u2026";

    loadDemoAudio().then(function (demo) {
      state.signal = demo.signal;
      state.signalRate = demo.rate;
      state.duration = demo.duration;
      state.source = "demo";
      state.demoBuffer = demo.buffer;
      state.recordedBlob = null;
      els.recordStatus.textContent = "Demo voice loaded: \u201Cone, two\u201D. Press \u25B6 Play Original Voice to hear it.";
      recompute();
    }).catch(function () {
      // Fallback: the original artificial tone (not speech, but keeps the demo usable).
      state.signal = makeDemoSignal(WAVE_POINTS);
      state.signalRate = WAVE_POINTS / 2;
      state.duration = 2;
      state.source = "demo";
      state.demoBuffer = null;
      state.recordedBlob = null;
      els.recordStatus.textContent = "Could not load demo.wav \u2014 using the fallback tone instead.";
      recompute();
    });
  }

  function supportsMic() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  function setRecordingUi(recording) {
    els.btnRecord.textContent = recording ? "\u25A0 Stop Recording" : "\uD83C\uDFA4 Start Recording";
    els.btnRecord.disabled = false;
    els.btnRecord.classList.toggle("active", recording);
  }

  function startRecording() {
    if (!supportsMic()) {
      els.recordStatus.textContent = "Microphone not available in this browser. Using the demo voice.";
      loadDemo();
      return;
    }
    if (state.source === "voice" && state.recordedBlob) stopPlayback();

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      media.stream = stream;
      media.chunks = [];
      var recorder;
      try {
        recorder = new MediaRecorder(stream);
      } catch (err) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        els.recordStatus.textContent = "Recording is not supported here. Using the demo voice.";
        loadDemo();
        return;
      }
      media.recorder = recorder;

      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) media.chunks.push(e.data);
      };

      recorder.onstop = finishRecording;

      recorder.start();
      media.started = Date.now();
      setRecordingUi(true);
      els.recordStatus.textContent = "Recording\u2026 0.0s of " + (RECORD_MS / 1000).toFixed(1) + "s";

      media.ticker = window.setInterval(function () {
        var elapsed = (Date.now() - media.started) / 1000;
        els.recordStatus.textContent = "Recording\u2026 " + elapsed.toFixed(1) + "s of " + (RECORD_MS / 1000).toFixed(1) + "s";
      }, 100);

      media.timer = window.setTimeout(stopRecording, RECORD_MS);
    }).catch(function (err) {
      var msg = (err && err.name === "NotAllowedError")
        ? "Microphone permission was denied. Using the demo voice."
        : "Could not access the microphone. Using the demo voice.";
      els.recordStatus.textContent = msg;
      loadDemo();
    });
  }

  function stopRecording() {
    if (media.timer) { window.clearTimeout(media.timer); media.timer = null; }
    if (media.ticker) { window.clearInterval(media.ticker); media.ticker = null; }
    if (media.recorder && media.recorder.state !== "inactive") {
      try { media.recorder.stop(); } catch (e) { /* ignore */ }
    }
  }

  function finishRecording() {
    setRecordingUi(false);
    if (media.stream) {
      media.stream.getTracks().forEach(function (t) { t.stop(); });
      media.stream = null;
    }

    var blob = new Blob(media.chunks, { type: media.recorder && media.recorder.mimeType || "audio/webm" });
    media.chunks = [];
    if (!blob.size) {
      els.recordStatus.textContent = "Nothing was recorded. Using the demo voice.";
      loadDemo();
      return;
    }

    var ctx = getAudioContext();
    blob.arrayBuffer().then(function (buffer) {
      return ctx.decodeAudioData(buffer);
    }).then(function (decoded) {
      var mono = mixToMono(decoded);
      state.signal = normalizeSignal(mono);
      state.signalRate = decoded.sampleRate || 44100;
      state.duration = decoded.duration || 3;
      state.source = "voice";
      state.recordedBlob = blob;
      els.recordStatus.textContent = "Recording captured (" + state.duration.toFixed(1) + "s).";
      recompute();
    }).catch(function () {
      els.recordStatus.textContent = "Could not decode the recording. Using the demo voice.";
      loadDemo();
    });
  }

  function mixToMono(buffer) {
    var len = buffer.length;
    var out = new Float32Array(len);
    var channels = buffer.numberOfChannels || 1;
    for (var ch = 0; ch < channels; ch++) {
      var data = buffer.getChannelData(ch);
      for (var i = 0; i < len; i++) out[i] += data[i];
    }
    if (channels > 1) {
      for (var j = 0; j < len; j++) out[j] /= channels;
    }
    return out;
  }

  /* --------------------------------------------------------------- playback */

  function getAudioContext() {
    if (!audioCtx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function stopPlayback() {
    if (playback) {
      try { playback.onended = null; playback.stop(); } catch (e) { /* ignore */ }
      playback = null;
    }
  }

  function playBuffer(buffer, label) {
    var ctx = getAudioContext();
    stopPlayback();

    var src = ctx.createBufferSource();
    src.buffer = buffer;

    // Short fades so the buffer does not click.
    var gain = ctx.createGain();
    var fade = Math.min(0.01, buffer.duration / 10);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + fade);
    gain.gain.setValueAtTime(1, ctx.currentTime + Math.max(fade, buffer.duration - fade));
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + buffer.duration);

    src.disconnect();
    src.connect(gain);
    gain.connect(ctx.destination);

    src.onended = function () {
      if (playback === src) {
        playback = null;
        els.playStatus.textContent = label + " finished.";
      }
    };

    playback = src;
    els.playStatus.textContent = label;
    src.start();
  }

  /* One-pole low-pass, applied before downsampling so we do not alias. */
  function lowPassAt(sig, rate, cutoff) {
    var dt = 1 / rate;
    var rc = 1 / (2 * Math.PI * cutoff);
    var alpha = dt / (rc + dt);
    var out = new Float32Array(sig.length);
    var y = sig[0] || 0;
    for (var i = 0; i < sig.length; i++) {
      y += alpha * (sig[i] - y);
      out[i] = y;
    }
    return out;
  }

  function flipBits(code, percent) {
    var out = "";
    for (var i = 0; i < code.length; i++) {
      var bit = code.charAt(i);
      out += (Math.random() * 100 < percent)
        ? (bit === "0" ? "1" : "0")
        : bit;
    }
    return out;
  }

  /* Audible PCM.
   *
   * The on-screen diagrams deliberately use a very low sample count so the
   * sampling effect is visible. For playback that would destroy speech, so the
   * audio is re-sampled at telephone rate (8 kHz), quantized with the selected
   * number of levels, encoded to bits, and only then converted back to sound.
   * Noise flips bits of this audio-rate stream, which is what makes speech
   * break up instead of turning into a single low buzz.
   */
  function buildPcmBuffer(useNoisy) {
    var ctx = getAudioContext();
    if (!state.signal || !state.signal.length) return null;

    var seconds = Math.max(0.25, state.duration || 2);
    var srcRate = state.signalRate || (state.signal.length / seconds);
    var source = state.signal;
    var levels = state.levels;

    if (srcRate > PCM_PLAY_RATE * 1.05) {
      source = lowPassAt(source, srcRate, PCM_PLAY_RATE * 0.45);
    }

    var n = Math.max(1, Math.round(seconds * PCM_PLAY_RATE));
    var buffer = ctx.createBuffer(1, n, PCM_PLAY_RATE);
    var data = buffer.getChannelData(0);
    var last = source.length - 1;

    for (var i = 0; i < n; i++) {
      var pos = n === 1 ? 0 : ((i + 0.5) / n) * last;
      var i0 = Math.floor(pos);
      var i1 = Math.min(last, i0 + 1);
      var f = pos - i0;
      var v = source[i0] * (1 - f) + source[i1] * f;

      var code = encodePcm(quantize(v, levels), levels);
      if (useNoisy && state.noise > 0) code = flipBits(code, state.noise);

      data[i] = levelAmplitude(parseInt(code, 2), levels) * 0.7;
    }
    return buffer;
  }

  function playVoice() {
    if (state.source === "demo" && state.demoBuffer) {
      playBuffer(state.demoBuffer, "Playing the demo voice (\u201Cone, two\u201D)\u2026");
      return;
    }
    if (state.source === "voice" && state.recordedBlob) {
      var ctx = getAudioContext();
      state.recordedBlob.arrayBuffer().then(function (buf) {
        return ctx.decodeAudioData(buf);
      }).then(function (decoded) {
        playBuffer(decoded, "Playing your original recording\u2026");
      }).catch(function () {
        els.playStatus.textContent = "Could not play the recording.";
      });
      return;
    }
    if (!state.signal) {
      els.playStatus.textContent = "Load the demo voice or record first.";
      return;
    }
    var demoCtx = getAudioContext();
    var sr = 44100;
    var seconds = Math.max(1, state.duration || 2);
    var len = Math.floor(seconds * sr);
    var buffer = demoCtx.createBuffer(1, len, sr);
    var data = buffer.getChannelData(0);
    var sig = makeDemoSignal(len);
    data.set(sig);
    playBuffer(buffer, "Playing the analog demo signal\u2026");
  }

  function playPcm() {
    if (!state.signal) {
      els.playStatus.textContent = "Load the demo voice or record first.";
      return;
    }
    playBuffer(buildPcmBuffer(false), "Playing " + (PCM_PLAY_RATE / 1000) + " kHz PCM\u2026");
  }

  function playNoisy() {
    if (!state.signal) {
      els.playStatus.textContent = "Load the demo voice or record first.";
      return;
    }
    if (state.noise === 0) {
      playBuffer(buildPcmBuffer(false), "No noise applied \u2014 this is the clean PCM\u2026");
      return;
    }
    playBuffer(buildPcmBuffer(true), "Playing noisy PCM (" + state.noise + "% bit flips)\u2026");
  }

  /* ------------------------------------------------------------------ reset */

  function reset() {
    stopRecording();
    stopPlayback();
    setRecordingUi(false);

    state.signal = null;
    state.signalRate = null;
    state.duration = 2;
    state.source = null;
    state.sampleCount = 24;
    state.levels = 8;
    state.noise = 0;
    state.samples = [];
    state.txCodes = [];
    state.rxCodes = [];
    state.errors = 0;
    state.totalBits = 0;
    state.demoBuffer = null;
    state.recordedBlob = null;

    els.samplingRate.value = "24";
    els.samplingValue.textContent = "24";
    els.noise.value = "0";
    els.noiseValue.textContent = "0";
    Array.prototype.forEach.call(els.quantBtns.querySelectorAll("button"), function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-levels") === "8");
    });

    els.recordStatus.textContent = "Record ~3 seconds of voice, or use the demo voice.";
    els.playStatus.textContent = "Hear your true voice, then the digitized versions.";

    paint();
  }

  /* ------------------------------------------------------------------ setup */

  function bind() {
    els.analog = $("canvas-analog");
    els.samples = $("canvas-samples");
    els.quant = $("canvas-quant");
    els.samplingRate = $("sampling-rate");
    els.samplingValue = $("sampling-value");
    els.quantBtns = $("quant-btns");
    els.encodingBody = $("encoding-body");
    els.binarySpaced = $("binary-spaced");
    els.binaryFlat = $("binary-flat");
    els.noise = $("noise");
    els.noiseValue = $("noise-value");
    els.recordStatus = $("record-status");
    els.playStatus = $("play-status");
    els.rxTx = $("rx-tx");
    els.rxRx = $("rx-rx");
    els.bitErrors = $("bit-errors");
    els.ber = $("ber");
    els.btnRecord = $("btn-record");
    els.btnDemo = $("btn-demo");
    els.btnPlay = $("btn-play");
    els.btnPlayPcm = $("btn-play-pcm");
    els.btnPlayNoisy = $("btn-play-noisy");
    els.btnReset = $("btn-reset");

    els.btnDemo.addEventListener("click", loadDemo);

    els.btnRecord.addEventListener("click", function () {
      if (media.recorder && media.recorder.state === "recording") stopRecording();
      else startRecording();
    });

    els.samplingRate.addEventListener("input", function () {
      state.sampleCount = parseInt(els.samplingRate.value, 10) || 24;
      els.samplingValue.textContent = String(state.sampleCount);
      recompute();
    });

    els.quantBtns.addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-levels]") : null;
      if (!btn) return;
      state.levels = parseInt(btn.getAttribute("data-levels"), 10) || 8;
      Array.prototype.forEach.call(els.quantBtns.querySelectorAll("button"), function (b) {
        b.classList.toggle("active", b === btn);
      });
      recompute();
    });

    els.noise.addEventListener("input", function () {
      state.noise = parseInt(els.noise.value, 10) || 0;
      els.noiseValue.textContent = String(state.noise);
      recompute();
    });

    els.btnPlay.addEventListener("click", playVoice);
    els.btnPlayPcm.addEventListener("click", playPcm);
    els.btnPlayNoisy.addEventListener("click", playNoisy);
    els.btnReset.addEventListener("click", reset);

    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(paint, 120);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    paint();
  });
})();
