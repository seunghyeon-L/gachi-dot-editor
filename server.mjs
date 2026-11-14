// 가치고치 도트 편집기 서버 — node server.mjs  (→ http://localhost:5191, 포트 바꾸기: PORT=5300 node server.mjs)
// 문서 원본은 이 서버가 들고 있다. 사람(브라우저)과 AI(dot.mjs) 가 같은 연산(op)을 보내고,
// 서버가 적용 → projects/<이름>.dot.json 저장 → 열린 화면 모두에 전달. 되돌리기 기록도 하나를 같이 쓴다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';
import { encodePNG, decodePNG } from './png.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = path.join(ROOT, 'projects');
const EXPORT = path.join(ROOT, 'export');
const SNAP = path.join(ROOT, '.snap');
const BACKUP = path.join(ROOT, '.backup');
const PORT = +(process.env.PORT || 5191);
for (const d of [PROJECTS, EXPORT, SNAP, BACKUP]) fs.mkdirSync(d, { recursive: true });

const NAME_RE = /^[\w가-힣.-]{1,60}$/;
const fileOf = (name) => path.join(PROJECTS, `${name}.dot.json`);
const sessions = new Map(); // name → { doc, hist, pos, version, lastWritten, backedUp, clients:Set }
let focus = { name: null, frame: 0, layer: 0, selection: null, tag: null, t: 0 };

// ───────────── 세션 ─────────────
function load(name) {
  if (!NAME_RE.test(name || '')) throw new Error(`프로젝트 이름 "${name}" 을 쓸 수 없음 (글자·숫자·_-. 만)`);
  if (sessions.has(name)) return sessions.get(name);
  const f = fileOf(name);
  if (!fs.existsSync(f)) throw new Error(`프로젝트 "${name}" 없음 (있는 것: ${listNames().join(', ') || '없음'})`);
  const text = fs.readFileSync(f, 'utf8');
  const doc = core.parse(text, { name });
  const s = { name, doc, hist: [{ doc, label: '열기', actor: '-', t: Date.now() }], pos: 0, version: 1, lastWritten: text, backedUp: false, clients: new Set() };
  sessions.set(name, s);
  return s;
}
function create(name, doc, actor) {
  if (!NAME_RE.test(name || '')) throw new Error(`프로젝트 이름 "${name}" 을 쓸 수 없음`);
  if (fs.existsSync(fileOf(name))) throw new Error(`프로젝트 "${name}" 이(가) 이미 있음`);
  doc.name = name;
  const text = core.serialize(doc);
  fs.writeFileSync(fileOf(name), text);
  const s = { name, doc, hist: [{ doc, label: '새로 만들기', actor, t: Date.now() }], pos: 0, version: 1, lastWritten: text, backedUp: true, clients: new Set() };
  sessions.set(name, s);
  return s;
}
const listNames = () => fs.readdirSync(PROJECTS).filter((f) => f.endsWith('.dot.json')).map((f) => f.slice(0, -9)).sort();

function save(s) {
  const text = core.serialize(s.doc);
  if (text === s.lastWritten) return;
  const f = fileOf(s.name);
  if (!s.backedUp && s.lastWritten) {
    // 이 세션에서 처음 덮어쓰기 전, 마지막으로 알던 내용(=불러올 때 파일)을 백업
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(BACKUP, `${s.name}-${stamp}.dot.json`), s.lastWritten);
    s.backedUp = true;
  }
  s.lastWritten = text;
  fs.writeFileSync(f, text);
}
/** 저장했다 다시 읽어도 되는 문서인지 (깨진 파일이 생기지 않게) */
function verify(doc) {
  try { core.parse(core.serialize(doc)); } catch (e) { throw new Error(`저장 형식 검사 실패 — 적용 안 함: ${e.message}`); }
}
function commit(s, doc, label, actor, by, { write = true } = {}) {
  verify(doc);
  s.hist.splice(s.pos + 1);
  s.hist.push({ doc, label, actor, t: Date.now() });
  if (s.hist.length > 400) s.hist.shift();
  s.pos = s.hist.length - 1;
  s.doc = doc;
  s.version++;
  if (write) save(s);
  broadcast(s, { label, actor, by });
}
function moveHistory(s, pos, actor, by) {
  pos = Math.max(0, Math.min(s.hist.length - 1, pos));
  if (pos === s.pos) return null;
  const label = pos < s.pos ? `되돌리기: ${s.hist[s.pos].label}` : `다시 하기: ${s.hist[pos].label}`;
  s.pos = pos;
  s.doc = s.hist[pos].doc;
  s.version++;
  save(s);
  broadcast(s, { label, actor, by, undo: true });
  return label;
}
const histSummary = (s) => ({
  pos: s.pos,
  items: s.hist.map((h, i) => ({ i, label: h.label, actor: h.actor, t: h.t })).slice(-120),
});

