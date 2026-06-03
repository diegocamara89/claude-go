import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTitleSeq, prefixTitles, labelPrefix } from '../src/title.js';

test('setTitleSeq monta a sequência OSC com o rótulo', () => {
  assert.equal(setTitleSeq(2), '\x1b]0;#2 · claude\x07');
  assert.equal(setTitleSeq(2, 'foo'), '\x1b]0;#2 · foo\x07');
});

test('prefixTitles adiciona o prefixo #N a um título do Claude', () => {
  const input = 'antes\x1b]0;C:\\node.exe\x07depois';
  assert.equal(prefixTitles(input, 3), 'antes\x1b]0;#3 · C:\\node.exe\x07depois');
});

test('prefixTitles não duplica prefixo já presente', () => {
  const already = '\x1b]0;#3 · claude\x07';
  assert.equal(prefixTitles(already, 3), already);
});

test('prefixTitles ignora dados sem OSC de título', () => {
  const data = 'texto normal \x1b[31mvermelho\x1b[0m sem titulo';
  assert.equal(prefixTitles(data, 1), data);
});

test('labelPrefix', () => {
  assert.equal(labelPrefix(7), '#7 · ');
});
