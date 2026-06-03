// Lê stdin e imprime com prefixo; usado no lugar do Claude no e2e.
// Quando descoberto pelo node --test diretamente (não via ConPTY), sai imediatamente.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  if (buf.includes('\r')) {
    process.stdout.write(`RECEBIDO:${buf.replace(/\r/g, '')}\n`);
    buf = '';
  }
});
