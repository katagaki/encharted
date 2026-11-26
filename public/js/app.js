import { G } from "./geometry.js";
import { CHUNK, MAX_TEXT_BYTES, encodeMessage, pairingNumber, utf8Length } from "./codec.js";
import { drawChart, drawStatic } from "./screen.js";

const PROC_LONG_SIDE = 640;
const DEFAULT_TEXT = "今日も楽しく灼熱Beachside Bunnyでお皿を回しまくれえええ";

const $ = (id) => document.getElementById(id);
const views = ["home", "send", "receive", "demo"];
let leaveView = null;

function route() {
  const name = location.hash.slice(1) || "home";
  const view = views.includes(name) ? name : "home";
  leaveView?.();
  leaveView = null;
  for (const v of views) $(v).hidden = v !== view;
  if (view === "receive") leaveView = startReceiver();
  if (view === "demo") leaveView = startDemo();
  window.scrollTo(0, 0);
}
addEventListener("hashchange", route);

function createWorker() {
  return new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderProgress(root, state, { timeOrigin = state.lockedAt ?? 0, expected = null, onAgain = null } = {}) {
  root.replaceChildren();
  if (state.count === null) {
    root.append(el("p", "waiting", state.everLocked ? "Reading the first block…" : "Point the camera at the sender’s chart."));
    return;
  }
  const times = new Map(state.blocks.map((b) => [b.index, b.time]));
  const list = el("ol", "blocks");
  for (let i = 0; i < state.count; i++) {
    const li = el("li", times.has(i) ? "got" : "");
    li.append(el("span", "bname", `Block ${i + 1}/${state.count}`));
    if (times.has(i)) {
      li.append(el("span", "judge", "PGREAT"), el("span", "btime", `${(times.get(i) - timeOrigin).toFixed(2)} s`));
    } else {
      li.append(el("span", "reading", "reading…"));
    }
    list.append(li);
  }
  root.append(list);
  const text = el("p", "preview");
  for (const part of state.preview.split(/(·+)/)) {
    if (part) text.append(part.startsWith("·") ? el("span", "missing", part) : document.createTextNode(part));
  }
  root.append(text);
  if (!state.done) return;
  const done = el("div", "done");
  const ok = expected === null || expected === state.text;
  done.append(el("p", ok ? "complete" : "mismatch", ok ? "Transfer complete" : "Mismatch"));
  const pair = el("p", "pair");
  pair.append("Pairing number ", el("strong", "", state.pairing));
  done.append(pair, el("p", "took", `in ${(state.doneAt - timeOrigin).toFixed(2)} s`));
  const actions = el("div", "actions");
  const copy = el("button", "primary", "Copy");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.text);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
  };
  actions.append(copy);
  if (onAgain) {
    const again = el("button", "", "Receive another");
    again.onclick = onAgain;
    actions.append(again);
  }
  done.append(actions);
  root.append(done);
}

function statusText(state) {
  if (state.done) return ["Done", "ok"];
  if (state.locked) return ["Locked on, reading chart", "lock"];
  return [state.everLocked ? "Re-acquiring…" : "Searching for chart…", ""];
}

function drawQuad(ctx, corners, map) {
  if (!corners) return;
  const pts = corners.map(([x, y]) => map(x, y));
  ctx.strokeStyle = "rgba(255, 217, 51, 0.95)";
  ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
  const r = 9 * (window.devicePixelRatio || 1);
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Sender

const message = $("message");
function updateCounter() {
  const bytes = utf8Length(message.value);
  const over = bytes > MAX_TEXT_BYTES;
  $("byte-count").textContent = `${bytes} / ${MAX_TEXT_BYTES} bytes`;
  $("byte-count").classList.toggle("over", over);
  $("block-count").textContent = bytes ? `${Math.ceil((bytes + 1) / CHUNK)} block${bytes + 1 > CHUNK ? "s" : ""}` : "";
  $("start").disabled = over || bytes === 0;
}
message.addEventListener("input", updateCounter);
updateCounter();

let player = null;

async function startSender() {
  const text = message.value;
  const { bits, blocks } = await encodeMessage(text);
  const pairing = await pairingNumber(text);
  const canvas = $("chart");
  const ctx = canvas.getContext("2d", { alpha: false });
  $("player").hidden = false;
  document.body.classList.add("playing");
  const root = document.documentElement;
  try {
    await root.requestFullscreen?.({ navigationUI: "hide" });
  } catch {}
  let wakeLock = null;
  const lock = async () => {
    try {
      wakeLock = await navigator.wakeLock?.request("screen");
    } catch {}
  };
  const onVisible = () => document.visibilityState === "visible" && player && lock();
  document.addEventListener("visibilitychange", onVisible);
  lock();

  let layout;
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = innerWidth, h = innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const s = Math.min(w / G.screenW, h / G.screenH);
    layout = { dpr, s, ox: (w - G.screenW * s) / 2, oy: (h - G.screenH * s) / 2 };
    const stop = $("stop");
    stop.style.top = `${layout.oy + 6 * s}px`;
    stop.style.height = `${28 * s}px`;
    stop.style.fontSize = `${14 * s}px`;
  };
  resize();
  addEventListener("resize", resize);

  const t0 = performance.now();
  let raf = 0;
  const frame = (now) => {
    const { dpr, s, ox, oy } = layout;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    drawStatic(ctx);
    drawChart(ctx, bits, (G.speed * (now - t0)) / 1000);
    ctx.fillStyle = "#c8c8cc";
    ctx.font = "600 15px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(`Pairing number  ${pairing}`, G.frameX + 4, 800);
    ctx.textAlign = "right";
    ctx.fillText(`${blocks.length} block${blocks.length > 1 ? "s" : ""}`, G.frameX + G.frameWidth - 4, 800);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  player = () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisible);
    wakeLock?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    $("player").hidden = true;
    document.body.classList.remove("playing");
    player = null;
  };
}

