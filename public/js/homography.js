export class Homography {
  constructor(m) {
    this.m = m;
  }

  static fit(src, dst) {
    const a = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
      if (Math.abs(a[piv][col]) < 1e-12) return null;
      [a[col], a[piv]] = [a[piv], a[col]];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = a[r][col] / a[col][col];
        if (f !== 0) for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
      }
    }
    const m = [];
    for (let i = 0; i < 8; i++) m.push(a[i][8] / a[i][i]);
    m.push(1);
    return new Homography(m);
  }

  apply(x, y) {
    const m = this.m;
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  }

  get inverse() {
    const [a, b, c, d, e, f, g, h, i] = this.m;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    return new Homography(
      [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map(
        (v) => v / det,
      ),
    );
  }

  then(o) {
    const r = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) r[i * 3 + j] += o.m[i * 3 + k] * this.m[k * 3 + j];
      }
    }
    return new Homography(r);
  }

  static similarity(cx, cy, angle, scale, dx, dy) {
    const c = Math.cos(angle) * scale;
    const s = Math.sin(angle) * scale;
    return new Homography([c, -s, cx - c * cx + s * cy + dx, s, c, cy - s * cx - c * cy + dy, 0, 0, 1]);
  }

  translated(dx, dy) {
    const r = [...this.m];
    for (let j = 0; j < 3; j++) {
      r[j] += dx * this.m[6 + j];
      r[3 + j] += dy * this.m[6 + j];
    }
    return new Homography(r);
  }
}
