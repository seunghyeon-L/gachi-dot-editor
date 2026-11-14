// 가치고치 도트 편집기 화면. 문서 원본은 서버에 있고, 여기서는 그리기 결과를 연산(op)으로 보낸다.
// 서버가 적용해 모든 화면(사람·AI)에 다시 보내 주면 그걸 그린다.
import * as core from './core.js';

const $ = (s) => document.querySelector(s);
const CLIENT = Math.random().toString(36).slice(2, 10);
const DPR = () => window.devicePixelRatio || 1;
const store = {
  get(k, d) { try { const v = localStorage.getItem('dotani.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('dotani.' + k, JSON.stringify(v)); } catch { /* 저장 못 해도 됨 */ } },
};

const TOOLS = [
  { id: 'marquee', key: 'M', icon: '⬚', name: '사각 선택' },
  { id: 'move', key: 'V', icon: '✥', name: '이동 (선택 영역, 없으면 레이어 전체)' },
  { id: 'pencil', key: 'B', icon: '✎', name: '연필' },
  { id: 'eraser', key: 'E', icon: '⌫', name: '지우개' },
  { id: 'eyedrop', key: 'I', icon: '⌖', name: '스포이트 (Alt 를 누른 채 클릭해도 됨)' },
  { id: 'bucket', key: 'G', icon: '◧', name: '페인트 통' },
  { id: 'line', key: 'L', icon: '╱', name: '직선 (Shift: 45도 단위)' },
  { id: 'rect', key: 'U', icon: '▭', name: '사각형 (Shift: 정사각형)' },
  { id: 'ellipse', key: 'O', icon: '◯', name: '원 (Shift: 정원)' },
  { id: 'hand', key: 'H', icon: '✋', name: '손 (Space 를 누른 채 끌어도 됨)' },
];
const DRAW_TOOLS = ['pencil', 'eraser', 'bucket', 'line', 'rect', 'ellipse'];
const ZOOMS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64];

const S = {
  name: null, doc: null, store: new core.Store(), version: 0, hist: null,
  frame: 0, layer: 0, tool: 'pencil', fg: 1, bg: 0,
  brush: 1, pixelPerfect: true, symmetry: false, fillContig: true, shapeFill: false, allFrames: false,
  grid: store.get('grid', true), showPivot: store.get('pivot', true),
  onion: store.get('onion', false), onionPrev: 1, onionNext: 1,
  zoom: 12, panX: 0, panY: 0, fitted: false,
  sel: null, fsel: null, fanchor: 0, clip: null,
  live: null, pending: new Map(), seq: 0,
  hover: null, lastPt: null, spaceDown: false, pickPivot: false,
  playing: false, playTimer: null, flash: null,
};
window.dot = { S, core };

// ───────────── 서버 ─────────────
async function api(method, route, body) {
  const r = await fetch(route, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (j && j.ok === false) throw new Error(j.error);
  return j;
}
/** after: 서버가 이 연산을 반영한 문서를 보내 준 뒤 실행 (프레임·레이어 이동 등) */
const afterAck = new Map();
let opChain = Promise.resolve(); // 보낸 순서대로 서버에 도착하게 (붓질 직후 Ctrl+Z 등)
async function sendOp(op, pendingItems = [], after) {
  if (!S.name) return;
  const seq = ++S.seq;
  const name = S.name;
  for (const it of pendingItems) S.pending.set(`${it.li}/${it.f}`, { buf: it.buf, seq });
  if (after) afterAck.set(seq, after);
  schedule('canvas', 'timeline');
  const req = opChain.then(() => api('POST', '/api/op', { name, op, actor: '나', client: CLIENT, seq }));
  opChain = req.catch(() => {});
  try {
    await req;
  } catch (e) {
    toast(e.message, 'err');
    afterAck.delete(seq);
    for (const [k, v] of S.pending) if (v.seq === seq) S.pending.delete(k);
    schedule('canvas', 'timeline');
  }
}
let es = null;
function connect() {
  es?.close();
  es = new EventSource(`/api/events?name=${encodeURIComponent(S.name || '')}&client=${CLIENT}`);
  es.addEventListener('doc', (e) => onDoc(JSON.parse(e.data)));
  es.addEventListener('warn', (e) => toast(JSON.parse(e.data).msg, 'err'));
  es.addEventListener('switch', (e) => { const n = JSON.parse(e.data).name; if (n !== S.name) switchProject(n); });
}
function onDoc(m) {
  for (const [id, b] of Object.entries(m.cels)) S.store.set(+id, core.b64dec(b));
  const prev = S.doc;
  S.doc = { ...m.struct, store: S.store };
  S.version = m.version;
  S.hist = m.hist;
  const d = S.doc;
  if (m.full) S.pending.clear();
  // 팔레트가 바뀌어도(정리·순서·되돌리기) 앞/뒷색은 같은 글자의 색을 가리키게
  if (prev) {
    const re = (i, dflt) => {
      if (!i) return 0;
      const ch = prev.palette[i - 1]?.ch;
      const k = ch == null ? -1 : d.palette.findIndex((p) => p.ch === ch);
      return k >= 0 ? k + 1 : dflt;
    };
    S.fg = re(S.fg, d.palette.length ? 1 : 0);
    S.bg = re(S.bg, 0);
  }
  if (m.by && m.by.client === CLIENT) {
    for (const [k, v] of S.pending) if (v.seq <= m.by.seq) S.pending.delete(k);
    for (const [seq, fn] of afterAck) if (seq <= m.by.seq) { afterAck.delete(seq); fn(); }
  }
  S.frame = Math.max(0, Math.min(S.frame, d.frames.length - 1));
  S.layer = Math.max(0, Math.min(S.layer, d.layers.length - 1));
  if (S.fg > d.palette.length) S.fg = d.palette.length;
  if (S.bg > d.palette.length) S.bg = 0;
  if (S.fsel) S.fsel = S.fsel.map((f) => Math.min(f, d.frames.length - 1));
  if (S.sel) S.sel = clipSel(S.sel);
  if (!S.fitted) { S.layer = d.layers.length - 1; fit(); S.fitted = true; }
  else if (prev && (prev.w !== d.w || prev.h !== d.h)) { S.sel = null; fit(); }
  if (prev && !m.full && m.actor && m.actor !== '나' && m.label) {
    flashDiff(prev);
    toast(`${m.actor || 'AI'}: ${m.label}`, 'claude');
  }
  $('#saveState').textContent = `저장됨 · v${S.version}`;
  refreshPreviewTags();
  schedule('all');
  postFocus();
}

// ───────────── 셀 ─────────────
const cf = () => Math.min(S.frame, (S.doc?.frames.length || 1) - 1);
function override(li, f) {
  if (S.live && S.live.li === li && S.live.f === f) return S.live.buf;
  const p = S.pending.get(`${li}/${f}`);
  return p ? p.buf : undefined;
}
function celBuf(li, f) { const o = override(li, f); return o !== undefined ? o : S.doc.store.get(S.doc.layers[li]?.cels[f] || 0); }
function celCopy(li = S.layer, f = cf()) { const b = celBuf(li, f); return b ? b.slice() : new Uint8Array(S.doc.w * S.doc.h); }
function editable() {
  if (!S.doc) return false;
  const L = S.doc.layers[S.layer];
  if (!L) return false;
  if (L.locked) { toast(`레이어 "${L.name}" 가 잠겨 있음`, 'err'); return false; }
  if (!L.visible) { toast(`레이어 "${L.name}" 가 숨겨져 있음`, 'err'); return false; }
  return true;
}
const selFrames = () => { if (!S.fsel) return [cf()]; const [a, b] = [Math.min(...S.fsel), Math.max(...S.fsel)]; const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
const frameSpec = (fs) => (fs.length === 1 ? fs[0] : `${fs[0]}-${fs[fs.length - 1]}`);

// ───────────── 그리기 예약 ─────────────
const dirty = new Set();
let raf = 0, rafTimer = 0;
function schedule(...parts) {
  parts.forEach((p) => dirty.add(p));
  if (raf) return;
  raf = requestAnimationFrame(flush);
  // 창이 숨겨져 있으면 requestAnimationFrame 이 멈춤 → 타이머로 대신 그림
  rafTimer = setTimeout(() => { if (raf) flush(); }, 120);
}
function flush() {
  raf = 0;
  clearTimeout(rafTimer);
  const parts = new Set(dirty); // 목록을 비우기 전에 복사 (비운 뒤 확인하면 아무것도 안 그려짐)
  dirty.clear();
  const all = parts.has('all');
  const has = (p) => all || parts.has(p);
  if (has('tools')) renderTools();
  if (has('ctx')) renderCtx();
  if (has('palette')) renderPalette();
  if (has('timeline')) renderTimeline();
  if (has('history')) renderHistory();
  if (has('canvas')) renderCanvas();
  renderStatus();
}
window.dot.dbg = { schedule, flush, get raf() { return raf; }, get dirty() { return [...dirty]; } };

// ───────────── 캔버스 ─────────────
const cv = $('#cv');
const ctx = cv.getContext('2d');
const off = document.createElement('canvas');
const offc = off.getContext('2d');
function sizeCanvas() {
  const r = cv.getBoundingClientRect(), d = DPR();
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
}
function drawFrame(f, alpha = 1, tint = null) {
  const doc = S.doc;
  if (off.width !== doc.w || off.height !== doc.h) { off.width = doc.w; off.height = doc.h; }
  const data = core.composite(doc, f, { override });
  if (tint) for (let i = 0; i < data.length; i += 4) if (data[i + 3]) { data[i] = (data[i] + tint[0]) / 2; data[i + 1] = (data[i + 1] + tint[1]) / 2; data[i + 2] = (data[i + 2] + tint[2]) / 2; }
  offc.putImageData(new ImageData(data, doc.w, doc.h), 0, 0);
  ctx.globalAlpha = alpha;
  ctx.drawImage(off, S.panX, S.panY, doc.w * S.zoom, doc.h * S.zoom);
  ctx.globalAlpha = 1;
}
function renderCanvas() {
  sizeCanvas();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#17151c';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!S.doc) return;
  const { w, h } = S.doc, z = S.zoom, X = S.panX, Y = S.panY, f = cf();
  // 체크 배경 (도트 2칸 단위)
  const cs = Math.max(4, z * (Math.max(w, h) > 64 ? 4 : 2));
  for (let y = 0; y < h * z; y += cs) for (let x = 0; x < w * z; x += cs) {
    ctx.fillStyle = ((x / cs + y / cs) & 1) ? '#cfcfd4' : '#ececf0';
    ctx.fillRect(X + x, Y + y, Math.min(cs, w * z - x), Math.min(cs, h * z - y));
  }
  if (S.onion && !S.playing) {
    for (let k = S.onionPrev; k >= 1; k--) if (f - k >= 0) drawFrame(f - k, 0.32 / k, [255, 60, 60]);
    for (let k = S.onionNext; k >= 1; k--) if (f + k < S.doc.frames.length) drawFrame(f + k, 0.32 / k, [60, 120, 255]);
  }
  drawFrame(f);
  // 격자
  if (S.grid && z >= 6) {
    ctx.beginPath();
    for (let x = 1; x < w; x++) { ctx.moveTo(X + x * z + 0.5, Y); ctx.lineTo(X + x * z + 0.5, Y + h * z); }
    for (let y = 1; y < h; y++) { ctx.moveTo(X, Y + y * z + 0.5); ctx.lineTo(X + w * z, Y + y * z + 0.5); }
    ctx.strokeStyle = 'rgba(40,30,60,0.13)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (w > 16 || h > 16) {
      ctx.beginPath();
      for (let x = 8; x < w; x += 8) { ctx.moveTo(X + x * z + 0.5, Y); ctx.lineTo(X + x * z + 0.5, Y + h * z); }
      for (let y = 8; y < h; y += 8) { ctx.moveTo(X, Y + y * z + 0.5); ctx.lineTo(X + w * z, Y + y * z + 0.5); }
      ctx.strokeStyle = 'rgba(40,30,60,0.28)';
      ctx.stroke();
    }
  }
  ctx.strokeStyle = '#000';
  ctx.strokeRect(X - 0.5, Y - 0.5, w * z + 1, h * z + 1);
  // 기준점 (발바닥 줄)
  if (S.showPivot && S.doc.pivot) {
    const [px, py] = S.doc.pivot;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#2aa8ff';
    ctx.lineWidth = Math.max(1, DPR());
    ctx.beginPath();
    ctx.moveTo(X - 12, Y + (py + 1) * z); ctx.lineTo(X + w * z + 12, Y + (py + 1) * z);
    ctx.moveTo(X + px * z + z / 2, Y + (py + 1) * z - 8); ctx.lineTo(X + px * z + z / 2, Y + (py + 1) * z + 8);
    ctx.stroke();
    ctx.restore();
  }
  if (S.symmetry) {
    ctx.save();
    ctx.strokeStyle = '#d65cb5';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X + (w * z) / 2, Y); ctx.lineTo(X + (w * z) / 2, Y + h * z); ctx.stroke();
    ctx.restore();
  }
  // 선택 영역
  const sel = S.selView || S.sel;
  if (sel) {
    ctx.save();
    ctx.lineWidth = 1;
    const r = [X + sel.x * z + 0.5, Y + sel.y * z + 0.5, sel.w * z - 1, sel.h * z - 1];
    ctx.strokeStyle = '#000'; ctx.setLineDash([]); ctx.strokeRect(...r);
    ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 4]); ctx.strokeRect(...r);
    ctx.restore();
  }
  // AI 가 바꾼 곳 깜빡임
  if (S.flash) {
    const t = (performance.now() - S.flash.t0) / 1800;
    if (t >= 1) S.flash = null;
    else {
      ctx.fillStyle = `rgba(255, 214, 0, ${0.75 * (1 - t)})`;
      const m = S.flash.mask;
      for (let i = 0; i < m.length; i++) if (m[i]) ctx.fillRect(X + (i % w) * z, Y + Math.floor(i / w) * z, z, z);
      ctx.strokeStyle = `rgba(255, 140, 0, ${1 - t})`;
      ctx.lineWidth = 2;
      const b = S.flash.box;
      ctx.strokeRect(X + b[0] * z - 3, Y + b[1] * z - 3, (b[2] - b[0] + 1) * z + 6, (b[3] - b[1] + 1) * z + 6);
      schedule('canvas');
    }
  }
  // 붓 위치
  if (S.hover && (DRAW_TOOLS.includes(S.tool) || S.pickPivot) && !S.spaceDown) {
    const [hx, hy] = S.hover;
    const size = S.pickPivot || S.tool === 'bucket' ? 1 : S.brush;
    const o = Math.floor((size - 1) / 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000';
    ctx.strokeRect(X + (hx - o) * z - 0.5, Y + (hy - o) * z - 0.5, size * z + 1, size * z + 1);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(X + (hx - o) * z + 0.5, Y + (hy - o) * z + 0.5, size * z - 1, size * z - 1);
  }
}
function flashDiff(prev) {
  if (!prev || prev.w !== S.doc.w || prev.h !== S.doc.h) return;
  const f = cf();
  if (f >= prev.frames.length) return;
  const a = core.composite(prev, f), b = core.composite(S.doc, f);
  const mask = new Uint8Array(S.doc.w * S.doc.h);
  let n = 0;
  const box = [1e9, 1e9, -1, -1];
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    if (a[o] !== b[o] || a[o + 1] !== b[o + 1] || a[o + 2] !== b[o + 2] || a[o + 3] !== b[o + 3]) {
      mask[i] = 1; n++;
      const x = i % S.doc.w, y = Math.floor(i / S.doc.w);
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
  }
  if (n) S.flash = { mask, box, t0: performance.now() };
}
function fit() {
  if (!S.doc) return;
  sizeCanvas();
  const z = Math.max(1, Math.floor(Math.min((cv.width * 0.86) / S.doc.w, (cv.height * 0.86) / S.doc.h)));
  S.zoom = z;
  S.panX = Math.round((cv.width - S.doc.w * z) / 2);
  S.panY = Math.round((cv.height - S.doc.h * z) / 2);
  schedule('canvas');
}
function zoomAt(dir, px, py) {
  let i = ZOOMS.findIndex((z) => z >= S.zoom);
  if (i < 0) i = ZOOMS.length - 1;
  if (ZOOMS[i] !== S.zoom && dir < 0) i++;
  const nz = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
  if (px == null) { px = cv.width / 2; py = cv.height / 2; }
  S.panX = Math.round(px - ((px - S.panX) * nz) / S.zoom);
  S.panY = Math.round(py - ((py - S.panY) * nz) / S.zoom);
  S.zoom = nz;
  schedule('canvas');
}

// ───────────── 캔버스 조작 ─────────────
function artPt(e) {
  const r = cv.getBoundingClientRect(), d = DPR();
  const x = (e.clientX - r.left) * d, y = (e.clientY - r.top) * d;
  return [Math.floor((x - S.panX) / S.zoom), Math.floor((y - S.panY) / S.zoom), x, y];
}
const inDoc = (x, y) => S.doc && x >= 0 && y >= 0 && x < S.doc.w && y < S.doc.h;
function plotSym(buf, x, y, v, size) {
  const { w, h } = S.doc;
  core.plot(buf, w, h, x, y, v, size);
  if (S.symmetry) core.plot(buf, w, h, w - 1 - x, y, v, size);
}
function paintPath(dr) {
  const buf = dr.base.slice();
  const pts = S.pixelPerfect && S.brush === 1 && dr.tool === 'pencil' ? core.pixelPerfect(dr.path) : dr.path;
  for (const [x, y] of pts) plotSym(buf, x, y, dr.v, S.brush);
  S.live = { li: S.layer, f: cf(), buf };
  schedule('canvas');
}
function shapeUpdate(dr, x, y, shift) {
  let { x0, y0 } = dr;
  if (shift) {
    const dx = x - x0, dy = y - y0;
    if (dr.tool === 'line') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.max(Math.abs(dx), Math.abs(dy));
      x = x0 + Math.round(Math.cos(ang) * len); y = y0 + Math.round(Math.sin(ang) * len);
    } else { const m = Math.max(Math.abs(dx), Math.abs(dy)); x = x0 + Math.sign(dx || 1) * m; y = y0 + Math.sign(dy || 1) * m; }
  }
  const pts = dr.tool === 'line' ? core.linePts(x0, y0, x, y) : dr.tool === 'rect' ? core.rectPts(x0, y0, x, y, S.shapeFill) : core.ellipsePts(x0, y0, x, y, S.shapeFill);
  const buf = dr.base.slice();
  for (const [px, py] of pts) plotSym(buf, px, py, dr.v, dr.tool === 'line' ? S.brush : 1);
  S.live = { li: S.layer, f: cf(), buf };
  schedule('canvas');
}
function commitLive(label, base) {
  const live = S.live;
  S.live = null;
  if (!live) return;
  const px = [];
  for (let i = 0; i < base.length; i++) if (base[i] !== live.buf[i]) px.push(i % S.doc.w, Math.floor(i / S.doc.w), live.buf[i]);
  if (!px.length) { schedule('canvas'); return; }
  sendOp({ type: 'paint', label, items: [{ layer: live.li, frame: live.f, px }] }, [live]);
}
function pick(x, y, right) {
  if (!inDoc(x, y)) return;
  const v = core.topIndex(S.doc, cf())[y * S.doc.w + x];
  if (right) S.bg = v; else S.fg = v;
  schedule('palette', 'ctx');
}

