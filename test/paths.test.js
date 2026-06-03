import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveQueueDir } from '../src/paths.js';

test('usa CLAUDE_GO_QUEUE_DIR quando definido', () => {
  assert.equal(resolveQueueDir({ CLAUDE_GO_QUEUE_DIR: 'D:\\fila' }, 'C:\\Users\\x'), 'D:\\fila');
});

test('cai no homedir/.claude-disparador quando ausente', () => {
  const got = resolveQueueDir({}, 'C:\\Users\\x');
  assert.ok(got.endsWith('.claude-disparador'));
  assert.ok(got.startsWith('C:\\Users\\x'));
});
