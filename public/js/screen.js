import { G } from "./geometry.js";

const BAR = [0.45, 0.45, 0.48];
const BAR_MARK = [0.85, 0.85, 0.88];
const GUTTER_BG = [0.035, 0.035, 0.04];
const DIVIDER = [0.24, 0.24, 0.26];
const LANE_TOP = [0.11, 0.11, 0.13];
const LANE_BG = [0.05, 0.05, 0.06];
const SCRATCH_BG = [0.07, 0.04, 0.045];
const KEY_WHITE = [0.78, 0.78, 0.8];
const KEY_BLUE = [0.14, 0.28, 0.7];
const TT_DISC = [0.12, 0.12, 0.14];
const TT_HUB = [0.4, 0.4, 0.42];
const JUDGE = [0.95, 0.12, 0.1];

function visibleRows(offset, extra, p) {
  return [Math.floor((offset - p) / p), Math.ceil((G.judgeY + offset - G.visTop + p + extra) / p)];
}

export class SoftRenderer {
  constructor(scale, bits, deadLanes = [], pitch = G.pitch) {
    this.scale = scale;
    this.pitch = pitch;
    this.bits = bits;
    this.rows = bits.length / 8;
    this.deadLanes = deadLanes;
    this.w = Math.floor(G.screenW * scale);
    this.h = Math.floor(G.screenH * scale);
    this.base = new Float32Array(this.w * this.h * 3);
    this.#drawStatic();
  }

