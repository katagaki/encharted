# Encharted

Send text by playing a rhythm-game chart. Receive it by pointing a camera at the screen.

The sender turns a short message into a looping, 8-lane falling-note chart (scratch + 7 keys, IIDX 1P layout). The receiver reads the chart through the phone's camera, decodes it block by block and shows the text as it arrives. It's a static web page with no build step, no dependencies and no server-side code.

## Use it

1. On the sending device, open the page, tap **Send**, type up to 224 bytes of text (Japanese and emoji are fine) and press **Start**. The chart fills the window and loops until you press **Stop**.
2. On the receiving device, tap **Receive** and allow camera access. Hold the camera so all four green corner markers are in view.
3. Each block shows **PGREAT** as it's read, and the text fills in as blocks arrive. When it's done, check that the pairing number matches the one on the sender, then copy the text.

**Loopback demo** runs both sides on one device. It feeds the receiver from a simulated hand-held camera (tilt, blur, noise, glare, flicker, shake and an approach move), so you can try it without a second device.

## Run it locally

```sh
cd public
python3 -m http.server 8000
```

Open <http://localhost:8000>. The camera only works on `localhost` or over HTTPS. To test with a phone, serve the page over HTTPS, for example with a tunnel or by deploying it.

Run the tests (Node 20 or later, no install needed):

```sh
npm test        # same as: node --test test/
```

The tests cover Reed–Solomon round trips with errors and erasures, known-answer vectors generated from the Swift reference implementation (`test/vectors.json`), and an end-to-end loopback decode through the camera model.

## Deploy

The site is served by Cloudflare Workers as static assets from `public/` (see `wrangler.jsonc`). Connect the repository in the Cloudflare dashboard (Workers & Pages → Create → Import a repository) and use `npx wrangler deploy` as the deploy command, with no build command. To deploy by hand, run `npx wrangler deploy`.

## Files

| Path | What it does |
| --- | --- |
| `public/js/rs.js` | GF(256) and RS(32,18) encoding and decoding with errors and erasures |
| `public/js/codec.js` | Block format, checksum, whitening, symbol layout, pairing number and progressive preview |
| `public/js/geometry.js` | Playfield geometry |
| `public/js/screen.js` | Chart drawing for the sender canvas, plus a software renderer for the simulation |
| `public/js/decoder.js` | Corner markers → homography → bar-line phase tracking → soft cell sampling → decoding |
| `public/js/session.js` | Multi-block bookkeeping on the receiving side |
| `public/js/camera.js` | Simulated camera for the loopback demo and tests |
| `public/js/worker.js` | Runs decoding (and the simulation) off the main thread |
| `public/js/app.js` | Pages: landing, sender, receiver and loopback demo |

## Format

The byte format is the same as the Swift reference prototype's, so a native receiver can be added later. The row spacing and speed match the reference run with `PITCH=112 RPS=8`.

### Playfield

All values are in logical units on a 390 × 844 portrait canvas. The canvas is scaled uniformly to fit the screen and letterboxed in black.

- **Lanes:** 8 lanes, scratch first, with widths `[54, 38, 32, 38, 32, 38, 32, 38]`, 3-unit dividers and a 14-unit gutter on each side. The frame is 357 units wide and centred.
- **Note colours:** scratch is red `(1.0, 0.18, 0.16)`, keys 1, 3, 5 and 7 are white `(0.95, 0.95, 0.97)` and keys 2, 4 and 6 are blue `(0.22, 0.48, 1.0)`.
- **Vertical layout:** the frame top is at 40, notes are visible from 64 to the judgment line at 700, and the frame bottom is at 760.
- **Rows:** 112 units per row, notes 14 units tall, and 8 rows (896 units) per measure.
- **Scroll speed:** fixed at 8 rows/s (896 units/s). It's part of the protocol, because the receiver uses it to predict the scroll position.
  - Row `k` is centred at `y = 700 − 112k + offset`, where `offset = 896 · t`.
  - Its data row is `k mod rows`.
- **Bar lines:** drawn on rows where `row % 8 == 0`, at `y + 56`.
  - Across the lanes: a grey line (0.45), 2 units thick.
  - In both gutters: an 8-unit mark (0.85).
  - At block starts (`row % 32 == 0`), the gutter mark is 28 units tall instead. This is the loop-start marker.
