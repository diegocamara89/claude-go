# Disparador Automático (`claude-go`) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir um wrapper Node.js (`claude-go`) que hospeda o `claude.exe` num ConPTY e injeta mensagens agendadas na sessão interativa, sem roubar foco, apenas quando o Claude está ocioso no prompt.

**Architecture:** Módulos puros e testáveis (scheduler, queue, idle, inject) orquestrados por um host PTY (`claude-go.js`). A fila vive em disco (`pending→claimed→done/failed`) com claim atômico por rename. O scheduler decide *o quê* disparar; o injetor decide *quando* (só em idle) e *como* (bracketed paste).

**Tech Stack:** Node.js v22 (ESM, test runner nativo `node --test`), `@lydell/node-pty` (ConPTY prebuilt), Windows 11.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `package.json` | ESM, bins (`claude-go`, `agendar`), script de teste, dep node-pty pinada |
| `disparador.config.json` | Template de config (caminho do claude, polling, idleMs) |
| `src/scheduler.js` | **Puro:** `parseDuration`, `parseClock`, `isDue`, `nextFireAt` |
| `src/queue.js` | I/O da fila: `createJob`, `validateJob`, `writeJob`, `readPending`, `claim`, `markDone`, `markFailed`, `reschedule` |
| `src/idle.js` | `createIdleTracker`: classifica `busy`/`idle-prompt` por silêncio de saída |
| `src/inject.js` | `sanitize`, `buildPasteSequence`, `injectMessage` (bracketed paste + Enter) |
| `src/claude-go.js` | Host PTY: passthrough, raw mode, cleanup, loop scheduler→injetor |
| `bin/agendar.js` | CLI `agendar` / `list` / `cancel` (lê `CLAUDE_GO_QUEUE_DIR`) |
| `test/*.test.js` | Testes unitários + e2e do PTY |

Convenções: ESM (`import`), `node --test`, sem libs de teste externas. Caminho da fila resolvido por `CLAUDE_GO_QUEUE_DIR` → senão `os.homedir()/.claude-disparador`.

---

## Etapa 0: Setup do projeto + smoke-test do node-pty (valida o risco nº 1)