let drag = null;
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  if (!S.doc) return;
  hideMenu();
  cv.setPointerCapture(e.pointerId);
  const [x, y, dx, dy] = artPt(e);
  if (e.button === 1 || S.spaceDown || S.tool === 'hand') { drag = { kind: 'pan', sx: dx, sy: dy, px: S.panX, py: S.panY }; return; }
  if (S.playing) stopPlay();
  if (S.pickPivot) {
    S.pickPivot = false;
    if (inDoc(x, y)) sendOp({ type: 'pivot', x, y });
    schedule('canvas', 'ctx');
    return;
  }
  const right = e.button === 2;
  let tool = S.tool;
  if (e.altKey && tool !== 'marquee' && tool !== 'move') tool = 'eyedrop';
  if (tool === 'eyedrop') { pick(x, y, right); drag = { kind: 'pick', right }; return; }
  if (tool === 'marquee') { drag = { kind: 'marquee', x0: x, y0: y, moved: false }; return; }
  if (tool === 'move') {
    if (!editable()) return;
    drag = { kind: 'move', x0: x, y0: y, base: celCopy(), dx: 0, dy: 0, sel: S.sel ? { ...S.sel } : null };
    return;
  }
  if (!editable()) return;
  const v = tool === 'eraser' ? 0 : right ? S.bg : S.fg;
  const base = celCopy();
  if (tool === 'bucket') {
    if (!inDoc(x, y)) return;
    const buf = base.slice();
    core.floodFill(buf, S.doc.w, S.doc.h, x, y, v, S.fillContig);
    S.live = { li: S.layer, f: cf(), buf };
    commitLive('채우기', base);
    return;
  }
  if (tool === 'pencil' || tool === 'eraser') {
    const path = e.shiftKey && S.lastPt ? core.linePts(S.lastPt[0], S.lastPt[1], x, y) : [[x, y]];
    drag = { kind: 'paint', base, v, path, tool };
    paintPath(drag);
    return;
  }
  drag = { kind: 'shape', base, v, x0: x, y0: y, tool };
  shapeUpdate(drag, x, y, e.shiftKey);
});
cv.addEventListener('pointermove', (e) => {
  if (!S.doc) return;
  const [x, y, dx, dy] = artPt(e);
  const prevHover = S.hover;
  S.hover = inDoc(x, y) ? [x, y] : null;
  if (!drag) {
    if (String(prevHover) !== String(S.hover)) schedule('canvas');
    return;
  }
  if (drag.kind === 'pan') { S.panX = drag.px + dx - drag.sx; S.panY = drag.py + dy - drag.sy; schedule('canvas'); return; }
  if (drag.kind === 'pick') { pick(x, y, drag.right); return; }
  if (drag.kind === 'paint') {
    const last = drag.path[drag.path.length - 1];
    if (last[0] === x && last[1] === y) return;
    drag.path.push(...core.linePts(last[0], last[1], x, y).slice(1));
    paintPath(drag);
    return;
  }
  if (drag.kind === 'shape') { shapeUpdate(drag, x, y, e.shiftKey); return; }
  if (drag.kind === 'marquee') {
    const { w, h } = S.doc;
    const ax = Math.max(0, Math.min(drag.x0, x)), ay = Math.max(0, Math.min(drag.y0, y));
    const bx = Math.min(w - 1, Math.max(drag.x0, x)), by = Math.min(h - 1, Math.max(drag.y0, y));
    if (x !== drag.x0 || y !== drag.y0) drag.moved = true;
    if (drag.moved && bx >= ax && by >= ay) S.sel = { x: ax, y: ay, w: bx - ax + 1, h: by - ay + 1 };
    schedule('canvas');
    return;
  }
  if (drag.kind === 'move') {
    const ddx = x - drag.x0, ddy = y - drag.y0;
    if (ddx === drag.dx && ddy === drag.dy) return;
    drag.dx = ddx; drag.dy = ddy;
    S.live = { li: S.layer, f: cf(), buf: core.shiftBuf(drag.base, S.doc.w, S.doc.h, ddx, ddy, { region: drag.sel || undefined }) };
    S.selView = drag.sel ? { ...drag.sel, x: drag.sel.x + ddx, y: drag.sel.y + ddy } : null;
    schedule('canvas');
  }
});
function endDrag(e) {
  if (!drag) return;
  const dr = drag;
  drag = null;
  if (dr.kind === 'paint') {
    S.lastPt = dr.path[dr.path.length - 1];
    commitLive(dr.tool === 'eraser' ? '지우개' : '연필', dr.base);
  } else if (dr.kind === 'shape') {
    commitLive({ line: '직선', rect: '사각형', ellipse: '원' }[dr.tool], dr.base);
  } else if (dr.kind === 'marquee') {
    if (!dr.moved) S.sel = null;
    postFocus();
    schedule('canvas', 'ctx');
  } else if (dr.kind === 'move') {
    S.selView = null;
    if (dr.dx || dr.dy) {
      const live = S.live;
      S.live = null;
      sendOp({ type: 'shift', layer: S.layer, frames: S.allFrames ? 'all' : cf(), dx: dr.dx, dy: dr.dy, region: dr.sel || undefined }, live ? [live] : []);
      if (dr.sel) S.sel = clipSel({ ...dr.sel, x: dr.sel.x + dr.dx, y: dr.sel.y + dr.dy });
      postFocus();
    } else S.live = null;
    schedule('canvas');
  }
}
cv.addEventListener('pointerup', endDrag);
cv.addEventListener('pointercancel', endDrag);
cv.addEventListener('pointerleave', () => { if (S.hover) { S.hover = null; schedule('canvas'); } });
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [, , dx, dy] = artPt(e);
  if (e.ctrlKey || !e.shiftKey) zoomAt(e.deltaY < 0 ? 1 : -1, dx, dy);
  else { S.panX -= e.deltaY; schedule('canvas'); }
}, { passive: false });
function clipSel(s) {
  const { w, h } = S.doc;
  const x0 = Math.max(0, s.x), y0 = Math.max(0, s.y), x1 = Math.min(w, s.x + s.w), y1 = Math.min(h, s.y + s.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// ───────────── 선택·복사 ─────────────
function copySel(cut) {
  const { w } = S.doc;
  const r = S.sel || { x: 0, y: 0, w: S.doc.w, h: S.doc.h };
  const src = celCopy();
  const data = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) data[y * r.w + x] = src[(r.y + y) * w + r.x + x];
  S.clip = { w: r.w, h: r.h, data, x: r.x, y: r.y };
  if (cut && editable()) sendOp({ type: 'clear', layer: S.layer, frames: cf(), region: r });
  toast(cut ? '잘라냄' : `복사함 ${r.w}×${r.h}`);
}
function paste() {
  if (!S.clip || !editable()) return;
  const c = S.clip;
  const x0 = S.sel ? S.sel.x : c.x, y0 = S.sel ? S.sel.y : c.y;
  const px = [];
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const v = c.data[y * c.w + x]; if (v) px.push(x0 + x, y0 + y, v); }
  const buf = celCopy();
  for (let i = 0; i < px.length; i += 3) if (inDoc(px[i], px[i + 1])) buf[px[i + 1] * S.doc.w + px[i]] = px[i + 2];
  sendOp({ type: 'paint', label: '붙여넣기', items: [{ layer: S.layer, frame: cf(), px }] }, [{ li: S.layer, f: cf(), buf }]);
  S.sel = clipSel({ x: x0, y: y0, w: c.w, h: c.h });
  setTool('move');
}
function regionOp(type, extra) {
  if (!editable()) return;
  sendOp({ type, layer: S.layer, frames: S.allFrames ? 'all' : cf(), region: S.sel || undefined, ...extra });
}