- **Corner markers:** green `(0.12, 0.95, 0.3)` squares, 14 × 14, centred in the gutters at y = 50 and y = 742. Nothing else on the sender screen uses this green.
- **Judgment line:** red, from y = 697 to 702, drawn over the notes.

### Blocks

Each block takes 32 rows and carries 16 payload bytes:

```
payload  = [(index << 4) | count] + 15 data bytes        (at most 15 blocks)
message  = [UTF-8 length] + UTF-8 text                   (text ≤ 224 bytes, split into 15-byte chunks, last chunk zero-padded)
data     = payload + SHA-256("DJDX-CHART1" ‖ payload)[0..<2]
codeword = RS(32,18) encode of data                      (GF(256), polynomial 0x11d, generator 2, first root α⁰)
chart[i] = codeword[i] XOR SHA-256("DJDX-CHART1-WHITEN")[i]
```

- **Layout:** symbol `i` goes in lane `i % 8` of measure `i / 8`. Its 8 bits run MSB first down rows `8·(i/8) + b`, and a note is drawn wherever a bit is 1. The chart has `32 × count` rows and loops forever.
- **Pairing number:** `SHA-256("DJDX-PAIR1" ‖ UTF-8 text)`. Its first 4 bytes are read as a big-endian integer, taken mod 10000 and shown as 4 digits.

### Decoding

1. **Corners:** pixels where `G − max(R, B)` is above 0.18 are grouped into blobs. The 4 largest become the corners, and a 4-point homography is fitted.
2. **Phase:** a brightness profile (`max(R, G, B)`) is taken down both gutters, and the running minimum over ±30 units is subtracted. Peaks give the measure phase.
   - The phase is unwrapped using the known speed and the real frame timestamps (`requestVideoFrameCallback` `captureTime`, or `mediaTime` where that's missing).
   - A phone camera's rolling shutter captures the left gutter at a different moment from the right one, so the chart appears slanted. The decoder tracks this slant from the two gutters, aligns them before finding bars, and shifts each lane's samples to match.
   - While no bar line is in view, it keeps sampling for up to 0.6 s at the predicted position.
   - Peaks more than 14 units from the predicted phase are rejected. After 10 rejected frames in a row, a fresh lock is accepted.
   - A peak more than 2.2× the normal bar size is a loop marker. It votes for which of the 4 measures starts the block.
3. **Cells:** each note position is sampled on a 3 × 3 grid and compared with the darker of the two backgrounds ±0.3 rows away. Cells under glare (background above 0.8) are skipped. The result becomes a soft value from −1 to 1, scaled by each lane's contrast, and soft values are summed per data row over many frames.
4. **Blocks:** every third frame, each candidate rotation and block is assembled.
   - A symbol's confidence is the weakest of its 8 cells. Symbols below 0.3 are erasures.
   - RS decoding is retried while erasing progressively more of the least-confident symbols, up to 14.
   - A block is accepted only if its checksum matches and its header's block count matches the chart length.
   - Until the first block arrives, the receiver keeps accumulators for all 15 possible chart lengths. After that, it keeps only the one that matches.

## Field testing and tuning

Turn on **Diagnostics** below the receiver's viewfinder to see where it samples each note. Magenta dots are cells it reads as notes and cyan dots are empty cells. It also shows the lock stats. A screenshot of this view is the quickest way to see why a device isn't decoding.

The decoder has been verified against the simulated camera. It still needs testing on real devices, with phone A sending and phone B receiving. These settings are the ones most likely to need tuning:

- **Processing resolution:** `PROC_LONG_SIDE` in `app.js` (640, so 360 × 640 for a portrait camera).
- **Thresholds:** `TUNING` in `decoder.js`. These include the corner-marker green threshold (0.18), the minimum quad size, the bar gate (14 units), the glare limit (0.8), the minimum lane contrast (0.06) and how often decoding runs.
- **Exposure:** a bright screen in a dim room can blow out the camera's auto-exposure. Turning the sender's brightness down a little, or adding `exposureCompensation` / `exposureMode` constraints where the browser supports them, may help.
