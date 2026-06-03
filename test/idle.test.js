import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleTracker } from '../src/idle.js';

test('estado inicial é unknown antes de qualquer saida', () => {
  const t = createIdleTracker({ idleMs: 1000 });
  assert.equal(t.state(0), 'unknown');
});

test('busy logo apos saida, idle-prompt apos silencio >= idleMs', () => {
  const t = createIdleTracker({ idleMs: 1000 });
  t.onData(5000);
  assert.equal(t.state(5500), 'busy');
  assert.equal(t.state(6000), 'idle-prompt');
});
