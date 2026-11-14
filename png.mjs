// 아주 작은 PNG 읽기/쓰기 (Node zlib 만 사용). 8비트 그레이/RGB/팔레트/그레이+알파/RGBA, 비인터레이스.
import zlib from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function decodePNG(buf) {
  buf = Buffer.from(buf);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 파일이 아님');
  let p = 8, w, h, depth, ctype, interlace, plte, trns;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('인터레이스 PNG 는 못 읽음');
  if (depth !== 8 && !(ctype === 3 && depth < 8)) throw new Error(`비트 깊이 ${depth} 는 못 읽음`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch) throw new Error(`색 형식 ${ctype} 은 못 읽음`);
  const bpp = Math.max(1, (ch * depth) >> 3);
  const stride = Math.ceil((w * ch * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i] = v & 255;
    }
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, r = px.subarray(y * stride);
    if (ctype === 6) { rgba[o] = r[x * 4]; rgba[o + 1] = r[x * 4 + 1]; rgba[o + 2] = r[x * 4 + 2]; rgba[o + 3] = r[x * 4 + 3]; }
    else if (ctype === 2) { rgba[o] = r[x * 3]; rgba[o + 1] = r[x * 3 + 1]; rgba[o + 2] = r[x * 3 + 2]; rgba[o + 3] = 255; }
    else if (ctype === 0) { rgba[o] = rgba[o + 1] = rgba[o + 2] = r[x]; rgba[o + 3] = 255; }
    else if (ctype === 4) { rgba[o] = rgba[o + 1] = rgba[o + 2] = r[x * 2]; rgba[o + 3] = r[x * 2 + 1]; }
    else {
      const per = 8 / depth, byte = r[Math.floor(x / per)], shift = 8 - depth * ((x % per) + 1);
      const i = (byte >> shift) & ((1 << depth) - 1);
      rgba[o] = plte[i * 3]; rgba[o + 1] = plte[i * 3 + 1]; rgba[o + 2] = plte[i * 3 + 2];
      rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
    }
  }
  return { w, h, rgba };
}