// ───────────── 프레임·재생 ─────────────
function setFrame(f, keepSel) {
  if (!S.doc) return;
  S.frame = Math.max(0, Math.min(S.doc.frames.length - 1, f));
  if (!keepSel) { S.fsel = null; S.fanchor = S.frame; }
  schedule('canvas', 'timeline');
  postFocus();
}
function playRange() {
  const d = S.doc;
  if (S.fsel && S.fsel[0] !== S.fsel[1]) {
    const fs = selFrames();
    return fs;
  }
  const t = d.tags.find((x) => cf() >= x.from && cf() <= x.to);
  return core.playOrder(d, t?.name);
}
function startPlay() {
  if (!S.doc || S.playing) return;
  S.playing = true;
  const order = playRange();
  let i = Math.max(0, order.indexOf(cf()));
  const step = () => {
    if (!S.playing || !S.doc) return;
    S.frame = order[i % order.length];
    schedule('canvas', 'timeline');
    S.playTimer = setTimeout(() => { i++; step(); }, S.doc.frames[S.frame] || 100);
  };
  step();
  schedule('timeline');
}
function stopPlay() { S.playing = false; clearTimeout(S.playTimer); postFocus(); schedule('canvas', 'timeline'); }
const togglePlay = () => (S.playing ? stopPlay() : startPlay());

function newFrame(kind) { // copy | link | empty
  const f = cf();
  S.fsel = null;
  sendOp({ type: 'addFrame', at: f + 1, from: kind === 'empty' ? null : f, link: kind === 'link' }, [], () => setFrame(f + 1));
}
function delFrames() {
  const fs = selFrames();
  if (fs.length >= S.doc.frames.length) { toast('프레임을 모두 지울 수는 없음', 'err'); return; }
  S.fsel = null;
  sendOp({ type: 'delFrames', frames: fs }, [], () => setFrame(Math.max(0, fs[0] - 1)));
}
function moveFrames(dir) {
  const fs = selFrames();
  const to = dir < 0 ? fs[0] - 1 : fs[fs.length - 1] + 2;
  if (to < 0 || to > S.doc.frames.length) return;
  const had = S.fsel;
  sendOp({ type: 'moveFrames', frames: fs, to }, [], () => {
    S.frame = cf() + dir;
    S.fsel = had ? had.map((f) => f + dir) : null;
    schedule('timeline', 'canvas');
    postFocus();
  });
}
async function setDuration(fs, ms) { if (ms > 0) await sendOp({ type: 'duration', frames: fs, ms }); }

