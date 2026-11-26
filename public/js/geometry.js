const laneWidths = [54, 38, 32, 38, 32, 38, 32, 38];
const divider = 3;
const gutter = 14;
const screenW = 390;
const screenH = 844;
const frameWidth = 2 * gutter + laneWidths.reduce((a, b) => a + b, 0) + 9 * divider;
const frameX = (screenW - frameWidth) / 2;
const laneX0 = [];
{
  let x = frameX + gutter + divider;
  for (const w of laneWidths) {
    laneX0.push(x);
    x += w + divider;
  }
}
const pitch = 70;
const leftGutterX = frameX + gutter / 2;
const rightGutterX = frameX + frameWidth - gutter / 2;

export const G = Object.freeze({
  screenW,
  screenH,
  laneWidths,
  divider,
  gutter,
  frameWidth,
  frameX,
  laneX0,
  laneX1: (i) => laneX0[i] + laneWidths[i],
  leftGutterX,
  rightGutterX,
  frameTop: 40,
  visTop: 64,
  judgeY: 700,
  frameBottom: 760,
  pitch,
  noteH: 14,
  measure: 8 * pitch,
  rowsPerSecond: 24,
  speed: 24 * pitch,
  fiducialSize: 14,
  fiducials: [
    [leftGutterX, 50],
    [rightGutterX, 50],
    [leftGutterX, 742],
    [rightGutterX, 742],
  ],
  red: [1.0, 0.18, 0.16],
  white: [0.95, 0.95, 0.97],
  blue: [0.22, 0.48, 1.0],
  green: [0.12, 0.95, 0.3],
  noteColor: (lane) => (lane === 0 ? G.red : lane % 2 === 1 ? G.white : G.blue),
});

export const PITCHES = [35, 42, 49, 56, 63, 70];

export function greenNumber(pitch) {
  return Math.round(((G.judgeY - G.visTop) / (G.rowsPerSecond * pitch)) * 600);
}