// ───────────── 화면에 전달 (SSE) ─────────────
const allClients = new Set();
function send(c, type, data) { c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
function docMessage(s, c, extra = {}) {
  const cels = {};
  for (const id of core.celIds(s.doc)) if (!c.have.has(id)) { cels[id] = core.b64enc(s.doc.store.get(id)); c.have.add(id); }
  return { version: s.version, struct: core.structOf(s.doc), cels, hist: histSummary(s), ...extra };
}
function broadcast(s, extra) { for (const c of s.clients) send(c, 'doc', docMessage(s, c, extra)); }

// ───────────── 파일 직접 수정 감지 ─────────────
const watchTimers = new Map();
fs.watch(PROJECTS, (ev, file) => {
  if (!file || !file.endsWith('.dot.json')) return;
  const name = file.slice(0, -9);
  clearTimeout(watchTimers.get(name));
  watchTimers.set(name, setTimeout(() => {
    const s = sessions.get(name);
    if (!s || !fs.existsSync(fileOf(name))) return;
    const text = fs.readFileSync(fileOf(name), 'utf8');
    if (text === s.lastWritten) return;
    try {
      const doc = core.parse(text, { name, store: s.doc.store });
      // 내용이 같으면(공백·순서만 다름) 기록을 남기지 않음
      if (core.serialize(doc) === core.serialize(s.doc)) { s.lastWritten = text; return; }
      // 직접 고친 파일은 다시 쓰지 않음 (서버가 모르는 칸이 있어도 지워지지 않게). 다음 편집 때 저장됨
      commit(s, doc, '파일 직접 수정', 'AI', undefined, { write: false });
      s.lastWritten = text;
      console.log(`[파일] ${name} 다시 읽음`);
    } catch (e) {
      for (const c of s.clients) send(c, 'warn', { msg: `${name}.dot.json 을 못 읽음: ${e.message}` });
      console.log(`[파일] ${name} 읽기 실패: ${e.message}`);
    }
  }, 150));
});

// ───────────── 요청 처리 ─────────────
function pickName(q) { const n = q.name || focus.name || listNames()[0]; if (!n) throw new Error('프로젝트가 없음. new 로 만드세요'); return n; }
/** CLI 가 'cur' 로 쓴 레이어·프레임을 사람이 보고 있는 것으로 */
function fillCur(op, s) {
  const f = focus.name === s.name ? focus : { frame: 0, layer: 0 };
  const fix = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of ['layer', 'layers']) if (o[k] === 'cur') o[k] = f.layer;
    for (const k of ['frame', 'frames']) if (o[k] === 'cur') o[k] = f.frame;
    if (o.region === 'sel') o.region = f.selection || undefined;
    for (const v of Object.values(o)) if (typeof v === 'object') fix(v);
    if (Array.isArray(o.ops)) o.ops.forEach(fix);
  };
  fix(op);
  return op;
}

