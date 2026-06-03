#!/usr/bin/env node
// Comando completo de agendamento (modos --in/--every/--at), direcionado a uma
// janela do claude-go via --to <n>. Para o atalho rápido, veja 'cont'.
//   agendar                                  -> lista janelas ativas
//   agendar "msg" --to 2 --in 15m
//   agendar "msg" --to 2 --every 5h
//   agendar "msg" --to 2 --at 14:30 [--daily]
//   agendar cancel <n> <id>
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveQueueDir } from '../src/paths.js';
import { parseDuration, parseClock } from '../src/scheduler.js';
import { createJob, validateJob, writeJob, ensureDirs } from '../src/queue.js';
import { listSessions } from '../src/sessions.js';

const MAX = 2000;
const base = resolveQueueDir(process.env, homedir());
const now = Date.now();
const [cmd, ...rest] = process.argv.slice(2);

function genId() { return `${Date.now()}-${randomUUID().slice(0, 8)}`; }
function activeSessions() { return listSessions(base, now).filter((s) => s.alive); }

function printList() {
  const sessions = activeSessions();
  if (!sessions.length) { console.log('Nenhuma janela claude-go ativa.'); return; }
  console.log('Janelas ativas:');
  for (const s of sessions) {
    const started = s.meta.startedAt ? new Date(s.meta.startedAt).toLocaleTimeString() : '?';
    console.log(`  #${s.label}  (aberta ${started})`);
  }
}

function parseFlags(args) {
  const message = args[0];
  if (!message || message.startsWith('--'))
    throw new Error('Uso: agendar "<mensagem>" --to <n> --in 15m | --every 5h | --at 14:30 [--daily]');
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--daily') flags.daily = true;
    else if (a.startsWith('--')) {
      const val = args[++i];
      if (val === undefined || val.startsWith('--'))
        throw new Error(`A opção ${a} precisa de um valor (ex: ${a} 15m).`);
      flags[a.slice(2)] = val;
    }
  }
  return { message, flags };
}

function buildJob(message, flags) {
  if (flags.in) return createJob({ message, mode: 'once', fireAt: now + parseDuration(flags.in), createdAt: now }, genId());
  if (flags.every) return createJob({ message, mode: 'interval', everyMs: parseDuration(flags.every), fireAt: now + parseDuration(flags.every), createdAt: now }, genId());
  if (flags.at) return createJob({ message, mode: 'at', time: flags.at, daily: !!flags.daily, fireAt: parseClock(flags.at, now), createdAt: now }, genId());
  throw new Error('Especifique --in <dur> | --every <dur> | --at <HH:MM>');
}

if (!cmd || cmd === 'list') {
  printList();
} else if (cmd === 'cancel') {
  const label = Number(rest[0]);
  const id = rest[1];
  const alvo = activeSessions().find((s) => s.label === label);
  if (!alvo) { console.error(`Janela #${label} não está ativa.`); process.exit(1); }
  const p = join(alvo.dir, 'pending', `${id}.json`);
  if (existsSync(p)) { rmSync(p); console.log(`Cancelado em #${label}: ${id}`); }
  else console.log(`Não encontrado em #${label}/pending: ${id}`);
} else {
  try {
    const { message, flags } = parseFlags([cmd, ...rest]);
    if (!flags.to) throw new Error('Falta --to <n> (a janela alvo). Rode "agendar" para listar as janelas ativas.');
    const label = Number(flags.to);
    const alvo = activeSessions().find((s) => s.label === label);
    if (!alvo) throw new Error(`Janela #${label} não está ativa. Rode "agendar" para ver as janelas abertas.`);
    const job = buildJob(message, flags);
    validateJob(job, { maxMessageLength: MAX });
    if (!existsSync(join(alvo.dir, 'pending'))) ensureDirs(alvo.dir);
    writeJob(alvo.dir, job);
    console.log(`#${label} ← "${message}" (${job.mode}) dispara ${new Date(job.fireAt).toLocaleString()}`);
  } catch (e) {
    console.error(`Erro: ${e.message}`);
    process.exit(1);
  }
}
