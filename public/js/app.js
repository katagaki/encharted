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
    root.append(el("p", "waiting", state.everLocked ? "最初のブロックを読み取り中…" : "送信側の譜面にカメラを向けてください。"));
    return;
  }
  const times = new Map(state.blocks.map((b) => [b.index, b.time]));
  const list = el("ol", "blocks");
  for (let i = 0; i < state.count; i++) {
    const li = el("li", times.has(i) ? "got" : "");
    li.append(el("span", "bname", `ブロック ${i + 1}/${state.count}`));
    if (times.has(i)) {
      li.append(el("span", "judge", "PGREAT"), el("span", "btime", `${(times.get(i) - timeOrigin).toFixed(2)} 秒`));
    } else {
      li.append(el("span", "reading", "読み取り中…"));
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
  done.append(el("p", ok ? "complete" : "mismatch", ok ? "受信完了" : "内容が一致しません"));
  const pair = el("p", "pair");
  pair.append("ペアリング番号 ", el("strong", "", state.pairing));
  done.append(pair, el("p", "took", `所要時間 ${(state.doneAt - timeOrigin).toFixed(2)} 秒`));
  const actions = el("div", "actions");
  const copy = el("button", "primary", "コピー");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.text);
      copy.textContent = "コピーしました";
    } catch {
      copy.textContent = "コピーできませんでした";
    }
  };
  actions.append(copy);
  if (onAgain) {
    const again = el("button", "", "続けて受信");
    again.onclick = onAgain;
    actions.append(again);
  }
  done.append(actions);
  root.append(done);
}

function statusText(state) {
  if (state.done) return ["完了", "ok"];
  if (state.locked) return ["譜面を捕捉、読み取り中", "lock"];
  return [state.everLocked ? "再捕捉中…" : "譜面を探しています…", ""];
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
  $("byte-count").textContent = `${bytes} / ${MAX_TEXT_BYTES} バイト`;
  $("byte-count").classList.toggle("over", over);
  $("block-count").textContent = bytes ? `${Math.ceil((bytes + 1) / CHUNK)} ブロック` : "";
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
    ctx.font = '600 15px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(`ペアリング番号  ${pairing}`, G.frameX + 4, 800);
    ctx.textAlign = "right";
    ctx.fillText(`${blocks.length} ブロック`, G.frameX + G.frameWidth - 4, 800);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  player = () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisible);
    wakeLock?.release().catch(() => {});
    $("player").hidden = true;
    document.body.classList.remove("playing");
    player = null;
  };
}

$("start").onclick = () => startSender();
$("stop").onclick = () => player?.();
addEventListener("keydown", (e) => e.key === "Escape" && player?.());

// Receiver

function cameraError(err) {
  if (!window.isSecureContext) return "カメラを使うには安全な接続が必要です。HTTPS か localhost でこのページを開いてください。";
  if (!navigator.mediaDevices?.getUserMedia) return "このブラウザではカメラを使用できません。";
  switch (err?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "カメラへのアクセスが許可されていません。ブラウザの設定でこのサイトのカメラを許可してから、ページを再読み込みしてください。";
    case "NotFoundError":
    case "OverconstrainedError":
      return "このデバイスにカメラが見つかりません。";
    case "NotReadableError":
      return "カメラが別のアプリで使用中です。";
    default:
      return `カメラを起動できませんでした${err?.message ? `（${err.message}）` : "。"}`;
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
  let timeSource = "clock";
  let lastState = null;
  const diagToggle = $("rx-diag");
  const diagText = $("rx-diag-text");
  const arrivals = [];
  diagText.hidden = !diagToggle.checked;
  diagToggle.onchange = () => {
    diagText.hidden = !diagToggle.checked;
    worker.postMessage({ type: "debug", on: diagToggle.checked });
  };

  errorBox.hidden = true;
  status.textContent = "カメラを起動中…";
  status.className = "status";
  progress.replaceChildren();

  const reset = () => {
    const wasDone = done;
    session++;
    done = false;
    busy = false;
    lastState = null;
    worker.postMessage({ type: "reset", id: session, debug: diagToggle.checked });
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
    if (state.diag) {
      const now = performance.now();
      arrivals.push(now);
      while (arrivals[0] < now - 1000) arrivals.shift();
      const g = state.diag;
      diagText.textContent = [
        `frames ${g.processed} decoded/s ${arrivals.length}  time ${timeSource} ${g.t.toFixed(2)}`,
        `video ${video.videoWidth}×${video.videoHeight}  proc ${proc.width}×${proc.height}`,
        `no corners ${g.skippedFiducials}  no bar ${g.skippedBars}  coasted ${g.coasted}`,
        `skew ${g.skew.toFixed(1)}  speed ${(g.speed / G.pitch).toFixed(2)} rows/s  loop votes ${g.votes.join(" ")}`,
        `lane contrast ${g.contrast.map((c) => c.toFixed(2)).join(" ")}`,
        `cells seen ≥3× ${(g.observed * 100).toFixed(0)}%  blocks ${state.count ?? "?"}`,
      ].join("\n");
    }
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
    const map = (x, y) => [(dx + x * sx * k) * dpr, (dy + y * sx * k) * dpr];
    drawQuad(octx, lastState.corners, map);
    if (lastState.diag) {
      for (const [x, y, v] of lastState.diag.samples) {
        const [px, py] = map(x, y);
        octx.fillStyle = v > 0 ? "rgba(255, 60, 200, 0.95)" : "rgba(0, 200, 255, 0.8)";
        octx.beginPath();
        octx.arc(px, py, (v > 0 ? 3.5 : 2) * dpr, 0, Math.PI * 2);
        octx.fill();
      }
    }
  };

  const onFrame = (now, meta) => {
    if (stopped || done) return;
    schedule();
    if (busy || !video.videoWidth) return;
    let t = now / 1000;
    timeSource = "clock";
    const stamp = typeof meta?.captureTime === "number" ? meta.captureTime / 1000 : meta?.mediaTime;
    if (useMediaTime && typeof stamp === "number") {
      if (stamp <= lastMedia) {
        if (++stalls > 10) {
          useMediaTime = false;
          reset();
        }
        return;
      }
      stalls = 0;
      lastMedia = stamp;
      t = stamp;
      timeSource = typeof meta.captureTime === "number" ? "captureTime" : "mediaTime";
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
    status.textContent = "カメラを使用できません";
    errorBox.hidden = false;
    errorBox.replaceChildren(el("p", "", cameraError(err)));
    const p = el("p", "");
    const a = el("a", "", "代わりにループバックデモを試す");
    a.href = "#demo";
    p.append(a);
    errorBox.append(p);
  };

  const start = async () => {
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw null;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "environment", width: { ideal: 1280 }, frameRate: { ideal: 60 } } });
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      status.textContent = "譜面を探しています…";
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
      $("demo-time").textContent = `${(finished ?? (performance.now() - t0) / 1000).toFixed(2)} 秒`;
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
        $("demo-time").textContent = `${t.toFixed(2)} 秒`;
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
