import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from '@lydell/node-pty';
import { injectMessage } from '../src/inject.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('injeta mensagem com acentos no PTY e o processo recebe', async () => {
  // Remove NODE_TEST_CONTEXT para que a fixture não se auto-encerre ao detectar o runner
  const { NODE_TEST_CONTEXT: _, ...childEnv } = process.env;
  const child = pty.spawn(process.execPath, [join(__dirname, 'fixtures', 'echo.js')], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: __dirname, env: childEnv,
  });

  let out = '';
  child.onData((d) => { out += d; });

  // Aguarda exit para garantir que o PTY seja encerrado antes de continuar
  const exitPromise = new Promise((r) => child.onExit(() => r()));

  await new Promise((r) => setTimeout(r, 400));
  injectMessage(child, 'olá áéí', { enterDelayMs: 50 });

  await new Promise((r) => setTimeout(r, 800));
  child.kill();

  // Aguarda até 2s pelo exit do processo filho no ConPTY (Windows)
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2000))]);

  // Força destruição do socket interno para não bloquear o event loop do runner
  try { child._socket?.destroy(); } catch (_) {}
  try { child._agent?._outSocket?.destroy(); } catch (_) {}
  try { child._agent?._inSocket?.destroy(); } catch (_) {}

  // Verifica o prefixo RECEBIDO: (saída da fixture), não apenas o texto — assim
  // provamos que a mensagem chegou ao STDIN do processo, e não apenas o eco do terminal.
  assert.ok(out.includes('RECEBIDO:olá áéí'),
    `a fixture não recebeu a mensagem com acentos via stdin. out=${JSON.stringify(out)}`);
});
