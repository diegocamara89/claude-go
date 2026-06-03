import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const VALID_MODES = new Set(['once', 'interval', 'at']);
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const SUBDIRS = ['pending', 'claimed', 'done', 'failed'];

export function createJob(input, id) {
  return {
    id,
    message: input.message,
    mode: input.mode,
    fireAt: input.fireAt ?? null,
    everyMs: input.everyMs ?? null,
    time: input.time ?? null,
    daily: input.daily ?? false,
    createdAt: input.createdAt ?? null,
    status: 'pending',
  };
}

export function validateJob(job, { maxMessageLength }) {
  if (!job || typeof job.message !== 'string' || job.message.length === 0)
    throw new Error('Job inválido: message vazio');
  if (job.message.length > maxMessageLength)
    throw new Error(`Job inválido: message excede ${maxMessageLength} chars`);
  if (CONTROL_RE.test(job.message))
    throw new Error('Job inválido: message contém caracteres de controle');
  if (!VALID_MODES.has(job.mode))
    throw new Error(`Job inválido: mode desconhecido "${job.mode}"`);
  return true;
}

export function ensureDirs(dir) {
  for (const s of SUBDIRS) mkdirSync(join(dir, s), { recursive: true });
}

function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

export function writeJob(dir, job) {
  writeAtomic(join(dir, 'pending', `${job.id}.json`), JSON.stringify(job, null, 2));
}

function isWellFormed(job) {
  return job && typeof job.id === 'string'
    && typeof job.message === 'string' && job.message.length > 0
    && VALID_MODES.has(job.mode)
    && typeof job.fireAt === 'number';
}

// Move um arquivo problemático de pending/ para failed/ (auditoria). Best-effort.
function quarantine(dir, file) {
  try { renameSync(join(dir, 'pending', file), join(dir, 'failed', file)); } catch { /* ignore */ }
}

// Lê a fila pending de forma RESILIENTE: um JSON corrompido ou malformado nunca
// derruba o host — é movido para failed/ e ignorado. (spec §5/§7-S2)
export function readPending(dir) {
  const out = [];
  for (const f of readdirSync(join(dir, 'pending')).filter(f => f.endsWith('.json'))) {
    let job;
    try { job = JSON.parse(readFileSync(join(dir, 'pending', f), 'utf8')); }
    catch { quarantine(dir, f); continue; }
    if (isWellFormed(job)) out.push(job);
    else quarantine(dir, f);
  }
  return out;
}

// Recupera jobs órfãos: se uma sessão morreu entre claim e markDone/reschedule,
// o arquivo fica preso em claimed/. No startup, devolvemos todos a pending/ para
// reentrega (semântica at-least-once). MVP assume 1 sessão ativa por vez. (spec §4.2)
export function recoverClaimed(dir) {
  let n = 0;
  for (const f of readdirSync(join(dir, 'claimed')).filter(f => f.endsWith('.json'))) {
    const pendingName = f.replace(/\.[^.]+\.json$/, '.json'); // <id>.<sid>.json -> <id>.json
    try { renameSync(join(dir, 'claimed', f), join(dir, 'pending', pendingName)); n++; }
    catch { /* ignore */ }
  }
  return n;
}

function claimedName(job, sid) { return `${job.id}.${sid}.json`; }

export function claim(dir, job, sid) {
  const from = join(dir, 'pending', `${job.id}.json`);
  const to = join(dir, 'claimed', claimedName(job, sid));
  try { renameSync(from, to); return true; }
  catch { return false; }
}

export function markDone(dir, job, sid) {
  renameSync(join(dir, 'claimed', claimedName(job, sid)), join(dir, 'done', `${job.id}.json`));
}

export function markFailed(dir, job, sid) {
  renameSync(join(dir, 'claimed', claimedName(job, sid)), join(dir, 'failed', `${job.id}.json`));
}

export function reschedule(dir, job, sid, newFireAt) {
  rmSync(join(dir, 'claimed', claimedName(job, sid)), { force: true });
  writeJob(dir, { ...job, fireAt: newFireAt, status: 'pending' });
}
