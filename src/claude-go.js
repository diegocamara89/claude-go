#!/usr/bin/env node
import { homedir } from 'node:os';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as pty from '@lydell/node-pty';
import { resolveQueueDir } from './paths.js';
import { recoverClaimed } from './queue.js';
import { createIdleTracker } from './idle.js';
import { schedulerTick } from './tick.js';
import { allocLabel, writeHeartbeat, removeSession } from './sessions.js';
import { setTitleSeq, prefixTitles } from './title.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HEARTBEAT_INTERVAL_MS = 5000;

// Descobre o executável do Claude no PATH (where/which), para o projeto funcionar
// em qualquer máquina sem caminho fixo.
function detectClaude() {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const out = execSync(cmd, { encoding: 'utf8' });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch { return null; }
}

// Resolve o caminho do Claude: caminho configurado válido > detecção no PATH > "claude".
function resolveClaudePath(configured) {
  if (configured && existsSync(configured)) return configured;
  return detectClaude() || configured || 'claude';
}

// Prioridade: variável de ambiente > disparador.config.json > default.
// As env vars permitem apontar outra build do Claude e habilitam testes de integração.
function loadConfig(env = process.env) {
  const p = join(__dirname, '..', 'disparador.config.json');
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  const num = (k, fb) => (env[k] != null && env[k] !== '' ? Number(env[k]) : fb);
  return {
    claudePath: env.CLAUDE_GO_CLAUDE_PATH || cfg.claudePath || 'claude.exe',
    claudeArgs: env.CLAUDE_GO_CLAUDE_ARGS ? JSON.parse(env.CLAUDE_GO_CLAUDE_ARGS) : (cfg.claudeArgs || []),
    pollMs: num('CLAUDE_GO_POLL_MS', cfg.pollMs || 1000),
    idleMs: num('CLAUDE_GO_IDLE_MS', cfg.idleMs || 1500),
    enterDelayMs: num('CLAUDE_GO_ENTER_DELAY_MS', cfg.enterDelayMs || 80),
  };
}

function main() {
  const cfg = loadConfig();
  const baseDir = resolveQueueDir(process.env, homedir());

  // Aloca um rótulo curto (#1, #2, ...) e a inbox própria desta janela.
  const { label, dir: inbox } = allocLabel(baseDir, { pid: process.pid, cwd: process.cwd() }, Date.now());
  recoverClaimed(inbox); // devolve órfãos de um crash anterior desta inbox

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const claudePath = resolveClaudePath(cfg.claudePath);
  const child = pty.spawn(claudePath, cfg.claudeArgs, {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_GO_QUEUE_DIR: baseDir, CLAUDE_GO_LABEL: String(label) },
  });

  const idle = createIdleTracker({ idleMs: cfg.idleMs });

  // Define o título da aba/janela com o rótulo desta janela.
  process.stdout.write(setTitleSeq(label));

  // PTY -> tela, mantendo o prefixo #N em qualquer título que o Claude defina.
  child.onData((d) => { idle.onData(Date.now()); process.stdout.write(prefixTitles(d, label)); });

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => child.write(d.toString('utf8')));

  process.stdout.on('resize', () => child.resize(process.stdout.columns || cols, process.stdout.rows || rows));

  // Animação de identificação (cont ping): pisca o título por ~3s.
  let pingTicks = 0;
  const pingFile = join(inbox, 'control-ping');

  let lastHeartbeat = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();

    // heartbeat periódico para a janela continuar "viva" no registro
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      writeHeartbeat(inbox, { pid: process.pid, cwd: process.cwd(), label }, now);
      lastHeartbeat = now;
    }

    // pedido de identificação visual
    if (pingTicks === 0 && existsSync(pingFile)) {
      try { rmSync(pingFile, { force: true }); } catch { /* ignore */ }
      pingTicks = 6;
    }
    if (pingTicks > 0) {
      process.stdout.write(pingTicks % 2 === 0 ? setTitleSeq(label, '‹‹ AQUI ››') : setTitleSeq(label));
      pingTicks -= 1;
      if (pingTicks === 0) process.stdout.write(setTitleSeq(label));
    }

    schedulerTick({ queueDir: inbox, sid: String(label), child, idle, now, enterDelayMs: cfg.enterDelayMs });
  }, Math.min(cfg.pollMs, 500));

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(timer);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch { /* ignore */ } }
    process.stdin.pause();
    removeSession(baseDir, label); // libera o rótulo para reuso
  }

  child.onExit(({ exitCode }) => { cleanup(); process.exit(exitCode ?? 0); });
  process.on('SIGINT', () => {}); // Ctrl+C vai como \x03 ao Claude (raw mode); não mata o wrapper
  process.on('SIGBREAK', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
  process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });
}

main();
