---
description: Agenda uma mensagem para ser injetada NESTA janela do claude-go
---

O usuário quer agendar uma mensagem para o disparador, **nesta própria janela**. Os argumentos dele são: `$ARGUMENTS`

Execute **IMEDIATAMENTE** o comando abaixo via Bash, exatamente como está. **NÃO** simule com `sleep`, **NÃO** improvise um timer, **NÃO** rode nada em background — apenas execute e mostre a saída:

```bash
agendar $ARGUMENTS --to "$CLAUDE_GO_LABEL"
```

Depois de executar:
- Se a variável `$CLAUDE_GO_LABEL` estiver vazia (o comando reclamar de `--to`), avise o usuário: esta sessão **não** foi aberta pelo `claude-go`, então o disparo não funciona aqui — ele precisa abrir o Claude com `claude-go`.
- Se teve sucesso, confirme em UMA linha quando vai disparar.
- Se deu outro erro, mostre a mensagem e lembre a sintaxe: `/agendar "<mensagem>" --in 15m | --every 5h | --at 14:30 [--daily]`.

Contexto para você (Claude): o disparo **não** acontece via CLI nem em sessão nova. Quando o horário chegar e este prompt estiver ocioso, o wrapper `claude-go` que hospeda esta janela injeta a mensagem **aqui mesmo**. Para agendar de FORA da conversa (sem gastar tokens, útil quando o limite travou), o usuário usa o comando `cont <n> <tempo>` num terminal externo.