**Files:**
- Create: `package.json`
- Create: `disparador.config.json`

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "disparador-claude",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "claude-go": "src/claude-go.js",
    "agendar": "bin/agendar.js"
  },
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@lydell/node-pty": "1.2.0-beta.12"
  }
}
```

- [ ] **Step 2: Criar `disparador.config.json` (template)**

```json
{
  "claudePath": "",
  "claudeArgs": [],
  "pollMs": 1000,
  "idleMs": 1500,
  "enterDelayMs": 80,
  "maxMessageLength": 2000
}
```

- [ ] **Step 3: Instalar a dependência (smoke-test de instalação)**

Run (PowerShell): `npm install`
Expected: instala sem compilar C++ (binário prebuilt). Sem erro de `node-gyp`/MSB.

- [ ] **Step 4: Verificar que o binário nativo carrega no Node 22 x64**

Run (PowerShell): `node -e "import('@lydell/node-pty').then(m=>{const p=m.spawn(process.env.ComSpec||'cmd.exe',[],{cols:80,rows:24});p.onData(()=>{});setTimeout(()=>{p.kill();console.log('PTY_OK')},500)})"`
Expected: imprime `PTY_OK` sem erro de módulo nativo.
**Se falhar:** trocar a dep por `node-pty` oficial (`npm i node-pty`) e reexecutar; ajustar imports nas tarefas seguintes (a API `spawn/onData/onExit/resize/write/kill` é idêntica).

- [ ] **Step 5: Commit**

```powershell
git add package.json disparador.config.json package-lock.json
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "chore: setup do projeto e dependencia node-pty (prebuilt)"
```

---

## Task 1: Parser de tempo (`scheduler.js`)

**Files:**
- Create: `src/scheduler.js`
- Test: `test/scheduler.test.js`

- [ ] **Step 1: Escrever os testes que falham**

```js
// test/scheduler.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseClock } from '../src/scheduler.js';

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/scheduler.test.js`
Expected: FAIL (`parseDuration is not a function` / módulo não encontrado).

- [ ] **Step 3: Implementar**

```js
// src/scheduler.js
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(str) {
  const m = /^(\d+)([smhd])$/.exec(String(str).trim());
  if (!m) throw new Error(`Duração inválida: "${str}" (use ex: 30s, 15m, 5h, 1d)`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

export function parseClock(str, now) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(str).trim());
  if (!m) throw new Error(`Horário inválido: "${str}" (use HH:MM)`);
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = d.getTime();
  if (t <= now) t += UNIT_MS.d;
  return t;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/scheduler.test.js`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```powershell
git add src/scheduler.js test/scheduler.test.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: parser de tempo do scheduler (parseDuration, parseClock)"
```

---

## Task 2: Lógica de disparo e reagendamento (`scheduler.js`)

**Files:**
- Modify: `src/scheduler.js`
- Modify: `test/scheduler.test.js`

- [ ] **Step 1: Adicionar testes que falham**

```js
// adicionar em test/scheduler.test.js
import { isDue, nextFireAt } from '../src/scheduler.js';

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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/scheduler.test.js`
Expected: FAIL (`isDue is not a function`).

- [ ] **Step 3: Implementar (anexar ao `src/scheduler.js`)**

```js
// src/scheduler.js (anexar)
export function isDue(job, now) {
  return job.fireAt != null && job.fireAt <= now;
}

export function nextFireAt(job, now) {
  if (job.mode === 'interval') return now + job.everyMs;
  if (job.mode === 'at' && job.daily) return parseClock(job.time, now);
  return null; // once / at nao-diario: encerra
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/scheduler.test.js`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```powershell
git add src/scheduler.js test/scheduler.test.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: isDue e nextFireAt (sem catch-up; encerra once/at)"
```

---

## Task 3: Criação e validação de jobs (`queue.js`)

**Files:**
- Create: `src/queue.js`
- Test: `test/queue.test.js`

- [ ] **Step 1: Escrever testes que falham**

```js
// test/queue.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJob, validateJob } from '../src/queue.js';

test('createJob: once gera fireAt e id', () => {
  const job = createJob({ message: 'oi', mode: 'once', fireAt: 1234 }, 'id-1');
  assert.equal(job.id, 'id-1');
  assert.equal(job.message, 'oi');
  assert.equal(job.mode, 'once');
  assert.equal(job.fireAt, 1234);
  assert.equal(job.status, 'pending');
});

test('validateJob: aceita job valido', () => {
  assert.doesNotThrow(() => validateJob(
    { id: 'a', message: 'oi', mode: 'once', fireAt: 1, status: 'pending' },
    { maxMessageLength: 2000 }));
});

test('validateJob: rejeita mensagem vazia, longa ou com controle', () => {
  const opts = { maxMessageLength: 10 };
  assert.throws(() => validateJob({ id:'a', message:'', mode:'once', fireAt:1 }, opts));
  assert.throws(() => validateJob({ id:'a', message:'x'.repeat(11), mode:'once', fireAt:1 }, opts));
  assert.throws(() => validateJob({ id:'a', message:'a\x00b', mode:'once', fireAt:1 }, opts));
});

test('validateJob: rejeita modo desconhecido', () => {
  assert.throws(() => validateJob({ id:'a', message:'oi', mode:'xxx' }, { maxMessageLength: 2000 }));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/queue.test.js`
Expected: FAIL (`createJob is not a function`).

- [ ] **Step 3: Implementar (início do `src/queue.js`)**

```js
// src/queue.js
const VALID_MODES = new Set(['once', 'interval', 'at']);
// rejeita C0 controls e DEL (mantém apenas texto de 1 linha)
const CONTROL_RE = /[\x00-\x1f\x7f]/;

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
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/queue.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/queue.js test/queue.test.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: createJob e validateJob com validacao de schema/tamanho/controle"
```

---

## Task 4: Persistência atômica e claim da fila (`queue.js`)

**Files:**
- Modify: `src/queue.js`
- Modify: `test/queue.test.js`

- [ ] **Step 1: Adicionar testes que falham**

```js
// adicionar em test/queue.test.js
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDirs, writeJob, readPending, claim, markDone } from '../src/queue.js';

function tmpQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'dispq-'));
  ensureDirs(dir);
  return dir;
}

