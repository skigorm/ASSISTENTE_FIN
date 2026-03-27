# Assistente Financeiro no WhatsApp (Node.js + Baileys + OpenAI)

Bot financeiro para WhatsApp com:
- registro de gastos por linguagem natural
- leitura de comprovante por foto (imagem)
- onboarding de novos usuários
- perfil financeiro (nome, renda, orçamento por categoria)
- categorias personalizadas (ex: obra, dízimo, água, luz, alarme)
- alertas de consumo automáticos
- edição e remoção de despesas
- painel de administração para habilitar/desabilitar acesso por usuário
- painel web do usuário com gráficos, tabela de despesas e exportação Excel
- persistência em Redis (Heroku) com fallback em arquivo

## Como funciona

1. Usuário envia mensagem no WhatsApp (ex: `gastei 45 no mercado ontem`).
2. O bot tenta interpretar com OpenAI.
3. Se a OpenAI falhar, usa fallback local por regex.
4. Salva transação com ID.
5. Responde com confirmação natural + resumo do mês.
6. Dispara alertas automáticos de consumo a cada 10% (total do mês e por categoria).

Também aceita foto de comprovante:
1. Usuário envia imagem (com ou sem legenda).
2. O bot extrai valor/categoria/descrição/data via OpenAI.
3. Mostra prévia e pergunta: `Deseja salvar esse gasto? (sim/não)`.
4. Usuário confirma (`sim`) ou corrige em texto (`valor 45 categoria alimentação`) antes de salvar.

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

Alertas de consumo são automáticos em faixas de `10% 20% ... 100%`, no total do mês e por categoria.

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
- `painel web` (envia link para acessar o dashboard no navegador)
- `link web`
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
- `alertas` (mostra como funcionam os alertas automáticos)
- `reconfigurar perfil`
- enviar foto do comprovante + responder `sim` para salvar

## Pareamento (código, sem QR)

1. Defina `WHATSAPP_PAIRING_NUMBER` (somente dígitos, com DDI).
2. Abra `https://SEU-APP.herokuapp.com/pairing`.
3. Copie o código exibido.
4. No celular do número do WhatsApp:
   - WhatsApp → Dispositivos conectados → Conectar com número de telefone
   - cole o código.

## Painel de administração (acesso de usuário)

1. Configure as variáveis:
   - `ADMIN_PANEL_USERNAME=admin` (ou outro usuário)
   - `ADMIN_PANEL_PASSWORD=<senha forte>`
2. Abra `https://SEU-APP.herokuapp.com/admin`
3. Faça login (Basic Auth do navegador).
4. No painel, clique em **Habilitar** ou **Desabilitar** para cada usuário.

Quando desabilitado, o usuário recebe mensagem de acesso bloqueado no WhatsApp.

## Painel web do usuário (resumo financeiro)

1. No WhatsApp, envie `painel web` para receber o link automaticamente.
2. Faça login com:
   - Usuário: número de telefone (somente dígitos)
   - Senha: o mesmo número de telefone
3. O painel mostra:
   - KPIs do mês e acumulado
   - gráfico de categorias do mês
   - gráfico dos últimos meses
   - tabela com todas as despesas
4. Use o botão **Exportar Excel** para baixar planilha `.xls` com resumo e despesas.

Regras de acesso:
- no primeiro login web, o perfil do telefone é criado automaticamente
- se o acesso estiver desabilitado no `/admin`, o painel web também bloqueia login

## Variáveis de ambiente

Use `.env.example` como base:

- `OPENAI_KEY=...`
- `OPENAI_MODEL=gpt-4o-mini` (opcional)
- `OPENAI_VISION_MODEL=gpt-4o-mini` (opcional, para leitura de comprovante por imagem)
- `WHATSAPP_PAIRING_NUMBER=55619...`
- `APP_BASE_URL=https://seu-app.herokuapp.com` (necessária para o comando `painel web` enviar link completo)
- `DISABLE_WHATSAPP_BOT=false`
- `WHATSAPP_LOG_MESSAGES=true`
- `WHATSAPP_LOG_IGNORED_MESSAGES=false`
- `REDIS_URL=...`
- `WHATSAPP_AUTH_PREFIX=finance-bot:baileys-auth`
- `WHATSAPP_DATA_PREFIX=finance-bot:transactions`
- `REDIS_TLS=true`
- `REDIS_TLS_REJECT_UNAUTHORIZED=false`
- `ADMIN_PANEL_USERNAME=admin`
- `ADMIN_PANEL_PASSWORD=...` (obrigatória para ativar `/admin`)

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
- `GET /web` -> painel web para usuário final
- `GET /web/api/dashboard` -> dados do dashboard (auth Basic com telefone:telefone)
- `GET /web/api/dashboard/export` -> exportação Excel `.xls` (auth Basic com telefone:telefone)
- `GET /admin` -> painel de gestão de usuários (com autenticação)
- `GET /admin/api/users` -> lista usuários para o painel
- `POST /admin/api/users/:user/access` -> habilita/desabilita acesso

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
