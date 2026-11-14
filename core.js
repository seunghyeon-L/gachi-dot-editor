// 가치고치 도트 편집기 — 핵심 (브라우저·Node 공용, 의존성 없음)
// 문서 구조 · 글자 파일 형식 · 연산(op) · 그리기 · 합성 · 가져오기/내보내기 계산
//
// 문서(doc) 모양 — Aseprite 의 인덱스 모드와 같은 생각
//   { name, w, h, pivot:[x,y]|null,
//     palette: [{ch, c:[r,g,b,a], name}],         // 픽셀 값 1..N = palette[0..N-1], 0 = 투명
//     layers:  [{name, visible, opacity, locked, cels:[celId per frame]}],  // 0 = 맨 아래
//     frames:  [ms, ms, ...],
//     tags:    [{name, from, to, dir:'forward'|'reverse'|'pingpong', color}],
//     motion:  [dx per frame] | null                // 프레임마다 앞으로 가는 거리(px). 이동 미리보기·내보내기용
//     lift:    [y per frame] | null                 // 프레임이 시작할 때 캐릭터 높이(px, 음수=위). 재생기가 프레임 사이를 부드럽게 이음
//     store }                                      // celId → Uint8Array(w*h) (절대 고쳐 쓰지 않음)
// 셀 데이터는 바꾸지 않고 새로 만든다 → 문서 복사가 싸고, 되돌리기 = 예전 구조로 돌아가기.
// 같은 celId 를 여러 프레임이 쓰면 링크 셀(Aseprite linked cel).

export const FORMAT = 'gachi-dot/1';
export const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&*+-/:;<=>@^_|~';
export const MAX_COLORS = CHARS.length;
export const KEEP = '?'; // stamp 에서 "그대로 두기"
export const TAG_COLORS = ['#e8615d', '#e9a23b', '#cfc83e', '#5bb865', '#45a5d8', '#7d6be3', '#d65cb5', '#9a9a9a'];
export const DIRS = ['forward', 'reverse', 'pingpong'];

export const DEFAULT_PALETTE = [
  ['#1a1520', '외곽선'], ['#ffffff', '흰색'], ['#6b6470', '회색'], ['#b9b2bd', '밝은 회색'],
  ['#f08a3c', '주황'], ['#ffc48a', '밝은 주황'], ['#c25a28', '진한 주황'], ['#ffe2a8', '크림'],
  ['#5bb04a', '초록'], ['#2f7a3a', '진한 초록'], ['#45a5d8', '파랑'], ['#2a5d9a', '진한 파랑'],
  ['#8a5a3a', '갈색'], ['#ff9bb0', '볼터치'], ['#ffe08a', '노랑'], ['#16141e46', '그림자'],
];

// ───────────────────────── 색 ─────────────────────────
export function parseColor(s) {
  if (Array.isArray(s)) return [s[0] | 0, s[1] | 0, s[2] | 0, s.length > 3 ? s[3] | 0 : 255];
  const t = String(s ?? '').trim().toLowerCase();
  if (t === 'transparent' || t === 'none') return [0, 0, 0, 0];
  const m = t.match(/^#?([0-9a-f]+)$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  return [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
}
export function toHex(c) {
  const h = '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
  return c[3] === 255 ? h : h + c[3].toString(16).padStart(2, '0');
}
const colorDist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 + 2 * (a[3] - b[3]) ** 2;

// ───────────────────────── base64 ─────────────────────────
export function b64enc(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64dec(s) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ───────────────────────── 문서 ─────────────────────────
export class Store {
  constructor() { this.map = new Map(); this.next = 1; }
  add(data) { const id = this.next++; this.map.set(id, data); return id; }
  set(id, data) { this.map.set(id, data); if (id >= this.next) this.next = id + 1; }
  get(id) { return id ? this.map.get(id) || null : null; }
  has(id) { return this.map.has(id); }
}

export function makeDoc({ name = 'untitled', w = 32, h = 32, palette, store } = {}) {
  const pal = palette ? palette.map((p) => ({ ...p })) :
    DEFAULT_PALETTE.map(([hex, nm], i) => ({ ch: CHARS[i], c: parseColor(hex), name: nm }));
  return {
    name, w, h, pivot: [Math.floor(w / 2), h - 1], palette: pal,
    layers: [{ name: '레이어 1', visible: true, opacity: 255, locked: false, cels: [0] }],
    frames: [100], tags: [], motion: null, lift: null, store: store || new Store(),
  };
}

export function cloneDoc(d) {
  return {
    ...d,
    pivot: d.pivot ? d.pivot.slice() : null,
    palette: d.palette.slice(),
    layers: d.layers.map((L) => ({ ...L, cels: L.cels.slice() })),
    frames: d.frames.slice(),
    tags: d.tags.map((t) => ({ ...t })),
    motion: d.motion ? d.motion.slice() : null,
    lift: d.lift ? d.lift.slice() : null,
  };
}

export const celOf = (doc, li, f) => doc.store.get(doc.layers[li]?.cels[f] || 0);
export const blank = (doc) => new Uint8Array(doc.w * doc.h);
export const isEmpty = (buf) => { for (let i = 0; i < buf.length; i++) if (buf[i]) return false; return true; };
export const copyCel = (doc, li, f) => { const b = celOf(doc, li, f); return b ? b.slice() : blank(doc); };

/** 셀 내용 교체. 링크된 셀이면 링크된 프레임 모두 바뀜 (Aseprite 와 같음). doc 은 이미 복사본이어야 함 */
export function setCel(doc, li, f, data) {
  const L = doc.layers[li];
  const old = L.cels[f];
  const id = !data || isEmpty(data) ? 0 : doc.store.add(data);
  if (old) { for (let i = 0; i < L.cels.length; i++) if (L.cels[i] === old) L.cels[i] = id; }
  else L.cels[f] = id;
}

/** 링크 묶음: 같은 celId 를 쓰는 프레임들 */
export function linkGroup(doc, li, f) {
  const id = doc.layers[li].cels[f];
  if (!id) return [f];
  return doc.layers[li].cels.map((c, i) => (c === id ? i : -1)).filter((i) => i >= 0);
}

// ───────────────────────── 지정자 풀기 ─────────────────────────
export function layerIndex(doc, spec) {
  if (spec == null || spec === '') throw new Error('레이어를 지정하세요');
  const s = String(spec);
  let i = /^-?\d+$/.test(s) ? +s : doc.layers.findIndex((L) => L.name === s);
  if (i < 0 && /^-\d+$/.test(s)) i = doc.layers.length + +s;
  if (i < 0 || i >= doc.layers.length) {
    throw new Error(`레이어 "${s}" 없음 (있는 것: ${doc.layers.map((L, k) => `${k}:${L.name}`).join(', ')})`);
  }
  return i;
}
export function layerList(doc, spec) {
  if (spec == null || spec === 'all' || spec === '*') return doc.layers.map((_, i) => i);
  if (Array.isArray(spec)) return spec.map((s) => layerIndex(doc, s));
  const s = String(spec);
  if (/^[\d,]+$/.test(s) && s.includes(',')) return s.split(',').map((x) => layerIndex(doc, x));
  return [layerIndex(doc, s)];
}
export function frameList(doc, spec) {
  const n = doc.frames.length;
  const chk = (f) => { if (!(f >= 0 && f < n)) throw new Error(`프레임 ${f} 없음 (0~${n - 1})`); return f; };
  if (spec == null || spec === 'all' || spec === '*') return doc.frames.map((_, i) => i);
  if (typeof spec === 'number') return [chk(spec)];
  if (Array.isArray(spec)) return spec.map((f) => chk(+f));
  const s = String(spec).trim();
  if (s.startsWith('tag:')) {
    const t = doc.tags.find((x) => x.name === s.slice(4));
    if (!t) throw new Error(`태그 "${s.slice(4)}" 없음`);
    return range(t.from, t.to);
  }
  const out = [];
  for (const part of s.split(',')) {
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) out.push(...range(+m[1], +m[2]).map(chk));
    else if (/^\d+$/.test(part)) out.push(chk(+part));
    else throw new Error(`프레임 지정 "${part}" 을 못 읽음 (예: 0, 0-3, 1,3, all, tag:idle)`);
  }
  return [...new Set(out)];
}
const range = (a, b) => { const r = []; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) r.push(i); return r; };

