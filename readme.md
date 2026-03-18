# Assistente Financeiro no WhatsApp (Node.js + Baileys + OpenAI)

Bot financeiro para WhatsApp com:
- registro de gastos por linguagem natural
- onboarding de novos usuários
- perfil financeiro (nome, renda, orçamento por categoria)
- categorias personalizadas (ex: obra, dízimo, água, luz, alarme)
- alertas de orçamento
- edição e remoção de despesas
- persistência em Redis (Heroku) com fallback em arquivo

## Como funciona

1. Usuário envia mensagem no WhatsApp (ex: `gastei 45 no mercado ontem`).
2. O bot tenta interpretar com OpenAI.
3. Se a OpenAI falhar, usa fallback local por regex.
4. Salva transação com ID.
5. Responde com confirmação natural + resumo do mês.
6. Dispara alerta se orçamento por categoria estiver perto de acabar.

## Fluxo de primeiro uso (onboarding)

Na primeira conversa, o bot pergunta:
- como chamar o usuário (nome)
- se deseja informar renda mensal
- se deseja definir orçamento por categoria

Categorias padrão:
- Alimentação
- Transporte
- Lazer
- Outros

Você pode criar categorias novas a qualquer momento.

Também salva alertas de orçamento (padrão: `10% 20% 30%` de saldo restante).

## Comandos principais (WhatsApp)

- `ajuda`
- `resumo do mes`
- `resumo 03/2026`
- `total por categoria`
- `total alimentação no mes`
- `como estao minhas contas`
- `orçamento do mes`
- `saldo do mes`
- `listar gastos`
- `listar gastos 20`
- `remover gasto <id>`
- `remover ultimo gasto`
- `desfazer ultimo gasto`
- `editar gasto <id> para 45 no mercado ontem`
- `corrigir ultimo gasto para uber 32 hoje`
- `meu perfil`
- `nome Igor`
- `renda 8500`
- `orçamento alimentação 1200`
- `categorias`
- `criar categoria obra`
- `criar categoria água com orçamento 250`
- `remover categoria obra`
- `limpar orçamento alimentação`
- `alertas 10 20 30`
- `reconfigurar perfil`

## Pareamento (código, sem QR)

1. Defina `WHATSAPP_PAIRING_NUMBER` (somente dígitos, com DDI).
2. Abra `https://SEU-APP.herokuapp.com/pairing`.
3. Copie o código exibido.
4. No celular do número do WhatsApp:
   - WhatsApp → Dispositivos conectados → Conectar com número de telefone
   - cole o código.

## Variáveis de ambiente

Use `.env.example` como base:

- `OPENAI_KEY=...`
- `OPENAI_MODEL=gpt-4o-mini` (opcional)
- `WHATSAPP_PAIRING_NUMBER=55619...`
- `DISABLE_WHATSAPP_BOT=false`
- `WHATSAPP_LOG_MESSAGES=true`
- `WHATSAPP_LOG_IGNORED_MESSAGES=false`
- `REDIS_URL=...`
- `WHATSAPP_AUTH_PREFIX=finance-bot:baileys-auth`
- `WHATSAPP_DATA_PREFIX=finance-bot:transactions`
- `REDIS_TLS=true`
- `REDIS_TLS_REJECT_UNAUTHORIZED=false`

## Persistência de dados

### Sessão do WhatsApp
- preferencialmente no Redis (`WHATSAPP_AUTH_PREFIX`)
- fallback local em `data/baileys_auth` se Redis indisponível

### Dados financeiros
- preferencialmente no Redis (`WHATSAPP_DATA_PREFIX`)
- fallback local:
  - `data/transactions.json`
  - `data/users.json`

## Redis no Heroku

1. Adicione o add-on Redis:
```bash
heroku addons:create heroku-redis:mini
```
2. Confirme:
```bash
heroku config:get REDIS_URL
```
3. Configure TLS:
```bash
heroku config:set REDIS_TLS=true REDIS_TLS_REJECT_UNAUTHORIZED=false
```

## Rodar local

```bash
nvm use 23
npm install
npm start
```

App HTTP:
- `GET /` -> `finance-bot online`
- `GET /health` -> `{ "ok": true, "service": "finance-bot" }`
- `GET /pairing` -> página de pareamento
- `GET /pairing/status` -> status do WhatsApp

## Deploy Heroku

`Procfile`:
```txt
worker: node src/app.js
```

Se usar dyno `web`, também funciona, pois há servidor HTTP em `process.env.PORT`.

## Observações importantes

- O bot responde apenas em chat direto (não responde em grupos/newsletter).
- Mensagens promocionais tendem a ser ignoradas para reduzir falso positivo.
- Se OpenAI estiver sem quota, o fallback local continua ativo para casos simples.