// ───────────── 타임라인 ─────────────
const tlGrid = $('#tlGrid');
function renderTimeline() {
  const d = S.doc;
  renderTlBar();
  if (!d) { tlGrid.innerHTML = ''; return; }
  const N = d.frames.length, Ln = d.layers.length;
  const cell = 'var(--cell)';
  tlGrid.style.gridTemplateColumns = `200px repeat(${N}, ${cell})`;
  tlGrid.style.gridTemplateRows = `18px 32px repeat(${Ln}, 26px)`;
  const f0 = cf();
  const sel = new Set(selFrames());
  const h = [];
  h.push(`<div class="tlh top" style="grid-row:1/3;grid-column:1"><span class="dim small">레이어 \\ 프레임</span></div>`);
  h.push(`<div class="tagrow" style="grid-row:1;grid-column:2/span ${N}">`);
  const arrows = { forward: '→', reverse: '←', pingpong: '↔' };
  for (const t of d.tags) {
    h.push(`<div class="tag" data-k="tag" data-t="${esc(t.name)}" title="${esc(t.name)} ${t.from}-${t.to} ${t.dir} (더블클릭 고치기)" style="left:calc(${t.from} * var(--cell) + 1px);width:calc(${t.to - t.from + 1} * var(--cell) - 3px);background:${t.color}">${arrows[t.dir]} ${esc(t.name)}</div>`);
  }
  h.push('</div>');
  for (let f = 0; f < N; f++) {
    h.push(`<div class="fh${f === f0 ? ' cur' : ''}${sel.has(f) && S.fsel ? ' insel' : ''}" data-k="fh" data-f="${f}" style="grid-row:2;grid-column:${f + 2}" title="프레임 ${f} · ${d.frames[f]}ms${d.motion ? ` · 이동 ${d.motion[f]}px` : ''} (더블클릭: 시간)">${f}<br><span class="ms">${d.frames[f]}</span></div>`);
  }
  for (let r = 0; r < Ln; r++) {
    const li = Ln - 1 - r, L = d.layers[li], row = r + 3;
    const cls = `lrow${li === S.layer ? ' cur' : ''}${L.visible ? '' : ' hidden'}`;
    h.push(`<div class="tlh ${cls}" style="grid-row:${row};grid-column:1" data-k="lh" data-l="${li}">
      <span class="ico${L.visible ? '' : ' off'}" data-k="eye" data-l="${li}" title="보이기/숨기기">👁</span>
      <span class="ico${L.locked ? '' : ' off'}" data-k="lock" data-l="${li}" title="잠그기">🔒</span>
      <span class="lname" data-k="lname" data-l="${li}" title="${esc(L.name)}${L.opacity < 255 ? ` · 불투명도 ${L.opacity}` : ''} (더블클릭: 이름)">${esc(L.name)}${L.opacity < 255 ? ` <span class="dim small">${Math.round((L.opacity / 255) * 100)}%</span>` : ''}</span></div>`);
    for (let f = 0; f < N; f++) {
      const pend = S.pending.has(`${li}/${f}`);
      const id = L.cels[f];
      const full = pend ? !core.isEmpty(S.pending.get(`${li}/${f}`).buf) : !!id;
      const link = id && f > 0 && L.cels[f - 1] === id;
      const c = `cel${f === f0 ? ' curf' : ''}${sel.has(f) && S.fsel ? ' insel' : ''}${f === f0 && li === S.layer ? ' cur' : ''}${link ? ' link' : ''}${li === S.layer ? ' lcur' : ''}${L.visible ? '' : ' hidden'}`;
      h.push(`<div class="${c}" data-k="cel" data-l="${li}" data-f="${f}" style="grid-row:${row};grid-column:${f + 2}"><span class="dot${full ? ' full' : ''}"></span></div>`);
    }
  }
  tlGrid.innerHTML = h.join('');
  const cur = tlGrid.querySelector('.fh.cur');
  if (cur && S.playing) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 타임라인 막대: 한 번만 만들고 값만 바꾼다 (입력 중인 칸이 지워지지 않게)
let tlBarBuilt = false;
function renderTlBar() {
  const bar = $('#tlBar');
  if (!tlBarBuilt) {
    bar.innerHTML = `
    <button data-tl="first" title="처음 (Home)">⏮</button>
    <button data-tl="prev" title="이전 프레임 (,)">◀</button>
    <button data-tl="play" id="tlPlay" title="재생/멈춤 (Enter)">▶</button>
    <button data-tl="next" title="다음 프레임 (.)">▶|</button>
    <button data-tl="last" title="끝 (End)">⏭</button>
    <span class="sep"></span>
    <button data-tl="newf" title="현재 프레임 복제 (Alt+N)">+ 프레임</button>
    <button data-tl="linkf" title="링크 프레임: 같은 그림을 공유 (Alt+L)">+ 링크</button>
    <button data-tl="emptyf" title="빈 프레임 (Alt+B)">+ 빈</button>
    <button data-tl="delf" title="선택한 프레임 지우기 (Alt+C)">삭제</button>
    <span class="sep"></span>
    <label title="선택한 프레임의 시간 (Enter 로 적용)">시간 <input type="number" id="msIn" min="1" step="10"> ms</label>
    <button data-tl="tag" title="선택한 프레임으로 태그 만들기 (F2)">태그</button>
    <span class="sep"></span>
    <label title="앞뒤 프레임 겹쳐 보기 (F3)"><input type="checkbox" id="onionCb" data-tl="onion"> 어니언</label>
    <label class="small dim">앞 <input type="number" id="onPrev" min="0" max="5" style="width:40px"></label>
    <label class="small dim">뒤 <input type="number" id="onNext" min="0" max="5" style="width:40px"></label>
    <span class="sep"></span>
    <button data-tl="addl" title="새 레이어 (Ctrl+Shift+N)">+ 레이어</button>
    <span class="grow"></span>
    <span class="dim small" id="tlInfo"></span>`;
    tlBarBuilt = true;
  }
  const d = S.doc;
  const fs = d ? selFrames() : [0];
  const setVal = (el, v) => { if (document.activeElement !== el && el.value !== String(v)) el.value = v; };
  const play = $('#tlPlay');
  play.classList.toggle('on', S.playing);
  play.textContent = S.playing ? '❚❚' : '▶';
  setVal($('#msIn'), d ? d.frames[fs[0]] : '');
  $('#onionCb').checked = S.onion;
  setVal($('#onPrev'), S.onionPrev);
  setVal($('#onNext'), S.onionNext);
  $('#tlInfo').textContent = d ? `프레임 ${fs.length > 1 ? `${fs[0]}-${fs[fs.length - 1]} 선택` : cf()} · 한 바퀴 ${d.frames.reduce((a, b) => a + b, 0)}ms` : '';
}
$('#tlBar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tl]');
  if (!b || !S.doc) return;
  const k = b.dataset.tl;
  if (k === 'first') setFrame(0);
  else if (k === 'prev') setFrame(cf() - 1 < 0 ? S.doc.frames.length - 1 : cf() - 1);
  else if (k === 'next') setFrame((cf() + 1) % S.doc.frames.length);
  else if (k === 'last') setFrame(S.doc.frames.length - 1);
  else if (k === 'play') togglePlay();
  else if (k === 'newf') newFrame('copy');
  else if (k === 'linkf') newFrame('link');
  else if (k === 'emptyf') newFrame('empty');
  else if (k === 'delf') delFrames();
  else if (k === 'tag') makeTag();
  else if (k === 'addl') addLayer();
  else if (k === 'onion') { S.onion = b.checked; store.set('onion', S.onion); schedule('canvas'); }
});
$('#tlBar').addEventListener('change', (e) => {
  if (e.target.id === 'msIn') setDuration(selFrames(), +e.target.value);
  if (e.target.id === 'onPrev') { S.onionPrev = Math.max(0, Math.min(5, +e.target.value)); schedule('canvas'); }
  if (e.target.id === 'onNext') { S.onionNext = Math.max(0, Math.min(5, +e.target.value)); schedule('canvas'); }
});

