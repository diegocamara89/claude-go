# Disparador Automático de Mensagens para o Claude Code — Design

- **Data:** 2026-05-31
- **Autor:** Diego + Claude
- **Status:** Aprovado para implementação (revisado pós-revisão adversarial do Codex)

## 1. Problema

O Claude Code (CLI interativo) trava periodicamente ao atingir o limite de uso
(~a cada 5 horas). Quando isso acontece, o usuário fica impedido de continuar o
trabalho até reenviar uma mensagem manualmente. O objetivo é **programar o envio
de uma mensagem para a sessão interativa que já está em andamento** — continuar o
mesmo fio de conversa (mesmo contexto), como se o usuário tivesse digitado mais
uma mensagem e dado Enter, só que de forma automática e agendada.

Requisitos confirmados no brainstorming:

- **Continuar a MESMA conversa** (mesmo contexto), não abrir sessão nova.
- **Não roubar o foco** da janela — deve funcionar mesmo enquanto o usuário usa o PC.
- Funcionar nos terminais que o usuário usa: **Windows Terminal, terminal do VS Code e PowerShell (pwsh)** — Windows nativo, sem WSL.
- **3 modos de disparo:** único (`daqui a X`), recorrente (`a cada ~5h`), horário absoluto (`14:30`).
- **3 formas de registrar:** da própria conversa, de outro terminal, ou por arquivo.
- Solução **simples de manter** porém **estável / sem falhas**.

## 2. Restrição física (Windows) que define a arquitetura

No Windows não é possível escrever na entrada (stdin) de um processo que já foi
iniciado por conta própria. Para "continuar a conversa viva" só existem dois
caminhos:

1. **Simular teclado na janela** → exige foco. **Rejeitado** (o usuário precisa
   usar o PC durante a espera).
2. **Hospedar a sessão** num processo que controla a entrada do Claude → permite
   injetar sem foco. **Escolhido.**

Não há terceiro caminho. Por isso a sessão precisa ser iniciada pelo wrapper.

## 3. Solução em duas camadas

### Camada 1 — `/loop` nativo (dia a dia, zero código)
Recurso embutido do Claude Code. `\/loop 15m <mensagem>` re-injeta a mensagem na
conversa atual no intervalo dado. **Já validado ao vivo** durante o brainstorming
(um disparo único via agendamento interno chegou nesta conversa após ~2 min, com
o contexto preservado).
**Limitação:** depende do Claude estar respondendo e ocioso; se a sessão estiver
travada pelo limite de 5h, o disparo só ocorre após o reset, e não há catch-up
completo enquanto ocupado.

### Camada 2 — Wrapper `claude-go` (crítico, busca sobreviver ao travamento de 5h)
Processo externo e independente que hospeda o Claude num pseudo-terminal
(ConPTY) e injeta mensagens **quando detecta que o Claude está ocioso no prompt**.
Por ser independente do estado interno do Claude, é o que tem a melhor chance de
robustez contra o travamento de 5h — mas essa robustez é uma **hipótese a validar
empiricamente** (ver §8 e §10), não um dado garantido.

O restante deste documento especifica a **Camada 2**.

## 4. Arquitetura do wrapper

O usuário inicia a sessão com `claude-go` em vez de `claude`. O wrapper lança
`claude.exe` dentro de um ConPTY (via `node-pty`) e faz passthrough transparente
da E/S (teclado ↔ Claude, saída ↔ tela, redimensionamento). Por ser dono da
entrada do Claude, injeta mensagens sem tocar no foco da janela.

> **Princípio-chave (pós-revisão Codex):** o scheduler **nunca escreve direto no
> PTY**. Quem injeta é um **injetor com estado** que (a) reivindica o job de forma
> atômica, (b) **espera o Claude estar ocioso no prompt**, (c) injeta via
> *bracketed paste* + Enter de forma única e auditável, (d) registra apenas
> "entregue ao PTY". Em estado desconhecido, **não injeta** — aguarda/re-tenta.

### 4.1 Componentes (isolados e testáveis)

