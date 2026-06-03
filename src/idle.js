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
