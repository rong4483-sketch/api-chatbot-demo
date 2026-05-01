# API Chatbot Demo

API Member Assistant demo for NPC 2026. Chat with the API standards corpus plus bank Security Instructions lookup for NAB, CBA, Westpac, and ANZ. Embedded as an iframe in api.org.au.

## Status

Pre-deploy. See `docs/superpowers/specs/2026-05-02-api-chatbot-demo-design.md` for the full design.

## Stack

- Cloudflare Pages, static + Pages Functions in one deploy
- TypeScript on Workers V8 isolate
- Primary model: Gemini 2.5 Flash with `cachedContent` for the SI matrix
- Fallback model: OpenAI gpt-4o-mini
- Retrieval: flexsearch over 1032 chunks of API standards
- PDF parsing: unpdf

## Local development

```bash
npm install
npm run dev
```

Requires three env vars set via `wrangler pages secret put` for chat to work:

| Name | Required | Description |
|------|----------|-------------|
| `GEMINI_API_KEY` | yes | Google AI Studio key |
| `OPENAI_API_KEY` | yes | OpenAI key (fallback path) |
| `ALLOWED_ORIGINS` | yes | Comma-separated list of allowed Origin headers |

For local dev, put them in a `.dev.vars` file (gitignored).

## Deploy

Connected to Cloudflare Pages project `api-chatbot-demo`. Auto-deploys from `main`.

```bash
npm run deploy
```

## Endpoints

| Path | Purpose |
|------|---------|
| `/` | Static widget HTML |
| `/api/chat` | Streaming chat (SSE), POST |
| `/api/upload` | PDF/text/markdown extraction, POST multipart |
| `/data/*.json` | Static reference data (SI matrix, chunks, doc index) |

## Project layout

```
public/             Static assets served by Pages
├── index.html      The widget
└── data/           Reference data, served as static JSON
functions/          Pages Functions (run on Workers)
├── _shared/        Internal modules (not exposed as routes)
└── api/            HTTP routes under /api/*
```

## Independence

This project is independent of `api-chatbot.pages.dev` (the existing internal staff bot) and the QA Valuation app. It does not share infrastructure or code with either.
