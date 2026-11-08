'use strict';
// Minimal MAVLink v1/v2 frame encoder used only by the tests. It is written from the spec,
// independently of the decoder in index.html, so each one checks the other.
// Payload builders lay fields out in wire order (sorted by size, as MAVLink requires).

const ID = { HEARTBEAT: 0, SYS_STATUS: 1, ATTITUDE: 30, GLOBAL_POSITION_INT: 33, VFR_HUD: 74, RADIO_STATUS: 109, STATUSTEXT: 253 };
const CRC_EXTRA = { HEARTBEAT: 50, SYS_STATUS: 124, ATTITUDE: 39, GLOBAL_POSITION_INT: 104, VFR_HUD: 20, RADIO_STATUS: 185, STATUSTEXT: 83 };

// X.25 / CRC-16-MCRF4XX as used by MAVLink, seeded with 0xffff, extra byte appended.
function crc16(bytes, extra) {
  let crc = 0xffff;
  const acc = (b) => {
    let tmp = (b ^ (crc & 0xff)) & 0xff;
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  };
  for (const b of bytes) acc(b);
  if (extra != null) acc(extra);
  return crc;
}

// Build one frame. v2 frames drop trailing zero payload bytes (always keeping one), as the
// spec allows; `signed` appends a 13-byte signature and sets the incompat flag;
// `corrupt` flips bits in the checksum.
function frame(name, payload, { v2 = true, seq = 0, sysid = 1, compid = 1, trim = v2, signed = false, corrupt = false } = {}) {
  if (!(name in ID)) throw new Error('unknown message ' + name);
  let p = Buffer.from(payload);
  if (trim) { let n = p.length; while (n > 1 && p[n - 1] === 0) n--; p = p.subarray(0, n); }
  const id = ID[name];
  const hdr = v2
    ? Buffer.from([0xfd, p.length, signed ? 1 : 0, 0, seq, sysid, compid, id & 255, (id >> 8) & 255, (id >> 16) & 255])
    : Buffer.from([0xfe, p.length, seq, sysid, compid, id]);
  let c = crc16(Buffer.concat([hdr.subarray(1), p]), CRC_EXTRA[name]);
  if (corrupt) c ^= 0x5555;
  const parts = [hdr, p, Buffer.from([c & 255, c >> 8])];
  if (signed && v2) parts.push(Buffer.alloc(13, 0xa5));
  return Buffer.concat(parts);
}

function heartbeat({ custom_mode = 0, type = 1, autopilot = 3, base_mode = 0, system_status = 4, mavlink_version = 3 } = {}) {
  const b = Buffer.alloc(9);
  b.writeUInt32LE(custom_mode, 0); b[4] = type; b[5] = autopilot; b[6] = base_mode; b[7] = system_status; b[8] = mavlink_version;
  return b;
}
function sysStatus({ voltage_battery = 0, current_battery = 0, battery_remaining = -1, drop_rate_comm = 0, load = 0 } = {}) {
  const b = Buffer.alloc(31);
  b.writeUInt16LE(load, 12); b.writeUInt16LE(voltage_battery, 14); b.writeInt16LE(current_battery, 16);
  b.writeUInt16LE(drop_rate_comm, 18); b.writeInt8(battery_remaining, 30);
  return b;
}
function attitude({ time_boot_ms = 0, roll = 0, pitch = 0, yaw = 0, rollspeed = 0, pitchspeed = 0, yawspeed = 0 } = {}) {
  const b = Buffer.alloc(28);
  b.writeUInt32LE(time_boot_ms, 0);
  [roll, pitch, yaw, rollspeed, pitchspeed, yawspeed].forEach((v, i) => b.writeFloatLE(v, 4 + 4 * i));
  return b;
}
function globalPosition({ time_boot_ms = 0, lat, lon, alt = 0, relative_alt = 0, vx = 0, vy = 0, vz = 0, hdg = 0 }) {
  const b = Buffer.alloc(28);
  b.writeUInt32LE(time_boot_ms, 0); b.writeInt32LE(lat, 4); b.writeInt32LE(lon, 8); b.writeInt32LE(alt, 12); b.writeInt32LE(relative_alt, 16);
  b.writeInt16LE(vx, 20); b.writeInt16LE(vy, 22); b.writeInt16LE(vz, 24); b.writeUInt16LE(hdg, 26);
  return b;
}
function vfrHud({ airspeed = 0, groundspeed = 0, alt = 0, climb = 0, heading = 0, throttle = 0 } = {}) {
  const b = Buffer.alloc(20);
  b.writeFloatLE(airspeed, 0); b.writeFloatLE(groundspeed, 4); b.writeFloatLE(alt, 8); b.writeFloatLE(climb, 12);
  b.writeInt16LE(heading, 16); b.writeUInt16LE(throttle, 18);
  return b;
}
function radioStatus({ rxerrors = 0, fixed = 0, rssi = 0, remrssi = 0, txbuf = 0, noise = 0, remnoise = 0 } = {}) {
  const b = Buffer.alloc(9);
  b.writeUInt16LE(rxerrors, 0); b.writeUInt16LE(fixed, 2); b[4] = rssi; b[5] = remrssi; b[6] = txbuf; b[7] = noise; b[8] = remnoise;
  return b;
}
function statustext(severity, text) {
  const b = Buffer.alloc(51);
  b[0] = severity; b.write(text.slice(0, 50), 1, 'latin1');
  return b;
}

module.exports = { ID, CRC_EXTRA, crc16, frame, heartbeat, sysStatus, attitude, globalPosition, vfrHud, radioStatus, statustext };
