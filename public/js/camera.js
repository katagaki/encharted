import { G } from "./geometry.js";
import { Homography } from "./homography.js";

export class RNG {
  constructor(seed) {
    this.a = seed >>> 0 || 0x9e3779b9;
    this.b = 0x243f6a88;
    this.c = 0xb7e15162;
    this.d = 1;
    for (let i = 0; i < 12; i++) this.next();
  }
  next() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    Object.assign(this, { a, b, c, d });
    return t >>> 0;
  }
  uniform() {
    return this.next() / 4294967296;
  }
  range(lo, hi) {
    return lo + (hi - lo) * this.uniform();
  }
  gaussian() {
    return (this.uniform() + this.uniform() + this.uniform() + this.uniform() - 2) * 1.7320508;
  }
  int(n) {
    return Math.floor(this.uniform() * n);
  }
  bytes(n) {
    return Uint8Array.from({ length: n }, () => this.next() & 255);
  }
}

export const SCENARIOS = {
  clean: { blur: [0.6, 1.0], noise: 0.015, ambient: [0, 0.03], glare: 0, shakeRate: 0, pwm: false, tilt: 0.04, handheld: 0, approach: false, readout: 0 },
  typical: { blur: [1.0, 1.6], noise: 0.035, ambient: [0.04, 0.1], glare: 1, shakeRate: 0.05, pwm: false, tilt: 0.08, handheld: 1, approach: true, readout: 0.025 },
  harsh: { blur: [1.6, 2.4], noise: 0.06, ambient: [0.1, 0.2], glare: 2, shakeRate: 0.12, pwm: true, tilt: 0.12, handheld: 1, approach: true, readout: 0.035 },
};

export class Camera {
  static W = 216;
  static H = 384;

