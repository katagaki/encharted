import { G } from "./geometry.js";
import { Homography } from "./homography.js";
import { decodeBlock, MAX_BLOCKS, ROWS } from "./codec.js";

export const TUNING = {
  greenThreshold: 0.18,
  minGreenThreshold: 0.06,
  greenTopFraction: 0.0004,
  maxCornerCandidates: 9,
  cornerAreaSpread: 5,
  maxSideRatio: 1.8,
  maxAspectError: 1.6,
  verifyCandidates: 4,
  redMargin: 0.08,
  minRedLanes: 3,
  minQuadFraction: 4000 / (216 * 384),
  maxBlobFraction: 800 / (216 * 384),
  barWindow: 30,
  gate: 14,
  maxRejected: 10,
  loopMarkerRatio: 2.2,
  glareLimit: 0.8,
  minContrast: 0.06,
  decodeEvery: 3,
  decodePitches: 2,
  resetAfterGap: 5,
  coastFor: 0.6,
  maxSkew: 80,
};

function sampler(luma, w, h) {
  return (x, y) => {
    const fx = x - 0.5, fy = y - 0.5;
    if (fx < 0 || fy < 0 || fx >= w - 1 || fy >= h - 1) return 0;
    const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
    const i = y0 * w + x0;
    return (luma[i] * (1 - ax) + luma[i + 1] * ax) * (1 - ay) + (luma[i + w] * (1 - ax) + luma[i + w + 1] * ax) * ay;
  };
}

class Accumulator {
  constructor(blocks) {
    this.blocks = blocks;
    this.rows = blocks * ROWS;
    this.sums = new Float32Array(this.rows * 8);
    this.counts = new Float32Array(this.rows * 8);
  }
  add(k, lane, s) {
    const i = (((k % this.rows) + this.rows) % this.rows) * 8 + lane;
    this.sums[i] += s;
    this.counts[i] += 1;
  }
  grid(c, block) {
    const bits = new Uint8Array(256), conf = new Float32Array(256);
    for (let r = 0; r < 32; r++) {
      const src = (((32 * block + r - 8 * c) % this.rows) + this.rows) % this.rows;
      for (let l = 0; l < 8; l++) {
        const i = src * 8 + l;
        bits[r * 8 + l] = this.sums[i] > 0 ? 1 : 0;
        conf[r * 8 + l] = this.counts[i] >= 3 ? Math.abs(this.sums[i]) / this.counts[i] : 0;
      }
    }
    return { bits, conf };
  }
}

