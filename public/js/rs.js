const EXP = new Uint8Array(512);
const LOG = new Int32Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export const GF = {
  exp: EXP,
  log: LOG,
  mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  },
  div(a, b) {
    if (a === 0) return 0;
    return EXP[(LOG[a] + 255 - LOG[b]) % 255];
  },
  pow(a, p) {
    return EXP[(((LOG[a] * p) % 255) + 255) % 255];
  },
  inverse(a) {
    return EXP[255 - LOG[a]];
  },
};

const polyScale = (p, x) => p.map((c) => GF.mul(c, x));

function polyAdd(p, q) {
  const n = Math.max(p.length, q.length);
  const r = new Array(n).fill(0);
  for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] ^= GF.mul(p[i], q[j]);
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = GF.mul(y, x) ^ p[i];
  return y;
}

export class ReedSolomon {
  constructor(nsym) {
    let g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, GF.pow(2, i)]);
    this.nsym = nsym;
    this.generator = g;
  }

  encode(msg) {
    const gen = this.generator;
    const out = [...msg, ...new Array(this.nsym).fill(0)];
    for (let i = 0; i < msg.length; i++) {
      const coef = out[i];
      if (coef !== 0) {
        for (let j = 1; j < gen.length; j++) out[i + j] ^= GF.mul(gen[j], coef);
      }
    }
    for (let i = 0; i < msg.length; i++) out[i] = msg[i];
    return out;
  }

  syndromes(msg) {
    const s = [0];
    for (let i = 0; i < this.nsym; i++) s.push(polyEval(msg, GF.pow(2, i)));
    return s;
  }

  #errataLocator(positions) {
    let loc = [1];
    for (const i of positions) loc = polyMul(loc, polyAdd([1], [GF.pow(2, i), 0]));
    return loc;
  }

  #errorEvaluator(synd, errLoc, n) {
    const r = polyMul(synd, errLoc);
    return r.slice(r.length - (n + 1));
  }

  #correctErrata(msg, synd, errPos) {
    const coefPos = errPos.map((p) => msg.length - 1 - p);
    const errLoc = this.#errataLocator(coefPos);
    const errEval = this.#errorEvaluator([...synd].reverse(), errLoc, errLoc.length - 1).reverse();
    const xs = coefPos.map((p) => GF.pow(2, -(255 - p)));
    const e = new Array(msg.length).fill(0);
    const evalRev = [...errEval].reverse();
    for (let i = 0; i < xs.length; i++) {
      const xi = xs[i];
      const xiInv = GF.inverse(xi);
      let prime = 1;
      for (let j = 0; j < xs.length; j++) {
        if (j !== i) prime = GF.mul(prime, 1 ^ GF.mul(xiInv, xs[j]));
      }
      if (prime === 0) return null;
      const y = GF.mul(xi, polyEval(evalRev, xiInv));
      e[errPos[i]] = GF.div(y, prime);
    }
    return polyAdd(msg, e);
  }

  #errorLocator(synd, eraseCount) {
    let errLoc = [1];
    let oldLoc = [1];
    const shift = synd.length > this.nsym ? synd.length - this.nsym : 0;
    for (let i = 0; i < this.nsym - eraseCount; i++) {
      const k = i + shift;
      let delta = synd[k];
      for (let j = 1; j < errLoc.length; j++) delta ^= GF.mul(errLoc[errLoc.length - 1 - j], synd[k - j]);
      oldLoc.push(0);
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = polyScale(oldLoc, delta);
          oldLoc = polyScale(errLoc, GF.inverse(delta));
          errLoc = newLoc;
        }
        errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    if (errLoc.length === 0 || (errLoc.length - 1) * 2 + eraseCount > this.nsym) return null;
    return errLoc;
  }

  #findErrors(errLocRev, n) {
    const positions = [];
    for (let i = 0; i < n; i++) {
      if (polyEval(errLocRev, GF.pow(2, i)) === 0) positions.push(n - 1 - i);
    }
    if (positions.length !== errLocRev.length - 1) return null;
    return positions;
  }

  #forneySyndromes(synd, positions, n) {
    const f = synd.slice(1);
    for (const p of positions) {
      const x = GF.pow(2, n - 1 - p);
      for (let j = 0; j < f.length - 1; j++) f[j] = GF.mul(f[j], x) ^ f[j + 1];
    }
    return f;
  }

  decode(input, erasures = []) {
    if (erasures.length > this.nsym) return null;
    let msg = Array.from(input);
    for (const e of erasures) msg[e] = 0;
    const synd = this.syndromes(msg);
    if (synd.every((s) => s === 0)) return msg.slice(0, msg.length - this.nsym);
    const fsynd = this.#forneySyndromes(synd, erasures, msg.length);
    const errLoc = this.#errorLocator(fsynd, erasures.length);
    if (!errLoc) return null;
    const errPos = this.#findErrors([...errLoc].reverse(), msg.length);
    if (!errPos) return null;
    msg = this.#correctErrata(msg, synd, [...erasures, ...errPos]);
    if (!msg) return null;
    if (this.syndromes(msg).some((s) => s !== 0)) return null;
    return msg.slice(0, msg.length - this.nsym);
  }
}