| Componente | Arquivo | Responsabilidade | Depende de |
|---|---|---|---|
| **Host PTY** | `src/claude-go.js` | Lança `claude.exe` no ConPTY; passthrough I/O; resize; tratamento de sinais e cleanup; recupera órfãos no startup; chama `schedulerTick` periodicamente | node-pty |
| **Tick** | `src/tick.js` | `schedulerTick`: um passo do loop, isolado e testável sem PTY (lê fila → due → claim → injeta se idle → done/reschedule). Dispara no máx. 1 job por tick | queue, scheduler, inject |
| **Scheduler** | `src/scheduler.js` | Lógica **pura** (sem I/O) de "está na hora?" para once/interval/at + parser de tempo. Decide *quais* jobs estão due; não injeta | — |
| **Detector de ociosidade** | `src/idle.js` | Observa o stream de saída do PTY e estima o estado: `idle-prompt`, `busy`, `unknown` (heurística: silêncio de saída por ≥ N ms ⇒ provável idle) | — |
| **Injetor** | `src/inject.js` | Recebe o handle do PTY; injeta `ESC[200~ <msg> ESC[201~` e depois `\r`; sanitiza caracteres de controle; só age em `idle-prompt` | idle, queue |
| **Fila** | `src/queue.js` | Estados `pending`→`claimed`→`done`/`failed` com claim atômico (rename); escrita atômica tmp+rename; at-least-once; valida schema e tamanho | fs |
| **CLI agendar** | `bin/agendar.js` | `agendar`/`list`/`cancel`. Usa `CLAUDE_GO_QUEUE_DIR` (não infere home) | queue, scheduler (parser) |

### 4.2 Localização da fila (decisão: global, via env var)

```
%USERPROFILE%\.claude-disparador\         (default; sobreposto por CLAUDE_GO_QUEUE_DIR)
├── config.json            # caminho do claude.exe, intervalo de polling, sessionId
├── pending\<id>.json      # agendamentos a disparar
├── claimed\<id>.<sid>.json# reivindicados por uma sessão (recuperados no startup)
├── done\<id>.json         # entregues ao PTY (histórico/idempotência)
└── failed\<id>.json       # falha ao entregar (auditoria)
```

**Correção do Codex (S2):** o Bash que o Claude usa de dentro da conversa é **WSL**
e não enxerga `%USERPROFILE%` da mesma forma que o wrapper Windows. Portanto o
wrapper **exporta `CLAUDE_GO_QUEUE_DIR`** (caminho Windows resolvido) no `env` do
processo, e `bin/agendar.js` **usa essa variável**, nunca inferindo a home. Quando
chamado de dentro do WSL, o caminho é convertido adequadamente.

**Escopo:** MVP assume **uma sessão `claude-go` ativa por vez**. O claim atômico
(`claimed\<id>.<sid>`) com `sid` da sessão protege contra disparo duplo. Jobs
reivindicados por uma sessão que morreu no meio do disparo são **recuperados no
startup** (`recoverClaimed`): todo arquivo em `claimed\` volta para `pending\`
quando um novo `claude-go` inicia (semântica at-least-once). Como o MVP assume uma
sessão por vez, recuperar tudo no startup é seguro e mais simples que TTL/lease.

### 4.3 Código do projeto

```
Disparador automatico claude/
├── package.json               # type=module; node-pty PINADO; scripts de teste
├── disparador.config.json     # template copiado para a pasta global no 1º uso
├── src/{claude-go,scheduler,idle,inject,queue}.js
├── bin/agendar.js
└── test/{scheduler,queue,inject,idle,e2e-pty}.test.js
```

## 5. Formato do agendamento (arquivo `.json`)

```json
{
  "id": "1730000000000-ab12",
  "message": "continue de onde paramos",
  "mode": "once",
  "fireAt": 1730000900000,
  "everyMs": null,
  "time": null,
  "daily": false,
  "createdAt": 1730000000000,
  "status": "pending"
}
```

- `mode: "once"` → usa `fireAt` (epoch ms).
- `mode: "interval"` → usa `everyMs`; após **entrega**, recalcula `fireAt = agora + everyMs`.
- `mode: "at"` → usa `time` (`"HH:MM"`); calcula a próxima ocorrência; `daily` reagenda, senão `done`.

**Validação (S2):** schema validado na escrita e na leitura; `message` com limite
de tamanho; caracteres de controle rejeitados por padrão (a injeção via bracketed
paste assume texto, não sequências de controle).

## 6. Fluxo de dados (com claim e detecção de estado)

```
[1] agendar.js (você / Claude / arquivo) → grava pending\<id>.json (atômico, validado)
[2] Scheduler (polling ~1s) → seleciona jobs com fireAt <= agora
[3] Claim atômico: rename pending\<id>.json → claimed\<id>.<sid>.json
       (se o rename falhar, outra sessão pegou; ignora)
