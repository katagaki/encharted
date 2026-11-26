import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ReedSolomon } from "../public/js/rs.js";
import { WHITENING, checksum, decodeBlock, encodeBlock, encodeMessage, messageBlocks, pairingNumber, preview } from "../public/js/codec.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url)));
const hex = (b) => Buffer.from(b).toString("hex");
const rowBytes = (bits) => Array.from({ length: bits.length / 8 }, (_, r) => bits.slice(r * 8, r * 8 + 8).reduce((v, b, l) => v | (b << (7 - l)), 0));

test("whitening matches the Swift reference", () => {
  assert.equal(hex(WHITENING), vectors.whitening);
});

for (const msg of vectors.messages) {
  test(`known-answer vectors: ${msg.text}`, async () => {
    const blocks = messageBlocks(msg.text);
    assert.equal(blocks.length, msg.blocks.length);
    assert.equal(await pairingNumber(msg.text), msg.pairing);
    const rs = new ReedSolomon(14);
    for (let i = 0; i < blocks.length; i++) {
      const v = msg.blocks[i];
      assert.equal(hex(blocks[i]), v.payload);
      const data = [...blocks[i], ...(await checksum(blocks[i]))];
      assert.equal(hex(data), v.data);
      assert.equal(hex(rs.encode(data)), v.codeword);
      assert.equal(hex(rowBytes(await encodeBlock(blocks[i]))), v.rows);
    }
  });
}

test("codec round-trips with flipped cells and erasures", async () => {
  const { blocks, bits } = await encodeMessage("今日も楽しく灼熱Beachside Bunnyでお皿を回しまくれえええ");
  const received = new Map();
  for (let b = 0; b < blocks.length; b++) {
    const grid = bits.slice(b * 256, b * 256 + 256);
    const conf = new Float32Array(256).fill(1);
    for (const cell of [3, 77, 140, 201]) grid[cell] ^= 1;
    for (let r = 0; r < 32; r++) conf[r * 8 + 5] = 0;
    const payload = await decodeBlock(grid, conf);
    assert.deepEqual(payload, blocks[b]);
    received.set(payload[0] >> 4, payload);
  }
  assert.equal(preview(received, blocks.length), "今日も楽しく灼熱Beachside Bunnyでお皿を回しまくれえええ");
});

test("preview shows missing bytes as dots", async () => {
  const blocks = messageBlocks("今日も楽しく灼熱Beachside Bunnyでお皿を回しまくれえええ");
  const partial = new Map([[0, blocks[0]], [2, blocks[2]]]);
  const text = preview(partial, blocks.length);
  assert.ok(text.startsWith("今日も楽·"));
  assert.ok(text.includes("·"));
  assert.equal(preview(new Map(), blocks.length).replaceAll("·", ""), "");
});

test("messages over 224 bytes are rejected", () => {
  assert.equal(messageBlocks("a".repeat(224)).length, 15);
  assert.throws(() => messageBlocks("a".repeat(225)));
});