/** 보기 명령의 프레임·레이어 지정에서 cur 풀기 */
function curSpec(v, s, key) {
  if (v !== 'cur') return v;
  const f = focus.name === s.name ? focus : { frame: 0, layer: 0 };
  return f[key];
}
function infoText(s) {
  const d = s.doc;
  const lines = [];
  lines.push(`${d.name}  ${d.w}×${d.h}  프레임 ${d.frames.length}개  레이어 ${d.layers.length}개  기준점 ${d.pivot ? d.pivot.join(',') : '없음'}`);
  lines.push('레이어 (아래→위):');
  d.layers.forEach((L, i) => {
    const cells = L.cels.map((id, f) => {
      if (!id) return '·';
      const first = L.cels.indexOf(id);
      return first === f ? '●' : `↳${first}`;
    });
    lines.push(`  ${i}: ${L.name}${L.visible ? '' : ' (숨김)'}${L.locked ? ' (잠김)' : ''}${L.opacity < 255 ? ` 불투명도 ${L.opacity}` : ''}   ${cells.join(' ')}`);
  });
  lines.push(`프레임 시간(ms): ${d.frames.map((ms, i) => `${i}:${ms}`).join(' ')}  · 한 바퀴 ${d.frames.reduce((a, b) => a + b, 0)}ms`);
  if (d.lift) lines.push(`높이(px, 음수=위, 프레임 사이 부드럽게): ${d.lift.map((v, i) => `${i}:${v}`).join(' ')}`);
  if (d.motion) lines.push(`이동(px/프레임): ${d.motion.map((v, i) => `${i}:${v}`).join(' ')}  · 한 바퀴 ${d.motion.reduce((a, b) => a + b, 0)}px`);
  lines.push(`태그: ${d.tags.length ? d.tags.map((t) => `${t.name} ${t.from}-${t.to} ${t.dir}`).join(' / ') : '없음'}`);
  lines.push('팔레트 (. = 투명):');
  lines.push(core.paletteText(d));
  if (focus.name === d.name) lines.push(`사람이 보는 곳: 프레임 ${focus.frame}, 레이어 ${focus.layer}(${d.layers[focus.layer]?.name})${focus.selection ? `, 선택 ${JSON.stringify(focus.selection)}` : ''}`);
  return lines.join('\n');
}
function historyText(s) {
  return s.hist.map((h, i) => `${i === s.pos ? '▶' : ' '} ${String(i).padStart(3)} ${new Date(h.t).toTimeString().slice(0, 8)} ${h.actor.padEnd(6)} ${h.label}`).slice(-40).join('\n');
}
function snapFile(s, q) {
  const d = s.doc;
  const frames = core.frameList(d, curSpec(q.frames, s, 'frame') ?? (q.tag ? `tag:${q.tag}` : 'all'));
  const only = q.layer != null && q.layer !== '' ? core.layerIndex(d, curSpec(q.layer, s, 'layer')) : undefined;
  const img = core.renderStrip(d, frames, { scale: +q.scale || Math.max(2, Math.min(10, Math.floor(320 / Math.max(d.w, d.h)))), cols: +q.cols || 8, only, onion: !!q.onion });
  const old = fs.readdirSync(SNAP).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 60))) fs.rmSync(path.join(SNAP, f), { force: true });
  const file = path.join(SNAP, `${s.name}-${Date.now()}.png`);
  fs.writeFileSync(file, encodePNG(img.w, img.h, img.rgba));
  return file;
}
function exportFiles(s, q) {
  const d = s.doc;
  const scale = Math.max(1, +q.scale || 1);
  const dir = path.join(EXPORT, s.name);
  fs.mkdirSync(dir, { recursive: true });
  const base = scale > 1 ? `${s.name}@${scale}x` : s.name;
  const sheet = core.buildSheet(d, { layout: q.layout || 'grid', cols: +q.cols || undefined, scale });
  fs.writeFileSync(path.join(dir, `${base}.png`), encodePNG(sheet.w, sheet.h, sheet.rgba));
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(core.asepriteJson(d, sheet, `${base}.png`, scale), null, 2) + '\n');
  const still = core.buildSheet(d, { frames: [0], scale });
  fs.writeFileSync(path.join(dir, `${base}_static.png`), encodePNG(still.w, still.h, still.rgba));
  const rel = (f) => path.relative(ROOT, path.join(dir, f)).replace(/\\/g, '/');
  return { files: [rel(`${base}.png`), rel(`${base}.json`), rel(`${base}_static.png`)], size: `${sheet.w}×${sheet.h}`, grid: `${sheet.cols}열×${sheet.rows}줄` };
}
function importDoc(q) {
  let bytes;
  if (q.png) bytes = Buffer.from(q.png, 'base64');
  else if (q.path) bytes = fs.readFileSync(path.resolve(q.cwd || ROOT, q.path));
  else throw new Error('png(base64) 또는 path 가 필요');
  const img = decodePNG(bytes);
  const palette = q.paletteFrom ? load(q.paletteFrom).doc.palette : undefined;
  const r = core.importRGBA(img.rgba, img.w, img.h, {
    name: q.name, scale: q.scale || 'auto', cellW: +q.cellW || undefined, cellH: +q.cellH || undefined, ms: +q.ms || 100, palette,
  });
  return { ...r, src: `${img.w}×${img.h}` };
}