[4] Injetor consulta o Detector de ociosidade:
       - idle-prompt → injeta ESC[200~ <msg> ESC[201~  e, após ~80ms, "\r"
       - busy / unknown → NÃO injeta; aguarda o próximo ciclo (re-tenta)
[5] Entregue ao PTY → move claimed → done\ (once/at não-diário)
       ou recalcula fireAt e volta a pending\ (interval / at diário)
[6] Claude recebe como entrada digitada no prompt → continua a MESMA conversa
```

Semântica **at-least-once**: em crash entre injetar e mover, o job pode ser
reentregue. `done` significa "entregue ao PTY", não "Claude processou".

## 7. Tratamento de erros e casos de borda

- **Detecção de estado (S0):** injeta apenas em `idle-prompt`. Heurística inicial:
  silêncio de saída do PTY por ≥ N ms (configurável, default ~1500ms) ⇒ idle.
  Refinável com padrões do prompt do Claude. Em `unknown`, não injeta.
- **Bracketed paste (S1):** mensagem enviada entre `ESC[200~` e `ESC[201~`, com
  `\r` **separado** depois — evita que o readline interprete o texto como comandos
  de edição. Caracteres de controle são removidos/escapados antes.
- **Ctrl+C / sinais / cleanup (S1):** em raw mode, `Ctrl+C` chega como `\x03` e é
  repassado ao child (Claude trata). O wrapper registra `process.on('exit')`,
  `SIGINT`, `SIGBREAK`, `uncaughtException` e `child.onExit` para **restaurar
  `setRawMode(false)`** e encerrar limpo. Fechar a janela encerra o child.
- **Backpressure (S2):** respeita o retorno de `stdout.write`/evento `drain` em
  floods de saída; usa flow control do node-pty com parcimônia (sem XON/XOFF que
  conflite com Ctrl+S/Ctrl+Q).
- **`claude.exe` não encontrado:** erro claro; caminho em `config.json`
  (autodetectado via `where claude` no 1º uso; default `C:\Users\<voce>\.local\bin\claude.exe`).
- **Disparo duplicado:** prevenido pelo claim atômico (rename) + `sid`.
- **Sleep/resume, relógio, DST (S2):** regra explícita = **sem catch-up completo**
  (igual ao scheduler nativo do Claude); ao acordar, um job atrasado dispara no
  máximo uma vez, jobs muito antigos podem ser descartados (configurável).
- **Segurança local (S2):** qualquer processo do mesmo usuário poderia gravar em
  `pending`. Mitigações: validar schema, limitar tamanho, rejeitar controle,
  manter `done`/`failed` como audit log, oferecer `list`/`cancel`.
- **Dependência nativa (S1):** `@lydell/node-pty` PINADO; **smoke-test de
  instalação** (Etapa 0 do plano) confirma o binário prebuilt no Node v22.14.0
  x64; fallback `node-pty` oficial documentado.
- **Mensagem multilinha:** MVP só **uma linha**; multilinha fica como melhoria.

## 8. Limitações conhecidas (MVP)

- **A sobrevivência ao limite de 5h é hipótese a validar (S0):** controlar o stdin
  não garante que o TUI do Claude aplique o input como prompt no estado de limite.
  Mitigação: detecção de idle + modo `interval` reenviando até a sessão voltar ao
  prompt. Se o teste manual mostrar que o Claude descarta input no estado de
  limite, o documento será atualizado e a estratégia revista.
- Uma sessão `claude-go` ativa por vez (claim por `sid` protege o resto).
- Mensagens de uma linha apenas.
- Não reabre o Claude automaticamente se o wrapper morrer.

## 9. Estratégia de testes ("sem falhas")

Test runner **nativo do Node 22** (`node --test`), sem dependências extras.

1. **`scheduler.test.js`** — parser (`15m`→900000, `5h`→18000000, `14:30`→próxima
   ocorrência) e "está due?" com relógio injetado; reagendamento interval/at;
   regra "sem catch-up" ao acordar.
2. **`queue.test.js`** — escrita atômica; **claim atômico** (duas sessões
   competindo, só uma vence); recuperação de `claimed` órfão no startup; leitura
   resiliente (JSON corrompido vai para `failed` sem derrubar); validação
   de schema/tamanho/caracteres de controle.
3. **`inject.test.js`** — monta a sequência bracketed paste correta; sanitiza
   controle; só injeta quando o detector diz `idle-prompt`.
4. **`idle.test.js`** — detector classifica `busy` (saída contínua) vs
   `idle-prompt` (silêncio ≥ N ms) a partir de um stream simulado.
5. **`e2e-pty.test.js`** — teste-chave: processo-eco dentro do ConPTY (não o
   Claude); injeta `"olá áéí"` pela fila e verifica recebimento **+ Enter +
   acentos** intactos e a sequência de paste. Sem Claude, sem foco.
6. **Smoke manual final (valida a hipótese S0)** — com o Claude real:
   (a) `agendar "diga oi" --in 1m` no prompt ocioso → chega sem roubar foco;
   (b) **forçar/aguardar o estado de limite de 5h** e disparar → observar se o
   input é aplicado ao reset. Resultado registrado no spec.

## 10. Critérios de aceitação

- [ ] `claude-go` abre o Claude indistinguível de rodar `claude` direto (cores,
      teclas, **Ctrl+C**, redimensionamento, **cleanup do terminal ao sair**).
- [ ] `agendar "msg" --in 1m` faz a mensagem chegar na conversa após ~1 min, com
      acentos corretos, **sem roubar foco**, **apenas no prompt ocioso**.
- [ ] Os 3 modos (`--in`, `--every`, `--at`) e `list`/`cancel` funcionam.
- [ ] Claim atômico impede disparo duplicado sob duas sessões.
- [ ] As 3 interfaces (CLI da conversa via WSL usando `CLAUDE_GO_QUEUE_DIR`, CLI de
      outro terminal, arquivo manual) registram agendamentos válidos.
- [ ] `node --test` passa em 100% dos testes automatizados.
- [ ] **Hipótese S0 registrada:** resultado do smoke-test no estado de limite de
      5h documentado (funciona / não funciona / mitigação aplicada).

## 11. Revisão adversarial (Codex) — achados incorporados

- **S0** Input enfileirado no limite não é garantido → tratado como hipótese a
  validar (§8/§10) + detecção de idle + modo interval de reenvio.
- **S0** Injeção sem estado pode submeter no momento errado → injetor só age em
  `idle-prompt`; em `unknown`, aguarda (§6).
- **S1** `texto+\r` ≠ paste → bracketed paste + sanitização (§7).
- **S1** Raw mode quebra Ctrl+C → mapeamento de `\x03` + restauração do terminal
  em todos os caminhos de saída (§7).
- **S1** Consumo não atômico → claim por rename + at-least-once + `done`=entregue
  (§4.1/§6).
- **S1** Dependência nativa → pin + smoke-test de instalação (Etapa 0).
- **S2** Caminho global x WSL → `CLAUDE_GO_QUEUE_DIR` no env (§4.2).
- **S2** Backpressure, sleep/DST, segurança local, `list`/`cancel` → §7.