/** 색 지정 → 팔레트 번호(0=투명). '#hex' 가 팔레트에 없으면 추가 (doc 은 복사본이어야 함) */
export function colorIndex(doc, spec, { add = true } = {}) {
  if (typeof spec === 'number') {
    if (spec < 0 || spec > doc.palette.length) throw new Error(`팔레트 번호 ${spec} 없음`);
    return spec;
  }
  const s = String(spec ?? '');
  if (s === '.' || s === 'transparent') return 0;
  if (s.length === 1) {
    const i = doc.palette.findIndex((p) => p.ch === s);
    if (i < 0) throw new Error(`팔레트에 "${s}" 글자 없음 (${doc.palette.map((p) => p.ch).join('')})`);
    return i + 1;
  }
  const c = parseColor(s);
  if (!c) throw new Error(`색 "${s}" 을 못 읽음 (팔레트 글자, #rrggbb, #rrggbbaa, .)`);
  if (c[3] === 0) return 0;
  const i = doc.palette.findIndex((p) => p.c.every((v, k) => v === c[k]));
  if (i >= 0) return i + 1;
  if (!add) throw new Error(`팔레트에 ${s} 없음`);
  return addPaletteColor(doc, c);
}
export function addPaletteColor(doc, c, ch, name) {
  if (doc.palette.length >= MAX_COLORS) throw new Error(`팔레트가 가득 참 (${MAX_COLORS}색)`);
  const used = new Set(doc.palette.map((p) => p.ch));
  if (ch && (used.has(ch) || !CHARS.includes(ch))) throw new Error(`팔레트 글자 "${ch}" 를 쓸 수 없음`);
  ch = ch || [...CHARS].find((x) => !used.has(x));
  doc.palette.push({ ch, c, name: name || '' });
  return doc.palette.length;
}

// ───────────────────────── 그리기 (버퍼 직접 고침, 호출하는 쪽이 복사본을 넘김) ─────────────────────────
export function linePts(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}
export function rectPts(x0, y0, x1, y1, filled) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const pts = [];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    if (filled || x === ax || x === bx || y === ay || y === by) pts.push([x, y]);
  }
  return pts;
}
export function ellipsePts(x0, y0, x1, y1, filled) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const cx = (ax + bx) / 2, cy = (ay + by) / 2, rx = (bx - ax) / 2 + 0.5, ry = (by - ay) / 2 + 0.5;
  const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0001;
  const pts = [];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    if (!inside(x, y)) continue;
    if (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) pts.push([x, y]);
  }
  return pts;
}
/** 픽셀 퍼펙트: ㄱ자 꺾임의 가운데 점을 뺀다 (Aseprite pixel-perfect) */
export function pixelPerfect(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
    if (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      if ((a[0] === b[0] || a[1] === b[1]) && (c[0] === b[0] || c[1] === b[1]) && a[0] !== c[0] && a[1] !== c[1]) out.splice(out.length - 2, 1);
    }
  }
  return out;
}
export function plot(buf, w, h, x, y, v, size = 1) {
  const o = Math.floor((size - 1) / 2);
  for (let yy = y - o; yy < y - o + size; yy++) for (let xx = x - o; xx < x - o + size; xx++) {
    if (xx >= 0 && yy >= 0 && xx < w && yy < h) buf[yy * w + xx] = v;
  }
}
export function floodFill(buf, w, h, x, y, v, contiguous = true) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const t = buf[y * w + x];
  if (t === v) return;
  if (!contiguous) { for (let i = 0; i < buf.length; i++) if (buf[i] === t) buf[i] = v; return; }
  const st = [[x, y]];
  while (st.length) {
    const [px, py] = st.pop();
    let lx = px;
    while (lx > 0 && buf[py * w + lx - 1] === t) lx--;
    let up = false, dn = false;
    for (let cx = lx; cx < w && buf[py * w + cx] === t; cx++) {
      buf[py * w + cx] = v;
      if (py > 0) { const u = buf[(py - 1) * w + cx] === t; if (u && !up) st.push([cx, py - 1]); up = u; }
      if (py < h - 1) { const d = buf[(py + 1) * w + cx] === t; if (d && !dn) st.push([cx, py + 1]); dn = d; }
    }
  }
}
/** 영역을 캔버스와 겹치는 부분으로 자름 (없으면 캔버스 전체, 안 겹치면 null) */
export function clipRegion(r, w, h) {
  if (!r) return { x: 0, y: 0, w, h };
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(w, Math.round(r.x) + Math.round(r.w)), y1 = Math.min(h, Math.round(r.y) + Math.round(r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
const inRegion = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
/** 영역 안 픽셀을 dx,dy 만큼 옮긴 새 버퍼 (영역 밖은 그대로, wrap 이면 영역 안에서 돌아 나옴) */
export function shiftBuf(buf, w, h, dx, dy, { wrap = false, region } = {}) {
  const r = clipRegion(region, w, h);
  if (!r) return buf.slice();
  const out = buf.slice();
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out[y * w + x] = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const v = buf[y * w + x];
    if (!v) continue;
    let nx = x + dx, ny = y + dy;
    if (wrap) { nx = r.x + (((nx - r.x) % r.w) + r.w) % r.w; ny = r.y + (((ny - r.y) % r.h) + r.h) % r.h; }
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    out[ny * w + nx] = v;
  }
  return out;
}
export function flipBuf(buf, w, h, axis, region) {
  const r = clipRegion(region, w, h);
  if (!r) return buf.slice();
  const out = buf.slice();
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const sx = axis === 'h' ? r.x + r.w - 1 - (x - r.x) : x;
    const sy = axis === 'v' ? r.y + r.h - 1 - (y - r.y) : y;
    out[y * w + x] = buf[sy * w + sx];
  }
  return out;
}
export function rotateBuf(buf, w, h, deg, region) {
  const r = clipRegion(region, w, h);
  if (!r) return buf.slice();
  const k = (((deg / 90) | 0) % 4 + 4) % 4;
  if (!k) return buf.slice();
  const out = buf.slice();
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out[y * w + x] = 0;
  const cx = r.x + (r.w - 1) / 2, cy = r.y + (r.h - 1) / 2;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const v = buf[y * w + x];
    if (!v) continue;
    let rx = x - cx, ry = y - cy;
    for (let i = 0; i < k; i++) [rx, ry] = [-ry, rx];
    const nx = Math.round(cx + rx), ny = Math.round(cy + ry);
    if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = v;
  }
  return out;
}
export function outlineBuf(buf, w, h, v, diagonal = false) {
  const out = buf.slice();
  const nb = diagonal ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (buf[y * w + x]) continue;
    if (nb.some(([dx, dy]) => { const nx = x + dx, ny = y + dy; return nx >= 0 && ny >= 0 && nx < w && ny < h && buf[ny * w + nx] && buf[ny * w + nx] !== v; })) out[y * w + x] = v;
  }
  return out;
}
/** 글자 줄을 (x,y) 에 찍기. '?' = 그대로, '.' = 투명 */
export function stampRows(doc, buf, x0, y0, rows) {
  const map = new Map(doc.palette.map((p, i) => [p.ch, i + 1]));
  map.set('.', 0);
  let n = 0;
  rows.forEach((row, dy) => {
    [...row].forEach((ch, dx) => {
      if (ch === KEEP || ch === ' ') return;
      if (!map.has(ch)) throw new Error(`${dy}번째 줄 ${dx}번째 글자 "${ch}" 가 팔레트에 없음 (${doc.palette.map((p) => p.ch).join('')} 와 . ?)`);
      const x = x0 + dx, y = y0 + dy;
      if (x >= 0 && y >= 0 && x < doc.w && y < doc.h) { buf[y * doc.w + x] = map.get(ch); n++; }
    });
  });
  return n;
}

