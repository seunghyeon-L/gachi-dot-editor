#!/usr/bin/env node
// AI(또는 사람)가 터미널에서 도트 편집기를 조작하는 명령. 서버가 켜져 있어야 함.
//   node dot.mjs help
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.DOT_URL || `http://127.0.0.1:${process.env.PORT || 5191}`;
const argv = process.argv.slice(2);
const pos = [];
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (nx != null && !nx.startsWith('--')) { opt[k] = nx; i++; } else opt[k] = true;
  } else pos.push(a);
}
const P = opt.p || opt.project; // 프로젝트 (없으면 사람이 보고 있는 것)
const cmd = pos.shift();

const HELP = `도트 편집기 명령  (node dot.mjs <명령> ... [--p 프로젝트])
프로젝트를 안 쓰면 사람이 지금 보고 있는 프로젝트. 프레임·레이어에 cur 를 쓰면 사람이 보고 있는 곳.
프레임: 0 | 0-3 | 1,3,5 | all | tag:idle      레이어: 이름 | 번호(0=맨 아래) | all
색: 팔레트 글자(a) | #rrggbb | #rrggbbaa(반투명) | . (투명)   ※ 팔레트에 없는 #색은 자동 추가

보기
  list                              프로젝트 목록
  state                             사람이 보는 프로젝트·프레임·레이어·선택 영역
  info                              크기·레이어(셀 ●/링크 ↳/빈 ·)·프레임 시간·태그·팔레트
  show [프레임] [--layer L]          글자 그림 (레이어 생략 = 보이는 레이어 합친 것). 여러 프레임은 나란히
  diff <f1> <f2> [--layer L]        f1 → f2 바뀐 픽셀만
  snap [프레임] [--scale 8] [--layer L] [--onion] [--tag 이름] [--cols 8]
                                    프레임 줄 그림 PNG 경로 출력 → Read 로 보기
  history                           되돌리기 기록 (누가 무엇을)

그리기 (모두 되돌리기 가능, 사람 화면에 바로 보임)
  stamp <프레임> <레이어> [x y]  < 글자파일   글자 줄을 (x,y) 에 찍기. '.' = 투명, '?' = 그대로 두기
        (--file 경로 로도 됨. 여러 프레임에 같은 그림을 찍을 수 있음)
  px <프레임> <레이어> x,y,색 [x,y,색 ...]
  line|rect|ellipse <프레임> <레이어> x0 y0 x1 y1 <색> [--fill] [--size n]
  fill <프레임> <레이어> x y <색> [--global]
  shift <프레임> <레이어> dx dy [--wrap] [--region x,y,w,h]   (통째로 옮기기, 숨쉬기·통통 뛰기에)
  flip <프레임> <레이어> h|v [--region x,y,w,h]
  rotate <프레임> <레이어> 90|180|270 [--region x,y,w,h]
  replace <프레임> <레이어|all> <색1> <색2>
  outline <프레임> <레이어> <색> [--diagonal]
  clear <프레임> <레이어> [--region x,y,w,h]

프레임·셀
  frame add [위치] [--from f] [--link] [--ms 100] [--count n]   (--from 없으면 빈 프레임)
  frame dup <f> [--count n] [--link]   f 를 복제해 바로 뒤에
  frame del <프레임>
  frame move <프레임> <새위치>
  frame ms <프레임> <ms>
  motion <프레임> <dx>               그 프레임 동안 앞으로 가는 거리(px). 미리보기 '이동'·내보내기 JSON 에 씀
  lift <프레임> <y>                 그 프레임이 시작할 때 높이(px, 음수=위). 재생기가 프레임 사이를 부드럽게 이음
  cel copy <f> <레이어> <대상프레임> [대상레이어] [--link]
  cel link <프레임들> <레이어>         첫 프레임 셀을 공유 (Aseprite 링크 셀)
  cel unlink <프레임> <레이어>

레이어·태그·팔레트·캔버스
  layer add <이름> [--at i] | dup <L> | del <L> | rename <L> <새이름> | move <L> <위치>
  layer hide|show|lock|unlock <L> | opacity <L> <0-255> | merge <L>(아래로 합치기)
  tag add <이름> <from> <to> [forward|reverse|pingpong] | edit <이름> [--from] [--to] [--dir] [--rename] | del <이름>
  pal                               팔레트 보기
  pal add <#색> [글자] [이름] | set <글자> <#색> [--name 이름] | clean (안 쓰는 색 지우기)
  resize <w> <h> [기준 tl t tr l c r bl b br, 기본 b]
  pivot <x> <y>                     기준점(발바닥 가운데). 내보내기 JSON 에 들어감

파일
  new <이름> [w h] [--palette 프로젝트] [--copy 프로젝트]
  open <이름>                        사람 화면도 이 프로젝트로 바꿈
  import <png경로> <이름> [--cell 32x32] [--scale auto|n] [--ms 100] [--palette 프로젝트]
  export [--layout grid|row] [--scale n] [--cols n]   → export/<이름>/ 에 시트 PNG + Aseprite JSON + _static.png
  undo [n] | redo [n] | goto <기록번호>
  op '<JSON>'                       연산 직접 보내기 (core.js applyOp 참고, batch 로 여러 개를 한 번에)
`;

