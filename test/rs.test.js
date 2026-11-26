import test from "node:test";
import assert from "node:assert/strict";
import { ReedSolomon } from "../public/js/rs.js";
import { RNG } from "../public/js/camera.js";

test("RS(32,18) corrects errors and erasures within 2e + f <= 14", () => {
  const rng = new RNG(7);
  const rs = new ReedSolomon(14);
  for (let trial = 0; trial < 3000; trial++) {
    const data = [...rng.bytes(18)];
    const cw = rs.encode(data);
    const erasures = rng.int(15);
    const errors = rng.int(Math.floor((14 - erasures) / 2) + 1);
    const positions = [...Array(32).keys()];
    for (let i = 0; i < 32; i++) {
      const j = i + rng.int(32 - i);
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    for (const p of positions.slice(0, erasures + errors)) cw[p] ^= 1 + rng.int(255);
    assert.deepEqual(rs.decode(cw, positions.slice(0, erasures)), data, `trial ${trial}: ${erasures} erasures, ${errors} errors`);
  }
});

test("RS rejects a word with too many errors", () => {
  const rs = new ReedSolomon(14);
  const cw = rs.encode([...Array(18).keys()]);
  for (let i = 0; i < 12; i++) cw[i * 2] ^= 0x5a;
  const out = rs.decode(cw, []);
  assert.ok(out === null || out.some((v, i) => v !== i));
});