// ───────────────────────── 연산 (op) ─────────────────────────
// applyOp(doc, op) → { doc: 새 문서, label }. 실패하면 Error (한국어 메시지).
// 사람 화면과 AI 명령이 모두 이 함수로 문서를 바꾼다.
const celsFor = (doc, op) => {
  const ls = layerList(doc, op.layer ?? op.layers);
  const fs = frameList(doc, op.frame ?? op.frames);
  return { ls, fs };
};
function editCels(d, ls, fs, fn) {
  // 링크 셀은 한 번만 고친다
  for (const li of ls) {
    if (d.layers[li].locked) throw new Error(`레이어 "${d.layers[li].name}" 가 잠겨 있음`);
    const done = new Set();
    for (const f of fs) {
      const id = d.layers[li].cels[f];
      if (id && done.has(id)) continue;
      const before = copyCel(d, li, f);
      const after = fn(before, li, f);
      if (after) setCel(d, li, f, after);
      const nid = d.layers[li].cels[f];
      if (id) done.add(nid || id);
    }
  }
}
const shiftTags = (d, at, n) => {
  for (const t of d.tags) {
    if (t.from >= at) t.from += n;
    if (t.to >= at) t.to += n;
  }
};

export function applyOp(doc, op) {
  const d = cloneDoc(doc);
  const W = d.w, H = d.h;
  const t = op.type;
  const L = (spec) => layerIndex(d, spec);
  // 입력 검사: 숫자가 아니거나 터무니없이 크면 거절 (깨진 파일·무한 루프 방지)
  const int = (v, name, lo = -4096, hi = 4096) => {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} 값 "${v}" 이(가) 잘못됨 (${lo}~${hi})`);
    return Math.round(n);
  };
  const one = (spec) => { const fs = frameList(d, spec); if (fs.length !== 1) throw new Error('프레임을 하나만 지정하세요'); return fs[0]; };
  const region = (r) => {
    if (!r) return undefined;
    const c = clipRegion({ x: int(r.x, 'region.x'), y: int(r.y, 'region.y'), w: int(r.w, 'region.w', 1), h: int(r.h, 'region.h', 1) }, W, H);
    if (!c) throw new Error('영역이 캔버스 밖에 있음');
    return c;
  };
  const NP = d.palette.length;
  switch (t) {
    case 'paint': { // 사람 붓질: items [{layer, frame, px:[x,y,v, ...]}]
      for (const it of op.items) {
        const li = L(it.layer), f = one(it.frame);
        if (d.layers[li].locked) throw new Error(`레이어 "${d.layers[li].name}" 가 잠겨 있음`);
        if (!Array.isArray(it.px) || it.px.length % 3) throw new Error('px 는 [x, y, 번호, ...]');
        const buf = copyCel(d, li, f);
        for (let i = 0; i < it.px.length; i += 3) {
          const x = it.px[i], y = it.px[i + 1], v = it.px[i + 2];
          if (!Number.isInteger(v) || v < 0 || v > NP) throw new Error(`팔레트 번호 ${v} 없음`);
          if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = v;
        }
        setCel(d, li, f, buf);
      }
      return { doc: d, label: op.label || '그리기' };
    }
    case 'putCel': {
      for (const it of op.items) {
        const li = L(it.layer);
        const data = typeof it.data === 'string' ? b64dec(it.data) : it.data;
        if (data.length !== W * H) throw new Error('셀 크기가 캔버스와 다름');
        for (const v of data) if (v > NP) throw new Error(`팔레트 번호 ${v} 없음`);
        setCel(d, li, one(it.frame), data);
      }
      return { doc: d, label: op.label || '셀 바꾸기' };
    }
    case 'pixels': { // [[x,y,color], ...]
      const { ls, fs } = celsFor(d, op);
      const set = op.set.map(([x, y, c]) => [int(x, 'x'), int(y, 'y'), colorIndex(d, c)]);
      editCels(d, ls, fs, (b) => { for (const [x, y, v] of set) if (x >= 0 && y >= 0 && x < W && y < H) b[y * W + x] = v; return b; });
      return { doc: d, label: `점 ${set.length}개` };
    }
    case 'stamp': {
      const { ls, fs } = celsFor(d, op);
      const rows = Array.isArray(op.rows) ? op.rows : String(op.rows).split(/\r?\n/);
      while (rows.length && rows[rows.length - 1] === '') rows.pop();
      for (const c of new Set(rows.join(''))) if (c !== '.' && c !== KEEP && c !== ' ' && !d.palette.some((p) => p.ch === c)) throw new Error(`글자 "${c}" 가 팔레트에 없음`);
      const sx = int(op.x ?? 0, 'x'), sy = int(op.y ?? 0, 'y');
      editCels(d, ls, fs, (b) => { stampRows(d, b, sx, sy, rows); return b; });
      return { doc: d, label: `글자 그림 ${rows[0]?.length || 0}×${rows.length} 찍기` };
    }
    case 'shape': { // kind: line|rect|ellipse, x0 y0 x1 y1, color, fill, size
      const { ls, fs } = celsFor(d, op);
      const v = colorIndex(d, op.color);
      const [x0, y0, x1, y1] = ['x0', 'y0', 'x1', 'y1'].map((k) => int(op[k], k, -1024, 2048));
      const size = int(op.size ?? 1, 'size', 1, 16);
      const pts = op.kind === 'line' ? linePts(x0, y0, x1, y1)
        : op.kind === 'rect' ? rectPts(x0, y0, x1, y1, op.fill)
          : op.kind === 'ellipse' ? ellipsePts(x0, y0, x1, y1, op.fill) : null;
      if (!pts) throw new Error(`도형 종류 ${op.kind} 없음 (line, rect, ellipse)`);
      editCels(d, ls, fs, (b) => { for (const [x, y] of pts) plot(b, W, H, x, y, v, size); return b; });
      return { doc: d, label: { line: '직선', rect: '사각형', ellipse: '원' }[op.kind] };
    }
    case 'fill': {
      const { ls, fs } = celsFor(d, op);
      const v = colorIndex(d, op.color);
      const fx = int(op.x, 'x'), fy = int(op.y, 'y');
      editCels(d, ls, fs, (b) => { floodFill(b, W, H, fx, fy, v, op.contiguous !== false); return b; });
      return { doc: d, label: '채우기' };
    }
    case 'shift': {
      const { ls, fs } = celsFor(d, op);
      const dx = int(op.dx, 'dx'), dy = int(op.dy, 'dy'), r = region(op.region);
      editCels(d, ls, fs, (b) => shiftBuf(b, W, H, dx, dy, { wrap: op.wrap, region: r }));
      return { doc: d, label: `옮기기 (${dx}, ${dy})` };
    }
    case 'flip': {
      const { ls, fs } = celsFor(d, op);
      const r = region(op.region);
      editCels(d, ls, fs, (b) => flipBuf(b, W, H, op.axis === 'v' ? 'v' : 'h', r));
      return { doc: d, label: op.axis === 'v' ? '상하 뒤집기' : '좌우 뒤집기' };
    }
    case 'rotate': {
      const { ls, fs } = celsFor(d, op);
      const deg = int(op.deg, 'deg', -360, 360), r = region(op.region);
      if (deg % 90) throw new Error('돌리기는 90도 단위만');
      editCels(d, ls, fs, (b) => rotateBuf(b, W, H, deg, r));
      return { doc: d, label: `${op.deg}도 돌리기` };
    }
    case 'replace': {
      const { ls, fs } = celsFor(d, op);
      const a = colorIndex(d, op.from, { add: false }), b2 = colorIndex(d, op.to);
      editCels(d, ls, fs, (b) => { for (let i = 0; i < b.length; i++) if (b[i] === a) b[i] = b2; return b; });
      return { doc: d, label: '색 바꾸기' };
    }
    case 'outline': {
      const { ls, fs } = celsFor(d, op);
      const v = colorIndex(d, op.color);
      editCels(d, ls, fs, (b) => outlineBuf(b, W, H, v, op.diagonal));
      return { doc: d, label: '외곽선' };
    }
    case 'clear': {
      const { ls, fs } = celsFor(d, op);
      editCels(d, ls, fs, (b) => {
        if (!op.region) return blank(d);
        const r = region(op.region);
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < W && y < H) b[y * W + x] = 0;
        return b;
      });
      return { doc: d, label: '지우기' };
    }
    case 'copyCel': { // from {layer,frame} → to {layer,frame(s)}, link
      const sl = L(op.from.layer), sf = frameList(d, op.from.frame)[0];
      const tl = L(op.to.layer ?? op.from.layer);
      const src = d.layers[sl].cels[sf];
      for (const tf of frameList(d, op.to.frame)) {
        if (op.link && sl === tl) d.layers[tl].cels[tf] = src;
        else d.layers[tl].cels[tf] = src ? d.store.add(d.store.get(src)) : 0;
      }
      return { doc: d, label: op.link ? '셀 링크 복사' : '셀 복사' };
    }
    case 'link': {
      const li = L(op.layer);
      const fs = frameList(d, op.frames);
      const src = d.layers[li].cels[fs[0]];
      for (const f of fs) d.layers[li].cels[f] = src;
      return { doc: d, label: `셀 링크 (${fs.join(',')})` };
    }
    case 'unlink': {
      const li = L(op.layer);
      for (const f of frameList(d, op.frames ?? op.frame)) {
        const id = d.layers[li].cels[f];
        if (id) d.layers[li].cels[f] = d.store.add(d.store.get(id));
      }
      return { doc: d, label: '링크 풀기' };
    }
    case 'addFrame': { // at, from(복사할 프레임, null=빈), link, ms
      const at = int(op.at ?? d.frames.length, '위치', 0, d.frames.length);
      const from = op.from == null ? null : one(op.from);
      const count = int(op.count ?? 1, 'count', 1, 256);
      const ms0 = op.ms == null ? null : int(op.ms, 'ms', 1, 60000);
      for (let k = 0; k < count; k++) {
        const pos = at + k;
        const src = from == null ? null : (from >= at ? from + k : from);
        d.frames.splice(pos, 0, ms0 ?? (src != null ? d.frames[src] : d.frames[Math.max(0, pos - 1)] ?? 100));
        if (d.motion) d.motion.splice(pos, 0, src != null ? d.motion[src] : 0);
        if (d.lift) d.lift.splice(pos, 0, src != null ? d.lift[src] : 0);
        for (const Ly of d.layers) {
          const id = src != null ? Ly.cels[src] : 0;
          Ly.cels.splice(pos, 0, id ? (op.link ? id : d.store.add(d.store.get(id))) : 0);
        }
        shiftTags(d, pos, 1);
        // 태그 끝 바로 뒤에 붙인 프레임은 그 태그에 포함 (Aseprite 처럼)
        for (const tg of d.tags) if (tg.to === pos - 1 && op.extendTag !== false && from != null) tg.to = pos;
      }
      return { doc: d, label: from == null ? '빈 프레임' : op.link ? '링크 프레임' : '새 프레임' };
    }
    case 'delFrames': {
      const fs = frameList(d, op.frames).sort((a, b) => b - a);
      if (fs.length >= d.frames.length) throw new Error('프레임을 모두 지울 수는 없음');
      for (const f of fs) {
        d.frames.splice(f, 1);
        if (d.motion) d.motion.splice(f, 1);
        if (d.lift) d.lift.splice(f, 1);
        for (const Ly of d.layers) Ly.cels.splice(f, 1);
        d.tags = d.tags.filter((tg) => !(tg.from === f && tg.to === f));
        for (const tg of d.tags) { if (tg.from > f) tg.from--; if (tg.to >= f) tg.to--; }
      }
      return { doc: d, label: `프레임 지우기 (${fs.length})` };
    }
    case 'moveFrames': { // frames → before index `to` (to = 새 위치, 원래 배열 기준 삽입점)
      const fs = frameList(d, op.frames).sort((a, b) => a - b);
      const order = d.frames.map((_, i) => i).filter((i) => !fs.includes(i));
      const to = int(op.to, 'to', 0, d.frames.length);
      let ins = to;
      ins -= fs.filter((f) => f < to).length;
      ins = Math.max(0, Math.min(order.length, ins));
      order.splice(ins, 0, ...fs);
      d.frames = order.map((i) => doc.frames[i]);
      if (d.motion) d.motion = order.map((i) => doc.motion[i]);
      if (d.lift) d.lift = order.map((i) => doc.lift[i]);
      for (const Ly of d.layers) { const old = Ly.cels; Ly.cels = order.map((i) => old[i]); }
      return { doc: d, label: '프레임 옮기기' };
    }
    case 'duration': {
      const ms = int(op.ms, 'ms', 1, 60000);
      for (const f of frameList(d, op.frames)) d.frames[f] = ms;
      return { doc: d, label: `프레임 시간 ${ms}ms` };
    }
    case 'lift': { // 프레임이 시작할 때 캐릭터 높이 (음수 = 위). 그림을 다시 그리지 않고 재생기가 부드럽게 옮김
      if (!d.lift) d.lift = d.frames.map(() => 0);
      const y = int(op.y, 'y', -1024, 1024);
      for (const f of frameList(d, op.frames)) d.lift[f] = y;
      if (d.lift.every((v) => !v)) d.lift = null;
      return { doc: d, label: `높이 ${y}px` };
    }
    case 'motion': { // 프레임마다 앞으로 가는 거리
      if (!d.motion) d.motion = d.frames.map(() => 0);
      const dx = int(op.dx, 'dx', -1024, 1024);
      for (const f of frameList(d, op.frames)) d.motion[f] = dx;
      if (d.motion.every((v) => !v)) d.motion = null;
      return { doc: d, label: `이동 거리 ${op.dx}px` };
    }
    case 'addLayer': {
      let name = op.name || `레이어 ${d.layers.length + 1}`;
      while (d.layers.some((x) => x.name === name)) name += "'";
      const at = int(op.at ?? d.layers.length, '위치', 0, d.layers.length);
      d.layers.splice(at, 0, { name, visible: true, opacity: 255, locked: false, cels: d.frames.map(() => 0) });
      return { doc: d, label: `레이어 추가 "${name}"` };
    }
    case 'dupLayer': {
      const li = L(op.layer);
      const src = d.layers[li];
      let name = src.name + ' 복사';
      while (d.layers.some((x) => x.name === name)) name += "'";
      const map = new Map();
      const cels = src.cels.map((id) => { if (!id) return 0; if (!map.has(id)) map.set(id, d.store.add(d.store.get(id))); return map.get(id); });
      d.layers.splice(li + 1, 0, { ...src, name, cels });
      return { doc: d, label: `레이어 복제 "${name}"` };
    }
    case 'delLayer': {
      const li = L(op.layer);
      if (d.layers.length <= 1) throw new Error('레이어를 모두 지울 수는 없음');
      const [gone] = d.layers.splice(li, 1);
      return { doc: d, label: `레이어 지우기 "${gone.name}"` };
    }
    case 'layer': { // 속성: name visible opacity locked
      const li = L(op.layer);
      const Ly = d.layers[li];
      if (op.name != null && op.name !== Ly.name) {
        if (d.layers.some((x) => x.name === op.name)) throw new Error(`레이어 이름 "${op.name}" 이미 있음`);
        Ly.name = String(op.name);
      }
      if (op.visible != null) Ly.visible = !!op.visible;
      if (op.locked != null) Ly.locked = !!op.locked;
      if (op.opacity != null) Ly.opacity = int(op.opacity, 'opacity', 0, 255);
      return { doc: d, label: `레이어 "${Ly.name}" 설정` };
    }
    case 'moveLayer': {
      const li = L(op.layer);
      const to = Math.max(0, Math.min(d.layers.length - 1, int(op.to, 'to')));
      const [Ly] = d.layers.splice(li, 1);
      d.layers.splice(to, 0, Ly);
      return { doc: d, label: `레이어 순서 "${Ly.name}"` };
    }
    case 'mergeDown': {
      const li = L(op.layer);
      if (li === 0) throw new Error('맨 아래 레이어는 아래로 합칠 수 없음');
      const up = d.layers[li], dn = d.layers[li - 1];
      if (up.visible) {
        for (let f = 0; f < d.frames.length; f++) {
          const a = celOf(d, li, f);
          if (!a) continue;
          const b = copyCel(d, li - 1, f);
          for (let i = 0; i < b.length; i++) if (a[i]) b[i] = a[i];
          dn.cels[f] = d.store.add(b); // 아래 레이어 링크는 풀린다
        }
      }
      d.layers.splice(li, 1);
      return { doc: d, label: `"${up.name}" 아래로 합치기` };
    }
    case 'addTag': {
      const [a, b] = [op.from, op.to].map((f) => frameList(d, f)[0]);
      const name = op.name || `tag${d.tags.length + 1}`;
      if (d.tags.some((x) => x.name === name)) throw new Error(`태그 "${name}" 이미 있음`);
      const dir = DIRS.includes(op.dir) ? op.dir : 'forward';
      d.tags.push({ name, from: Math.min(a, b), to: Math.max(a, b), dir, color: op.color || TAG_COLORS[d.tags.length % TAG_COLORS.length] });
      d.tags.sort((x, y) => x.from - y.from);
      return { doc: d, label: `태그 "${name}"` };
    }
    case 'editTag': {
      const tg = d.tags.find((x) => x.name === op.name);
      if (!tg) throw new Error(`태그 "${op.name}" 없음`);
      if (op.rename) { if (d.tags.some((x) => x.name === op.rename)) throw new Error('같은 이름 태그 있음'); tg.name = op.rename; }
      if (op.from != null) tg.from = frameList(d, op.from)[0];
      if (op.to != null) tg.to = frameList(d, op.to)[0];
      if (tg.from > tg.to) [tg.from, tg.to] = [tg.to, tg.from];
      if (op.dir) { if (!DIRS.includes(op.dir)) throw new Error('방향은 forward, reverse, pingpong'); tg.dir = op.dir; }
      if (op.color) tg.color = op.color;
      return { doc: d, label: `태그 "${tg.name}" 고치기` };
    }
    case 'delTag': {
      const n = d.tags.length;
      d.tags = d.tags.filter((x) => x.name !== op.name);
      if (d.tags.length === n) throw new Error(`태그 "${op.name}" 없음`);
      return { doc: d, label: `태그 지우기 "${op.name}"` };
    }
    case 'palAdd': {
      const c = parseColor(op.color);
      if (!c) throw new Error(`색 "${op.color}" 을 못 읽음`);
      addPaletteColor(d, c, op.ch, op.name);
      return { doc: d, label: `팔레트 추가 ${d.palette[d.palette.length - 1].ch}` };
    }
    case 'palSet': { // 인덱스 모드: 팔레트 색을 바꾸면 그 색 쓴 곳 전부 바뀜
      const i = d.palette.findIndex((p) => p.ch === op.ch);
      if (i < 0) throw new Error(`팔레트 글자 "${op.ch}" 없음`);
      const p = { ...d.palette[i] };
      if (op.color != null) { const c = parseColor(op.color); if (!c) throw new Error(`색 "${op.color}" 을 못 읽음`); p.c = c; }
      if (op.name != null) p.name = op.name;
      if (op.newCh && op.newCh !== p.ch) {
        if (!CHARS.includes(op.newCh) || d.palette.some((x) => x.ch === op.newCh)) throw new Error(`글자 "${op.newCh}" 를 쓸 수 없음`);
        p.ch = op.newCh;
      }
      d.palette[i] = p;
      return { doc: d, label: `팔레트 ${p.ch} 바꾸기` };
    }
    case 'palClean': { // 안 쓰는 색 지우기 (픽셀 번호 다시 매김)
      const used = new Set();
      for (const id of new Set(d.layers.flatMap((x) => x.cels))) { const b = d.store.get(id); if (b) for (const v of b) used.add(v); }
      const keep = d.palette.map((_, i) => i + 1).filter((v) => used.has(v) || (op.keep || []).includes(d.palette[v - 1].ch));
      const remap = new Uint8Array(256);
      keep.forEach((v, i) => { remap[v] = i + 1; });
      const removed = d.palette.length - keep.length;
      d.palette = keep.map((v) => d.palette[v - 1]);
      remapAll(d, remap);
      return { doc: d, label: `안 쓰는 색 ${removed}개 지우기` };
    }
    case 'palMove': { // 팔레트 순서 바꾸기 (글자는 그대로)
      const i = d.palette.findIndex((p) => p.ch === op.ch);
      if (i < 0) throw new Error(`팔레트 글자 "${op.ch}" 없음`);
      const to = Math.max(0, Math.min(d.palette.length - 1, op.to));
      const order = d.palette.map((_, k) => k);
      order.splice(i, 1); order.splice(to, 0, i);
      const remap = new Uint8Array(256);
      order.forEach((old, k) => { remap[old + 1] = k + 1; });
      d.palette = order.map((k) => d.palette[k]);
      remapAll(d, remap);
      return { doc: d, label: '팔레트 순서' };
    }
    case 'resize': { // w h anchor(tl t tr l c r bl b br)
      const nw = int(op.w, 'w', 1, 1024), nh = int(op.h, 'h', 1, 1024);
      const a = op.anchor || 'b';
      if (!['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'].includes(a)) throw new Error('기준은 tl t tr l c r bl b br 중 하나');
      const ox = a.includes('l') ? 0 : a.includes('r') ? nw - W : Math.floor((nw - W) / 2);
      const oy = a.startsWith('t') ? 0 : a.startsWith('b') ? nh - H : Math.floor((nh - H) / 2);
      const map = new Map();
      for (const Ly of d.layers) Ly.cels = Ly.cels.map((id) => {
        if (!id) return 0;
        if (!map.has(id)) {
          const src = d.store.get(id), out = new Uint8Array(nw * nh);
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const nx = x + ox, ny = y + oy;
            if (nx >= 0 && ny >= 0 && nx < nw && ny < nh) out[ny * nw + nx] = src[y * W + x];
          }
          map.set(id, isEmpty(out) ? 0 : d.store.add(out));
        }
        return map.get(id);
      });
      d.w = nw; d.h = nh;
      if (d.pivot) d.pivot = [d.pivot[0] + ox, d.pivot[1] + oy];
      return { doc: d, label: `캔버스 ${nw}×${nh}` };
    }
    case 'pivot': {
      d.pivot = op.x == null ? null : [int(op.x, 'x', 0, W - 1), int(op.y, 'y', 0, H - 1)];
      return { doc: d, label: d.pivot ? `기준점 (${d.pivot})` : '기준점 없앰' };
    }
    case 'batch': { // 여러 op 를 되돌리기 한 번으로
      let cur = d;
      for (const sub of op.ops) cur = applyOp(cur, sub).doc;
      return { doc: cur, label: op.label || `묶음 ${op.ops.length}개` };
    }
    default:
      throw new Error(`모르는 연산 "${t}"`);
  }
}
function remapAll(d, remap) {
  const map = new Map();
  for (const Ly of d.layers) Ly.cels = Ly.cels.map((id) => {
    if (!id) return 0;
    if (!map.has(id)) { const b = d.store.get(id).map((v) => remap[v]); map.set(id, d.store.add(b)); }
    return map.get(id);
  });
}

// ───────────────────────── 글자 파일 (.dot.json) ─────────────────────────
const J = JSON.stringify;
export function serialize(doc) {
  const chOf = ['.', ...doc.palette.map((p) => p.ch)];
  const out = [];
  out.push('{');
  out.push(`  "format": ${J(FORMAT)},`);
  out.push(`  "name": ${J(doc.name)},`);
  out.push(`  "width": ${doc.w}, "height": ${doc.h},`);
  if (doc.pivot) out.push(`  "pivot": [${doc.pivot[0]}, ${doc.pivot[1]}],`);
  out.push('  "palette": [');
  out.push(doc.palette.map((p) => `    [${J(p.ch)}, ${J(toHex(p.c))}${p.name ? ', ' + J(p.name) : ''}]`).join(',\n'));
  out.push('  ],');
  out.push('  "layers": [');
  out.push(doc.layers.map((L) => `    ${J({ name: L.name, visible: L.visible, opacity: L.opacity, locked: L.locked })}`).join(',\n'));
  out.push('  ],');
  out.push(`  "frames": [${doc.frames.join(', ')}],`);
  if (doc.motion && doc.motion.some((v) => v)) out.push(`  "motion": [${doc.motion.join(', ')}],`);
  if (doc.lift && doc.lift.some((v) => v)) out.push(`  "lift": [${doc.lift.join(', ')}],`);
  out.push('  "tags": [');
  out.push(doc.tags.map((t) => `    ${J({ name: t.name, from: t.from, to: t.to, direction: t.dir, color: t.color })}`).join(',\n'));
  out.push('  ],');
  const cels = [];
  doc.layers.forEach((L) => {
    const first = new Map();
    L.cels.forEach((id, f) => {
      if (!id) return;
      if (first.has(id)) { cels.push(`    { "layer": ${J(L.name)}, "frame": ${f}, "link": ${first.get(id)} }`); return; }
      first.set(id, f);
      const b = doc.store.get(id);
      const rows = [];
      for (let y = 0; y < doc.h; y++) {
        let s = '';
        for (let x = 0; x < doc.w; x++) s += chOf[b[y * doc.w + x]] ?? '.';
        rows.push(`        ${J(s)}`);
      }
      cels.push(`    { "layer": ${J(L.name)}, "frame": ${f}, "rows": [\n${rows.join(',\n')}\n    ] }`);
    });
  });
  out.push('  "cels": [');
  out.push(cels.join(',\n'));
  out.push('  ]');
  out.push('}');
  return out.join('\n') + '\n';
}

export function parse(text, { store, name } = {}) {
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`JSON 문법 오류: ${e.message}`); }
  if (j.format !== FORMAT) throw new Error(`format 이 "${FORMAT}" 가 아님`);
  const w = j.width | 0, h = j.height | 0;
  if (!(w > 0 && h > 0)) throw new Error('width/height 가 잘못됨');
  const palette = (j.palette || []).map(([ch, hex, nm], i) => {
    const c = parseColor(hex);
    if (!c) throw new Error(`팔레트 ${i}번 색 "${hex}" 을 못 읽음`);
    if (!CHARS.includes(ch)) throw new Error(`팔레트 글자 "${ch}" 는 쓸 수 없음`);
    return { ch, c, name: nm || '' };
  });
  if (new Set(palette.map((p) => p.ch)).size !== palette.length) throw new Error('팔레트 글자가 겹침');
  const idx = new Map(palette.map((p, i) => [p.ch, i + 1]));
  idx.set('.', 0);
  if (palette.length > MAX_COLORS) throw new Error(`팔레트는 ${MAX_COLORS}색까지`);
  const frames = (j.frames || [100]).map((ms) => Math.max(1, ms | 0));
  if (!frames.length) throw new Error('frames 가 비어 있음 (프레임은 1개 이상)');
  const st = store || new Store();
  const layers = (j.layers || [{ name: '레이어 1' }]).map((L) => ({
    name: String(L.name), visible: L.visible !== false, opacity: L.opacity == null ? 255 : Math.max(0, Math.min(255, L.opacity | 0)), locked: !!L.locked, cels: frames.map(() => 0),
  }));
  if (!layers.length) throw new Error('layers 가 비어 있음 (레이어는 1개 이상)');
  if (new Set(layers.map((L) => L.name)).size !== layers.length) throw new Error('레이어 이름이 겹침');
  const li = (nm) => { const i = layers.findIndex((L) => L.name === nm); if (i < 0) throw new Error(`cels 의 레이어 "${nm}" 가 layers 에 없음`); return i; };
  const links = [];
  for (const c of j.cels || []) {
    const l = li(c.layer), f = c.frame | 0;
    if (f < 0 || f >= frames.length) throw new Error(`cels 의 프레임 ${f} 가 범위 밖 (0~${frames.length - 1})`);
    if (c.link != null) {
      const src = c.link | 0;
      if (src < 0 || src >= frames.length) throw new Error(`레이어 "${c.layer}" 프레임 ${f}: link ${src} 가 범위 밖`);
      links.push([l, f, src]);
      continue;
    }
    const rows = c.rows || [];
    if (rows.length !== h) throw new Error(`레이어 "${c.layer}" 프레임 ${f}: 줄 수 ${rows.length} ≠ height ${h}`);
    const b = new Uint8Array(w * h);
    rows.forEach((row, y) => {
      const chars = [...row];
      if (chars.length !== w) throw new Error(`레이어 "${c.layer}" 프레임 ${f} ${y}번째 줄: 길이 ${chars.length} ≠ width ${w}`);
      chars.forEach((ch, x) => {
        const v = idx.get(ch);
        if (v == null) throw new Error(`레이어 "${c.layer}" 프레임 ${f} (${x},${y}): 글자 "${ch}" 가 팔레트에 없음`);
        b[y * w + x] = v;
      });
    });
    layers[l].cels[f] = isEmpty(b) ? 0 : st.add(b);
  }
  for (const [l, f, src] of links) layers[l].cels[f] = layers[l].cels[src] || 0;
  const tags = (j.tags || []).map((t, i) => {
    const from = t.from | 0, to = t.to | 0;
    if (from < 0 || to >= frames.length || from > to) throw new Error(`태그 "${t.name}" 범위 ${t.from}-${t.to} 가 잘못됨 (프레임 0~${frames.length - 1})`);
    return { name: String(t.name), from, to, dir: DIRS.includes(t.direction) ? t.direction : 'forward', color: t.color || TAG_COLORS[i % TAG_COLORS.length] };
  });
  const motion = Array.isArray(j.motion) ? frames.map((_, i) => Number(j.motion[i]) || 0) : null;
  const lift = Array.isArray(j.lift) ? frames.map((_, i) => Number(j.lift[i]) || 0) : null;
  if (new Set(tags.map((t) => t.name)).size !== tags.length) throw new Error('태그 이름이 겹침');
  return { name: name || j.name || 'untitled', w, h, pivot: Array.isArray(j.pivot) ? [j.pivot[0] | 0, j.pivot[1] | 0] : null, palette, layers, frames, tags, motion, lift, store: st };
}

// 전송용 구조 (셀 데이터 없이 id 만)
export function structOf(doc) {
  return {
    name: doc.name, w: doc.w, h: doc.h, pivot: doc.pivot,
    palette: doc.palette.map((p) => ({ ch: p.ch, c: p.c, name: p.name })),
    layers: doc.layers.map((L) => ({ name: L.name, visible: L.visible, opacity: L.opacity, locked: L.locked, cels: L.cels })),
    frames: doc.frames, tags: doc.tags, motion: doc.motion || null, lift: doc.lift || null,
  };
}
export const celIds = (doc) => new Set(doc.layers.flatMap((L) => L.cels).filter(Boolean));

// ───────────────────────── 합성 ─────────────────────────
/** 프레임 f 를 RGBA 로. opt: only(레이어 번호), hidden(숨긴 레이어도), override(li,f)→버퍼|undefined, out */
export function composite(doc, f, opt = {}) {
  const { w, h } = doc;
  const out = opt.out || new Uint8ClampedArray(w * h * 4);
  if (opt.out) out.fill(0);
  const pal = doc.palette;
  for (let li = 0; li < doc.layers.length; li++) {
    const L = doc.layers[li];
    if (opt.only != null && opt.only !== li) continue;
    if (!L.visible && !opt.hidden && opt.only == null) continue;
    let buf = opt.override ? opt.override(li, f) : undefined;
    if (buf === undefined) buf = doc.store.get(L.cels[f]);
    if (!buf) continue;
    const lo = L.opacity / 255;
    for (let p = 0; p < buf.length; p++) {
      const v = buf[p];
      if (!v) continue;
      const c = pal[v - 1];
      if (!c) continue;
      const sa = (c.c[3] / 255) * lo;
      if (sa <= 0) continue;
      const o = p * 4;
      if (sa >= 1) { out[o] = c.c[0]; out[o + 1] = c.c[1]; out[o + 2] = c.c[2]; out[o + 3] = 255; continue; }
      const da = out[o + 3] / 255, oa = sa + da * (1 - sa);
      out[o] = (c.c[0] * sa + out[o] * da * (1 - sa)) / oa;
      out[o + 1] = (c.c[1] * sa + out[o + 1] * da * (1 - sa)) / oa;
      out[o + 2] = (c.c[2] * sa + out[o + 2] * da * (1 - sa)) / oa;
      out[o + 3] = oa * 255;
    }
  }
  return out;
}
/** 맨 위에 보이는 픽셀의 팔레트 번호 (글자 지도·스포이트용) */
export function topIndex(doc, f, only) {
  const out = new Uint8Array(doc.w * doc.h);
  doc.layers.forEach((L, li) => {
    if (only != null ? only !== li : !L.visible) return;
    const b = doc.store.get(L.cels[f]);
    if (b) for (let i = 0; i < b.length; i++) if (b[i]) out[i] = b[i];
  });
  return out;
}

// ───────────────────────── 글자 보기 (AI 용) ─────────────────────────
export function asciiRows(doc, f, only) {
  const chOf = ['.', ...doc.palette.map((p) => p.ch)];
  const b = topIndex(doc, f, only);
  const rows = [];
  for (let y = 0; y < doc.h; y++) { let s = ''; for (let x = 0; x < doc.w; x++) s += chOf[b[y * doc.w + x]]; rows.push(s); }
  return rows;
}
function ruler(w) {
  let tens = '', ones = '';
  for (let x = 0; x < w; x++) { tens += x % 10 === 0 ? String(Math.floor(x / 10) % 10) : ' '; ones += x % 10; }
  return [tens, ones];
}
/** 여러 프레임을 나란히: 각 칸 위에 제목, 왼쪽에 줄 번호, 위에 열 번호 */
export function asciiBlock(doc, frames, only, { maxWidth = 170 } = {}) {
  const blocks = frames.map((f) => ({ f, rows: asciiRows(doc, f, only) }));
  const per = doc.w + 2;
  const fit = Math.max(1, Math.floor((maxWidth - 4) / per));
  const lines = [];
  const [tens, ones] = ruler(doc.w);
  for (let i = 0; i < blocks.length; i += fit) {
    const group = blocks.slice(i, i + fit);
    lines.push('    ' + group.map((b) => `f${b.f} ${doc.frames[b.f]}ms`.padEnd(per)).join(''));
    lines.push('    ' + group.map(() => tens.padEnd(per)).join(''));
    lines.push('    ' + group.map(() => ones.padEnd(per)).join(''));
    for (let y = 0; y < doc.h; y++) lines.push(String(y).padStart(3) + ' ' + group.map((b) => b.rows[y].padEnd(per)).join(''));
    lines.push('');
  }
  return lines.join('\n');
}
export function paletteText(doc) {
  return doc.palette.map((p, i) => `  ${p.ch}  ${toHex(p.c).padEnd(9)} ${p.name || ''}`).join('\n');
}
/** f1 → f2 바뀐 곳만 (안 바뀐 곳은 공백) */
export function asciiDiff(doc, f1, f2, only) {
  const a = asciiRows(doc, f1, only), b = asciiRows(doc, f2, only);
  let n = 0;
  const rows = b.map((row, y) => [...row].map((c, x) => (c === a[y][x] ? ' ' : (n++, c))).join(''));
  const [tens, ones] = ruler(doc.w);
  return { count: n, text: [`    ${tens}`, `    ${ones}`, ...rows.map((r, y) => String(y).padStart(3) + ' ' + r + '|')].join('\n') };
}

// ───────────────────────── 그림 만들기 (스냅·내보내기) ─────────────────────────
const DIGITS = { // 3×5 숫자
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111',
  f: '111100110100100', m: '000111111101101', s: '000011010001110', '-': '000000111000000', ' ': '000000000000000',
};
function drawText(img, W, x, y, text, s, col) {
  [...text].forEach((ch, i) => {
    const g = DIGITS[ch] || DIGITS[' '];
    for (let k = 0; k < 15; k++) {
      if (g[k] !== '1') continue;
      const gx = x + (i * 4 + (k % 3)) * s, gy = y + Math.floor(k / 3) * s;
      for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) {
        const o = ((gy + yy) * W + gx + xx) * 4;
        img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2]; img[o + 3] = 255;
      }
    }
  });
}
function blitScaled(dst, DW, src, sw, sh, ox, oy, s) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4, a = src[i + 3];
    if (!a) continue;
    for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) {
      const o = ((oy + y * s + yy) * DW + ox + x * s + xx) * 4;
      if (a === 255) { dst[o] = src[i]; dst[o + 1] = src[i + 1]; dst[o + 2] = src[i + 2]; dst[o + 3] = 255; continue; }
      const sa = a / 255, da = dst[o + 3] / 255, oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) dst[o + k] = (src[i + k] * sa + dst[o + k] * da * (1 - sa)) / oa;
      dst[o + 3] = oa * 255;
    }
  }
}
/** AI 가 이미지로 볼 프레임 줄 그림: 칸마다 번호, 체크 배경(한 칸 = 도트 1개), 기준점 선 */
export function renderStrip(doc, frames, { scale = 8, cols = 8, only, onion = false, guides = true } = {}) {
  const fw = doc.w * scale, fh = doc.h * scale, pad = 6, label = 14;
  cols = Math.min(cols, frames.length);
  const rows = Math.ceil(frames.length / cols);
  const W = pad + cols * (fw + pad), H = pad + rows * (fh + label + pad);
  const img = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < img.length; i += 4) { img[i] = 52; img[i + 1] = 48; img[i + 2] = 60; img[i + 3] = 255; }
  frames.forEach((f, k) => {
    const ox = pad + (k % cols) * (fw + pad), oy = pad + Math.floor(k / cols) * (fh + label + pad) + label;
    drawText(img, W, ox, oy - label + 2, `f${f} ${doc.frames[f]}ms`, 2, [235, 232, 240]);
    for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) {
      const v = (x + y) % 2 ? 236 : 250;
      for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
        const o = ((oy + y * scale + yy) * W + ox + x * scale + xx) * 4;
        img[o] = v; img[o + 1] = v; img[o + 2] = v;
      }
    }
    if (onion && f > 0) {
      const prev = composite(doc, f - 1, { only });
      for (let i = 3; i < prev.length; i += 4) prev[i] = prev[i] ? 70 : 0;
      for (let i = 0; i < prev.length; i += 4) if (prev[i + 3]) { prev[i] = 230; prev[i + 1] = 60; prev[i + 2] = 60; }
      blitScaled(img, W, prev, doc.w, doc.h, ox, oy, scale);
    }
    blitScaled(img, W, composite(doc, f, { only }), doc.w, doc.h, ox, oy, scale);
    if (guides && doc.pivot) {
      const gy = oy + (doc.pivot[1] + 1) * scale - 1;
      for (let x = 0; x < fw; x += 2) { const o = (gy * W + ox + x) * 4; img[o] = 40; img[o + 1] = 170; img[o + 2] = 255; img[o + 3] = 255; }
    }
  });
  return { w: W, h: H, rgba: img };
}

/** 스프라이트 시트: layout 'grid'(최대 가로 maxW 안에서 줄바꿈) | 'row' */
export function buildSheet(doc, { layout = 'grid', cols, scale = 1, maxW = 4096, frames } = {}) {
  const fs = frames || doc.frames.map((_, i) => i);
  const fw = doc.w * scale, fh = doc.h * scale;
  let c = layout === 'row' ? fs.length : (cols || Math.max(1, Math.min(fs.length, Math.floor(maxW / fw))));
  const r = Math.ceil(fs.length / c);
  const W = c * fw, H = r * fh;
  const img = new Uint8ClampedArray(W * H * 4);
  const rects = fs.map((f, k) => {
    const x = (k % c) * fw, y = Math.floor(k / c) * fh;
    blitScaled(img, W, composite(doc, f), doc.w, doc.h, x, y, scale);
    return { f, x, y, w: fw, h: fh };
  });
  return { w: W, h: H, rgba: img, rects, cols: c, rows: r };
}
/** Aseprite JSON (hash) 과 같은 모양 + meta.pivot */
export function asepriteJson(doc, sheet, imageName, scale = 1) {
  const frames = {};
  sheet.rects.forEach((r, k) => {
    frames[`${doc.name} ${k}.png`] = {
      frame: { x: r.x, y: r.y, w: r.w, h: r.h }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: r.w, h: r.h }, sourceSize: { w: r.w, h: r.h }, duration: doc.frames[r.f],
    };
  });
  return {
    frames,
    meta: {
      app: 'gachi-dot-animator', version: '1', image: imageName, format: 'RGBA8888',
      size: { w: sheet.w, h: sheet.h }, scale: String(scale),
      frameTags: doc.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.dir, color: t.color })),
      layers: doc.layers.map((L) => ({ name: L.name, opacity: L.opacity, blendMode: 'normal' })),
      slices: [],
      pivot: doc.pivot ? { x: doc.pivot[0] * scale, y: doc.pivot[1] * scale } : null,
      motion: doc.motion ? sheet.rects.map((r) => doc.motion[r.f] * scale) : null,
      lift: doc.lift ? sheet.rects.map((r) => doc.lift[r.f] * scale) : null,
      grid: { cellWidth: doc.w * scale, cellHeight: doc.h * scale, columns: sheet.cols, rows: sheet.rows },
    },
  };
}

// ───────────────────────── 가져오기 (PNG RGBA → 문서) ─────────────────────────
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
/** 확대된 도트 그림의 배율 찾기 (같은 색이 이어진 길이들의 최대공약수) */
export function detectScale(rgba, W, H) {
  let g = gcd(W, H);
  const same = (i, j) => rgba[i] === rgba[j] && rgba[i + 1] === rgba[j + 1] && rgba[i + 2] === rgba[j + 2] && rgba[i + 3] === rgba[j + 3];
  for (let y = 0; y < H && g > 1; y++) {
    let run = 1;
    for (let x = 1; x <= W; x++) {
      if (x < W && same((y * W + x) * 4, (y * W + x - 1) * 4)) run++;
      else { g = gcd(g, run); run = 1; }
    }
  }
  for (let x = 0; x < W && g > 1; x++) {
    let run = 1;
    for (let y = 1; y <= H; y++) {
      if (y < H && same((y * W + x) * 4, ((y - 1) * W + x) * 4)) run++;
      else { g = gcd(g, run); run = 1; }
    }
  }
  return g;
}
/**
 * opts: name, scale('auto'|숫자), cellW/cellH(줄인 뒤 기준 한 칸 크기, 없으면 한 장=한 프레임),
 *       palette(이 팔레트부터 맞춰 씀), ms
 * → { doc, scale, warnings }
 */
export function importRGBA(rgba, W, H, opts = {}) {
  const warnings = [];
  const s = opts.scale === 'auto' || opts.scale == null ? detectScale(rgba, W, H) : opts.scale | 0;
  const w = Math.floor(W / s), h = Math.floor(H / s);
  const cw = opts.cellW || w, ch = opts.cellH || h;
  const doc = makeDoc({ name: opts.name || 'imported', w: cw, h: ch, palette: opts.palette || [] });
  // 색 모으기
  const counts = new Map();
  const px = (x, y) => { const i = ((y * s) * W + x * s) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = px(x, y);
    if (c[3] < 16) continue;
    const k = toHex(c);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const known = new Map(doc.palette.map((p, i) => [toHex(p.c), i + 1]));
  const fresh = [...counts.entries()].filter(([k]) => !known.has(k)).sort((a, b) => b[1] - a[1]);
  for (const [k] of fresh) {
    if (doc.palette.length >= MAX_COLORS) break;
    known.set(k, addPaletteColor(doc, parseColor(k)));
  }
  if (fresh.some(([k]) => !known.has(k))) warnings.push(`색이 ${MAX_COLORS}개보다 많아 나머지는 가장 가까운 색으로 바꿈`);
  const lookup = (c) => {
    if (c[3] < 16) return 0;
    const k = toHex(c);
    if (known.has(k)) return known.get(k);
    let best = 1, bd = Infinity;
    doc.palette.forEach((p, i) => { const dd = colorDist(p.c, c); if (dd < bd) { bd = dd; best = i + 1; } });
    known.set(k, best);
    return best;
  };
  const cols = Math.max(1, Math.floor(w / cw)), rows = Math.max(1, Math.floor(h / ch));
  const bufs = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const b = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) b[y * cw + x] = lookup(px(c * cw + x, r * ch + y));
    bufs.push(b);
  }
  while (bufs.length > 1 && isEmpty(bufs[bufs.length - 1])) bufs.pop();
  doc.frames = bufs.map(() => opts.ms || 100);
  doc.layers[0].cels = bufs.map((b) => (isEmpty(b) ? 0 : doc.store.add(b)));
  // 기준점: 그림 맨 아래 줄, 가로 가운데
  let bottom = -1;
  for (const b of bufs) for (let y = ch - 1; y > bottom; y--) { let any = false; for (let x = 0; x < cw; x++) if (b[y * cw + x]) { any = true; break; } if (any) { bottom = y; break; } }
  doc.pivot = [Math.floor(cw / 2), bottom >= 0 ? bottom : ch - 1];
  if (s > 1) warnings.push(`${s}배로 키운 그림으로 보고 ${w}×${h} 로 줄임`);
  return { doc, scale: s, warnings };
}

/** 태그 재생 순서 (방향 반영). 프레임 번호 배열 */
export function playOrder(doc, tagName) {
  const t = tagName ? doc.tags.find((x) => x.name === tagName) : null;
  const from = t ? t.from : 0, to = t ? t.to : doc.frames.length - 1;
  const fwd = range(from, to);
  const dir = t ? t.dir : 'forward';
  if (dir === 'reverse') return fwd.reverse();
  if (dir === 'pingpong') return fwd.length > 1 ? fwd.concat(fwd.slice(1, -1).reverse()) : fwd;
  return fwd;
}

/** 재생 중 위치: 프레임 f 를 t(0~1) 만큼 지났을 때 { x: 이 프레임 안에서 간 거리, y: 높이 }.
 *  x 는 프레임 시간에 비례해 이어서, y 는 이번 프레임 높이 → 다음 프레임 높이로 이어서 (부드러운 이동) */
export function motionAt(doc, f, next, t) {
  const dx = (doc.motion?.[f] || 0) * t;
  const y0 = doc.lift?.[f] || 0, y1 = doc.lift?.[next] || 0;
  return { x: dx, y: y0 + (y1 - y0) * t };
}
/** 그림자 레이어('그림자')와 나머지를 따로 합성 — 캐릭터만 뜨고 그림자는 땅에 */
export function compositeSplit(doc, f, opt = {}) {
  const si = doc.layers.findIndex((L) => L.name === '그림자');
  if (si < 0) return { body: composite(doc, f, opt), shadow: null };
  const ov = opt.override;
  const body = composite(doc, f, { ...opt, override: (li, ff) => (li === si ? null : ov ? ov(li, ff) : undefined) });
  const shadow = doc.layers[si].visible ? composite(doc, f, { ...opt, only: si }) : null;
  return { body, shadow };
}
