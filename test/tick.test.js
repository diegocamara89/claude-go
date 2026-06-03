import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, writeJob, ensureDirs, readPending } from '../src/queue.js';
import { schedulerTick } from '../src/tick.js';

function tmpQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'disptick-'));
  ensureDirs(dir);
  return dir;
}

// child falso que captura o que seria escrito no PTY
function fakeChild() {
  const writes = [];
  return { writes, write: (s) => writes.push(s) };
}

const idleAlways = { state: () => 'idle-prompt' };
const busyAlways = { state: () => 'busy' };

test('tick: job once due em idle -> injeta (paste) e move para done', () => {
  const dir = tmpQueue();
  writeJob(dir, createJob({ message: 'oi', mode: 'once', fireAt: 100 }, 'id-1'));
  const child = fakeChild();

  const fired = schedulerTick({ queueDir: dir, sid: 'sA', child, idle: idleAlways, now: 200, enterDelayMs: 80 });

  assert.equal(fired?.id, 'id-1');
  assert.equal(child.writes[0], '\x1b[200~oi\x1b[201~'); // bracketed paste
  assert.equal(existsSync(join(dir, 'done', 'id-1.json')), true);
  assert.equal(readPending(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('tick: quando busy nao injeta e o job continua em pending', () => {
  const dir = tmpQueue();
  writeJob(dir, createJob({ message: 'oi', mode: 'once', fireAt: 100 }, 'id-1'));
  const child = fakeChild();

  const fired = schedulerTick({ queueDir: dir, sid: 'sA', child, idle: busyAlways, now: 200, enterDelayMs: 80 });

  assert.equal(fired, null);
  assert.equal(child.writes.length, 0);
  assert.equal(readPending(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('tick: job nao due nao dispara', () => {
  const dir = tmpQueue();
  writeJob(dir, createJob({ message: 'oi', mode: 'once', fireAt: 1000 }, 'id-1'));
  const child = fakeChild();

  const fired = schedulerTick({ queueDir: dir, sid: 'sA', child, idle: idleAlways, now: 200, enterDelayMs: 80 });

  assert.equal(fired, null);
  assert.equal(child.writes.length, 0);
  assert.equal(readPending(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('tick: job interval re-agenda em pending com novo fireAt', () => {
  const dir = tmpQueue();
  writeJob(dir, createJob({ message: 'ping', mode: 'interval', everyMs: 1000, fireAt: 100 }, 'id-1'));
  const child = fakeChild();

  const fired = schedulerTick({ queueDir: dir, sid: 'sA', child, idle: idleAlways, now: 5000, enterDelayMs: 80 });

  assert.equal(fired?.id, 'id-1');
  assert.equal(child.writes[0], '\x1b[200~ping\x1b[201~');
  assert.equal(existsSync(join(dir, 'done', 'id-1.json')), false); // nao encerrou
  const pend = readPending(dir);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].fireAt, 6000); // now + everyMs
  rmSync(dir, { recursive: true, force: true });
});

test('tick: nao dispara o mesmo job duas vezes (claim ja consumido)', () => {
  const dir = tmpQueue();
  writeJob(dir, createJob({ message: 'oi', mode: 'once', fireAt: 100 }, 'id-1'));
  const child = fakeChild();

  schedulerTick({ queueDir: dir, sid: 'sA', child, idle: idleAlways, now: 200, enterDelayMs: 80 });
  const second = schedulerTick({ queueDir: dir, sid: 'sA', child, idle: idleAlways, now: 200, enterDelayMs: 80 });

  assert.equal(second, null);
  assert.equal(child.writes.length, 1); // injetou só uma vez
  rmSync(dir, { recursive: true, force: true });
});