test('writeJob + readPending faz round-trip', () => {
  const dir = tmpQueue();
  const job = createJob({ message:'oi', mode:'once', fireAt: 1 }, 'id-1');
  writeJob(dir, job);
  const pend = readPending(dir);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].id, 'id-1');
  rmSync(dir, { recursive: true, force: true });
});

test('claim move pending->claimed e so um vencedor', () => {
  const dir = tmpQueue();
  const job = createJob({ message:'oi', mode:'once', fireAt: 1 }, 'id-1');
  writeJob(dir, job);
  assert.equal(claim(dir, job, 'sessA'), true);
  assert.equal(claim(dir, job, 'sessB'), false); // ja reivindicado
  assert.equal(readPending(dir).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('markDone move claimed->done', () => {
  const dir = tmpQueue();
  const job = createJob({ message:'oi', mode:'once', fireAt: 1 }, 'id-1');
  writeJob(dir, job);
  claim(dir, job, 'sessA');
  markDone(dir, job, 'sessA');
  assert.equal(existsSync(join(dir, 'done', 'id-1.json')), true);
  assert.equal(readdirSync(join(dir, 'claimed')).length, 0);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/queue.test.js`
Expected: FAIL (`ensureDirs is not a function`).

- [ ] **Step 3: Implementar (anexar ao `src/queue.js`)**

```js
// src/queue.js (anexar)
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SUBDIRS = ['pending', 'claimed', 'done', 'failed'];

export function ensureDirs(dir) {
  for (const s of SUBDIRS) mkdirSync(join(dir, s), { recursive: true });
}

function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path); // rename é atômico
}

export function writeJob(dir, job) {
  writeAtomic(join(dir, 'pending', `${job.id}.json`), JSON.stringify(job, null, 2));
}

export function readPending(dir) {
  return readdirSync(join(dir, 'pending'))
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, 'pending', f), 'utf8')));
}

function claimedName(job, sid) { return `${job.id}.${sid}.json`; }

export function claim(dir, job, sid) {
  const from = join(dir, 'pending', `${job.id}.json`);
  const to = join(dir, 'claimed', claimedName(job, sid));
  try { renameSync(from, to); return true; }
  catch { return false; } // outra sessão venceu ou já saiu de pending
}

export function markDone(dir, job, sid) {
  const from = join(dir, 'claimed', claimedName(job, sid));
  const to = join(dir, 'done', `${job.id}.json`);
  renameSync(from, to);
}

export function markFailed(dir, job, sid) {
  const from = join(dir, 'claimed', claimedName(job, sid));
  const to = join(dir, 'failed', `${job.id}.json`);
  renameSync(from, to);
}

