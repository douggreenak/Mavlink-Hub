'use strict';
// The hub stops by itself when the program that owns it (the Windows or Mac app) is gone, so it is never left running in the background.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ports = () => { const b = 20000 + Math.floor(Math.random() * 20000); return { WEB_PORT: String(b), UDP_PORT: String(b + 1) }; };
const until = async (fn, ms) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };

test('the hub exits shortly after the process named in HUB_EXIT_WITH ends, and keeps running while it lives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-owner-'));
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore' });
  const hub = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, DATA_DIR: dir, ...ports(), AIRSPACE: 'off', HUB_EXIT_WITH: String(owner.pid) }, stdio: 'ignore' });
  let hubGone = false, ownerGone = false; hub.on('exit', () => { hubGone = true; }); owner.on('exit', () => { ownerGone = true; });
  try {
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(hubGone, false, 'still running while its owner is');
    assert.ok(await until(() => ownerGone, 5000), 'the owner ended');
    assert.ok(await until(() => hubGone, 6000), 'the hub stopped itself after its owner ended');
  } finally { hub.kill(); owner.kill(); }
});

test('without HUB_EXIT_WITH the hub is not tied to anything', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-owner-'));
  const hub = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, DATA_DIR: dir, ...ports(), AIRSPACE: 'off', HUB_EXIT_WITH: '' }, stdio: 'ignore' });
  let gone = false; hub.on('exit', () => { gone = true; });
  try { await new Promise((r) => setTimeout(r, 3500)); assert.equal(gone, false); } finally { hub.kill(); }
});
