import { G } from "./geometry.js";
import { Homography } from "./homography.js";
import { decodeBlock, MAX_BLOCKS, ROWS } from "./codec.js";

export const TUNING = {
  greenThreshold: 0.18,
  minQuadFraction: 4000 / (216 * 384),
  maxBlobFraction: 800 / (216 * 384),
  barWindow: 30,
  gate: 14,
  maxRejected: 10,
  loopMarkerRatio: 2.2,
  glareLimit: 0.8,
  minContrast: 0.06,
  decodeEvery: 3,
  resetAfterGap: 5,
  coastFor: 0.6,
  maxSkew: 48,
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

export class ChartDecoder {
  constructor({ blocks = null, speed = G.speed } = {}) {
    this.nominalSpeed = speed;
    this.speed = speed;
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
    this.lastCorners = null;
    this.samples = [];
    const { width: w, height: h, data } = img;
    const hom = this.findHomography(img);
    if (!hom) {
      this.skippedFiducials++;
      return false;
    }
    const luma = new Float32Array(w * h);
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) luma[i] = Math.max(data[j], data[j + 1], data[j + 2]) / 255;
    const sample = sampler(luma, w, h);
    const at = (x, y) => {
      const [cx, cy] = hom.apply(x, y);
      return sample(cx, cy);
    };
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
    const m = G.measure;
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
      const kL = (G.judgeY + u - (bar.loopY - G.pitch / 2)) / G.pitch;
      this.votes[(((-Math.round(kL / 8)) % 4) + 4) % 4] += 1;
    }
    this.sampleCells(at, hom, u);
    this.processed++;
    return true;
  }

  findHomography(img) {
    const { width: w, height: h, data } = img;
    const n = w * h;
    const thr = TUNING.greenThreshold * 255;
    const green = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) green[i] = data[j + 1] - Math.max(data[j], data[j + 2]);
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
        const x = i % w, y = (i / w) | 0, g = green[i] / 255;
        sx += x * g; sy += y * g; sw += g; area++;
        if (x > 0 && !seen[i - 1] && green[i - 1] > thr) { seen[i - 1] = 1; stack.push(i - 1); }
        if (x < w - 1 && !seen[i + 1] && green[i + 1] > thr) { seen[i + 1] = 1; stack.push(i + 1); }
        if (y > 0 && !seen[i - w] && green[i - w] > thr) { seen[i - w] = 1; stack.push(i - w); }
        if (y < h - 1 && !seen[i + w] && green[i + w] > thr) { seen[i + w] = 1; stack.push(i + w); }
      }
      if (area >= 4 && area <= maxArea) blobs.push({ x: sx / sw + 0.5, y: sy / sw + 0.5, area });
    }
    if (blobs.length < 4) return null;
    const four = blobs.sort((a, b) => b.area - a.area).slice(0, 4).sort((a, b) => a.y - b.y);
    const top = four.slice(0, 2).sort((a, b) => a.x - b.x), bottom = four.slice(2).sort((a, b) => a.x - b.x);
    const quadArea = Math.abs((top[1].x - bottom[0].x) * (top[0].y - bottom[1].y) - (top[0].x - bottom[1].x) * (top[1].y - bottom[0].y)) / 2;
    if (quadArea <= TUNING.minQuadFraction * n) return null;
    this.lastCorners = [top[0], top[1], bottom[1], bottom[0]].map((b) => [b.x, b.y]);
    return Homography.fit(G.fiducials, [top[0], top[1], bottom[0], bottom[1]].map((b) => [b.x, b.y]));
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
    const m = G.measure;
    const phase = (y) => {
      const v = (y - G.judgeY - G.pitch / 2) % m;
      return v < 0 ? v + m : v;
    };
    const signed = (a, b) => {
      let x = a - b;
      if (x > m / 2) x -= m;
      if (x < -m / 2) x += m;
      return x;
    };
    if (this.uPrev !== null && this.rejected < TUNING.maxRejected) {
      const predicted = phase(this.uPrev + this.speed * (t - this.tPrev) + G.judgeY + G.pitch / 2);
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
    const p = G.pitch;
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
