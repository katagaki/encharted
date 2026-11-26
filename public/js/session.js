import { ChartDecoder, TUNING, locateChart } from "./decoder.js";
import { pairingNumber, preview } from "./codec.js";
import { PITCHES, greenNumber } from "./geometry.js";

export class ReceiveSession {
  constructor() {
    this.decoders = PITCHES.map((pitch) => new ChartDecoder({ pitch }));
    this.debug = false;
    this.corners = null;
    this.skippedFiducials = 0;
    this.locked = 0;
    this.count = null;
    this.received = new Map();
    this.times = new Map();
    this.lockedAt = null;
    this.doneAt = null;
    this.text = null;
    this.pairing = null;
  }

  get done() {
    return this.doneAt !== null;
  }

  get decoder() {
    return this.decoders.reduce((a, b) => (b.hits > a.hits ? b : a));
  }

  async push(img, t) {
    if (this.done) return this.state(t);
    const frame = locateChart(img);
    this.corners = frame ? frame.corners : null;
    if (!frame) {
      this.skippedFiducials++;
      return this.state(t);
    }
    let ok = false;
    for (const d of this.decoders) {
      d.debug = this.debug;
      if (d.track(frame, t)) ok = true;
    }
    if (ok) {
      this.locked++;
      if (this.lockedAt === null) this.lockedAt = t;
    }
    if (ok && this.locked % TUNING.decodeEvery === 0) {
      const ranked = [...this.decoders].sort((a, b) => b.hits - a.hits).slice(0, TUNING.decodePitches);
      for (const d of ranked) {
        for (const p of await d.decodeBlocks()) {
          const index = p[0] >> 4, count = p[0] & 0xf;
          if (this.count === null) {
            this.count = count;
            for (const other of this.decoders) other.setBlockCount(count);
          }
          if (count !== this.count || this.received.has(index)) continue;
          this.received.set(index, p);
          this.times.set(index, t);
        }
      }
      if (this.count !== null && this.received.size === this.count) {
        this.doneAt = t;
        this.text = preview(this.received, this.count);
        this.pairing = await pairingNumber(this.text);
      }
    }
    return this.state(t);
  }

  state(t) {
    return {
      corners: this.corners,
      locked: this.corners !== null,
      everLocked: this.lockedAt !== null,
      count: this.count,
      blocks: [...this.times.entries()].map(([index, time]) => ({ index, time })),
      preview: this.count !== null ? preview(this.received, this.count) : "",
      done: this.done,
      text: this.text,
      pairing: this.pairing,
      lockedAt: this.lockedAt,
      doneAt: this.doneAt,
      diag: this.debug ? this.diagnostics(t) : null,
    };
  }

  diagnostics(t) {
    const d = this.decoder;
    const best = d.accumulators.reduce((a, b) => (b.blocks === (this.count ?? b.blocks) ? b : a), d.accumulators[0]);
    let observed = 0;
    for (const c of best.counts) if (c >= 3) observed++;
    return {
      samples: d.samples,
      processed: d.processed,
      skippedFiducials: this.skippedFiducials,
      skippedBars: d.skippedBars,
      coasted: d.coasted,
      skew: d.skew,
      speed: d.speed / d.pitch,
      greenNumber: greenNumber(d.pitch),
      votes: d.votes,
      contrast: d.laneContrast,
      observed: observed / best.counts.length,
      t,
    };
  }
}