  #blend(px, i, c, a) {
    px[i] += (c[0] - px[i]) * a;
    px[i + 1] += (c[1] - px[i + 1]) * a;
    px[i + 2] += (c[2] - px[i + 2]) * a;
  }

  fillRect(px, x0, x1, y0, y1, c) {
    const s = this.scale;
    const sx0 = x0 * s, sx1 = x1 * s, sy0 = y0 * s, sy1 = y1 * s;
    if (!(sx1 > sx0 && sy1 > sy0)) return;
    for (let py = Math.max(0, Math.floor(sy0)); py < Math.min(this.h, Math.ceil(sy1)); py++) {
      const cy = Math.max(0, Math.min(py + 1, sy1) - Math.max(py, sy0));
      for (let x = Math.max(0, Math.floor(sx0)); x < Math.min(this.w, Math.ceil(sx1)); x++) {
        const cx = Math.max(0, Math.min(x + 1, sx1) - Math.max(x, sx0));
        this.#blend(px, (py * this.w + x) * 3, c, cy * cx);
      }
    }
  }

  fillMoving(px, x0, x1, yc, half, smear, clip0, clip1, c) {
    const s = this.scale;
    const subs = smear > 0.5 ? 4 : 1;
    const spans = [];
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < subs; k++) {
      const y = yc - (smear * k) / Math.max(1, subs - 1);
      const a = Math.max(y - half, clip0) * s, b = Math.min(y + half, clip1) * s;
      spans.push([a, b]);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    if (!(hi > lo)) return;
    const sx0 = x0 * s, sx1 = x1 * s;
    for (let py = Math.max(0, Math.floor(lo)); py < Math.min(this.h, Math.ceil(hi)); py++) {
      let cy = 0;
      for (const [a, b] of spans) if (b > a) cy += Math.max(0, Math.min(py + 1, b) - Math.max(py, a));
      cy /= subs;
      if (cy <= 0) continue;
      for (let x = Math.max(0, Math.floor(sx0)); x < Math.min(this.w, Math.ceil(sx1)); x++) {
        const cx = Math.max(0, Math.min(x + 1, sx1) - Math.max(x, sx0));
        this.#blend(px, (py * this.w + x) * 3, c, cy * cx);
      }
    }
  }

  fillCircle(px, cx, cy, r, c) {
    const s = this.scale;
    const scx = cx * s, scy = cy * s, sr = r * s;
    for (let py = Math.max(0, Math.trunc(scy - sr - 1)); py < Math.min(this.h, Math.trunc(scy + sr + 2)); py++) {
      for (let x = Math.max(0, Math.trunc(scx - sr - 1)); x < Math.min(this.w, Math.trunc(scx + sr + 2)); x++) {
        const dx = x + 0.5 - scx, dy = py + 0.5 - scy;
        const a = Math.max(0, Math.min(1, sr - Math.hypot(dx, dy) + 0.5));
        if (a > 0) this.#blend(px, (py * this.w + x) * 3, c, a);
      }
    }
  }

  #drawStatic() {
    const px = this.base;
    const right = G.frameX + G.frameWidth;
    this.fillRect(px, G.frameX, G.frameX + G.gutter, G.frameTop, G.frameBottom, GUTTER_BG);
    this.fillRect(px, right - G.gutter, right, G.frameTop, G.frameBottom, GUTTER_BG);
    for (let i = 0; i <= 8; i++) {
      const x = i < 8 ? G.laneX0[i] - G.divider : G.laneX1(7);
      this.fillRect(px, x, x + G.divider, G.frameTop, G.frameBottom, DIVIDER);
    }
    for (let lane = 0; lane < 8; lane++) {
      const x0 = G.laneX0[lane], x1 = G.laneX1(lane);
      this.fillRect(px, x0, x1, G.frameTop, G.visTop, LANE_TOP);
      this.fillRect(px, x0, x1, G.visTop, G.judgeY, lane === 0 ? SCRATCH_BG : LANE_BG);
      if (lane === 0) {
        const cx = (x0 + x1) / 2;
        this.fillCircle(px, cx, 731, 23, G.red);
        this.fillCircle(px, cx, 731, 20, TT_DISC);
        this.fillCircle(px, cx, 731, 5, TT_HUB);
      } else if (lane % 2 === 1) {
        this.fillRect(px, x0 + 3, x1 - 3, 718, 756, KEY_WHITE);
      } else {
        this.fillRect(px, x0 + 3, x1 - 3, 708, 744, KEY_BLUE);
      }
    }
    const h = G.fiducialSize / 2;
    for (const [x, y] of G.fiducials) this.fillRect(px, x - h, x + h, y - h, y + h, G.green);
  }

  frame(offset, smear) {
    const px = this.base.slice();
    const p = this.pitch;
    const left = G.laneX0[0], right = G.laneX1(7);
    const [kLo, kHi] = visibleRows(offset, smear, p);
    for (let k = kLo; k <= kHi; k++) {
      const y = G.judgeY - k * p + offset;
      const row = ((k % this.rows) + this.rows) % this.rows;
      if (row % 8 === 0) {
        const yb = y + p / 2;
        this.fillMoving(px, left, right, yb, 1, smear, G.visTop, G.judgeY, BAR);
        const gh = row % 32 === 0 ? 14 : 4;
        this.fillMoving(px, G.frameX + 2, G.frameX + G.gutter - 2, yb, gh, smear, G.visTop, G.judgeY, BAR_MARK);
        this.fillMoving(px, G.frameX + G.frameWidth - G.gutter + 2, G.frameX + G.frameWidth - 2, yb, gh, smear, G.visTop, G.judgeY, BAR_MARK);
      }
      for (let lane = 0; lane < 8; lane++) {
        if (this.bits[row * 8 + lane]) {
          this.fillMoving(px, G.laneX0[lane] + 2, G.laneX1(lane) - 2, y, G.noteH / 2, smear, G.visTop, G.judgeY, G.noteColor(lane));
        }
      }
    }
    this.fillRect(px, left, right, G.judgeY - 3, G.judgeY + 2, JUDGE);
    for (const dead of this.deadLanes) {
      const x0 = Math.trunc(G.laneX0[dead.lane] * this.scale) - 1, x1 = Math.trunc(G.laneX1(dead.lane) * this.scale) + 1;
      for (let py = Math.trunc(G.frameTop * this.scale); py < Math.trunc(G.judgeY * this.scale); py++) {
        for (let x = x0; x < x1; x++) {
          const i = (py * this.w + x) * 3;
          for (let c = 0; c < 3; c++) px[i + c] = dead.bright ? Math.min(1, 0.3 * px[i + c] + 0.82) : 0.07;
        }
      }
    }
    return { w: this.w, h: this.h, px };
  }
}

const css = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
const FILL = {
  gutter: css(GUTTER_BG),
  divider: css(DIVIDER),
  laneTop: css(LANE_TOP),
  lane: css(LANE_BG),
  scratch: css(SCRATCH_BG),
  keyWhite: css(KEY_WHITE),
  keyBlue: css(KEY_BLUE),
  disc: css(TT_DISC),
  hub: css(TT_HUB),
  bar: css(BAR),
  barMark: css(BAR_MARK),
  judge: css(JUDGE),
  green: css(G.green),
  notes: [0, 1, 2, 3, 4, 5, 6, 7].map((l) => css(G.noteColor(l))),
};