$("start").onclick = () => startSender();
$("stop").onclick = () => player?.();
addEventListener("keydown", (e) => e.key === "Escape" && player?.());
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && player && matchMedia("(pointer: fine)").matches) player();
});

// Receiver

function cameraError(err) {
  if (!window.isSecureContext) return "The camera needs a secure page. Open this site over HTTPS or on localhost.";
  if (!navigator.mediaDevices?.getUserMedia) return "This browser can’t use the camera.";
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was denied. Allow camera access for this site in your browser settings, then reload.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device.";
    case "NotReadableError":
      return "The camera is in use by another app.";
    default:
      return `The camera couldn’t start${err?.message ? `: ${err.message}` : "."}`;
  }
}

function startReceiver() {
  const video = $("video");
  const overlay = $("overlay");
  const octx = overlay.getContext("2d");
  const status = $("rx-status");
  const progress = $("rx-progress");
  const errorBox = $("rx-error");
  const proc = document.createElement("canvas");
  const pctx = proc.getContext("2d", { willReadFrequently: true });
  let stream = null;
  let worker = null;
  let stopped = false;
  let busy = false;
  let done = false;
  let session = 0;
  let lastMedia = -1;
  let stalls = 0;
  let useMediaTime = true;
  let lastState = null;

  errorBox.hidden = true;
  status.textContent = "Starting camera…";
  status.className = "status";
  progress.replaceChildren();

  const reset = () => {
    const wasDone = done;
    session++;
    done = false;
    busy = false;
    lastState = null;
    worker.postMessage({ type: "reset", id: session });
    renderProgress(progress, { count: null, everLocked: false });
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (wasDone) schedule();
  };

  const show = (state) => {
    lastState = state;
    const [label, cls] = statusText(state);
    status.textContent = label;
    status.className = `status ${cls}`;
    renderProgress(progress, state, { onAgain: reset });
    paintOverlay();
    if (state.done && !done) {
      done = true;
      navigator.vibrate?.(60);
    }
  };

  const paintOverlay = () => {
    const dpr = window.devicePixelRatio || 1;
    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) {
      overlay.width = Math.round(cw * dpr);
      overlay.height = Math.round(ch * dpr);
    }
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!lastState || lastState.done || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const k = Math.min(cw / vw, ch / vh);
    const dx = (cw - vw * k) / 2, dy = (ch - vh * k) / 2;
    const sx = vw / proc.width;
    drawQuad(octx, lastState.corners, (x, y) => [(dx + x * sx * k) * dpr, (dy + y * sx * k) * dpr]);
  };

  const onFrame = (now, meta) => {
    if (stopped || done) return;
    schedule();
    if (busy || !video.videoWidth) return;
    let t = now / 1000;
    if (useMediaTime && meta?.mediaTime !== undefined) {
      if (meta.mediaTime <= lastMedia) {
        if (++stalls > 10) {
          useMediaTime = false;
          reset();
        }
        return;
      }
      stalls = 0;
      lastMedia = meta.mediaTime;
      t = meta.mediaTime;
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    const k = PROC_LONG_SIDE / Math.max(vw, vh);
    const pw = Math.round(vw * k), ph = Math.round(vh * k);
    if (proc.width !== pw || proc.height !== ph) {
      proc.width = pw;
      proc.height = ph;
    }
    pctx.drawImage(video, 0, 0, pw, ph);
    const img = pctx.getImageData(0, 0, pw, ph);
    busy = true;
    worker.postMessage({ type: "frame", id: session, width: pw, height: ph, buffer: img.data.buffer, t }, [img.data.buffer]);
  };

  const schedule = () => {
    if (stopped || done) return;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
    else requestAnimationFrame((now) => onFrame(now));
  };

  const fail = (err) => {
    status.textContent = "No camera";
    errorBox.hidden = false;
    errorBox.replaceChildren(el("p", "", cameraError(err)));
    const p = el("p", "");
    const a = el("a", "", "Try the loopback demo instead");
    a.href = "#demo";
    p.append(a);
    errorBox.append(p);
  };

  const start = async () => {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw null;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "environment", width: { ideal: 1280 } } });
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      status.textContent = "Searching for chart…";
      schedule();
    } catch (err) {
      fail(err);
    }
  };

  worker = createWorker();
  worker.onmessage = ({ data }) => {
    if (data.id !== session) return;
    busy = false;
    show(data.state);
  };
  addEventListener("resize", paintOverlay);
  reset();
  start();

  return () => {
    stopped = true;
    removeEventListener("resize", paintOverlay);
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    worker.terminate();
  };
}

