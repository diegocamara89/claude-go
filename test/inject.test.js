import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, buildPasteSequence, injectMessage } from '../src/inject.js';

test('sanitize remove controle e quebras de linha', () => {
  assert.equal(sanitize('ola\nmundo\r\t'), 'olamundo');
  assert.equal(sanitize('olá áéí'), 'olá áéí');
});

test('buildPasteSequence envolve a mensagem em bracketed paste', () => {
  assert.equal(buildPasteSequence('oi'), '\x1b[200~oi\x1b[201~');
});

test('injectMessage escreve paste e depois Enter apos o delay', () => {
  const writes = [];
  const fakePty = { write: (s) => writes.push(s) };
  const timers = [];
  const fakeSetTimeout = (fn) => { timers.push(fn); };
  injectMessage(fakePty, 'olá', { enterDelayMs: 80, setTimeoutFn: fakeSetTimeout });
  assert.equal(writes[0], '\x1b[200~olá\x1b[201~');
  assert.equal(writes.length, 1);
  timers[0]();
  assert.equal(writes[1], '\r');
});
