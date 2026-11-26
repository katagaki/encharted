import { ReceiveSession } from "./session.js";
import { encodeMessage } from "./codec.js";
import { SoftRenderer } from "./screen.js";
import { Camera, RNG, SCENARIOS } from "./camera.js";
import { G } from "./geometry.js";

let session = new ReceiveSession();
let sim = null;

onmessage = async ({ data: msg }) => {
  switch (msg.type) {
    case "reset":
      session = new ReceiveSession();
      session.decoder.debug = !!msg.debug;
      sim = null;
      postMessage({ type: "state", id: msg.id, state: session.state(0) });
      break;
    case "debug":
      session.decoder.debug = !!msg.on;
      break;
    case "frame": {
      const img = { width: msg.width, height: msg.height, data: new Uint8ClampedArray(msg.buffer) };
      const state = await session.push(img, msg.t);
      postMessage({ type: "state", id: msg.id, state });
      break;
    }
    case "sim-start": {
      session = new ReceiveSession();
      const { bits } = await encodeMessage(msg.text);
      const rng = new RNG(msg.seed);
      sim = { renderer: new SoftRenderer(1, bits), camera: new Camera(SCENARIOS[msg.scenario], rng) };
      postMessage({ type: "state", id: msg.id, state: session.state(0) });
      break;
    }
    case "sim-frame": {
      if (!sim) break;
      const img = sim.camera.capture((ts) => sim.renderer.frame(G.speed * ts, G.speed / 60), msg.t);
      const state = await session.push(img, msg.t);
      postMessage({ type: "sim", id: msg.id, state, image: { width: img.width, height: img.height, buffer: img.data.buffer } }, [img.data.buffer]);
      break;
    }
  }
};
