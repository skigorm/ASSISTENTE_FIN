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