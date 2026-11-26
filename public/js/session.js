import { ChartDecoder, TUNING } from "./decoder.js";
import { pairingNumber, preview } from "./codec.js";

export class ReceiveSession {
  constructor() {
    this.decoder = new ChartDecoder();
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

  async push(img, t) {
    if (this.done) return this.state(t);
    const ok = this.decoder.process(img, t);
    if (ok && this.lockedAt === null) this.lockedAt = t;
    if (ok && this.decoder.processed % TUNING.decodeEvery === 0) {
      for (const p of await this.decoder.decodeBlocks()) {
        const index = p[0] >> 4, count = p[0] & 0xf;
        if (this.count === null) {
          this.count = count;
          this.decoder.setBlockCount(count);
        }
        if (count !== this.count || this.received.has(index)) continue;
        this.received.set(index, p);
        this.times.set(index, t);
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
      corners: this.decoder.lastCorners,
      locked: this.decoder.lastCorners !== null,
      everLocked: this.lockedAt !== null,
      count: this.count,
      blocks: [...this.times.entries()].map(([index, time]) => ({ index, time })),
      preview: this.count !== null ? preview(this.received, this.count) : "",
      done: this.done,
      text: this.text,
      pairing: this.pairing,
      lockedAt: this.lockedAt,
      doneAt: this.doneAt,
    };
  }
}
