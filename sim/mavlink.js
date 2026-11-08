'use strict';
// A small, spec-driven MAVLink v1/v2 encoder plus a reference decoder, used by the test-flight
// simulator and the test suite. Wire order and CRC_EXTRA are computed from sim/spec.js (extracted
// from the official XML), so nothing here shares code or tables with the dashboard's decoder.
const { MESSAGES } = require('./spec.js');

const SIZE = { uint64_t: 8, int64_t: 8, double: 8, uint32_t: 4, int32_t: 4, float: 4, uint16_t: 2, int16_t: 2, uint8_t: 1, int8_t: 1, char: 1 };

// X.25 CRC as used by MAVLink (seeded 0xffff).
function crcAccumulate(crc, b) {
  let tmp = (b ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}
function crc16(bytes, extra) {
  let crc = 0xffff;
  for (const b of bytes) crc = crcAccumulate(crc, b);
  if (extra != null) crc = crcAccumulate(crc, extra);
  return crc;
}

// Fields in wire order: base fields sorted by element size (stable), then extensions in XML order.
function layout(def) {
  const base = def.fields.filter((f) => !f[3]).map((f, i) => ({ t: f[0], n: f[1], al: f[2], i }));
  base.sort((a, b) => SIZE[b.t] - SIZE[a.t] || a.i - b.i);
  const ext = def.fields.filter((f) => f[3]).map((f, i) => ({ t: f[0], n: f[1], al: f[2], i }));
  let o = 0;
  const place = (f) => { f.o = o; f.sz = SIZE[f.t] * (f.al || 1); o += f.sz; return f; };
  const b = base.map(place), baseLen = o, e = ext.map(place);
  return { base: b, ext: e, baseLen, fullLen: o };
}

// CRC_EXTRA: CRC over "NAME " then "type name " per base field in wire order (+ array length byte).
function crcExtra(name, lay) {
  let c = 0xffff;
  const str = (s) => { for (const ch of Buffer.from(s)) c = crcAccumulate(c, ch); };
  str(name + ' ');
  for (const f of lay.base) { str(f.t + ' '); str(f.n + ' '); if (f.al) c = crcAccumulate(c, f.al); }
  return (c & 0xff) ^ (c >> 8);
}

const BY_NAME = {}, BY_ID = {};
for (const [name, def] of Object.entries(MESSAGES)) {
  const lay = layout(def);
  const m = { name, id: def.id, lay, extra: crcExtra(name, lay) };
  BY_NAME[name] = m; BY_ID[def.id] = m;
}

function writeScalar(buf, f, off, v) {
  v = v == null ? 0 : v;
  switch (f.t) {
    case 'uint8_t': buf.writeUInt8(v & 0xff, off); break;
    case 'int8_t': buf.writeInt8(Math.max(-128, Math.min(127, v)), off); break;
    case 'uint16_t': buf.writeUInt16LE(v & 0xffff, off); break;
    case 'int16_t': buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), off); break;
    case 'uint32_t': buf.writeUInt32LE(v >>> 0, off); break;
    case 'int32_t': buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(v))), off); break;
    case 'uint64_t': buf.writeBigUInt64LE(BigInt(Math.max(0, Math.round(v))), off); break;
    case 'int64_t': buf.writeBigInt64LE(BigInt(Math.round(v)), off); break;
    case 'float': buf.writeFloatLE(v, off); break;
    case 'double': buf.writeDoubleLE(v, off); break;
    default: throw new Error('unsupported type ' + f.t);
  }
}

// Build the payload bytes (all fields, including extensions) from a {name: value} object.
function payloadOf(name, values) {
  const m = BY_NAME[name]; if (!m) throw new Error('unknown message ' + name);
  const buf = Buffer.alloc(m.lay.fullLen);
  for (const f of [...m.lay.base, ...m.lay.ext]) {
    const v = values[f.n];
    if (f.t === 'char') { buf.write(String(v == null ? '' : v).slice(0, f.al), f.o, 'latin1'); continue; }
    if (f.al) { for (let k = 0; k < f.al; k++) writeScalar(buf, f, f.o + k * SIZE[f.t], v && v[k]); continue; }
    writeScalar(buf, f, f.o, v);
  }
  return buf;
}