export function locateChart(img) {
  const { width: w, height: h, data } = img;
  const finish = (hom, corners) => {
    const luma = new Float32Array(w * h);
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) luma[i] = Math.max(data[j], data[j + 1], data[j + 2]) / 255;
    const sample = sampler(luma, w, h);
    const at = (x, y) => {
      const [cx, cy] = hom.apply(x, y);
      return sample(cx, cy);
    };
    return { hom, at, corners: corners.map((b) => [b.x, b.y]) };
  };
  const n = w * h;
  const green = new Int16Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const g = data[j + 1] - Math.max(data[j], data[j + 2]);
    green[i] = g;
    if (g > 0) hist[g]++;
  }
  let top = 0, v = 255;
  const need = Math.max(16, Math.round(n * TUNING.greenTopFraction));
  for (; v > 0; v--) {
    top += hist[v];
    if (top >= need) break;
  }
  const thr = Math.min(TUNING.greenThreshold * 255, Math.max(TUNING.minGreenThreshold * 255, 0.5 * v));
  const seen = new Uint8Array(n);
  const maxArea = Math.max(800, TUNING.maxBlobFraction * n);
  const blobs = [];
  const stack = [];
  for (let start = 0; start < n; start++) {
    if (green[start] <= thr || seen[start]) continue;
    stack.push(start);
    seen[start] = 1;
    let sx = 0, sy = 0, sw = 0, area = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0, g = green[i] - thr + 1;
      sx += x * g; sy += y * g; sw += g; area++;
      if (x > 0 && !seen[i - 1] && green[i - 1] > thr) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !seen[i + 1] && green[i + 1] > thr) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - w] && green[i - w] > thr) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !seen[i + w] && green[i + w] > thr) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (area >= 3 && area <= maxArea) blobs.push({ x: sx / sw + 0.5, y: sy / sw + 0.5, area });
  }
  if (blobs.length < 4) return null;
  const cand = blobs.sort((a, b) => b.area - a.area).slice(0, TUNING.maxCornerCandidates);
  const expected = (G.fiducials[2][1] - G.fiducials[0][1]) / (G.fiducials[1][0] - G.fiducials[0][0]);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const options = [];
  for (let i = 0; i < cand.length; i++)
    for (let j = i + 1; j < cand.length; j++)
      for (let k = j + 1; k < cand.length; k++)
        for (let l = k + 1; l < cand.length; l++) {
          const four = [cand[i], cand[j], cand[k], cand[l]];
          const areas = four.map((b) => b.area);
          if (Math.max(...areas) > TUNING.cornerAreaSpread * Math.min(...areas)) continue;
          const byY = [...four].sort((a, b) => a.y - b.y);
          const [tl, tr] = byY.slice(0, 2).sort((a, b) => a.x - b.x);
          const [bl, br] = byY.slice(2).sort((a, b) => a.x - b.x);
          const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
          const turns = [cross(tl, tr, br), cross(tr, br, bl), cross(br, bl, tl), cross(bl, tl, tr)];
          if (!(turns.every((c) => c > 0) || turns.every((c) => c < 0))) continue;
          const quadArea = Math.abs((tr.x - bl.x) * (tl.y - br.y) - (tl.x - br.x) * (tr.y - bl.y)) / 2;
          if (quadArea <= TUNING.minQuadFraction * n) continue;
          const wTop = dist(tl, tr), wBot = dist(bl, br), hL = dist(tl, bl), hR = dist(tr, br);
          const sideSkew = Math.max(wTop / wBot, wBot / wTop, hL / hR, hR / hL);
          if (sideSkew > TUNING.maxSideRatio) continue;
          const ratio = (hL + hR) / (wTop + wBot) / expected;
          if (ratio < 1 / TUNING.maxAspectError || ratio > TUNING.maxAspectError) continue;
          const score = Math.abs(Math.log(ratio)) + 0.5 * Math.log(sideSkew) - 0.05 * Math.log(Math.min(...areas));
          options.push({ score, corners: [tl, tr, bl, br] });
        }
  options.sort((a, b) => a.score - b.score);
  const lumaAt = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const j = (yi * w + xi) * 4;
    return [data[j], data[j + 1], data[j + 2]];
  };
  for (const opt of options.slice(0, TUNING.verifyCandidates)) {
    const [tl, tr, bl, br] = opt.corners;
    const hom = Homography.fit(G.fiducials, [tl, tr, bl, br].map((b) => [b.x, b.y]));
    if (!hom) continue;
    let red = 0, total = 0;
    for (let lane = 0; lane < 8; lane++) {
      const cx = G.laneX0[lane] + G.laneWidths[lane] / 2;
      const px = lumaAt(...hom.apply(cx, G.judgeY - 0.5));
      if (!px) continue;
      total++;
      if (px[0] - Math.max(px[1], px[2]) > TUNING.redMargin * 255) red++;
    }
    if (options.length > 1 && total && red < TUNING.minRedLanes) continue;
    return finish(hom, [tl, tr, br, bl]);
  }
  if (!options.length) return null;
  const [tl, tr, bl, br] = options[0].corners;
  const hom = Homography.fit(G.fiducials, [tl, tr, bl, br].map((b) => [b.x, b.y]));
  return hom ? finish(hom, [tl, tr, br, bl]) : null;
}

export class ChartDecoder {
  constructor({ blocks = null, pitch = G.pitch } = {}) {
    this.pitch = pitch;
    this.measure = 8 * pitch;
    this.nominalSpeed = G.rowsPerSecond * pitch;
    this.speed = this.nominalSpeed;
    this.hits = 0;
    this.blocks = blocks;
    this.#resetAccumulation();
    this.processed = 0;
    this.rejected = 0;
    this.barAreas = [];
    this.uPrev = null;
    this.tPrev = 0;
    this.lastCorners = null;
    this.skippedFiducials = 0;
    this.skippedBars = 0;
    this.coasted = 0;
    this.skew = 0;
    this.noBars = false;
    this.debug = false;
    this.samples = [];
    this.laneContrast = new Array(8).fill(0);
  }

