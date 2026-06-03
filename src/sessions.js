// Registro de janelas (instâncias) do claude-go. Cada janela aloca um rótulo
// numérico curto (#1, #2, ...), mantém um heartbeat e tem sua própria inbox
// (pending/claimed/done/failed). Permite direcionar mensagens por janela sem IDs.
import {
  mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureDirs } from './queue.js';

export const HEARTBEAT_TTL_MS = 15_000;

export function sessionsRoot(baseDir) { return join(baseDir, 'sessions'); }
export function sessionDir(baseDir, label) { return join(sessionsRoot(baseDir), String(label)); }
function metaPath(dir) { return join(dir, 'meta.json'); }

export function isAlive(dir, now, ttl = HEARTBEAT_TTL_MS) {
  try {
    const meta = JSON.parse(readFileSync(metaPath(dir), 'utf8'));
    return typeof meta.heartbeat === 'number' && (now - meta.heartbeat) < ttl;
  } catch { return false; }
}

export function writeHeartbeat(dir, meta, now) {
  const tmp = `${metaPath(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...meta, heartbeat: now }, null, 2), 'utf8');
  renameSync(tmp, metaPath(dir));
}

// Aloca o menor rótulo livre (>=1), reciclando rótulos de janelas mortas.
// Retorna { label, dir }.
export function allocLabel(baseDir, meta, now, max = 99) {
  mkdirSync(sessionsRoot(baseDir), { recursive: true });
  for (let n = 1; n <= max; n++) {
    const dir = sessionDir(baseDir, n);
    if (existsSync(dir)) {
      if (isAlive(dir, now)) continue;                 // ocupado e vivo
      rmSync(dir, { recursive: true, force: true });   // morto: recicla
    }
    try { mkdirSync(dir, { recursive: false }); }
    catch { continue; }                                // corrida: outro pegou
    ensureDirs(dir);
    writeHeartbeat(dir, { ...meta, label: n, startedAt: now }, now);
    return { label: n, dir };
  }
  throw new Error('Sem rótulos de janela livres (máximo atingido)');
}

export function listSessions(baseDir, now) {
  const root = sessionsRoot(baseDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^\d+$/.test(name))
    .map((name) => {
      const dir = sessionDir(baseDir, name);
      let meta = {};
      try { meta = JSON.parse(readFileSync(metaPath(dir), 'utf8')); } catch { /* ignore */ }
      return { label: Number(name), dir, alive: isAlive(dir, now), meta };
    })
    .sort((a, b) => a.label - b.label);
}

export function removeSession(baseDir, label) {
  try { rmSync(sessionDir(baseDir, label), { recursive: true, force: true }); } catch { /* ignore */ }
}