let tlDrag = null;
tlGrid.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('[data-k]');
  if (!t || !S.doc || e.button !== 0) return;
  const k = t.dataset.k, li = +t.dataset.l, f = +t.dataset.f;
  if (S.playing) stopPlay();
  if (k === 'eye') { sendOp({ type: 'layer', layer: li, visible: !S.doc.layers[li].visible }); return; }
  if (k === 'lock') { sendOp({ type: 'layer', layer: li, locked: !S.doc.layers[li].locked }); return; }
  if (k === 'lname' || k === 'lh') { S.layer = li; schedule('timeline', 'canvas'); postFocus(); return; }
  if (k === 'tag') {
    const tg = S.doc.tags.find((x) => x.name === t.dataset.t);
    if (tg) { S.fsel = [tg.from, tg.to]; S.frame = tg.from; $('#pvTag').value = tg.name; pvRestart(); schedule('timeline', 'canvas'); postFocus(); }
    return;
  }
  if (k === 'fh' || k === 'cel') {
    if (k === 'cel') S.layer = li;
    if (e.shiftKey) { S.fsel = [S.fanchor, f]; S.frame = f; }
    else { S.fanchor = f; S.fsel = [f, f]; S.frame = f; }
    tlDrag = { k };
    schedule('timeline', 'canvas');
    postFocus();
  }
});
tlGrid.addEventListener('pointerover', (e) => {
  if (!tlDrag || !(e.buttons & 1)) { tlDrag = null; return; }
  const t = e.target.closest('[data-f]');
  if (!t) return;
  const f = +t.dataset.f;
  if (S.fsel && S.fsel[1] !== f) { S.fsel = [S.fanchor, f]; S.frame = f; schedule('timeline', 'canvas'); }
});
window.addEventListener('pointerup', () => { if (tlDrag) { tlDrag = null; if (S.fsel && S.fsel[0] === S.fsel[1]) S.fsel = null; schedule('timeline'); postFocus(); } });
tlGrid.addEventListener('dblclick', async (e) => {
  const t = e.target.closest('[data-k]');
  if (!t || !S.doc) return;
  const k = t.dataset.k;
  if (k === 'fh') {
    const fs = selFrames();
    const v = await modal({ title: `프레임 ${frameSpec(fs)} 시간`, fields: [{ k: 'ms', label: '시간 (ms)', type: 'number', value: S.doc.frames[+t.dataset.f], min: 1 }] });
    if (v) setDuration(fs, +v.ms);
  } else if (k === 'lname') renameLayer(+t.dataset.l);
  else if (k === 'tag') editTag(t.dataset.t);
});
tlGrid.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const t = e.target.closest('[data-k]');
  if (!t || !S.doc) return;
  const k = t.dataset.k;
  if (k === 'fh' || k === 'cel') {
    const f = +t.dataset.f;
    if (!selFrames().includes(f)) { S.frame = f; S.fsel = null; }
    if (k === 'cel') S.layer = +t.dataset.l;
    schedule('timeline', 'canvas');
    const fs = selFrames(), li = S.layer, L = S.doc.layers[li];
    const linked = L.cels[f] && L.cels.filter((x) => x === L.cels[f]).length > 1;
    const items = [
      { label: '새 프레임 (복제)', key: 'Alt+N', act: () => newFrame('copy') },
      { label: '링크 프레임', key: 'Alt+L', act: () => newFrame('link') },
      { label: '빈 프레임', key: 'Alt+B', act: () => newFrame('empty') },
      { label: `프레임 지우기 (${frameSpec(fs)})`, key: 'Alt+C', act: delFrames },
      '-',
      { label: '시간 바꾸기…', act: async () => { const v = await modal({ title: `프레임 ${frameSpec(fs)} 시간`, fields: [{ k: 'ms', label: '시간 (ms)', type: 'number', value: S.doc.frames[fs[0]], min: 1 }] }); if (v) setDuration(fs, +v.ms); } },
      { label: '이동 거리…', act: async () => { const v = await modal({ title: `프레임 ${frameSpec(fs)} 동안 앞으로 가는 거리 (px, 미리보기 "이동"·내보내기용)`, fields: [{ k: 'dx', label: 'px', type: 'number', value: S.doc.motion?.[fs[0]] || 0 }] }); if (v) sendOp({ type: 'motion', frames: fs, dx: +v.dx }); } },
      { label: '왼쪽으로 옮기기', key: 'Alt+←', act: () => moveFrames(-1) },
      { label: '오른쪽으로 옮기기', key: 'Alt+→', act: () => moveFrames(1) },
      { label: '태그 만들기…', key: 'F2', act: makeTag },
      '-',
      { label: `셀 지우기 (${L.name})`, act: () => sendOp({ type: 'clear', layer: li, frames: fs }) },
      { label: '셀 복사', key: 'Ctrl+C', act: () => { const ss = S.sel; S.sel = null; copySel(false); S.sel = ss; } },
      ...(fs.length > 1 ? [{ label: `셀 링크 (${frameSpec(fs)}, 첫 셀 공유)`, act: () => sendOp({ type: 'link', layer: li, frames: fs }) }] : []),
      ...(linked ? [{ label: '링크 풀기', act: () => sendOp({ type: 'unlink', layer: li, frames: fs }) }] : []),
    ];
    showMenu(e.clientX, e.clientY, items);
  } else if (k === 'lname' || k === 'lh' || k === 'eye' || k === 'lock') {
    const li = +t.dataset.l;
    S.layer = li;
    schedule('timeline');
    const L = S.doc.layers[li];
    showMenu(e.clientX, e.clientY, [
      { label: '새 레이어 (위에)', key: 'Ctrl+Shift+N', act: addLayer },
      { label: '레이어 복제', act: () => sendOp({ type: 'dupLayer', layer: li }) },
      { label: '이름 바꾸기…', act: () => renameLayer(li) },
      { label: '불투명도…', act: async () => { const v = await modal({ title: `"${L.name}" 불투명도`, fields: [{ k: 'o', label: '0~255', type: 'number', value: L.opacity, min: 0, max: 255 }] }); if (v) sendOp({ type: 'layer', layer: li, opacity: +v.o }); } },
      '-',
      { label: '위로', act: () => sendOp({ type: 'moveLayer', layer: li, to: li + 1 }, [], () => { S.layer = Math.min(li + 1, S.doc.layers.length - 1); schedule('timeline'); }) },
      { label: '아래로', act: () => sendOp({ type: 'moveLayer', layer: li, to: li - 1 }, [], () => { S.layer = Math.max(0, li - 1); schedule('timeline'); }) },
      { label: '아래 레이어와 합치기', key: 'Ctrl+E', act: () => mergeDown(li) },
      '-',
      { label: '레이어 지우기', act: () => sendOp({ type: 'delLayer', layer: li }) },
    ]);
  } else if (k === 'tag') {
    const name = t.dataset.t;
    showMenu(e.clientX, e.clientY, [
      { label: '태그 고치기…', act: () => editTag(name) },
      { label: '이 태그만 미리보기', act: () => { $('#pvTag').value = name; pvRestart(); } },
      { label: '태그 지우기', act: () => sendOp({ type: 'delTag', name }) },
    ]);
  }
});
function mergeDown(li) {
  if (li <= 0) { toast('맨 아래 레이어는 아래로 합칠 수 없음', 'err'); return; }
  sendOp({ type: 'mergeDown', layer: li }, [], () => { S.layer = li - 1; schedule('timeline'); postFocus(); });
}
function addLayer() {
  const at = S.layer + 1;
  sendOp({ type: 'addLayer', at }, [], () => { S.layer = at; schedule('timeline'); postFocus(); });
}
async function renameLayer(li) {
  const v = await modal({ title: '레이어 이름', fields: [{ k: 'name', label: '이름', type: 'text', value: S.doc.layers[li].name }] });
  if (v && v.name) sendOp({ type: 'layer', layer: li, name: v.name.trim() });
}
const DIR_OPTS = [['forward', '앞으로 →'], ['reverse', '거꾸로 ←'], ['pingpong', '왕복 ↔']];
async function makeTag() {
  const fs = selFrames();
  const v = await modal({
    title: `태그 만들기 (프레임 ${frameSpec(fs)})`,
    fields: [
      { k: 'name', label: '이름', type: 'text', value: '' , placeholder: 'idle, walk, hop …' },
      { k: 'from', label: '처음', type: 'number', value: fs[0] }, { k: 'to', label: '끝', type: 'number', value: fs[fs.length - 1] },
      { k: 'dir', label: '재생 방향', type: 'select', value: 'forward', options: DIR_OPTS },
    ],
  });
  if (v && v.name) sendOp({ type: 'addTag', name: v.name.trim(), from: +v.from, to: +v.to, dir: v.dir });
}
async function editTag(name) {
  const t = S.doc.tags.find((x) => x.name === name);
  if (!t) return;
  const v = await modal({
    title: `태그 "${name}"`,
    fields: [
      { k: 'rename', label: '이름', type: 'text', value: t.name },
      { k: 'from', label: '처음', type: 'number', value: t.from }, { k: 'to', label: '끝', type: 'number', value: t.to },
      { k: 'dir', label: '재생 방향', type: 'select', value: t.dir, options: DIR_OPTS },
      { k: 'color', label: '색', type: 'color', value: t.color },
    ],
  });
  if (v) sendOp({ type: 'editTag', name, rename: v.rename !== name ? v.rename : undefined, from: +v.from, to: +v.to, dir: v.dir, color: v.color });
}

// ───────────── 도구·옵션 ─────────────
function setTool(id) { S.tool = id; S.pickPivot = false; cv.style.cursor = id === 'hand' ? 'grab' : id === 'move' ? 'move' : 'crosshair'; schedule('tools', 'ctx', 'canvas'); }
function renderTools() {
  $('#tools').innerHTML = TOOLS.map((t) => `<button class="${S.tool === t.id ? 'on' : ''}" data-tool="${t.id}" title="${t.name} (${t.key})">${t.icon}</button>`).join('');
}
$('#tools').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
function renderCtx() {
  const t = S.tool, parts = [];
  const tool = TOOLS.find((x) => x.id === t);
  parts.push(`<b>${tool.name.split(' (')[0]}</b>`);
  if (['pencil', 'eraser', 'line'].includes(t)) parts.push(`<label>크기 <input type="number" data-o="brush" min="1" max="16" value="${S.brush}" style="width:46px"></label>`);
  if (t === 'pencil') parts.push(`<label title="ㄱ자 꺾임을 없애 깔끔한 도트 선"><input type="checkbox" data-o="pixelPerfect" ${S.pixelPerfect ? 'checked' : ''}> 픽셀 퍼펙트</label>`);
  if (DRAW_TOOLS.includes(t) && t !== 'bucket') parts.push(`<label title="세로 가운데 축으로 좌우 대칭"><input type="checkbox" data-o="symmetry" ${S.symmetry ? 'checked' : ''}> 좌우 대칭</label>`);
  if (t === 'bucket') parts.push(`<label><input type="checkbox" data-o="fillContig" ${S.fillContig ? 'checked' : ''}> 이어진 곳만</label>`);
  if (t === 'rect' || t === 'ellipse') parts.push(`<label><input type="checkbox" data-o="shapeFill" ${S.shapeFill ? 'checked' : ''}> 채우기</label>`);
  if (t === 'move' || t === 'marquee') {
    parts.push(`<label title="이동·뒤집기·지우기를 모든 프레임에"><input type="checkbox" data-o="allFrames" ${S.allFrames ? 'checked' : ''}> 모든 프레임</label>`);
    parts.push('<button data-c="flipH" title="좌우 뒤집기 (Shift+H)">⇋</button><button data-c="flipV" title="상하 뒤집기 (Shift+V)">⇵</button>');
    parts.push(`<span class="dim">${S.sel ? `선택 ${S.sel.w}×${S.sel.h} @${S.sel.x},${S.sel.y}` : '선택 없음 = 레이어 전체'}</span>`);
  }
  if (S.pickPivot) parts.push('<b style="color:#2aa8ff">기준점 정할 곳을 클릭</b>');
  parts.push('<span class="sep"></span>');
  parts.push(`<label><input type="checkbox" data-o="grid" ${S.grid ? 'checked' : ''}> 격자</label>`);
  parts.push(`<label title="발바닥 기준선 (파란 점선)"><input type="checkbox" data-o="showPivot" ${S.showPivot ? 'checked' : ''}> 기준선</label>`);
  const html = parts.join('');
  const bar = $('#ctxbar');
  // 붓 크기 칸에 입력 중이면 다시 그리지 않음 (값이 지워지지 않게) — 칸을 벗어나면 다시 그림
  if (bar.contains(document.activeElement) && document.activeElement.matches('input[type=number]')) return;
  if (html === lastCtxHtml) return;
  lastCtxHtml = html;
  bar.innerHTML = html;
}
let lastCtxHtml = '';
$('#ctxbar').addEventListener('focusout', () => schedule('ctx'));
$('#ctxbar').addEventListener('change', (e) => {
  const o = e.target.dataset.o;
  if (!o) return;
  S[o] = e.target.type === 'checkbox' ? e.target.checked : Math.max(1, Math.min(16, +e.target.value || 1));
  if (o === 'grid') store.set('grid', S.grid);
  if (o === 'showPivot') store.set('pivot', S.showPivot);
  schedule('canvas');
});
$('#ctxbar').addEventListener('click', (e) => {
  const c = e.target.closest('[data-c]')?.dataset.c;
  if (c === 'flipH') regionOp('flip', { axis: 'h' });
  if (c === 'flipV') regionOp('flip', { axis: 'v' });
});