async function call(method, route, body) {
  let res;
  try {
    res = await fetch(BASE + route, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch {
    console.error(`서버가 꺼져 있음 → node server.mjs  (${BASE})`);
    process.exit(2);
  }
  const j = await res.json();
  if (j && j.ok === false) { console.error('실패: ' + j.error); process.exit(1); }
  return j;
}
const qs = (o) => '?' + new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== false && v !== undefined).map(([k, v]) => [k, String(v)])).toString();
const op = async (o) => { const r = await call('POST', '/api/op', { name: P, actor: 'AI', op: o }); console.log(`✓ ${r.label}  (v${r.version})`); };
const num = (v, nm) => { const n = Number(v); if (!Number.isFinite(n)) { console.error(`${nm} 가 숫자가 아님: ${v}`); process.exit(1); } return n; };
const region = () => { if (!opt.region) return undefined; if (opt.region === 'sel') return 'sel'; const [x, y, w, h] = opt.region.split(',').map(Number); return { x, y, w, h }; };
const need = (n, usage) => { if (pos.length < n) { console.error('사용법: ' + usage); process.exit(1); } };
function readRows() {
  let text;
  if (opt.file) text = fs.readFileSync(opt.file, 'utf8');
  else if (!process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
  else { console.error('글자 그림을 표준입력(<<EOF) 이나 --file 로 주세요'); process.exit(1); }
  const rows = text.replace(/\r/g, '').split('\n');
  while (rows.length && rows[rows.length - 1].trim() === '') rows.pop();
  while (rows.length && rows[0].trim() === '') rows.shift();
  return rows;
}

const C = {
  help: () => console.log(HELP),
  list: async () => { for (const p of await call('GET', '/api/list')) console.log(p.error ? `${p.name}  (오류: ${p.error})` : `${p.name}  ${p.w}×${p.h}  프레임 ${p.frames}  레이어 ${p.layers}`); },
  state: async () => { const s = await call('GET', '/api/state'); console.log(JSON.stringify(s.focus, null, 1)); },
  info: async () => console.log((await call('GET', '/api/info' + qs({ name: P }))).text),
  history: async () => console.log((await call('GET', '/api/history' + qs({ name: P }))).text),
  show: async () => console.log((await call('GET', '/api/show' + qs({ name: P, frames: pos[0], layer: opt.layer }))).text),
  diff: async () => { need(2, 'diff <f1> <f2>'); console.log((await call('GET', '/api/diff' + qs({ name: P, a: pos[0], b: pos[1], layer: opt.layer }))).text); },
  snap: async () => console.log((await call('POST', '/api/snap', { name: P, frames: pos[0], scale: opt.scale, layer: opt.layer, onion: !!opt.onion, tag: opt.tag, cols: opt.cols })).path),
  stamp: async () => {
    need(2, 'stamp <프레임> <레이어> [x y] < 글자파일');
    const rows = readRows();
    await op({ type: 'stamp', frames: pos[0], layer: pos[1], x: num(pos[2] ?? 0, 'x'), y: num(pos[3] ?? 0, 'y'), rows });
  },
  px: async () => {
    need(3, 'px <프레임> <레이어> x,y,색 ...');
    const set = pos.slice(2).map((t) => { const [x, y, ...c] = t.split(','); return [num(x, 'x'), num(y, 'y'), c.join(',')]; });
    await op({ type: 'pixels', frames: pos[0], layer: pos[1], set });
  },
  ...Object.fromEntries(['line', 'rect', 'ellipse'].map((k) => [k, async () => {
    need(7, `${k} <프레임> <레이어> x0 y0 x1 y1 <색> [--fill]`);
    const [f, l, x0, y0, x1, y1, color] = pos;
    await op({ type: 'shape', kind: k, frames: f, layer: l, x0: num(x0), y0: num(y0), x1: num(x1), y1: num(y1), color, fill: !!opt.fill, size: opt.size ? num(opt.size) : 1 });
  }])),
  fill: async () => { need(5, 'fill <프레임> <레이어> x y <색> [--global]'); await op({ type: 'fill', frames: pos[0], layer: pos[1], x: num(pos[2]), y: num(pos[3]), color: pos[4], contiguous: !opt.global }); },
  shift: async () => { need(4, 'shift <프레임> <레이어> dx dy'); await op({ type: 'shift', frames: pos[0], layer: pos[1], dx: num(pos[2]), dy: num(pos[3]), wrap: !!opt.wrap, region: region() }); },
  flip: async () => { need(3, 'flip <프레임> <레이어> h|v'); await op({ type: 'flip', frames: pos[0], layer: pos[1], axis: pos[2], region: region() }); },
  rotate: async () => { need(3, 'rotate <프레임> <레이어> 90|180|270'); await op({ type: 'rotate', frames: pos[0], layer: pos[1], deg: num(pos[2]), region: region() }); },
  replace: async () => { need(4, 'replace <프레임> <레이어|all> <색1> <색2>'); await op({ type: 'replace', frames: pos[0], layers: pos[1], from: pos[2], to: pos[3] }); },
  outline: async () => { need(3, 'outline <프레임> <레이어> <색>'); await op({ type: 'outline', frames: pos[0], layer: pos[1], color: pos[2], diagonal: !!opt.diagonal }); },
  clear: async () => { need(2, 'clear <프레임> <레이어>'); await op({ type: 'clear', frames: pos[0], layer: pos[1], region: region() }); },
  frame: async () => {
    const sub = pos.shift();
    if (sub === 'add') await op({ type: 'addFrame', at: pos[0] != null ? num(pos[0]) : undefined, from: opt.from != null ? num(opt.from) : null, link: !!opt.link, ms: opt.ms ? num(opt.ms) : undefined, count: opt.count ? num(opt.count) : 1 });
    else if (sub === 'dup') { need(1, 'frame dup <f>'); const f = num(pos[0]); await op({ type: 'addFrame', at: f + 1, from: f, link: !!opt.link, count: opt.count ? num(opt.count) : 1 }); }
    else if (sub === 'del') { need(1, 'frame del <프레임>'); await op({ type: 'delFrames', frames: pos[0] }); }
    else if (sub === 'move') { need(2, 'frame move <프레임> <새위치>'); await op({ type: 'moveFrames', frames: pos[0], to: num(pos[1]) }); }
    else if (sub === 'ms') { need(2, 'frame ms <프레임> <ms>'); await op({ type: 'duration', frames: pos[0], ms: num(pos[1]) }); }
    else console.error('frame add|dup|del|move|ms');
  },
  cel: async () => {
    const sub = pos.shift();
    if (sub === 'copy') { need(3, 'cel copy <f> <레이어> <대상프레임> [대상레이어] [--link]'); await op({ type: 'copyCel', from: { frame: pos[0], layer: pos[1] }, to: { frame: pos[2], layer: pos[3] ?? pos[1] }, link: !!opt.link }); }
    else if (sub === 'link') { need(2, 'cel link <프레임들> <레이어>'); await op({ type: 'link', frames: pos[0], layer: pos[1] }); }
    else if (sub === 'unlink') { need(2, 'cel unlink <프레임> <레이어>'); await op({ type: 'unlink', frames: pos[0], layer: pos[1] }); }
    else console.error('cel copy|link|unlink');
  },
  layer: async () => {
    const sub = pos.shift();
    const L = pos[0];
    if (sub === 'add') await op({ type: 'addLayer', name: L, at: opt.at != null ? num(opt.at) : undefined });
    else if (sub === 'dup') await op({ type: 'dupLayer', layer: L });
    else if (sub === 'del') await op({ type: 'delLayer', layer: L });
    else if (sub === 'rename') await op({ type: 'layer', layer: L, name: pos[1] });
    else if (sub === 'move') await op({ type: 'moveLayer', layer: L, to: num(pos[1]) });
    else if (sub === 'hide' || sub === 'show') await op({ type: 'layer', layer: L, visible: sub === 'show' });
    else if (sub === 'lock' || sub === 'unlock') await op({ type: 'layer', layer: L, locked: sub === 'lock' });
    else if (sub === 'opacity') await op({ type: 'layer', layer: L, opacity: num(pos[1]) });
    else if (sub === 'merge') await op({ type: 'mergeDown', layer: L });
    else console.error('layer add|dup|del|rename|move|hide|show|lock|unlock|opacity|merge');
  },
  tag: async () => {
    const sub = pos.shift();
    if (sub === 'add') { need(3, 'tag add <이름> <from> <to> [방향]'); await op({ type: 'addTag', name: pos[0], from: pos[1], to: pos[2], dir: pos[3] }); }
    else if (sub === 'edit') await op({ type: 'editTag', name: pos[0], from: opt.from, to: opt.to, dir: opt.dir, rename: opt.rename });
    else if (sub === 'del') await op({ type: 'delTag', name: pos[0] });
    else console.error('tag add|edit|del');
  },
  pal: async () => {
    const sub = pos.shift();
    if (!sub) { const t = (await call('GET', '/api/info' + qs({ name: P }))).text; console.log(t.slice(t.indexOf('팔레트'))); }
    else if (sub === 'add') await op({ type: 'palAdd', color: pos[0], ch: pos[1], name: pos[2] });
    else if (sub === 'set') await op({ type: 'palSet', ch: pos[0], color: pos[1], name: opt.name });
    else if (sub === 'clean') await op({ type: 'palClean' });
    else console.error('pal [add|set|clean]');
  },
  motion: async () => { need(2, 'motion <프레임> <dx>'); await op({ type: 'motion', frames: pos[0], dx: num(pos[1]) }); },
  lift: async () => { need(2, 'lift <프레임> <y>'); await op({ type: 'lift', frames: pos[0], y: num(pos[1]) }); },
  resize: async () => { need(2, 'resize <w> <h> [기준]'); await op({ type: 'resize', w: num(pos[0]), h: num(pos[1]), anchor: pos[2] || 'b' }); },
  pivot: async () => { need(2, 'pivot <x> <y>'); await op({ type: 'pivot', x: num(pos[0]), y: num(pos[1]) }); },
  undo: async () => { const r = await call('POST', '/api/op', { name: P, actor: 'AI', op: { type: 'undo', n: pos[0] ? num(pos[0]) : 1 } }); console.log(`✓ ${r.label}`); },
  redo: async () => { const r = await call('POST', '/api/op', { name: P, actor: 'AI', op: { type: 'redo', n: pos[0] ? num(pos[0]) : 1 } }); console.log(`✓ ${r.label}`); },
  goto: async () => { need(1, 'goto <기록번호>'); const r = await call('POST', '/api/op', { name: P, actor: 'AI', op: { type: 'goto', pos: num(pos[0]) } }); console.log(`✓ ${r.label}`); },
  op: async () => { need(1, "op '<JSON>'"); await op(JSON.parse(pos[0])); },
  new: async () => {
    need(1, 'new <이름> [w h]');
    const r = await call('POST', '/api/new', { name: pos[0], w: pos[1], h: pos[2], paletteFrom: opt.palette, copyOf: opt.copy, actor: 'AI' });
    console.log(`✓ 만듦: ${r.name}  (사람 화면에서 열려면: open ${r.name})`);
  },
  open: async () => { need(1, 'open <이름>'); await call('POST', '/api/open', { name: pos[0] }); console.log(`✓ 화면을 ${pos[0]} 로 바꿈`); },
  import: async () => {
    need(2, 'import <png경로> <이름> [--cell 32x32]');
    const [cw, ch] = opt.cell ? String(opt.cell).split('x').map(Number) : [];
    const r = await call('POST', '/api/import', { path: path.resolve(pos[0]), name: pos[1], cellW: cw, cellH: ch, scale: opt.scale && opt.scale !== 'auto' ? num(opt.scale) : 'auto', ms: opt.ms, paletteFrom: opt.palette, actor: 'AI' });
    console.log(`✓ ${r.name}: 원본 ${r.src} → ${r.size}, 프레임 ${r.frames}, 색 ${r.colors}${r.warnings.length ? '\n  ' + r.warnings.join('\n  ') : ''}`);
  },
  export: async () => {
    const r = await call('POST', '/api/export', { name: P, layout: opt.layout, scale: opt.scale, cols: opt.cols });
    console.log(`✓ 시트 ${r.size} (${r.grid})\n  ${r.files.join('\n  ')}`);
  },
};

if (!cmd || !C[cmd]) { console.log(HELP); if (cmd) { console.error(`모르는 명령: ${cmd}`); process.exit(1); } }
else await C[cmd]();
