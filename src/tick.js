// Lógica de um "tick" do scheduler do host, isolada para ser testável sem PTY.
// O host chama isto periodicamente; aqui não há I/O de terminal nem timers de processo.
import { readPending, claim, markDone, reschedule } from './queue.js';
import { isDue, nextFireAt } from './scheduler.js';
import { injectMessage } from './inject.js';

// Dispara no máximo um job por tick (evita enfileirar várias mensagens no prompt).
// Só injeta quando o detector reporta 'idle-prompt'. Retorna o job disparado ou null.
export function schedulerTick({ queueDir, sid, child, idle, now, enterDelayMs, injectFn = injectMessage }) {
  if (idle.state(now) !== 'idle-prompt') return null;
  for (const job of readPending(queueDir)) {
    if (!isDue(job, now)) continue;
    if (!claim(queueDir, job, sid)) continue;
    injectFn(child, job.message, { enterDelayMs });
    const next = nextFireAt(job, now);
    if (next == null) markDone(queueDir, job, sid);
    else reschedule(queueDir, job, sid, next);
    return job;
  }
  return null;
}
