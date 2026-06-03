import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJob, validateJob, ensureDirs, writeJob, readPending, claim, markDone, recoverClaimed,
} from '../src/queue.js';

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
  assert.equal(claim(dir, job, 'sessB'), false);
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

test('readPending NAO derruba com JSON corrompido (move p/ failed) e mantem os validos', () => {
  const dir = tmpQueue();
  writeJob(dir, createJob({ message:'bom', mode:'once', fireAt: 1 }, 'id-ok'));
  writeFileSync(join(dir, 'pending', 'id-ruim.json'), '{ isso nao e json', 'utf8');
  writeFileSync(join(dir, 'pending', 'id-malformado.json'), JSON.stringify({ id:'x', foo:1 }), 'utf8');

  let pend;
  assert.doesNotThrow(() => { pend = readPending(dir); });
  assert.equal(pend.length, 1);
  assert.equal(pend[0].id, 'id-ok');
  assert.equal(existsSync(join(dir, 'failed', 'id-ruim.json')), true);
  assert.equal(existsSync(join(dir, 'failed', 'id-malformado.json')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('recoverClaimed devolve orfaos de claimed/ para pending/', () => {
  const dir = tmpQueue();
  const job = createJob({ message:'oi', mode:'once', fireAt: 1 }, 'id-1');
  writeJob(dir, job);
  claim(dir, job, 'sessMorta'); // simula sessão que morreu antes de markDone
  assert.equal(readPending(dir).length, 0);

  const n = recoverClaimed(dir);
  assert.equal(n, 1);
  assert.equal(existsSync(join(dir, 'pending', 'id-1.json')), true);
  assert.equal(readdirSync(join(dir, 'claimed')).length, 0);
  const pend = readPending(dir);
  assert.equal(pend.length, 1);
  assert.equal(pend[0].id, 'id-1');
  rmSync(dir, { recursive: true, force: true });
});
