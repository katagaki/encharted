import { ReedSolomon } from "./rs.js";

export const ROWS = 32;
export const LANES = 8;
export const PAYLOAD_BYTES = 16;
export const PARITY_BYTES = 14;
export const CHUNK = PAYLOAD_BYTES - 1;
export const MAX_BLOCKS = 15;
export const MAX_TEXT_BYTES = MAX_BLOCKS * CHUNK - 1;
export const ERASURE_THRESHOLD = 0.3;

const enc = new TextEncoder();
const rs = new ReedSolomon(PARITY_BYTES);

export async function sha256(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const CHART_TAG = enc.encode("DJDX-CHART1");
const PAIR_TAG = enc.encode("DJDX-PAIR1");
export const WHITENING = await sha256(enc.encode("DJDX-CHART1-WHITEN"));

export async function checksum(payload) {
  return (await sha256(CHART_TAG, payload)).slice(0, 2);
}

export async function pairingNumber(text) {
  const h = await sha256(PAIR_TAG, enc.encode(text));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(n % 10000).padStart(4, "0");
}

export function utf8Length(text) {
  return enc.encode(text).length;
}

export function symbolCells(i) {
  const measure = Math.floor(i / 8);
  const lane = i % 8;
  const cells = [];
  for (let b = 0; b < 8; b++) cells.push((measure * 8 + b) * 8 + lane);
  return cells;
}
const SYMBOL_CELLS = Array.from({ length: 32 }, (_, i) => symbolCells(i));

export async function encodeBlock(payload) {
  const codeword = rs.encode([...payload, ...(await checksum(payload))]);
  const bits = new Uint8Array(ROWS * LANES);
  for (let i = 0; i < 32; i++) {
    const byte = codeword[i] ^ WHITENING[i];
    SYMBOL_CELLS[i].forEach((cell, bit) => {
      bits[cell] = (byte & (0x80 >> bit)) !== 0 ? 1 : 0;
    });
  }
  return bits;
}

export async function decodeBlock(bits, confidence) {
  const raw = new Array(32).fill(0);
  const conf = new Float32Array(32).fill(1);
  for (let i = 0; i < 32; i++) {
    let byte = 0;
    const cells = SYMBOL_CELLS[i];
    for (let bit = 0; bit < 8; bit++) {
      const cell = cells[bit];
      if (bits[cell]) byte |= 0x80 >> bit;
      if (confidence[cell] < conf[i]) conf[i] = confidence[cell];
    }
    raw[i] = byte ^ WHITENING[i];
  }
  const order = [...Array(32).keys()].sort((a, b) => conf[a] - conf[b] || a - b);
  let base = 0;
  for (const i of order) if (conf[i] < ERASURE_THRESHOLD) base++;
  if (base > PARITY_BYTES) return null;
  for (let e = base; e <= PARITY_BYTES; e++) {
    const data = rs.decode(raw, order.slice(0, e));
    if (!data) continue;
    const payload = Uint8Array.from(data.slice(0, PAYLOAD_BYTES));
    const sum = await checksum(payload);
    if (data[PAYLOAD_BYTES] === sum[0] && data[PAYLOAD_BYTES + 1] === sum[1]) return payload;
  }
  return null;
}

export function messageBlocks(text) {
  const utf8 = enc.encode(text);
  if (utf8.length > MAX_TEXT_BYTES) throw new RangeError(`Message is ${utf8.length} bytes; the limit is ${MAX_TEXT_BYTES}`);
  const bytes = new Uint8Array(utf8.length + 1);
  bytes[0] = utf8.length;
  bytes.set(utf8, 1);
  const count = Math.ceil(bytes.length / CHUNK);
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const block = new Uint8Array(PAYLOAD_BYTES);
    block[0] = (i << 4) | count;
    block.set(bytes.subarray(i * CHUNK, Math.min(bytes.length, (i + 1) * CHUNK)), 1);
    blocks.push(block);
  }
  return blocks;
}

export async function encodeMessage(text) {
  const blocks = messageBlocks(text);
  const bits = new Uint8Array(blocks.length * ROWS * LANES);
  for (let i = 0; i < blocks.length; i++) bits.set(await encodeBlock(blocks[i]), i * ROWS * LANES);
  return { blocks, bits, rows: blocks.length * ROWS };
}

const utf8Decoder = new TextDecoder("utf-8");

export function preview(blocks, count) {
  const bytes = [];
  for (let i = 0; i < count; i++) {
    const b = blocks.get(i);
    for (let j = 1; j < PAYLOAD_BYTES; j++) bytes.push(b ? b[j] : null);
  }
  const length = bytes[0] ?? count * CHUNK - 1;
  let out = "";
  let run = [];
  let missing = 0;
  const flush = () => {
    if (run.length) out += utf8Decoder.decode(Uint8Array.from(run)).replaceAll("�", "·");
    if (missing > 0) out += "·".repeat(Math.floor((missing + 2) / 3));
    run = [];
    missing = 0;
  };
  for (let i = 1; i <= Math.min(length, bytes.length - 1); i++) {
    const b = bytes[i];
    if (b !== null) {
      if (missing > 0) flush();
      run.push(b);
    } else {
      if (run.length) flush();
      missing++;
    }
  }
  flush();
  return out;
}