// ───────────── 팔레트 ─────────────
function swatchStyle(i) {
  if (!i) return { cls: 'checker', bg: '' };
  const c = S.doc.palette[i - 1].c;
  return { cls: c[3] < 255 ? 'checker' : '', bg: `background-color:rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)});${c[3] < 255 ? `background-image:linear-gradient(rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)}),rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})),linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%),linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%);background-size:auto,8px 8px,8px 8px;background-position:0 0,0 0,4px 4px` : ''}` };
}
function colorLabel(i) {
  if (!S.doc) return '';
  if (!i) return '. 투명';
  const p = S.doc.palette[i - 1];
  return `${p.ch} ${core.toHex(p.c)} ${p.name || ''}`;
}
function renderPalette() {
  if (!S.doc) { $('#palette').innerHTML = ''; return; }
  const items = [0, ...S.doc.palette.map((_, i) => i + 1)];
  $('#palette').innerHTML = items.map((i) => {
    const st = swatchStyle(i);
    const ch = i ? S.doc.palette[i - 1].ch : '.';
    return `<div class="p ${st.cls}${S.fg === i ? ' fg' : ''}${S.bg === i ? ' bg' : ''}" data-i="${i}" style="${st.bg}" title="${esc(colorLabel(i))}"><span>${esc(ch)}</span></div>`;
  }).join('');
  for (const [el, i] of [[$('#fgSw'), S.fg], [$('#bgSw'), S.bg]]) {
    const st = swatchStyle(i);
    el.className = `sw big ${st.cls}`;
    el.style.cssText = st.bg;
  }
  $('#fgInfo').textContent = `앞 ${colorLabel(S.fg)} · 뒤 ${colorLabel(S.bg)}`;
}
$('#palette').addEventListener('click', (e) => { const p = e.target.closest('[data-i]'); if (p) { S.fg = +p.dataset.i; schedule('palette'); } });
$('#palette').addEventListener('contextmenu', (e) => { e.preventDefault(); const p = e.target.closest('[data-i]'); if (p) { S.bg = +p.dataset.i; schedule('palette'); } });
$('#palette').addEventListener('dblclick', (e) => { const p = e.target.closest('[data-i]'); if (p && +p.dataset.i) editColor(+p.dataset.i); });
$('#swapCol').addEventListener('click', () => { [S.fg, S.bg] = [S.bg, S.fg]; schedule('palette'); });
async function editColor(i) {
  const p = S.doc.palette[i - 1];
  const v = await modal({
    title: `팔레트 "${p.ch}" — 바꾸면 이 색을 쓴 곳이 모두 바뀜`,
    fields: [
      { k: 'color', label: '색', type: 'color', value: core.toHex(p.c).slice(0, 7) },
      { k: 'alpha', label: '불투명도 0~255', type: 'number', value: p.c[3], min: 0, max: 255 },
      { k: 'name', label: '이름', type: 'text', value: p.name || '' },
      { k: 'ch', label: '글자', type: 'text', value: p.ch },
    ],
  });
  if (!v) return;
  const a = Math.max(0, Math.min(255, +v.alpha | 0));
  const hex = v.color + (a === 255 ? '' : a.toString(16).padStart(2, '0'));
  sendOp({ type: 'palSet', ch: p.ch, color: hex, name: v.name, newCh: v.ch && v.ch !== p.ch ? v.ch : undefined });
}
async function addColor() {
  const v = await modal({
    title: '팔레트에 색 추가',
    fields: [
      { k: 'color', label: '색', type: 'color', value: '#ff8a3d' },
      { k: 'alpha', label: '불투명도 0~255', type: 'number', value: 255, min: 0, max: 255 },
      { k: 'name', label: '이름', type: 'text', value: '' },
    ],
  });
  if (!v) return;
  const a = Math.max(1, Math.min(255, +v.alpha | 0));
  sendOp({ type: 'palAdd', color: v.color + (a === 255 ? '' : a.toString(16).padStart(2, '0')), name: v.name }, [], () => { S.fg = S.doc.palette.length; schedule('palette'); });
}

// ───────────── 미리보기 ─────────────
const pv = $('#pv');
const pvc = pv.getContext('2d');
const PV = { playing: true, order: [0], i: 0, acc: 0, last: 0, x: 0 };
function refreshPreviewTags() {
  const sel = $('#pvTag');
  const cur = sel.value;
  const opts = [['', '전체 프레임'], ...(S.doc?.tags || []).map((t) => [t.name, `태그: ${t.name}`])];
  const html = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  if (sel.innerHTML !== html) { sel.innerHTML = html; sel.value = opts.some(([v]) => v === cur) ? cur : ''; }
  const sc = $('#pvScale');
  if (!sc.options.length) sc.innerHTML = [['0', '맞춤'], ...[1, 2, 3, 4, 6, 8].map((n) => [n, `${n}배`])].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  PV.order = S.doc ? core.playOrder(S.doc, sel.value || null) : [0];
}
function pvRestart() { PV.i = 0; PV.acc = 0; refreshPreviewTags(); }
$('#pvTag').addEventListener('change', pvRestart);
$('#pvPlay').addEventListener('click', () => { PV.playing = !PV.playing; $('#pvPlay').textContent = PV.playing ? '❚❚' : '▶'; });
function pvFrame(now) {
  requestAnimationFrame(pvFrame);
  const d = S.doc;
  if (!d) return;
  const dt = PV.last ? Math.min(250, now - PV.last) : 0;
  PV.last = now;
  let f, next, t = 0;
  if (PV.playing && PV.order.length) {
    PV.acc += dt * +$('#pvSpeed').value;
    PV.i %= PV.order.length;
    while (PV.acc >= (d.frames[PV.order[PV.i]] || 100)) { PV.acc -= d.frames[PV.order[PV.i]] || 100; PV.x += d.motion?.[PV.order[PV.i]] || 0; PV.i = (PV.i + 1) % PV.order.length; }
    f = PV.order[PV.i];
    next = PV.order[(PV.i + 1) % PV.order.length];
    t = Math.min(1, PV.acc / (d.frames[f] || 100));
  } else { f = cf(); next = f; }
  if (f >= d.frames.length) f = next = 0;
  // 프레임 사이를 매 화면마다 이어서 (이동은 시간 비례, 높이 lift 는 다음 프레임 쪽으로) — 화면 픽셀 단위라 부드러움
  const m = core.motionAt(d, f, next, t);
  const box = $('#pvWrap').getBoundingClientRect();
  let sc = +$('#pvScale').value;
  if (!sc) sc = Math.max(1, Math.floor(Math.min((box.width - 10) / d.w, (box.height - 10) / (d.h + 2 + Math.max(0, -Math.min(0, ...(d.lift || [0])))))));
  const moving = $('#pvMove').checked;
  const top = (2 + Math.max(0, -Math.min(0, ...(d.lift || [0])))) * sc;   // 높이(lift)로 떠도 위가 잘리지 않게 여유
  const W = moving ? Math.max(d.w * sc, Math.floor(box.width - 10)) : d.w * sc, H = d.h * sc + top;
  if (pv.width !== W || pv.height !== H) { pv.width = W; pv.height = H; }
  const bg = $('#pvBg').value;
  if (bg === 'checker') {
    const cs = Math.max(4, sc * 2);
    for (let y = 0; y < H; y += cs) for (let x = 0; x < W; x += cs) { pvc.fillStyle = ((x / cs + y / cs) & 1) ? '#cfcfd4' : '#ececf0'; pvc.fillRect(x, y, cs, cs); }
  } else { pvc.fillStyle = bg; pvc.fillRect(0, 0, W, H); }
  if (off.width !== d.w || off.height !== d.h) { off.width = d.w; off.height = d.h; }
  const parts = core.compositeSplit(d, f, { override });
  pvc.imageSmoothingEnabled = false;
  const span = W + d.w * sc;
  const x = moving && (d.motion || []).some((v) => v)
    ? Math.round((((PV.x + m.x) * sc + d.w * sc) % span + span) % span - d.w * sc)
    : Math.round((W - d.w * sc) / 2);
  if (parts.shadow) {   // 그림자는 땅에
    offc.putImageData(new ImageData(parts.shadow, d.w, d.h), 0, 0);
    pvc.drawImage(off, x, top, d.w * sc, d.h * sc);
  }
  offc.putImageData(new ImageData(parts.body, d.w, d.h), 0, 0);
  pvc.drawImage(off, x, top + Math.round(m.y * sc), d.w * sc, d.h * sc);
  const info = `프레임 ${f} · ${d.frames[f]}ms · ${sc}배${PV.playing ? '' : ' (멈춤: 편집 중 프레임)'}`;
  if ($('#pvInfo').textContent !== info) $('#pvInfo').textContent = info;
}
requestAnimationFrame(pvFrame);

