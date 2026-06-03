// Garante que o rótulo #N apareça no título da aba/janela do terminal e
// permaneça lá mesmo quando o Claude tenta definir o próprio título.
// OSC de título: ESC ] 0|1|2 ; <texto> BEL
const OSC_TITLE_RE = /\x1b\]([012]);([^\x07\x1b]*)(\x07)/g;

export function labelPrefix(label) { return `#${label} · `; }

export function setTitleSeq(label, text = 'claude') {
  return `\x1b]0;${labelPrefix(label)}${text}\x07`;
}

// Reescreve as sequências OSC de título dentro de um chunk de saída do Claude,
// garantindo o prefixo #N. Best-effort por chunk (sequências partidas entre
// chunks são raras e o próximo título corrige).
export function prefixTitles(data, label) {
  const pfx = labelPrefix(label);
  return data.replace(OSC_TITLE_RE, (m, ps, txt, term) => {
    if (txt.startsWith(pfx)) return m;
    return `\x1b]${ps};${pfx}${txt}${term}`;
  });
}