  #resetAccumulation() {
    this.votes = [0, 0, 0, 0];
    this.accumulators = this.blocks
      ? [new Accumulator(this.blocks)]
      : Array.from({ length: MAX_BLOCKS }, (_, i) => new Accumulator(i + 1));
  }

  setBlockCount(n) {
    if (this.blocks === n) return;
    this.blocks = n;
    this.accumulators = this.accumulators.filter((a) => a.blocks === n);
    if (!this.accumulators.length) this.accumulators = [new Accumulator(n)];
  }

  process(img, t) {
    const frame = locateChart(img);
    if (!frame) {
      this.lastCorners = null;
      this.samples = [];
      this.skippedFiducials++;
      return false;
    }
    return this.track(frame, t);
  }

  track({ hom, at, corners }, t) {
    this.lastCorners = corners;
    this.samples = [];
    this.hits *= 0.97;
    if (this.uPrev !== null && t - this.tPrev > TUNING.resetAfterGap) {
      this.uPrev = null;
      this.speed = this.nominalSpeed;
      this.#resetAccumulation();
    }
    const bar = this.barPhase(at, t);
    if (!bar) {
      this.skippedBars++;
      if (this.noBars && this.uPrev !== null && t - this.tPrev < TUNING.coastFor) {
        this.coasted++;
        this.sampleCells(at, hom, this.uPrev + this.speed * (t - this.tPrev));
        this.processed++;
        return true;
      }
      return false;
    }
    const m = this.measure;
    let u = bar.phi;
    if (this.uPrev !== null) {
      const dt = t - this.tPrev;
      const pred = this.uPrev + (dt > 1 ? this.nominalSpeed : this.speed) * dt;
      u = bar.phi + m * Math.round((pred - bar.phi) / m);
      if (dt > 0) {
        const inst = (u - this.uPrev) / dt;
        this.speed = Math.max(this.nominalSpeed * 0.9, Math.min(this.nominalSpeed * 1.1, 0.9 * this.speed + 0.1 * inst));
      }
    }
    this.uPrev = u;
    this.tPrev = t;
    if (bar.loopY !== null) {
      const kL = (G.judgeY + u - (bar.loopY - this.pitch / 2)) / this.pitch;
      this.votes[(((-Math.round(kL / 8)) % 4) + 4) % 4] += 1;
    }
    this.sampleCells(at, hom, u);
    this.processed++;
    this.hits += 1;
    return true;
  }

  barPhase(at, t) {
    const y0 = G.visTop + 2, y1 = G.judgeY - 2;
    const n = y1 - y0 + 1;
    const win = TUNING.barWindow;
    const detrend = (q) => {
      const d = new Float32Array(q.length);
      for (let i = 0; i < q.length; i++) {
        let lo = Infinity;
        for (let j = Math.max(0, i - win); j <= Math.min(q.length - 1, i + win); j++) lo = Math.min(lo, q[j]);
        d[i] = q[i] - lo;
      }
      return d;
    };
    const half = this.skew / 2;
    const pl = new Float32Array(n), pr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const y = y0 + i;
      let l = 0, r = 0;
      for (const dx of [-3, 0, 3]) {
        l += at(G.leftGutterX + dx, y - half);
        r += at(G.rightGutterX + dx, y + half);
      }
      pl[i] = l / 3;
      pr[i] = r / 3;
    }
    const pc = new Float32Array(n);
    for (let i = 0; i < n; i++) pc[i] = (pl[i] + pr[i]) / 2;
    const d = detrend(pc), dl = detrend(pl), dr = detrend(pr);
    let dMax = 0;
    for (let i = 0; i < n; i++) dMax = Math.max(dMax, d[i]);
    const thr = Math.max(0.08, 0.2 * dMax);
    let regions = [];
    for (let i = 0; i < n; ) {
      if (!(d[i] > thr)) {
        i++;
        continue;
      }
      let a = i, b = i;
      while (a > 0 && d[a - 1] > thr / 2) a--;
      while (b < n - 1 && d[b + 1] > thr / 2) b++;
      let area = 0, moment = 0;
      for (let k = a; k <= b; k++) {
        area += d[k];
        moment += d[k] * (y0 + k);
      }
      if (a > 3 && b < n - 4) regions.push({ y: moment / area, area });
      i = b + 1;
    }
    this.noBars = regions.length === 0;
    if (!regions.length) return null;
    const m = this.measure;
    const phase = (y) => {
      const v = (y - G.judgeY - this.pitch / 2) % m;
      return v < 0 ? v + m : v;
    };
    const signed = (a, b) => {
      let x = a - b;
      if (x > m / 2) x -= m;
      if (x < -m / 2) x += m;
      return x;
    };
    if (this.uPrev !== null && this.rejected < TUNING.maxRejected) {
      const predicted = phase(this.uPrev + this.speed * (t - this.tPrev) + G.judgeY + this.pitch / 2);
      regions = regions.filter((r) => Math.abs(signed(phase(r.y), predicted)) < TUNING.gate);
      if (!regions.length) {
        this.rejected++;
        return null;
      }
    }
    this.rejected = 0;
    const agree = (a) => regions.filter((r) => Math.abs(signed(phase(r.y), phase(a.y))) < 8).length;
    let ref = regions[0], best = agree(ref);
    for (const r of regions) {
      const c = agree(r);
      if (c > best) {
        best = c;
        ref = r;
      }
    }
    const kept = regions.filter((r) => Math.abs(signed(phase(r.y), phase(ref.y))) < 8);
    let phi = phase(ref.y) + kept.reduce((s, r) => s + signed(phase(r.y), phase(ref.y)), 0) / kept.length;
    if (phi < 0) phi += m;
    const areas = this.barAreas;
    const barArea = areas.length >= 4 ? [...areas].sort((a, b) => a - b)[Math.floor(areas.length * 0.3)] : null;
    let loop = null;
    for (const r of kept) {
      if (barArea !== null && r.area > TUNING.loopMarkerRatio * barArea) loop = r;
      areas.push(r.area);
      if (areas.length > 24) areas.shift();
    }
    const lim = TUNING.maxSkew;
    const centroid = (q, y) => {
      let a = 0, mo = 0;
      for (let k = Math.max(0, Math.round(y - y0 - lim)); k <= Math.min(n - 1, Math.round(y - y0 + lim)); k++) {
        const v = q[k] - thr / 2;
        if (v > 0) {
          a += v;
          mo += v * (y0 + k);
        }
      }
      return a > 0.05 ? mo / a : null;
    };
    for (const r of kept) {
      if (r === loop) continue;
      const yl = centroid(dl, r.y), yr = centroid(dr, r.y);
      if (yl !== null && yr !== null) {
        this.skew = Math.max(-lim, Math.min(lim, this.skew + 0.25 * (yr - yl)));
      }
    }
    return { phi, loopY: loop ? loop.y : null };
  }

  sampleCells(at, hom, u0) {
    const p = this.pitch;
    const span = G.rightGutterX - G.leftGutterX;
    for (let lane = 0; lane < 8; lane++) {
      const w = G.laneWidths[lane], cx = G.laneX0[lane] + w / 2, hw = w * 0.25;
      const u = u0 + ((cx - G.leftGutterX) / span - 0.5) * this.skew;
      const kLo = Math.ceil((u + 8) / p), kHi = Math.floor((G.judgeY + u - G.visTop - 8) / p);
      if (kLo > kHi) continue;
      const avg = (y) => (at(cx - hw, y) + at(cx, y) + at(cx + hw, y)) / 3;
      const vals = [];
      for (let k = kLo; k <= kHi; k++) {
        const y = G.judgeY - k * p + u;
        const note = (avg(y - 3) + avg(y) + avg(y + 3)) / 3;
        const bgA = avg(y - 0.3 * p), bgB = avg(y + 0.3 * p);
        if (Math.max(bgA, bgB) > TUNING.glareLimit) continue;
        vals.push([k, note - Math.min(bgA, bgB)]);
      }
      if (vals.length < 4) continue;
      const sorted = vals.map((v) => v[1]).sort((a, b) => b - a);
      const top = sorted.slice(0, Math.max(2, Math.floor(sorted.length / 4)));
      const c = top.reduce((a, b) => a + b, 0) / top.length;
      this.laneContrast[lane] = c;
      if (!(c > TUNING.minContrast)) continue;
      for (const [k, v] of vals) {
        const s = Math.max(-1, Math.min(1, (v - c / 2) / (c / 2)));
        for (const acc of this.accumulators) acc.add(k, lane, s);
        if (this.debug) this.samples.push([...hom.apply(cx, G.judgeY - k * p + u), s]);
      }
    }
  }

  async decodeBlocks() {
    const rotations = [0, 1, 2, 3].sort((a, b) => this.votes[b] - this.votes[a] || a - b);
    for (const acc of this.accumulators) {
      const found = [];
      for (const c of rotations) {
        for (let b = 0; b < acc.blocks; b++) {
          const g = acc.grid(c, b);
          const payload = await decodeBlock(g.bits, g.conf);
          if (payload && (payload[0] & 0xf) === acc.blocks && payload[0] >> 4 < acc.blocks) found.push(payload);
        }
        if (found.length) return found;
      }
    }
    return [];
  }
}
