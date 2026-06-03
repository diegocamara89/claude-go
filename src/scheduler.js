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

export function isDue(job, now) {
  return job.fireAt != null && job.fireAt <= now;
}

export function nextFireAt(job, now) {
  if (job.mode === 'interval') return now + job.everyMs;
  if (job.mode === 'at' && job.daily) return parseClock(job.time, now);
  return null;
}
