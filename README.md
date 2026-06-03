# Disparador Automático para o Claude Code

Envia mensagens agendadas para a **sessão interativa do Claude Code que já está
aberta** — continuando a mesma conversa, sem roubar o foco da janela. Pensado para
contornar o travamento por limite de uso: quando o Claude mostra *"faltam X min
para reset"*, você agenda a continuação e ela é injetada sozinha quando reseta.

## Duas camadas

### Camada 1 — `/loop` nativo (dia a dia, zero código)
Dentro da sessão, digite `/loop 15m continue de onde paramos`. A cada 15 min a
mensagem é reenviada nesta conversa. **Limite:** depende do Claude estar
respondendo; se travado pelo limite, só dispara após o reset.

### Camada 2 — Wrapper `claude-go` (independente do Claude, sobrevive ao travamento)
Um processo externo hospeda o Claude e injeta a mensagem no horário marcado,
**mesmo com o Claude travado**, apenas quando o prompt está ocioso. O **registro
via terminal externo não usa o Claude e não gasta tokens** — essencial, porque no
momento do travamento o Claude não responde.

---

## Requisitos
- **Windows 10 1809+ / 11** (usa ConPTY).
- **Node.js 18+** (vem junto com o Claude Code).
- **Claude Code** instalado e acessível no PATH (`claude`).

## Instalação (uma vez)

```powershell
git clone https://github.com/diegocamara89/claude-go.git
cd claude-go
npm install
npm link   # expõe 'claude-go', 'cont' e 'agendar' no PATH
```

O caminho do Claude é **detectado automaticamente** (via `where claude`). Se o seu
Claude não estiver no PATH, informe o caminho em `disparador.config.json`
(`claudePath`).

## Uso

1. **Abra o Claude pelo wrapper** (em vez de `claude`):
   ```powershell
   claude-go
   ```
   Cada janela recebe um **rótulo `#N`** que aparece no **título da aba** (no VS
   Code, o `.vscode/settings.json` incluído faz a aba mostrar o `#N`). Use o Claude
   normalmente.

2. **Quando precisar agendar** (ex.: o Claude travou e mostra "37 min para reset"),
   num **terminal externo** rode o atalho `cont`:

   ```powershell
   cont                      # lista as janelas abertas: #1, #2, #3 ...
   cont 2 37m                # janela #2: "continue de onde paramos" em 37 min
   cont 2 37m "continue, foca no módulo de pagamentos"   # janela #2, msg custom
   cont 1 40m "retoma os testes e roda o lint"           # janela #1, outra msg
   cont ping                 # faz as janelas piscarem o título p/ você identificar
   ```

   - **Default rápido:** `cont <n> <tempo>` → "continue de onde paramos".
   - **Custom:** `cont <n> <tempo> "sua mensagem técnica"`.
   - Cada mensagem cai **só na janela escolhida**. Não usa o Claude, não gasta token.

   Unidades de tempo: `s`, `m`, `h`, `d` (ex.: `30s`, `15m`, `5h`, `1d`).

3. **Modos recorrentes / horário absoluto** (comando completo `agendar`):
   ```powershell
   agendar "continue" --to 2 --every 5h        # a cada 5h na janela #2
   agendar "bom dia" --to 1 --at 09:00 --daily  # 09:00 todo dia na janela #1
   agendar cancel 2 <id>                         # cancela um agendamento da #2
   ```

4. **De dentro da conversa** (opcional, *usa o Claude/tokens*): o comando
   `/agendar "mensagem" --in 15m` mira a própria janela. Útil quando o Claude está
   vivo; inútil quando travado (aí use o `cont` externo).

---

## Exemplo: duas janelas, mensagens diferentes

Abra duas sessões com `claude-go` — as abas mostram `#1` e `#2`. Num terminal externo:

```text
> cont 1 1m "diga: cheguei na janela 1"
#1 ← "diga: cheguei na janela 1"  em 1m (dispara 08:54:49)

> cont 2 1m "diga: cheguei na janela 2"
#2 ← "diga: cheguei na janela 2"  em 1m (dispara 08:55:16)
```

~1 minuto depois, **cada janela recebe só a sua mensagem**, sozinha, sem roubar o foco:

```text
janela #1  >  diga: cheguei na janela 1      →  ● Cheguei na janela 1
janela #2  >  diga: cheguei na janela 2      →  ● Cheguei na janela 2
```

<!-- Dica: para incluir uma captura de tela, use um print com caminho neutro
     (ex: clone o repo em C:\claude-go) para não expor seu usuário do Windows. -->

## Como identifico qual janela é qual?
- O rótulo `#N` fica no **título da aba/janela** do terminal (Windows Terminal,
  PowerShell e — com o `.vscode/settings.json` incluído — o terminal do VS Code).
- `cont` lista as janelas ativas (rótulo, hora de abertura, pasta).
- `cont ping` faz o título das janelas piscar `‹‹ AQUI ››` por uns segundos.

## Onde ficam os dados
`%USERPROFILE%\.claude-disparador\sessions\<N>\` (cada janela tem sua inbox:
`pending`, `claimed`, `done`, `failed`). Sobreposto por `CLAUDE_GO_QUEUE_DIR`.

## Testes
```powershell
npm test    # node --test (42 testes)
npm run smoke   # integração do host completo via PTY (sem o Claude real)
```

## Limitações conhecidas (MVP)
- Mensagens de **uma linha**.
- A injeção só ocorre com o Claude **ocioso no prompt** (não no meio de um
  processamento nem em modal de permissão).
- O `cont` mira janelas **abertas no momento** do comando.
- **Sobrevivência ao limite** validada empiricamente (ver o spec em
  `docs/superpowers/specs/`); se o Claude descartar a entrada no estado de limite,
  use `agendar --every` para reenviar até o prompt aceitar.