export function drawStatic(ctx) {
  const right = G.frameX + G.frameWidth;
  ctx.fillStyle = FILL.gutter;
  ctx.fillRect(G.frameX, G.frameTop, G.gutter, G.frameBottom - G.frameTop);
  ctx.fillRect(right - G.gutter, G.frameTop, G.gutter, G.frameBottom - G.frameTop);
  ctx.fillStyle = FILL.divider;
  for (let i = 0; i <= 8; i++) {
    const x = i < 8 ? G.laneX0[i] - G.divider : G.laneX1(7);
    ctx.fillRect(x, G.frameTop, G.divider, G.frameBottom - G.frameTop);
  }
  for (let lane = 0; lane < 8; lane++) {
    const x0 = G.laneX0[lane], w = G.laneWidths[lane];
    ctx.fillStyle = FILL.laneTop;
    ctx.fillRect(x0, G.frameTop, w, G.visTop - G.frameTop);
    ctx.fillStyle = lane === 0 ? FILL.scratch : FILL.lane;
    ctx.fillRect(x0, G.visTop, w, G.judgeY - G.visTop);
    ctx.fillStyle = "#000";
    ctx.fillRect(x0, G.judgeY, w, G.frameBottom - G.judgeY);
    if (lane === 0) {
      const cx = x0 + w / 2;
      for (const [r, fill] of [[23, css(G.red)], [20, FILL.disc], [5, FILL.hub]]) {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(cx, 731, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (lane % 2 === 1) {
      ctx.fillStyle = FILL.keyWhite;
      ctx.fillRect(x0 + 3, 718, w - 6, 38);
    } else {
      ctx.fillStyle = FILL.keyBlue;
      ctx.fillRect(x0 + 3, 708, w - 6, 36);
    }
  }
  ctx.fillStyle = FILL.green;
  const h = G.fiducialSize / 2;
  for (const [x, y] of G.fiducials) ctx.fillRect(x - h, y - h, G.fiducialSize, G.fiducialSize);
}

export function drawChart(ctx, bits, offset, p = G.pitch) {
  const rows = bits.length / 8;
  const left = G.laneX0[0], right = G.laneX1(7);
  ctx.save();
  ctx.beginPath();
  ctx.rect(G.frameX, G.visTop, G.frameWidth, G.judgeY - G.visTop);
  ctx.clip();
  ctx.fillStyle = FILL.gutter;
  ctx.fillRect(G.frameX, G.visTop, G.gutter, G.judgeY - G.visTop);
  ctx.fillRect(G.frameX + G.frameWidth - G.gutter, G.visTop, G.gutter, G.judgeY - G.visTop);
  for (let lane = 0; lane < 8; lane++) {
    ctx.fillStyle = lane === 0 ? FILL.scratch : FILL.lane;
    ctx.fillRect(G.laneX0[lane], G.visTop, G.laneWidths[lane], G.judgeY - G.visTop);
  }
  const [kLo, kHi] = visibleRows(offset, 0, p);
  for (let k = kLo; k <= kHi; k++) {
    const y = G.judgeY - k * p + offset;
    const row = ((k % rows) + rows) % rows;
    if (row % 8 === 0) {
      const yb = y + p / 2;
      ctx.fillStyle = FILL.bar;
      ctx.fillRect(left, yb - 1, right - left, 2);
      const gh = row % 32 === 0 ? 14 : 4;
      ctx.fillStyle = FILL.barMark;
      ctx.fillRect(G.frameX + 2, yb - gh, G.gutter - 4, gh * 2);
      ctx.fillRect(G.frameX + G.frameWidth - G.gutter + 2, yb - gh, G.gutter - 4, gh * 2);
    }
    for (let lane = 0; lane < 8; lane++) {
      if (bits[row * 8 + lane]) {
        ctx.fillStyle = FILL.notes[lane];
        ctx.fillRect(G.laneX0[lane] + 2, y - G.noteH / 2, G.laneWidths[lane] - 4, G.noteH);
      }
    }
  }
  ctx.restore();
  ctx.fillStyle = FILL.judge;
  ctx.fillRect(left, G.judgeY - 3, right - left, 5);
}
