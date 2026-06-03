#!/usr/bin/env node
// Atalho rápido para agendar uma mensagem em UMA janela do claude-go.
//   cont                      -> lista as janelas ativas (#1, #2, ...)
//   cont <n> <tempo> [msg]    -> agenda (default: "continue de onde paramos")
//   cont ping [n]             -> faz a(s) janela(s) piscarem o título para identificação
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveQueueDir } from '../src/paths.js';
import { parseDuration } from '../src/scheduler.js';
import { createJob, validateJob, writeJob, ensureDirs } from '../src/queue.js';
import { listSessions } from '../src/sessions.js';

const DEFAULT_MSG = 'continue de onde paramos';
const MAX = 2000;
const base = resolveQueueDir(process.env, homedir());
const now = Date.now();
const args = process.argv.slice(2);

function genId() { return `${Date.now()}-${randomUUID().slice(0, 8)}`; }
function activeSessions() { return listSessions(base, now).filter((s) => s.alive); }

function printList() {
  const sessions = activeSessions();
  if (!sessions.length) { console.log('Nenhuma janela claude-go ativa.'); return; }
  console.log('Janelas ativas:');
  for (const s of sessions) {
    const started = s.meta.startedAt ? new Date(s.meta.startedAt).toLocaleTimeString() : '?';
    console.log(`  #${s.label}  (aberta ${started}, cwd ${s.meta.cwd || '?'})`);
  }
  console.log('\nUso: cont <n> <tempo> [mensagem]   ex: cont 2 37m "continue, foca no X"');
}

function ping(target) {
  const sessions = activeSessions();
  const alvos = target ? sessions.filter((s) => s.label === Number(target)) : sessions;
  if (!alvos.length) { console.log('Nenhuma janela ativa para identificar.'); return; }
  for (const s of alvos) { try { writeFileSync(join(s.dir, 'control-ping'), '', 'utf8'); } catch { /* ignore */ } }
  console.log(`Identificando ${alvos.map((s) => '#' + s.label).join(', ')} — olhe o título das abas (vai piscar "‹‹ AQUI ››").`);
}

if (args.length === 0 || args[0] === 'list') { printList(); process.exit(0); }
if (args[0] === 'ping') { ping(args[1]); process.exit(0); }

// cont <n> <tempo> [mensagem]
const label = Number(args[0]);
const tempo = args[1];
const message = args[2] || DEFAULT_MSG;
if (!Number.isInteger(label) || !tempo) {
  console.error('Uso: cont <n> <tempo> [mensagem]   ex: cont 2 37m   |   cont 2 37m "msg custom"');
  process.exit(1);
}
const alvo = activeSessions().find((s) => s.label === label);
if (!alvo) {
  console.error(`Janela #${label} não está ativa. Rode 'cont' para ver as janelas abertas.`);
  process.exit(1);
}
try {
  const ms = parseDuration(tempo);
  if (!existsSync(join(alvo.dir, 'pending'))) ensureDirs(alvo.dir);
  const job = createJob({ message, mode: 'once', fireAt: now + ms, createdAt: now }, genId());
  validateJob(job, { maxMessageLength: MAX });
  writeJob(alvo.dir, job);
  console.log(`#${label} ← "${message}"  em ${tempo} (dispara ${new Date(job.fireAt).toLocaleTimeString()})`);
} catch (e) {
  console.error(`Erro: ${e.message}`);
  process.exit(1);
}
