import test from "node:test";
import assert from "node:assert/strict";
import { encodeMessage, pairingNumber } from "../public/js/codec.js";
import { SoftRenderer } from "../public/js/screen.js";
import { Camera, RNG, SCENARIOS } from "../public/js/camera.js";
import { ReceiveSession } from "../public/js/session.js";
import { G } from "../public/js/geometry.js";

export async function runLoopback(text, { scenario = "typical", seed = 2026, fps = 30, maxSeconds = 40, deadLanes = [], t0 = 0 } = {}) {
  const { bits } = await encodeMessage(text);
  const renderer = new SoftRenderer(1, bits, deadLanes);
  const rng = new RNG(seed);
  const camera = new Camera(SCENARIOS[scenario], rng);
  const session = new ReceiveSession();
  let state;
  for (let f = 0; f < maxSeconds * fps; f++) {
    const t = f / fps;
    const screen = renderer.frame(G.speed * (t0 + t), G.speed / 60);
    state = await session.push(camera.capture(screen, t), t);
    if (state.done) return { ...state, seconds: t };
  }
  return { ...state, seconds: null };
}

const TEXT = "今日も楽しく灼熱Beachside Bunnyでお皿を回しまくれえええ";

test("loopback decodes the demo message through the handheld camera model", async () => {
  const r = await runLoopback(TEXT);
  assert.equal(r.text, TEXT, `decoded ${JSON.stringify(r.preview)}`);
  assert.equal(r.pairing, await pairingNumber(TEXT));
  assert.equal(r.count, 6);
});

test("loopback decodes a one-block message quickly with two dead lanes", async () => {
  const r = await runLoopback("Seven Times Four", { seed: 9, t0: 1.3, deadLanes: [{ lane: 2, bright: true }, { lane: 6, bright: false }] });
  assert.equal(r.text, "Seven Times Four");
  assert.ok(r.seconds < 6, `took ${r.seconds}s`);
});
