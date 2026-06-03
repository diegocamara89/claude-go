import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocLabel, listSessions, isAlive, writeHeartbeat, sessionDir, removeSession, HEARTBEAT_TTL_MS,
} from '../src/sessions.js';

function tmpBase() { return mkdtempSync(join(tmpdir(), 'dispsess-')); }

test('allocLabel atribui 1, depois 2, para janelas vivas', () => {
  const base = tmpBase();
  const now = 1_000_000;
  const a = allocLabel(base, { pid: 10 }, now);
  const b = allocLabel(base, { pid: 11 }, now);
  assert.equal(a.label, 1);
  assert.equal(b.label, 2);
  assert.ok(existsSync(join(sessionDir(base, 1), 'pending')));
  rmSync(base, { recursive: true, force: true });
});

test('allocLabel recicla o rótulo de uma janela morta', () => {
  const base = tmpBase();
  const now = 1_000_000;
  allocLabel(base, { pid: 10 }, now);                 // #1 vivo em t=now
  // tenta alocar muito depois: #1 está morto (heartbeat velho) -> deve reciclar 1
  const later = now + HEARTBEAT_TTL_MS + 1;
  const b = allocLabel(base, { pid: 99 }, later);
  assert.equal(b.label, 1);
  rmSync(base, { recursive: true, force: true });
});

test('isAlive: vivo com heartbeat recente, morto com heartbeat velho', () => {
  const base = tmpBase();
  const now = 5_000_000;
  const { dir } = allocLabel(base, { pid: 1 }, now);
  assert.equal(isAlive(dir, now + 1000), true);
  assert.equal(isAlive(dir, now + HEARTBEAT_TTL_MS + 1), false);
  rmSync(base, { recursive: true, force: true });
});

test('writeHeartbeat renova o tempo de vida', () => {
  const base = tmpBase();
  const now = 5_000_000;
  const { dir } = allocLabel(base, { pid: 1 }, now);
  const renew = now + HEARTBEAT_TTL_MS - 1;
  writeHeartbeat(dir, { pid: 1, label: 1 }, renew);
  assert.equal(isAlive(dir, renew + 1000), true);
  rmSync(base, { recursive: true, force: true });
});

test('listSessions lista rótulos com estado de vida', () => {
  const base = tmpBase();
  const now = 9_000_000;
  allocLabel(base, { pid: 1 }, now);
  allocLabel(base, { pid: 2 }, now);
  const list = listSessions(base, now + 1000);
  assert.deepEqual(list.map((s) => s.label), [1, 2]);
  assert.ok(list.every((s) => s.alive));
  // depois do TTL, ambas mortas
  const dead = listSessions(base, now + HEARTBEAT_TTL_MS + 1);
  assert.ok(dead.every((s) => !s.alive));
  rmSync(base, { recursive: true, force: true });
});

test('removeSession apaga o diretório da janela', () => {
  const base = tmpBase();
  const { label, dir } = allocLabel(base, { pid: 1 }, 1000);
  assert.ok(existsSync(dir));
  removeSession(base, label);
  assert.equal(existsSync(dir), false);
  rmSync(base, { recursive: true, force: true });
});
