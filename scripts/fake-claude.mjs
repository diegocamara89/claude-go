// "Claude" falso para o smoke do host: emite um prompt ao iniciar (para o detector
// de ociosidade ter saída para observar) e ecoa o que recebe no stdin com RECEBIDO:.
process.stdout.write('FAKE-CLAUDE-PRONTO> ');
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  if (buf.includes('\r')) {
    process.stdout.write('\nRECEBIDO:' + buf.replace(/\r/g, '') + '\n');
    buf = '';
  }
});