// ───────────── 기록·상태 ─────────────
function renderHistory() {
  const h = S.hist;
  if (!h) { $('#history').innerHTML = ''; return; }
  $('#history').innerHTML = h.items.map((it) => {
    const who = it.actor === '나' ? 'me' : (it.actor === 'Claude' || it.actor === 'AI') ? 'claude' : '';
    return `<div class="${it.i === h.pos ? 'cur' : ''}${it.i > h.pos ? ' future' : ''}" data-i="${it.i}" title="${new Date(it.t).toLocaleTimeString()}"><span class="who ${who}">${esc(it.actor === '-' ? '' : it.actor)}</span><span class="lbl">${esc(it.label)}</span></div>`;
  }).join('');
  $('#history .cur')?.scrollIntoView({ block: 'nearest' });
}
$('#history').addEventListener('click', (e) => { const d = e.target.closest('[data-i]'); if (d) sendOp({ type: 'goto', pos: +d.dataset.i }); });
function renderStatus() {
  const d = S.doc;
  if (!d) { $('#status').textContent = '프로젝트를 고르거나 새로 만드세요'; return; }
  const f = cf();
  const parts = [];
  if (S.hover) {
    const v = core.topIndex(d, f)[S.hover[1] * d.w + S.hover[0]];
    parts.push(`<b>${S.hover[0]}, ${S.hover[1]}</b> ${esc(colorLabel(v))}`);
  } else parts.push('<b>-, -</b>');
  parts.push(`${d.w}×${d.h}`, `확대 ×${S.zoom}`, `프레임 <b>${f}</b>/${d.frames.length - 1} · ${d.frames[f]}ms`, `레이어 <b>${esc(d.layers[S.layer]?.name || '')}</b>`);
  if (S.sel) parts.push(`선택 ${S.sel.w}×${S.sel.h}`);
  if (d.pivot) parts.push(`기준점 ${d.pivot.join(',')}`);
  if (S.pending.size) parts.push('보내는 중…');
  $('#status').innerHTML = parts.join(' · ');
}
let toastBox = $('#toast');
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = kind;
  el.textContent = msg;
  toastBox.appendChild(el);
  setTimeout(() => el.remove(), 4000);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
}
let focusTimer = 0;
function postFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    if (!S.name) return;
    api('POST', '/api/focus', { name: S.name, frame: cf(), layer: S.layer, selection: S.sel, frames: S.fsel ? selFrames() : null, tag: $('#pvTag').value || null, client: CLIENT }).catch(() => {});
  }, 120);
}

// ───────────── 대화상자·메뉴 ─────────────
let modalResolve = null;
function modal({ title, fields = [], html = '', ok = '확인', cancel = '취소' }) {
  const f = $('#modal');
  f.innerHTML = `<h3>${esc(title)}</h3>${html}${fields.map((x) => {
    let input;
    if (x.type === 'select') input = `<select name="${x.k}">${x.options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(x.value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else if (x.type === 'checkbox') input = `<input type="checkbox" name="${x.k}" ${x.value ? 'checked' : ''}>`;
    else input = `<input type="${x.type}" name="${x.k}" value="${esc(x.value ?? '')}"${x.min != null ? ` min="${x.min}"` : ''}${x.max != null ? ` max="${x.max}"` : ''}${x.placeholder ? ` placeholder="${esc(x.placeholder)}"` : ''}>`;
    return `<label class="row"><span>${esc(x.label)}</span>${input}</label>`;
  }).join('')}<div class="btns">${cancel ? `<button type="button" data-m="cancel">${cancel}</button>` : ''}<button type="submit" class="on">${ok}</button></div>`;
  $('#modalBack').hidden = false;
  setTimeout(() => (f.querySelector('input:not([type=checkbox]),select') || f.querySelector('[type=submit]'))?.focus(), 0);
  return new Promise((res) => {
    modalResolve = () => {
      const out = {};
      for (const x of fields) { const el = f.elements[x.k]; out[x.k] = x.type === 'checkbox' ? el.checked : el.value; }
      res(out);
    };
    f.onclick = (e) => { if (e.target.dataset.m === 'cancel') { closeModal(); res(null); } };
    f.onkeydown = (e) => { if (e.key === 'Escape') { closeModal(); res(null); } };
  });
}
function closeModal() { document.activeElement?.blur(); $('#modalBack').hidden = true; modalResolve = null; }
$('#modal').addEventListener('submit', (e) => { e.preventDefault(); const r = modalResolve; closeModal(); r?.(); });

function showMenu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<hr>' : `<div data-i="${i}">${esc(it.label)}${it.key ? `<span class="k">${it.key}</span>` : ''}</div>`)).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
  m.onclick = (e) => { const d = e.target.closest('[data-i]'); if (d) { hideMenu(); items[+d.dataset.i].act(); } };
}
function hideMenu() { $('#menu').hidden = true; }
window.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu')) hideMenu(); }, true);

// ───────────── 위쪽 메뉴 ─────────────
async function loadList(select) {
  const list = await api('GET', '/api/list');
  $('#projSel').innerHTML = (list.length ? '' : '<option value="">(프로젝트 없음)</option>') + list.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.w ? ` ${p.w}×${p.h}` : ''}</option>`).join('');
  if (select) $('#projSel').value = select;
  return list;
}
$('#projSel').addEventListener('change', (e) => { if (e.target.value) switchProject(e.target.value); });
// 드롭다운을 고른 뒤 초점을 풀어서 단축키(←→ 등)가 드롭다운 값을 바꾸지 않게
document.addEventListener('change', (e) => { if (e.target.matches?.('select')) e.target.blur(); });
async function switchProject(name) {
  stopPlay();
  S.name = name;
  store.set('last', name);
  S.store = new core.Store();
  S.doc = null; S.hist = null; S.fitted = false;
  S.pending.clear(); S.live = null; S.sel = null; S.fsel = null; S.frame = 0; S.layer = 0; S.flash = null;
  if (![...$('#projSel').options].some((o) => o.value === name)) await loadList(name);
  $('#projSel').value = name;
  document.title = `${name} — 가치고치 도트 편집기`;
  connect();
  schedule('all');
}
const ACTS = {
  undo: () => sendOp({ type: 'undo' }),
  redo: () => sendOp({ type: 'redo' }),
  async new() {
    const list = await api('GET', '/api/list');
    const opts = [['', '기본 팔레트'], ...list.map((p) => [p.name, p.name])];
    const v = await modal({
      title: '새 프로젝트',
      fields: [
        { k: 'name', label: '이름', type: 'text', value: '', placeholder: '예: gyulsae-adult-walk' },
        { k: 'w', label: '가로', type: 'number', value: S.doc?.w || 32, min: 1, max: 1024 },
        { k: 'h', label: '세로', type: 'number', value: S.doc?.h || 32, min: 1, max: 1024 },
        { k: 'pal', label: '팔레트 가져올 곳', type: 'select', value: S.name || '', options: opts },
        { k: 'copy', label: '통째로 복사', type: 'select', value: '', options: [['', '(안 함 — 빈 캔버스)'], ...list.map((p) => [p.name, p.name])] },
      ],
    });
    if (!v || !v.name) return;
    try {
      await api('POST', '/api/new', { name: v.name.trim(), w: +v.w, h: +v.h, paletteFrom: v.pal || undefined, copyOf: v.copy || undefined });
      await loadList();
      switchProject(v.name.trim());
    } catch (e) { toast(e.message, 'err'); }
  },
  import: () => { $('#fileIn').value = ''; $('#fileIn').click(); },
  async export() {
    if (!S.doc) return;
    const v = await modal({
      title: `"${S.name}" 내보내기 — 스프라이트 시트 PNG + Aseprite JSON + 정적 이미지(0번 프레임)`,
      fields: [
        { k: 'layout', label: '배치', type: 'select', value: 'grid', options: [['grid', '격자 (가로 4096px 안에서 줄바꿈)'], ['row', '가로 한 줄']] },
        { k: 'scale', label: '배율', type: 'select', value: '1', options: [['1', '1배 (원본, 권장)'], ['2', '2배'], ['4', '4배'], ['8', '8배'], ['16', '16배']] },
      ],
    });
    if (!v) return;
    try {
      const r = await api('POST', '/api/export', { name: S.name, layout: v.layout, scale: +v.scale });
      const url = (p) => '/export/' + p.split('/export/')[1];
      await modal({
        title: '내보냈어요',
        html: `<pre>${r.files.map(esc).join('\n')}</pre><div>시트 ${r.size} (${r.grid})</div><div>${r.files.filter((f) => f.endsWith('.png')).map((f) => `<a href="${url(f)}" target="_blank">${esc(f.split('/').pop())}</a>`).join(' · ')}</div>`,
        cancel: '',
      });
    } catch (e) { toast(e.message, 'err'); }
  },
  async resize() {
    if (!S.doc) return;
    const v = await modal({
      title: '캔버스 크기 (그림은 그대로, 칸만 바뀜)',
      fields: [
        { k: 'w', label: '가로', type: 'number', value: S.doc.w, min: 1, max: 1024 },
        { k: 'h', label: '세로', type: 'number', value: S.doc.h, min: 1, max: 1024 },
        { k: 'anchor', label: '기준', type: 'select', value: 'b', options: [['tl', '왼쪽 위'], ['t', '위'], ['tr', '오른쪽 위'], ['l', '왼쪽'], ['c', '가운데'], ['r', '오른쪽'], ['bl', '왼쪽 아래'], ['b', '아래 가운데 (발 고정)'], ['br', '오른쪽 아래']] },
      ],
    });
    if (v) sendOp({ type: 'resize', w: +v.w, h: +v.h, anchor: v.anchor });
  },
  pivot: () => { S.pickPivot = !S.pickPivot; schedule('ctx', 'canvas'); },
  compare: () => window.open('/compare.html', 'dot-compare'),
  palAdd: addColor,
  palClean: () => sendOp({ type: 'palClean' }),
  help: () => modal({ title: '단축키 · Aseprite 와 거의 같음', html: HELP_HTML, cancel: '' }),
};
document.querySelector('#app').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) ACTS[b.dataset.act]?.(); });
$('#fileIn').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(file); });
  const v = await modal({
    title: `가져오기: ${file.name}`,
    html: '<div class="dim small">확대해서 저장한 도트 그림(예: 512px = 32px × 16배)은 배율을 알아서 찾아 원래 크기로 줄여요. 시트라면 한 칸 크기를 적으세요.</div>',
    fields: [
      { k: 'name', label: '프로젝트 이름', type: 'text', value: file.name.replace(/\.png$/i, '').replace(/[^\w가-힣.-]/g, '-') },
      { k: 'cellW', label: '칸 가로 (시트일 때)', type: 'number', value: '' },
      { k: 'cellH', label: '칸 세로 (시트일 때)', type: 'number', value: '' },
      { k: 'scale', label: '배율', type: 'text', value: 'auto' },
      { k: 'ms', label: '프레임 시간 ms', type: 'number', value: 100 },
    ],
  });
  if (!v || !v.name) return;
  try {
    const r = await api('POST', '/api/import', { png: b64, name: v.name.trim(), cellW: +v.cellW || undefined, cellH: +v.cellH || undefined, scale: v.scale === 'auto' ? 'auto' : +v.scale, ms: +v.ms });
    toast(`가져옴: ${r.src} → ${r.size}, 프레임 ${r.frames}, 색 ${r.colors}${r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''}`);
    await loadList();
    switchProject(r.name);
  } catch (err) { toast(err.message, 'err'); }
});