  constructor(sc, rng) {
    this.rng = new RNG(rng.next());
    const s = rng.range(0.4, 0.47);
    const theta = rng.range(-0.08, 0.08);
    const hw = (G.frameWidth * s) / 2, hh = ((G.frameBottom - G.frameTop) * s) / 2;
    const jitter = (sc.tilt * (hw + hh)) / 2;
    const dst = [];
    for (const [ux, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const x = ux * hw + rng.gaussian() * jitter * 0.5, y = uy * hh + rng.gaussian() * jitter * 0.5;
      dst.push([108 + x * Math.cos(theta) - y * Math.sin(theta), 192 + x * Math.sin(theta) + y * Math.cos(theta)]);
    }
    const l = G.frameX, r = G.frameX + G.frameWidth, t = G.frameTop, b = G.frameBottom;
    this.h0 = Homography.fit([[l, t], [r, t], [r, b], [l, b]], dst);
    this.blur = rng.range(...sc.blur);
    this.noise = sc.noise;
    this.ambient = rng.range(...sc.ambient);
    this.gain = rng.range(0.75, 1.15);
    this.glare = [];
    for (let i = 0; i < sc.glare; i++) {
      const [x, y] = this.h0.apply(rng.range(G.laneX0[0], G.laneX1(7)), rng.range(G.visTop, G.judgeY));
      this.glare.push({ x, y, r: rng.range(8, 20), s: rng.range(0.5, 1.3) });
    }
    this.pwm = sc.pwm;
    this.shakeRate = sc.shakeRate;
    this.handheld = sc.handheld;
    this.approach = sc.approach;
    this.readout = sc.readout ?? 0;
    this.wobble = Array.from({ length: 8 }, () => ({ f: rng.range(0.15, 0.9), p: rng.range(0, 2 * Math.PI) }));
    this.lastPose = null;
    this.shake = [0, 0];
    this.img = new Float32Array(Camera.W * Camera.H * 3);
    this.tmp = new Float32Array(Camera.W * Camera.H * 3);
  }

  pose(t) {
    const w = (i) => {
      const a = this.wobble[2 * i], b = this.wobble[2 * i + 1];
      return 0.65 * Math.sin(2 * Math.PI * a.f * t + a.p) + 0.35 * Math.sin(2 * Math.PI * b.f * 2.3 * t + b.p);
    };
    const h = this.handheld;
    const p = [14 * h * w(0), 12 * h * w(1), 0.07 * h * w(2), 1 + 0.06 * h * w(3)];
    if (this.approach) {
      const x = Math.max(0, Math.min(1, (t - 0.3) / 2.0));
      const away = 1 - x * x * (3 - 2 * x);
      p[0] += 150 * away;
      p[1] += 170 * away;
      p[2] += 0.35 * away;
      p[3] *= 1 - 0.45 * away;
    }
    return p;
  }

  capture(screen, t) {
    const rng = this.rng;
    const W = Camera.W, H = Camera.H;
    this.shake[0] = Math.max(-4, Math.min(4, this.shake[0] + rng.gaussian() * 0.3));
    this.shake[1] = Math.max(-4, Math.min(4, this.shake[1] + rng.gaussian() * 0.3));
    let jx = this.shake[0], jy = this.shake[1], extra = 0;
    if (rng.uniform() < this.shakeRate) {
      extra = rng.range(2, 3.5);
      jx += rng.gaussian() * 2;
      jy += rng.gaussian() * 2;
    }
    let hf = this.h0.translated(jx, jy);
    if (this.handheld > 0 || this.approach) {
      const p = this.pose(t);
      hf = hf.then(Homography.similarity(108, 192, p[2], p[3], p[0], p[1]));
      if (this.lastPose) {
        const l = this.lastPose;
        const moved = Math.hypot(p[0] - l[0], p[1] - l[1]) + Math.abs(p[2] - l[2]) * 180 + Math.abs(p[3] - l[3]) * 190;
        extra = Math.max(extra, Math.min(this.approach ? 6 : 3, moved * 0.35));
      }
      this.lastPose = p;
    }
    const m = hf.inverse.m;
    const bands = typeof screen === "function" ? (this.readout > 0 ? 8 : 1) : 1;
    const shots = typeof screen === "function" ? Array.from({ length: bands }, (_, b) => screen(t + (this.readout * (b + 0.5)) / bands)) : [screen];
    const sw = shots[0].w / G.screenW;
    const sW = shots[0].w, sH = shots[0].h;
    let src = shots[0].px;
    const img = this.img;
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        src = shots[((cx * bands) / W) | 0].px;
        let r = 0, g = 0, b = 0;
        for (let sy = 0; sy < 2; sy++) {
          for (let sx = 0; sx < 2; sx++) {
            const X = cx + 0.25 + 0.5 * sx, Y = cy + 0.25 + 0.5 * sy;
            const w = m[6] * X + m[7] * Y + m[8];
            const fx = ((m[0] * X + m[1] * Y + m[2]) / w) * sw - 0.5;
            const fy = ((m[3] * X + m[4] * Y + m[5]) / w) * sw - 0.5;
            if (fx < 0 || fy < 0 || fx >= sW - 1 || fy >= sH - 1) {
              r += 0.1; g += 0.1; b += 0.1;
              continue;
            }
            const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
            const i00 = (y0 * sW + x0) * 3, i10 = i00 + 3, i01 = i00 + sW * 3, i11 = i01 + 3;
            const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
            r += src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
            g += src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
            b += src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
          }
        }
        const i = (cy * W + cx) * 3;
        img[i] = r / 4; img[i + 1] = g / 4; img[i + 2] = b / 4;
      }
    }
    for (const blob of this.glare) {
      const bx = blob.x + jx * 0.3, by = blob.y + jy * 0.3, rad = Math.trunc(blob.r * 3);
      for (let y = Math.max(0, Math.trunc(by) - rad); y < Math.min(H, Math.trunc(by) + rad); y++) {
        for (let x = Math.max(0, Math.trunc(bx) - rad); x < Math.min(W, Math.trunc(bx) + rad); x++) {
          const dx = x - bx, dy = y - by;
          const a = blob.s * Math.exp(-(dx * dx + dy * dy) / (2 * blob.r * blob.r));
          const i = (y * W + x) * 3;
          img[i] += a; img[i + 1] += a; img[i + 2] += a;
        }
      }
    }
    const phase = rng.uniform() * 30;
    for (let y = 0; y < H; y++) {
      const band = this.pwm ? 1 - 0.22 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (y / 23 + phase))) : 1;
      const k = this.gain * band;
      for (let i = y * W * 3, e = i + W * 3; i < e; i++) img[i] = (img[i] + this.ambient) * k;
    }
    gaussianBlur(img, this.tmp, W, H, Math.sqrt(this.blur * this.blur + extra * extra));
    const out = new Uint8ClampedArray(W * H * 4);
    for (let p = 0, q = 0; p < W * H * 3; p += 3, q += 4) {
      out[q] = Math.round(Math.max(0, Math.min(1, img[p] + rng.gaussian() * this.noise)) * 255);
      out[q + 1] = Math.round(Math.max(0, Math.min(1, img[p + 1] + rng.gaussian() * this.noise)) * 255);
      out[q + 2] = Math.round(Math.max(0, Math.min(1, img[p + 2] + rng.gaussian() * this.noise)) * 255);
      out[q + 3] = 255;
    }
    return { width: W, height: H, data: out };
  }
}

function gaussianBlur(img, tmp, w, h, sigma) {
  if (sigma <= 0.3) return;
  const r = Math.ceil(sigma * 2.5);
  const k = [];
  let sum = 0;
  for (let j = -r; j <= r; j++) {
    const v = Math.exp(-(j * j) / (2 * sigma * sigma));
    k.push(v);
    sum += v;
  }
  for (let j = 0; j < k.length; j++) k[j] /= sum;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let j = -r; j <= r; j++) {
        const i = (y * w + Math.min(w - 1, Math.max(0, x + j))) * 3, kw = k[j + r];
        a += img[i] * kw; b += img[i + 1] * kw; c += img[i + 2] * kw;
      }
      const o = (y * w + x) * 3;
      tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0, b = 0, c = 0;
      for (let j = -r; j <= r; j++) {
        const i = (Math.min(h - 1, Math.max(0, y + j)) * w + x) * 3, kw = k[j + r];
        a += tmp[i] * kw; b += tmp[i + 1] * kw; c += tmp[i + 2] * kw;
      }
      const o = (y * w + x) * 3;
      img[o] = a; img[o + 1] = b; img[o + 2] = c;
    }
  }
}
