import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseClock, isDue, nextFireAt } from '../src/scheduler.js';

test('parseDuration converte unidades em ms', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('5h'), 18_000_000);
  assert.equal(parseDuration('1d'), 86_400_000);
});

test('parseDuration rejeita formato invalido', () => {
  assert.throws(() => parseDuration('abc'));
  assert.throws(() => parseDuration('10'));
  assert.throws(() => parseDuration('-5m'));
});

test('parseClock retorna a proxima ocorrencia HH:MM hoje', () => {
  const now = new Date('2026-05-31T10:00:00').getTime();
  assert.equal(parseClock('14:30', now), new Date('2026-05-31T14:30:00').getTime());
});

test('parseClock pula para amanha se o horario ja passou', () => {
  const now = new Date('2026-05-31T15:00:00').getTime();
  assert.equal(parseClock('14:30', now), new Date('2026-06-01T14:30:00').getTime());
});

test('isDue: true quando fireAt <= now', () => {
  assert.equal(isDue({ fireAt: 100 }, 100), true);
  assert.equal(isDue({ fireAt: 101 }, 100), false);
  assert.equal(isDue({ fireAt: null }, 100), false);
});

test('nextFireAt: interval recalcula a partir de now', () => {
  const job = { mode: 'interval', everyMs: 1000 };
  assert.equal(nextFireAt(job, 5000), 6000);
});

test('nextFireAt: at diario soma 1 dia', () => {
  const now = new Date('2026-05-31T14:30:00').getTime();
  const job = { mode: 'at', time: '14:30', daily: true };
  assert.equal(nextFireAt(job, now), new Date('2026-06-01T14:30:00').getTime());
});

test('nextFireAt: once ou at nao-diario retorna null (encerra)', () => {
  assert.equal(nextFireAt({ mode: 'once' }, 1000), null);
  assert.equal(nextFireAt({ mode: 'at', time: '14:30', daily: false }, 1000), null);
});