const routes = {
  'GET /api/list': () => listNames().map((name) => {
    try { const s = load(name); return { name, w: s.doc.w, h: s.doc.h, frames: s.doc.frames.length, layers: s.doc.layers.length }; }
    catch (e) { return { name, error: e.message }; }
  }),
  'GET /api/state': () => ({ focus, projects: listNames() }),
  'GET /api/info': (q) => ({ text: infoText(load(pickName(q))) }),
  'GET /api/doc': (q) => ({ text: core.serialize(load(pickName(q)).doc) }),
  'GET /api/history': (q) => ({ text: historyText(load(pickName(q))) }),
  'GET /api/show': (q) => {
    const s = load(pickName(q));
    const frames = core.frameList(s.doc, curSpec(q.frames, s, 'frame') ?? (focus.name === s.name ? focus.frame : 0));
    const only = q.layer != null && q.layer !== '' ? core.layerIndex(s.doc, curSpec(q.layer, s, 'layer')) : undefined;
    const head = `${s.name} ${s.doc.w}×${s.doc.h} · ${only != null ? `레이어 ${only}:${s.doc.layers[only].name}` : '보이는 레이어 합친 그림'} · '.' 투명`;
    return { text: `${head}\n${core.asciiBlock(s.doc, frames, only)}팔레트:\n${core.paletteText(s.doc)}` };
  },
  'GET /api/diff': (q) => {
    const s = load(pickName(q));
    const [a, b] = [q.a, q.b].map((f) => core.frameList(s.doc, curSpec(f, s, 'frame'))[0]);
    const only = q.layer != null && q.layer !== '' ? core.layerIndex(s.doc, curSpec(q.layer, s, 'layer')) : undefined;
    const r = core.asciiDiff(s.doc, a, b, only);
    return { text: `f${a} → f${b}: 바뀐 픽셀 ${r.count}개 (공백 = 같음, 보이는 글자 = f${b} 의 새 값)\n${r.text}` };
  },
  'POST /api/snap': (q) => ({ path: snapFile(load(pickName(q)), q) }),
  'POST /api/export': (q) => exportFiles(load(pickName(q)), q),
  'POST /api/focus': (q) => { focus = { ...focus, ...q, t: Date.now() }; return { ok: true }; },
  'POST /api/open': (q) => {
    const s = load(q.name);
    focus = { ...focus, name: s.name, frame: 0, layer: 0, selection: null };
    for (const c of allClients) send(c, 'switch', { name: s.name });
    return { ok: true, name: s.name };
  },
  'POST /api/new': (q) => {
    let doc;
    if (q.copyOf) { const src = load(q.copyOf).doc; doc = core.parse(core.serialize(src)); }
    else {
      const w = +q.w || 32, h = +q.h || 32;
      if (w < 1 || h < 1 || w > 1024 || h > 1024) throw new Error('크기는 1~1024');
      doc = core.makeDoc({ name: q.name, w, h, palette: q.paletteFrom ? load(q.paletteFrom).doc.palette : undefined });
    }
    const s = create(q.name, doc, q.actor || '나');
    return { ok: true, name: s.name };
  },
  'POST /api/import': (q) => {
    const r = importDoc(q);
    const s = create(q.name, r.doc, q.actor || '나');
    return { ok: true, name: s.name, scale: r.scale, src: r.src, size: `${s.doc.w}×${s.doc.h}`, frames: s.doc.frames.length, colors: s.doc.palette.length, warnings: r.warnings };
  },
  'POST /api/op': (q) => {
    const s = load(pickName(q));
    const actor = q.actor || '나';
    const by = q.client ? { client: q.client, seq: q.seq } : undefined;
    const op = fillCur(q.op || {}, s);
    if (op.type === 'undo' || op.type === 'redo' || op.type === 'goto') {
      const pos = op.type === 'undo' ? s.pos - (op.n || 1) : op.type === 'redo' ? s.pos + (op.n || 1) : op.pos;
      const label = moveHistory(s, pos, actor, by);
      if (!label && by) broadcast(s, { by });
      return { ok: true, version: s.version, label: label || '더 갈 곳 없음' };
    }
    const r = core.applyOp(s.doc, op);
    commit(s, r.doc, r.label, actor, by);
    return { ok: true, version: s.version, label: r.label };
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
const STATIC = new Set(['/index.html', '/app.js', '/app.css', '/core.js', '/compare.html']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const c = { res, have: new Set(), id: q.client };
      allClients.add(c);
      let s = null;
      if (q.name) {
        try {
          s = load(q.name);
          s.clients.add(c);
          send(c, 'doc', docMessage(s, c, { label: '불러옴', full: true }));
        } catch (e) { send(c, 'warn', { msg: e.message }); }
      }
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); allClients.delete(c); s?.clients.delete(c); });
      return;
    }
    const key = `${req.method} ${url.pathname}`;
    if (routes[key]) {
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : {};
      }
      const out = await routes[key]({ ...q, ...body });
      res.writeHead(200, { 'content-type': MIME['.json'] });
      res.end(JSON.stringify(out));
      return;
    }
    let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    let file = null;
    if (STATIC.has(p)) file = path.join(ROOT, p);
    else if (p.startsWith('/export/') || p.startsWith('/.snap/') || p.startsWith('/gallery/')) {
      file = path.join(ROOT, p);
      if (!file.startsWith(ROOT + path.sep) || p.includes('..')) file = null;
    }
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('없음'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(400, { 'content-type': MIME['.json'] });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`가치고치 도트 편집기: http://localhost:${PORT}  (프로젝트 ${listNames().length}개, 폴더 ${PROJECTS})`);
});
