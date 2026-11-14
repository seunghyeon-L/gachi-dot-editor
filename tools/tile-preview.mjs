// 타일 이음매 확인: 한 장을 n×n 으로 이어 깔아 크게 그린 PNG 를 만들고, 좌우·위아래 이음매에서 끊기는 곳을 셈.
//   node tools/tile-preview.mjs <프로젝트> [프레임=0] [--n 3] [--scale 6]
//   → .snap/<프로젝트>-tile-<시각>.png 경로를 출력 (AI 는 이 그림을 열어서 직접 확인)
// 서버가 없어도 됨 (projects/<프로젝트>.dot.json 을 바로 읽음).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../core.js';
import { encodePNG } from '../png.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!pos[0]) { console.log('사용법: node tools/tile-preview.mjs <프로젝트> [프레임=0] [--n 3] [--scale 6]'); process.exit(1); }
const name = pos[0], frame = +(pos[1] || 0), n = opt('--n', 3), scale = opt('--scale', 6);
const doc = core.parse(fs.readFileSync(path.join(ROOT, 'projects', `${name}.dot.json`), 'utf8'), { name });
const { w, h } = doc;
const one = core.composite(doc, frame);

// 이음매 검사: 오른쪽 끝 열 ↔ 왼쪽 끝 열, 아래 끝 줄 ↔ 위 끝 줄이 "얼마나 다른지"(색이 다른 칸 수)
// — 디자인에 따라 달라도 되지만, 안쪽 이웃끼리보다 훨씬 많이 다르면 이음매가 티 남
const px = (x, y) => { const o = (y * w + x) * 4; return `${one[o]},${one[o + 1]},${one[o + 2]},${one[o + 3]}`; };
const diffCol = (a, b) => { let d = 0; for (let y = 0; y < h; y++) if (px(a, y) !== px(b, y)) d++; return d; };
const diffRow = (a, b) => { let d = 0; for (let x = 0; x < w; x++) if (px(x, a) !== px(x, b)) d++; return d; };
let inX = 0, inY = 0;
for (let x = 0; x < w - 1; x++) inX += diffCol(x, x + 1);
for (let y = 0; y < h - 1; y++) inY += diffRow(y, y + 1);
const seamX = diffCol(w - 1, 0), seamY = diffRow(h - 1, 0);
console.log(`좌우 이음매: 다른 칸 ${seamX}/${h} (안쪽 이웃 열 평균 ${(inX / (w - 1)).toFixed(1)})`);
console.log(`위아래 이음매: 다른 칸 ${seamY}/${w} (안쪽 이웃 줄 평균 ${(inY / (h - 1)).toFixed(1)})`);

// n×n 으로 깔고 크게
const W = w * n * scale, H = h * n * scale, out = new Uint8ClampedArray(W * H * 4);
for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
  const x = Math.floor(X / scale) % w, y = Math.floor(Y / scale) % h, s = (y * w + x) * 4, o = (Y * W + X) * 4;
  const bg = ((Math.floor(X / scale) + Math.floor(Y / scale)) & 1) ? 200 : 230, a = one[s + 3] / 255;   // 투명 칸은 체크 무늬
  for (let k = 0; k < 3; k++) out[o + k] = one[s + k] * a + bg * (1 - a);
  out[o + 3] = 255;
}
const dir = path.join(ROOT, '.snap'); fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${name}-tile-${Date.now()}.png`);
fs.writeFileSync(file, encodePNG(W, H, out));
console.log(file);