// Loopback demo

function startDemo() {
  const chart = $("demo-chart");
  const cctx = chart.getContext("2d", { alpha: false });
  const cam = $("demo-camera");
  const camCtx = cam.getContext("2d");
  const over = $("demo-overlay");
  const octx = over.getContext("2d");
  const progress = $("demo-progress");
  const worker = createWorker();
  let raf = 0;
  let run = 0;
  let stopped = false;

  const sizeChart = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = chart.clientWidth;
    chart.width = Math.round(w * dpr);
    chart.height = Math.round((w * G.screenH) / G.screenW * dpr);
  };

  const begin = async () => {
    cancelAnimationFrame(raf);
    const id = ++run;
    const text = utf8Length(message.value) > 0 && utf8Length(message.value) <= MAX_TEXT_BYTES ? message.value : DEFAULT_TEXT;
    const { bits } = await encodeMessage(text);
    $("demo-pairing").textContent = await pairingNumber(text);
    if (stopped || id !== run) return;
    sizeChart();
    camCtx.fillStyle = "#1a1a1a";
    camCtx.fillRect(0, 0, cam.width, cam.height);
    octx.clearRect(0, 0, over.width, over.height);
    renderProgress(progress, { count: null, everLocked: false });
    worker.postMessage({ type: "sim-start", id, text, scenario: $("scenario").value, seed: (Math.random() * 2 ** 32) >>> 0 });
    let busy = false;
    let finished = null;
    const t0 = performance.now();
    worker.onmessage = ({ data }) => {
      if (data.id !== run) return;
      busy = false;
      if (data.type !== "sim") return;
      const { width, height, buffer } = data.image;
      camCtx.putImageData(new ImageData(new Uint8ClampedArray(buffer), width, height), 0, 0);
      const s = data.state;
      octx.clearRect(0, 0, over.width, over.height);
      if (!s.done) drawQuad(octx, s.corners, (x, y) => [x * 2, y * 2]);
      const [label, cls] = statusText(s);
      $("demo-status").textContent = label;
      $("demo-status").className = `state ${cls}`;
      renderProgress(progress, s, { timeOrigin: 0, expected: text });
      if (s.done) finished = s.doneAt;
      $("demo-time").textContent = `${(finished ?? (performance.now() - t0) / 1000).toFixed(2)} s`;
    };
    const frame = (now) => {
      const t = (now - t0) / 1000;
      const dpr = chart.width / G.screenW;
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.fillStyle = "#000";
      cctx.fillRect(0, 0, chart.width, chart.height);
      cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawStatic(cctx);
      drawChart(cctx, bits, G.speed * t);
      if (finished === null) {
        $("demo-time").textContent = `${t.toFixed(2)} s`;
        if (!busy) {
          busy = true;
          worker.postMessage({ type: "sim-frame", id, t });
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  };

  $("restart").onclick = begin;
  $("scenario").onchange = begin;
  addEventListener("resize", sizeChart);
  begin();

  return () => {
    stopped = true;
    run++;
    cancelAnimationFrame(raf);
    removeEventListener("resize", sizeChart);
    worker.terminate();
  };
}

route();
