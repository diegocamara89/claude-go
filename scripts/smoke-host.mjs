// Smoke de integração do HOST completo (claude-go.js) — sem o Claude real.
// Lança o claude-go num PTY com um "Claude" falso, deixa ele alocar a janela #1,
// e injeta um job na inbox dessa janela. Prova: alocação de rótulo + passthrough +
// detector de ociosidade + scheduler + injeção via PTY + markDone, ponta a ponta.
// Saída: SMOKE_OK / SMOKE_FAIL.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from '@lydell/node-pty';
import { createJob, writeJob, ensureDirs } from '../src/queue.js';
import { sessionDir } from '../src/sessions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = process.cwd();
const base = mkdtempSync(join(tmpdir(), 'smoke-host-'));

const child = pty.spawn(process.execPath, [join(root, 'src', 'claude-go.js')], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: root,
  env: {
    ...process.env,
    CLAUDE_GO_QUEUE_DIR: base,
    CLAUDE_GO_CLAUDE_PATH: process.execPath,
    CLAUDE_GO_CLAUDE_ARGS: JSON.stringify([join(root, 'scripts', 'fake-claude.mjs')]),
    CLAUDE_GO_IDLE_MS: '300',
    CLAUDE_GO_POLL_MS: '200',
    CLAUDE_GO_ENTER_DELAY_MS: '50',
  },
});

let out = '';
child.onData((d) => { out += d; });

// 1) deixa o claude-go subir e alocar a janela #1
await sleep(1200);
const inbox = sessionDir(base, 1);
const alocou = existsSync(inbox);

// 2) injeta um job já vencido na inbox da janela #1
if (!existsSync(join(inbox, 'pending'))) ensureDirs(inbox);
writeJob(inbox, createJob({ message: 'ping-host', mode: 'once', fireAt: 1 }, 'job-1'));

// 3) aguarda o disparo
await sleep(2500);
child.kill();
await sleep(200);
try { child._socket?.destroy(); } catch { /* ignore */ }

const recebeu = out.includes('RECEBIDO:ping-host');
const foiParaDone = existsSync(join(inbox, 'done', 'job-1.json'));
const tituloComLabel = out.includes('#1 ·') || out.includes('#1 ');

console.log('--- saída capturada do PTY ---');
console.log(JSON.stringify(out));
console.log('ALOCOU_JANELA_1 =', alocou);
console.log('TITULO_COM_LABEL =', tituloComLabel);
console.log('RECEBEU_MENSAGEM =', recebeu);
console.log('JOB_EM_DONE =', foiParaDone);

rmSync(base, { recursive: true, force: true });

if (alocou && recebeu && foiParaDone) {
  console.log('SMOKE_OK');
  process.exit(0);
} else {
  console.log('SMOKE_FAIL');
  process.exit(1);
}