// Encode one frame. opts: v2 (default true), seq, sysid, compid, signed, corrupt, trim (v2 only, default true).
function frame(name, values, opts = {}) {
  const { v2 = true, seq = 0, sysid = 1, compid = 1, signed = false, corrupt = false } = opts;
  const m = BY_NAME[name];
  let p = payloadOf(name, values);
  if (!v2) p = p.subarray(0, m.lay.baseLen);            // v1 has no extension fields
  else if (opts.trim !== false) { let n = p.length; while (n > 1 && p[n - 1] === 0) n--; p = p.subarray(0, n); }
  if (!v2 && m.id > 255) throw new Error(name + ' does not exist in MAVLink 1');
  const hdr = v2
    ? Buffer.from([0xfd, p.length, signed ? 1 : 0, 0, seq & 255, sysid, compid, m.id & 255, (m.id >> 8) & 255, (m.id >> 16) & 255])
    : Buffer.from([0xfe, p.length, seq & 255, sysid, compid, m.id]);
  let c = crc16(Buffer.concat([hdr.subarray(1), p]), m.extra);
  if (corrupt) c ^= 0x5a5a;
  const parts = [hdr, p, Buffer.from([c & 255, c >> 8])];
  if (signed && v2) parts.push(Buffer.alloc(13, 0xa5));
  return Buffer.concat(parts);
}

function readScalar(buf, f, off) {
  switch (f.t) {
    case 'uint8_t': return buf.readUInt8(off); case 'int8_t': return buf.readInt8(off);
    case 'uint16_t': return buf.readUInt16LE(off); case 'int16_t': return buf.readInt16LE(off);
    case 'uint32_t': return buf.readUInt32LE(off); case 'int32_t': return buf.readInt32LE(off);
    case 'uint64_t': return Number(buf.readBigUInt64LE(off)); case 'int64_t': return Number(buf.readBigInt64LE(off));
    case 'float': return buf.readFloatLE(off); case 'double': return buf.readDoubleLE(off);
    default: throw new Error('unsupported type ' + f.t);
  }
}

// Reference decoder: every complete, CRC-valid frame in `buf` as {name, id, seq, sysid, compid, values}.
// Unknown ids and bad checksums are skipped. Used to check the encoder and the simulator.
function decodeAll(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i]; if (s !== 0xfd && s !== 0xfe) continue;
    const v2 = s === 0xfd, len = buf[i + 1], hdr = v2 ? 10 : 6;
    const end = i + hdr + len + 2 + (v2 && (buf[i + 2] & 1) ? 13 : 0);
    if (len === undefined || end > buf.length) continue;
    const id = v2 ? buf[i + 7] | buf[i + 8] << 8 | buf[i + 9] << 16 : buf[i + 5], m = BY_ID[id];
    if (!m) continue;
    const got = buf[i + hdr + len] | buf[i + hdr + len + 1] << 8;
    if (crc16(buf.subarray(i + 1, i + hdr + len), m.extra) !== got) continue;
    const p = Buffer.alloc(m.lay.fullLen); buf.copy(p, 0, i + hdr, i + hdr + Math.min(len, m.lay.fullLen));
    const values = {};
    for (const f of [...m.lay.base, ...m.lay.ext]) {
      if (f.t === 'char') { values[f.n] = p.toString('latin1', f.o, f.o + f.al).replace(/\0.*$/s, ''); continue; }
      if (f.al) { values[f.n] = Array.from({ length: f.al }, (_, k) => readScalar(p, f, f.o + k * SIZE[f.t])); continue; }
      values[f.n] = readScalar(p, f, f.o);
    }
    out.push({ name: m.name, id, seq: v2 ? buf[i + 4] : buf[i + 2], sysid: v2 ? buf[i + 5] : buf[i + 3], compid: v2 ? buf[i + 6] : buf[i + 4], values });
    i = end - 1;
  }
  return out;
}

module.exports = { frame, payloadOf, decodeAll, crc16, crcExtra, layout, BY_NAME, BY_ID, MESSAGES };
