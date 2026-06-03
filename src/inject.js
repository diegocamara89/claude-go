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
  // Enter separado e atrasado; protegido caso o PTY feche nesse intervalo.
  setTimeoutFn(() => { try { pty.write('\r'); } catch { /* PTY fechou */ } }, enterDelayMs);
}