const HELP_HTML = `<table>
<tr><td>B E G I</td><td>연필 · 지우개 · 페인트 통 · 스포이트 (어떤 도구든 Alt+클릭 = 스포이트)</td></tr>
<tr><td>L U O</td><td>직선 · 사각형 · 원 (Shift: 45도 / 정사각형 / 정원)</td></tr>
<tr><td>M V H</td><td>사각 선택 · 이동 · 손 (Space 누른 채 끌기 = 화면 이동)</td></tr>
<tr><td>왼쪽 / 오른쪽 클릭</td><td>앞색 / 뒷색으로 칠하기. 연필 Shift+클릭 = 마지막 점에서 직선</td></tr>
<tr><td>X · [ ]</td><td>앞뒷색 바꾸기 · 붓 크기</td></tr>
<tr><td>, . 또는 ← →</td><td>이전 / 다음 프레임 (이동 도구일 땐 화살표 = 1칸 옮기기)</td></tr>
<tr><td>↑ ↓</td><td>위 / 아래 레이어</td></tr>
<tr><td>Home End</td><td>첫 / 마지막 프레임</td></tr>
<tr><td>Enter</td><td>재생 / 멈춤 (선택한 프레임 범위, 없으면 현재 태그, 없으면 전체)</td></tr>
<tr><td>Alt+N / L / B / C</td><td>새 프레임(복제) / 링크 프레임 / 빈 프레임 / 프레임 지우기</td></tr>
<tr><td>Alt+← →</td><td>프레임 순서 옮기기</td></tr>
<tr><td>F2 · F3</td><td>태그 만들기 · 어니언 스킨</td></tr>
<tr><td>Ctrl+Shift+N · Ctrl+E</td><td>새 레이어 · 아래 레이어와 합치기</td></tr>
<tr><td>Ctrl+Z / Ctrl+Y</td><td>되돌리기 / 다시 하기 (AI 작업도 같이 되돌려짐)</td></tr>
<tr><td>Ctrl+A · Ctrl+D · Esc</td><td>전체 선택 · 선택 해제</td></tr>
<tr><td>Ctrl+C X V · Delete</td><td>복사 · 잘라내기 · 붙여넣기 · 선택 영역 지우기</td></tr>
<tr><td>Shift+H / Shift+V</td><td>좌우 / 상하 뒤집기 (선택 영역, 없으면 레이어 전체)</td></tr>
<tr><td>휠 · + − · 0</td><td>확대 축소 · 화면 맞춤</td></tr>
<tr><td>타임라인</td><td>칸 클릭 = 프레임·레이어 고르기, 끌기·Shift+클릭 = 범위, 더블클릭 = 시간·이름, 오른쪽 클릭 = 메뉴</td></tr>
</table>
<p class="dim small">저장은 자동입니다 (projects/이름.dot.json). AI 는 <code>node dot.mjs</code> 로 같은 문서를 고치고, 바뀐 곳은 노랗게 깜빡입니다.</p>`;

// ───────────── 키보드 ─────────────
window.addEventListener('keydown', (e) => {
  if (!$('#modalBack').hidden) return;
  if (e.target.matches?.('input:not([type=checkbox]), select, textarea')) { if (e.key === 'Escape' || e.key === 'Enter') e.target.blur(); return; }
  if (e.target.matches?.('input[type=checkbox]')) e.target.blur();
  const k = e.key, ctrl = e.ctrlKey || e.metaKey, lower = k.toLowerCase();
  if (k === ' ') { S.spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (ctrl && lower === 'z') { e.preventDefault(); sendOp({ type: e.shiftKey ? 'redo' : 'undo' }); return; }
  if (ctrl && lower === 'y') { e.preventDefault(); sendOp({ type: 'redo' }); return; }
  if (!S.doc) return;
  if (ctrl && e.shiftKey && lower === 'n') { e.preventDefault(); addLayer(); return; }
  if (ctrl && lower === 'e') { e.preventDefault(); mergeDown(S.layer); return; }
  if (ctrl && lower === 'a') { e.preventDefault(); S.sel = { x: 0, y: 0, w: S.doc.w, h: S.doc.h }; postFocus(); schedule('canvas', 'ctx'); return; }
  if (ctrl && lower === 'd') { e.preventDefault(); S.sel = null; postFocus(); schedule('canvas', 'ctx'); return; }
  if (ctrl && lower === 'c') { e.preventDefault(); copySel(false); return; }
  if (ctrl && lower === 'x') { e.preventDefault(); copySel(true); return; }
  if (ctrl && lower === 'v') { e.preventDefault(); paste(); return; }
  if (ctrl && lower === 's') { e.preventDefault(); toast('자동 저장되고 있어요'); return; }
  if (e.altKey) {
    if (lower === 'n') { e.preventDefault(); newFrame('copy'); return; }
    if (lower === 'l') { e.preventDefault(); newFrame('link'); return; }
    if (lower === 'b') { e.preventDefault(); newFrame('empty'); return; }
    if (lower === 'c') { e.preventDefault(); delFrames(); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); moveFrames(-1); return; }
    if (k === 'ArrowRight') { e.preventDefault(); moveFrames(1); return; }
  }
  if (ctrl || e.altKey) return;
  if (e.shiftKey && lower === 'h') { regionOp('flip', { axis: 'h' }); return; }
  if (e.shiftKey && lower === 'v') { regionOp('flip', { axis: 'v' }); return; }
  const tool = TOOLS.find((t) => t.key.toLowerCase() === lower);
  if (tool && !e.shiftKey) { setTool(tool.id); return; }
  if (S.tool === 'move' && k.startsWith('Arrow')) {
    e.preventDefault();
    if (!editable()) return;
    const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
    sendOp({ type: 'shift', layer: S.layer, frames: S.allFrames ? 'all' : cf(), dx, dy, region: S.sel || undefined });
    if (S.sel) { S.sel = clipSel({ ...S.sel, x: S.sel.x + dx, y: S.sel.y + dy }); postFocus(); }
    return;
  }
  switch (k) {
    case ',': case 'ArrowLeft': setFrame(cf() - 1 < 0 ? S.doc.frames.length - 1 : cf() - 1); break;
    case '.': case 'ArrowRight': setFrame((cf() + 1) % S.doc.frames.length); break;
    case 'Home': setFrame(0); break;
    case 'End': setFrame(S.doc.frames.length - 1); break;
    case 'ArrowUp': e.preventDefault(); S.layer = Math.min(S.doc.layers.length - 1, S.layer + 1); schedule('timeline'); postFocus(); break;
    case 'ArrowDown': e.preventDefault(); S.layer = Math.max(0, S.layer - 1); schedule('timeline'); postFocus(); break;
    case 'Enter': e.preventDefault(); togglePlay(); break;
    case 'Escape': if (S.playing) stopPlay(); S.sel = null; S.fsel = null; S.pickPivot = false; postFocus(); schedule('canvas', 'ctx', 'timeline'); break;
    case 'Delete': case 'Backspace': if (S.sel) regionOp('clear'); break;
    case 'x': case 'X': [S.fg, S.bg] = [S.bg, S.fg]; schedule('palette'); break;
    case '[': S.brush = Math.max(1, S.brush - 1); schedule('ctx', 'canvas'); break;
    case ']': S.brush = Math.min(16, S.brush + 1); schedule('ctx', 'canvas'); break;
    case '+': case '=': zoomAt(1); break;
    case '-': zoomAt(-1); break;
    case '0': fit(); break;
    case 'F2': e.preventDefault(); makeTag(); break;
    case 'F3': e.preventDefault(); S.onion = !S.onion; store.set('onion', S.onion); schedule('canvas', 'timeline'); break;
    default: break;
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') { S.spaceDown = false; cv.style.cursor = S.tool === 'hand' ? 'grab' : S.tool === 'move' ? 'move' : 'crosshair'; } });
window.addEventListener('resize', () => schedule('canvas'));

// ───────────── 시작 ─────────────
(async () => {
  renderTools();
  renderCtx();
  try {
    const list = await loadList();
    const st = await api('GET', '/api/state');
    const want = [store.get('last', null), st.focus?.name, list[0]?.name].find((n) => n && list.some((p) => p.name === n));
    if (want) switchProject(want);
    else { connect(); schedule('all'); }
  } catch (e) { toast('서버에 연결 못 함: ' + e.message, 'err'); }
})();
