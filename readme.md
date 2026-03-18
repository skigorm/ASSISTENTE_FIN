# 🤖 Assistente Financeiro com IA (WhatsApp)

Um assistente inteligente para controle financeiro via WhatsApp, capaz de registrar gastos através de texto ou imagem (comprovantes), utilizando IA para categorização automática.

## 🚀 Objetivo

Permitir que o usuário controle suas finanças de forma simples, enviando mensagens no WhatsApp como:

- "Gastei 50 reais no mercado"
- Foto de comprovante de compra

E o sistema automaticamente:
- Extrai os dados
- Categoriza o gasto
- Armazena
- Gera relatórios

---

## 🧠 Funcionalidades

- 📥 Entrada de dados via WhatsApp
- 🧾 Leitura de comprovantes (OCR)
- 🧠 Classificação automática com IA
- 💾 Armazenamento de gastos
- 📊 Resumo financeiro (diário/mensal)
- 🔍 Consulta por categoria
- ⚠️ Alertas de gastos

## 💬 Comandos de Consulta (WhatsApp)

Use em conversa privada com o bot:

- `resumo do mes`
- `total do mes`
- `total por categoria`
- `total alimentação no mes`
- `total transporte no mes`
- `total lazer no mes`
- `resumo 03/2026`
- `ajuda` (lista comandos)

## ⚙️ Variáveis de Ambiente (Heroku)

- `OPENAI_KEY`: chave da OpenAI
- `WHATSAPP_PAIRING_NUMBER`: número fixo para gerar código de pareamento (com DDI, só dígitos)
- `REDIS_URL`: URL do Heroku Redis (injetada automaticamente pelo add-on)
- `WHATSAPP_AUTH_PREFIX`: prefixo das chaves de sessão no Redis
- `REDIS_TLS`: habilita TLS no cliente Redis (`true` no Heroku)
- `REDIS_TLS_REJECT_UNAUTHORIZED`: validação de certificado TLS (`false` para Heroku Redis self-signed)

## 🔐 Pareamento com Número Fixo

1. Configure `WHATSAPP_PAIRING_NUMBER` com o número do bot (DDI + DDD + número, apenas dígitos).
2. Acesse `/pairing` para ver o código de pareamento (sem QR).
3. No celular do número do bot: `Dispositivos conectados` → `Conectar com número de telefone`.
4. Digite o código mostrado na página.

Com `REDIS_URL` ativo, a sessão do WhatsApp fica persistida e evita novo pareamento a cada deploy/restart.

---

## 🏗️ Arquitetura (MVP)

```bash
WhatsApp (Twilio / Meta API)
        ↓
Webhook (Node.js / Express)
        ↓
Processamento IA (OpenAI)
        ↓
Banco de Dados (SQLite / PostgreSQL)