export function reschedule(dir, job, sid, newFireAt) {
  const from = join(dir, 'claimed', claimedName(job, sid));
  rmSync(from, { force: true });
  writeJob(dir, { ...job, fireAt: newFireAt, status: 'pending' });
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/queue.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/queue.js test/queue.test.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: fila com escrita atomica e claim por rename (pending/claimed/done/failed)"
```

---

## Task 5: Detector de ociosidade (`idle.js`)

**Files:**
- Create: `src/idle.js`
- Test: `test/idle.test.js`

- [ ] **Step 1: Escrever testes que falham**

```js
// test/idle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdleTracker } from '../src/idle.js';

test('estado inicial é unknown antes de qualquer saida', () => {
  const t = createIdleTracker({ idleMs: 1000 });
  assert.equal(t.state(0), 'unknown');
});

test('busy logo apos saida, idle-prompt apos silencio >= idleMs', () => {
  const t = createIdleTracker({ idleMs: 1000 });
  t.onData(5000);                       // recebeu saída em t=5000
  assert.equal(t.state(5500), 'busy');  // 500ms depois: ainda ocupado
  assert.equal(t.state(6000), 'idle-prompt'); // 1000ms de silêncio
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/idle.test.js`
Expected: FAIL (`createIdleTracker is not a function`).

- [ ] **Step 3: Implementar**

```js
// src/idle.js
export function createIdleTracker({ idleMs }) {
  let lastDataAt = null;
  return {
    onData(now) { lastDataAt = now; },
    state(now) {
      if (lastDataAt === null) return 'unknown';
      return (now - lastDataAt) >= idleMs ? 'idle-prompt' : 'busy';
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/idle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/idle.js test/idle.test.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: detector de ociosidade por silencio de saida do PTY"
```

---

## Task 6: Injetor com bracketed paste (`inject.js`)

**Files:**
- Create: `src/inject.js`
- Test: `test/inject.test.js`

- [ ] **Step 1: Escrever testes que falham**

```js
// test/inject.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, buildPasteSequence, injectMessage } from '../src/inject.js';

test('sanitize remove controle e quebras de linha', () => {
  assert.equal(sanitize('ola\nmundo\r\t'), 'olamundo');
  assert.equal(sanitize('olá áéí'), 'olá áéí'); // acentos preservados
});

test('buildPasteSequence envolve a mensagem em bracketed paste', () => {
  assert.equal(buildPasteSequence('oi'), '\x1b[200~oi\x1b[201~');
});

test('injectMessage escreve paste e depois Enter apos o delay', () => {
  const writes = [];
  const fakePty = { write: (s) => writes.push(s) };
  const timers = [];
  const fakeSetTimeout = (fn) => { timers.push(fn); };
  injectMessage(fakePty, 'olá', { enterDelayMs: 80, setTimeoutFn: fakeSetTimeout });
  assert.equal(writes[0], '\x1b[200~olá\x1b[201~'); // paste imediato
  assert.equal(writes.length, 1);
  timers[0]();                                       // dispara o timer do Enter
  assert.equal(writes[1], '\r');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/inject.test.js`
Expected: FAIL (`sanitize is not a function`).

- [ ] **Step 3: Implementar**

```js
// src/inject.js
const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function sanitize(message) {
  return message.replace(CONTROL_RE, '');
}

export function buildPasteSequence(message) {
  return `${PASTE_START}${sanitize(message)}${PASTE_END}`;
}

export function injectMessage(pty, message, { enterDelayMs = 80, setTimeoutFn = setTimeout } = {}) {
  pty.write(buildPasteSequence(message));
  setTimeoutFn(() => pty.write('\r'), enterDelayMs);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/inject.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/inject.js test/inject.test.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: injetor via bracketed paste com sanitizacao e Enter atrasado"
```

---

## Task 7: CLI `agendar` / `list` / `cancel` (`bin/agendar.js`)

**Files:**
- Create: `src/paths.js` (resolve a pasta da fila)
- Create: `bin/agendar.js`
- Test: `test/paths.test.js`

- [ ] **Step 1: Escrever teste que falha (resolução da pasta)**

```js
// test/paths.test.js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/paths.test.js`
Expected: FAIL (`resolveQueueDir is not a function`).

- [ ] **Step 3: Implementar `src/paths.js`**

```js
// src/paths.js
import { join } from 'node:path';

export function resolveQueueDir(env, homedir) {
  if (env.CLAUDE_GO_QUEUE_DIR && env.CLAUDE_GO_QUEUE_DIR.trim())
    return env.CLAUDE_GO_QUEUE_DIR.trim();
  return join(homedir, '.claude-disparador');
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test test/paths.test.js`
Expected: PASS.

- [ ] **Step 5: Implementar `bin/agendar.js` (CLI)**

```js
#!/usr/bin/env node
// bin/agendar.js
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveQueueDir } from '../src/paths.js';
import { parseDuration, parseClock } from '../src/scheduler.js';
import { createJob, validateJob, writeJob, ensureDirs } from '../src/queue.js';

const MAX = 2000;
const dir = resolveQueueDir(process.env, homedir());
ensureDirs(dir);

const [cmd, ...rest] = process.argv.slice(2);

function genId() { return `${Date.now()}-${randomUUID().slice(0, 8)}`; }

function parseAdd(args) {
  // agendar "mensagem" --in 15m | --every 5h | --at 14:30 [--daily]
  const message = args[0];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--daily') flags.daily = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = args[++i];
  }
  const now = Date.now();
  let job;
  if (flags.in) job = createJob({ message, mode: 'once', fireAt: now + parseDuration(flags.in), createdAt: now }, genId());
  else if (flags.every) job = createJob({ message, mode: 'interval', everyMs: parseDuration(flags.every), fireAt: now + parseDuration(flags.every), createdAt: now }, genId());
  else if (flags.at) job = createJob({ message, mode: 'at', time: flags.at, daily: !!flags.daily, fireAt: parseClock(flags.at, now), createdAt: now }, genId());
  else throw new Error('Especifique --in <dur> | --every <dur> | --at <HH:MM>');
  return job;
}

if (!cmd || cmd === 'list') {
  for (const f of readdirSync(join(dir, 'pending')).filter(f => f.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(dir, 'pending', f), 'utf8'));
    console.log(`${j.id}  [${j.mode}]  fireAt=${new Date(j.fireAt).toLocaleString()}  ${j.message}`);
  }
} else if (cmd === 'cancel') {
  const id = rest[0];
  const p = join(dir, 'pending', `${id}.json`);
  if (existsSync(p)) { rmSync(p); console.log(`Cancelado: ${id}`); }
  else console.log(`Não encontrado em pending: ${id}`);
} else {
  // qualquer outro: trata cmd como a mensagem (agendar "msg" --in ...)
  const job = parseAdd([cmd, ...rest]);
  validateJob(job, { maxMessageLength: MAX });
  writeJob(dir, job);
  console.log(`Agendado ${job.id} (${job.mode}) para ${new Date(job.fireAt).toLocaleString()}`);
}
```

- [ ] **Step 6: Teste manual do CLI**

Run (PowerShell):
```powershell
$env:CLAUDE_GO_QUEUE_DIR="$env:TEMP\dispq-cli"; node bin/agendar.js "continue de onde paramos" --in 15m; node bin/agendar.js list
```
Expected: imprime `Agendado ...` e depois lista a linha com a mensagem. (Limpar: `Remove-Item -Recurse -Force $env:TEMP\dispq-cli`.)

- [ ] **Step 7: Commit**

```powershell
git add src/paths.js bin/agendar.js test/paths.test.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: CLI agendar/list/cancel com resolucao de fila via env var"
```

---

## Task 8: Host PTY com passthrough, cleanup e loop do scheduler (`claude-go.js`)

**Files:**
- Create: `src/claude-go.js`

> Este módulo é validado pelo e2e (Task 9) e pelo smoke manual (Task 10); a lógica fina já está coberta por unit tests (scheduler/queue/idle/inject).

- [ ] **Step 1: Implementar o host**

```js
#!/usr/bin/env node
// src/claude-go.js
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as pty from '@lydell/node-pty';
import { resolveQueueDir } from './paths.js';
import { ensureDirs, readPending, claim, markDone, reschedule } from './queue.js';
import { isDue, nextFireAt } from './scheduler.js';
import { createIdleTracker } from './idle.js';
import { injectMessage } from './inject.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const p = join(__dirname, '..', 'disparador.config.json');
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  return {
    claudePath: cfg.claudePath || 'claude.exe',
    claudeArgs: cfg.claudeArgs || [],
    pollMs: cfg.pollMs || 1000,
    idleMs: cfg.idleMs || 1500,
    enterDelayMs: cfg.enterDelayMs || 80,
  };
}

function main() {
  const cfg = loadConfig();
  const sid = randomUUID().slice(0, 8);
  const queueDir = resolveQueueDir(process.env, homedir());
  ensureDirs(queueDir);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const child = pty.spawn(cfg.claudePath, cfg.claudeArgs, {
    name: 'xterm-256color',
    cols, rows,
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_GO_QUEUE_DIR: queueDir },
  });

  const idle = createIdleTracker({ idleMs: cfg.idleMs });

  // PTY -> tela (respeita backpressure)
  child.onData((d) => { idle.onData(Date.now()); process.stdout.write(d); });

  // teclado -> PTY (raw)
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => child.write(d.toString('utf8')));

  // resize
  process.stdout.on('resize', () => child.resize(process.stdout.columns || cols, process.stdout.rows || rows));

  // loop do scheduler: decide o quê; injeta só em idle
  const timer = setInterval(() => {
    const now = Date.now();
    if (idle.state(now) !== 'idle-prompt') return; // S0: só injeta ocioso
    for (const job of readPending(queueDir)) {
      if (!isDue(job, now)) continue;
      if (!claim(queueDir, job, sid)) continue; // outra sessão pegou
      injectMessage(child, job.message, { enterDelayMs: cfg.enterDelayMs });
      const next = nextFireAt(job, now);
      if (next == null) markDone(queueDir, job, sid);
      else reschedule(queueDir, job, sid, next);
      break; // um disparo por ciclo, evita enfileirar vários no prompt
    }
  }, cfg.pollMs);

  function cleanup() {
    clearInterval(timer);
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();
  }

  child.onExit(({ exitCode }) => { cleanup(); process.exit(exitCode ?? 0); });
  process.on('SIGINT', () => {});      // Ctrl+C vai como \x03 ao child (raw); não mata o wrapper
  process.on('SIGBREAK', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
  process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1); });
}

main();
```

- [ ] **Step 2: Verificação de sintaxe/carga**

Run (PowerShell): `node --check src/claude-go.js`
Expected: sem erros de sintaxe.

- [ ] **Step 3: Commit**

```powershell
git add src/claude-go.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "feat: host PTY com passthrough, cleanup e loop scheduler->injetor (idle-gated)"
```

---

## Task 9: Teste e2e do PTY (pipeline completo, sem o Claude)

**Files:**
- Create: `test/e2e-pty.test.js`
- Create: `test/fixtures/echo.js`

- [ ] **Step 1: Criar o processo-eco de fixture**

```js
// test/fixtures/echo.js
// Lê stdin e imprime com prefixo; usado no lugar do Claude no e2e.
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  // ao receber Enter (\r), emite a linha recebida com marcador
  if (buf.includes('\r')) {
    process.stdout.write(`RECEBIDO:${buf.replace(/\r/g, '')}\n`);
    buf = '';
  }
});
```

- [ ] **Step 2: Escrever o teste e2e**

```js
// test/e2e-pty.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from '@lydell/node-pty';
import { injectMessage } from '../src/inject.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('injeta mensagem com acentos no PTY e o processo recebe', async () => {
  const child = pty.spawn(process.execPath, [join(__dirname, 'fixtures', 'echo.js')], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: __dirname, env: process.env,
  });

  let out = '';
  child.onData((d) => { out += d; });

  await new Promise((r) => setTimeout(r, 400)); // deixa o eco subir
  injectMessage(child, 'olá áéí', { enterDelayMs: 50 });

  await new Promise((r) => setTimeout(r, 800)); // aguarda eco
  child.kill();

  assert.ok(out.includes('olá áéí'), `saída não contém a mensagem. out=${JSON.stringify(out)}`);
});
```

- [ ] **Step 3: Rodar o e2e**

Run (PowerShell): `node --test test/e2e-pty.test.js`
Expected: PASS (a saída contém `olá áéí`).
**Se a fixture receber as sequências de paste cruas** (`\x1b[200~`), ajustar a fixture para também remover `\x1b[200~`/`\x1b[201~` antes de comparar — o objetivo é confirmar que o texto + acentos atravessam o PTY. Documentar o resultado.

- [ ] **Step 4: Rodar a suíte inteira**

Run (PowerShell): `node --test`
Expected: PASS em todos os arquivos.

- [ ] **Step 5: Commit**

```powershell
git add test/e2e-pty.test.js test/fixtures/echo.js
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "test: e2e do pipeline de injecao no PTY com acentos"
```

---

## Task 10: Smoke manual com o Claude real + validação da hipótese das 5h

**Files:** nenhum (validação manual; registrar resultado no spec §10)

- [ ] **Step 1: Instalar os bins localmente (link)**

Run (PowerShell): `npm link`  (expõe `claude-go` e `agendar` no PATH do usuário)
Expected: sem erros.

- [ ] **Step 2: Abrir a sessão via wrapper**

Run (PowerShell): `claude-go`
Expected: o Claude abre normalmente (cores, digitação, Ctrl+C, redimensionar funcionam como sempre).

- [ ] **Step 3: Disparo único (em outro terminal)**

Run (segundo PowerShell): `agendar "diga apenas: cheguei pelo disparador" --in 1m`
Expected: após ~1 min, a frase aparece **na sessão do Claude já aberta**, sem a janela roubar foco; acentos corretos; apenas quando o prompt está ocioso.

- [ ] **Step 4: Testar os modos `--every` e `--at`**

Run: `agendar "ping recorrente" --every 2m` e `agendar "ping horario" --at <HH:MM daqui 2 min>`
Expected: disparam nos tempos certos; `--every` repete.

- [ ] **Step 5: Validar a hipótese S0 (limite de 5h)**

Quando a sessão atingir/estiver perto do limite de 5h, agendar uma mensagem e observar:
- A mensagem é aplicada quando o limite reseta? (sucesso)
- É descartada? (então usar `--every` para reenviar até o prompt aceitar)

Registrar o resultado observado no spec, seção §10 (critério "Hipótese S0 registrada").

- [ ] **Step 6: Commit do resultado**

```powershell
git add docs/superpowers/specs/2026-05-31-disparador-automatico-design.md
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "docs: registra resultado do smoke-test (hipotese das 5h)"
```

---

## Self-review (cobertura do spec)

- §3 Camada 1 (`/loop`): validada no brainstorming; documentada (não requer código).
- §4 componentes: Tasks 1–8 cobrem scheduler, queue, idle, inject, host, CLI.
- §4.2 fila global + `CLAUDE_GO_QUEUE_DIR`: Task 7 (`paths.js`) + Task 8 (env no spawn).
- §5 formato/validação: Tasks 3–4.
- §6 fluxo claim + idle-gating: Task 8 (loop) + Tasks 4/5.
- §7 erros: bracketed paste (T6), cleanup/raw mode (T8), claim (T4), backpressure (T8 `stdout.write`), validação (T3).
- §9 testes 1–6: Tasks 1–6 (unit), Task 9 (e2e), Task 10 (smoke).
- §10 critérios de aceitação: Task 10.
- §8/§10 hipótese S0: Task 10 Step 5.
- Consistência de nomes: `ensureDirs/writeJob/readPending/claim/markDone/markFailed/reschedule`, `isDue/nextFireAt/parseDuration/parseClock`, `createIdleTracker(.onData/.state)`, `sanitize/buildPasteSequence/injectMessage`, `resolveQueueDir` — usados de forma idêntica entre tasks.
