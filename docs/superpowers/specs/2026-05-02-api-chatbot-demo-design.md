# API Chatbot Demo: Design Spec

**Date:** 2026-05-02
**Author:** Richard Ong
**Status:** Draft for review
**Target deploy:** NPC 2026 demo
**Design conversation:** brainstorming session 2026-05-02

## 1. Background

The Australian Property Institute already runs two AI projects:

1. `api-chatbot.pages.dev`. Internal staff reference tool for member enquiries. Originally built with both chat and a QA-on-uploaded-reports capability. After the API board demo, the QA function was split into its own product.
2. **QA Valuation Application.** Separate API product (Product 2). Currently in Phase 1.1: multi-tenant Postgres FORCE RLS shipped, FastAPI auth pending CEO approval for the Azure subscription. Lives in `~/api-brain/05_Projects/qa-valuation/`.

This new project is a **third deployment**, fully independent of both. It exists to demo the API knowledge tool with an SI lookup at NPC 2026, embedded in the api.org.au Vercel site (currently `api-website-eta.vercel.app`).

It must not affect or share infrastructure with the existing two projects.

## 2. Goals

1. Replicate the existing chatbot's API standards lookup experience.
2. Add bank Security Instructions (SI) lookup for NAB, CBA, Westpac, ANZ, baked into the system prompt with Gemini prompt caching.
3. Strip every QA-related UI element and copy from the widget.
4. Deploy to a new Cloudflare Pages site at `api-chatbot-demo.pages.dev`.
5. Replace the iframe src in the api-website Vercel project to point at the new bot.

## 3. Non-goals

- Modifying or replacing the existing `api-chatbot.pages.dev` deployment.
- Touching the QA Valuation app codebase.
- Implementing rate limiting in v1. Origin allowlist is the only abuse guard.
- GROQ fallback in v1. Deferred to v1.1 once the GROQ key on the Windows machine is reachable.
- Authentication of any kind. No PIN gate, no JWT, fully open.
- Embeddings-based retrieval. BM25-style text search via flexsearch is sufficient for the 1032-chunk corpus.
- Persistent chat history beyond the existing sessionStorage pattern.

## 4. Architecture

### 4.1 Repo layout

```
api-chatbot-demo/
├── public/
│   ├── index.html               Single-file widget, QA UI stripped, copy retuned
│   └── data/
│       ├── si-lookup-index.json
│       ├── bank-si-matrix.json
│       ├── doc-index.json
│       └── chunks.json
├── functions/
│   ├── _shared/
│   │   ├── retriever.ts         flexsearch index over chunks.json
│   │   ├── system-prompt.ts     Builds SI cachedContent block + base prompt
│   │   ├── origin-check.ts      Allowlist guard
│   │   └── providers/
│   │       ├── gemini.ts        Primary, with cachedContent
│   │       └── openai.ts        Fallback
│   └── api/
│       ├── chat.ts              Streaming Gemini call with retrieval injection
│       └── upload.ts            PDF/text extraction via unpdf
├── package.json
├── tsconfig.json
├── README.md
└── .gitignore
```

### 4.2 Stack

| Concern | Choice |
|---------|--------|
| Hosting | Cloudflare Pages, single deploy for static + Functions |
| Runtime | Workers V8 isolate, TypeScript |
| Primary model | `gemini-2.5-flash` via `@google/generative-ai` |
| Fallback model | `gpt-4o-mini` via `openai` npm package |
| Retrieval | `flexsearch` over `chunks.json`, in-memory per isolate |
| PDF parsing | `unpdf` (Workers-compatible replacement for `pdf-parse`) |
| Caching | Gemini `cachedContent` for the SI matrix block, ~5 min TTL |
| CI | None for v1. Manual `wrangler pages dev` + smoke checks |

### 4.3 Data assets

All four JSON files in `public/data/` are copied at scaffold time from `~/api-brain/05_Projects/qa-valuation/demo/data/` (currently a Google Drive symlink). They are static for the duration of the demo. Updates require a redeploy.

| File | Size | Tokens | Purpose |
|------|------|--------|---------|
| si-lookup-index.json | 5.9KB | ~1.5K | Lender to property type to column ref index |
| bank-si-matrix.json | 508KB | ~130K | Full SI matrix content per lender + property type |
| doc-index.json | 40KB | ~10K | Catalogue of API standards documents by docId |
| chunks.json | 3.5MB | ~900K | 1032 pre-chunked text snippets, no embeddings |

### 4.4 Environment

| Variable | Type | Purpose |
|----------|------|---------|
| `GEMINI_API_KEY` | Secret | Google AI Studio API key |
| `OPENAI_API_KEY` | Secret | Top line from `~/Downloads/from_windows/Open AI Key.txt` |
| `ALLOWED_ORIGINS` | Plain env | Comma-separated origins permitted to call `/api/*` |

`ALLOWED_ORIGINS` initial value:
```
https://api-website-eta.vercel.app,https://api-chatbot-demo.pages.dev
```

## 5. Chat flow

### 5.1 Request shape (frontend to /api/chat)

```json
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "uploadedDocs": [
    { "name": "filename.pdf", "text": "extracted text" }
  ]
}
```

The old `systemPrompt` field is removed from the request. The system prompt is now built server-side because the SI matrix lives there.

### 5.2 Worker pipeline per call

1. **Origin check.** Reject if `Origin` header is not in `ALLOWED_ORIGINS`. Returns 403 with no body.
2. **Retrieve.** flexsearch index already initialised in this isolate from `chunks.json`. Take the latest user message, query the index, return the top 8 chunks (id, title, text, page).
3. **Build prompt:**
   - **Cached block** (~140K tokens, reused for ~5 min via `cachedContent`):
     - BASE_PROMPT (role and behaviour rules, see section 7)
     - SI matrix JSON
     - SI lookup index JSON
     - doc-index JSON
   - **Per-call block:** top 8 retrieved chunks, plus any uploaded user documents.
   - **History:** the messages array.
4. **Call Gemini 2.5 Flash** with `cachedContent` reference + per-call block + history. Stream the response.
5. **On Gemini error or 3-second timeout:** fall back to OpenAI `gpt-4o-mini`. Send the full system prompt inline because OpenAI has no equivalent caching feature. Stream the response.
6. **Stream to client** as Server-Sent Events: `data: {...}\n\n` per chunk, `data: [DONE]\n\n` at end. Same wire format as the existing widget so the frontend stream parser stays untouched.

### 5.3 Cache lifecycle

- The Worker isolate holds `globalThis._geminiCache = { name: string, expiresAt: number } | null`.
- On first call (or when `expiresAt` is in the past), the Worker creates a new cached content via Gemini's API with the static blob and stores the returned cache name plus expiry.
- Concurrent first-calls within the same isolate use a single-flight Promise lock to prevent duplicate cache creation.
- Cache invalidation happens automatically on the Gemini side after TTL. The Worker recreates lazily on next call.

### 5.4 Provider fallback contract

Both `gemini.ts` and `openai.ts` export the same shape:

```ts
streamChat(opts: {
  systemPrompt: string,
  messages: Message[],
  signal?: AbortSignal
}): AsyncIterable<string>
```

`chat.ts` tries `gemini` first with a 3-second timeout for the first token. If Gemini errors or times out, the abort is propagated and `openai` is invoked. The user sees no UI difference. A single console log records the fallback for post-demo debugging.

## 6. Upload flow

1. Frontend posts a multipart form to `/api/upload` with a single file field.
2. Worker reads via the built-in `request.formData()`. No busboy needed.
3. PDF: `unpdf.extractText(buffer)` returns concatenated text. Truncate to 40,000 characters.
4. Plain text or markdown: read the file as UTF-8. Truncate to 40,000 characters.
5. Worker responds with `{ text, truncated }`. Frontend appends to in-memory `uploadedDocs` and threads them into the next chat request.

5MB file size limit enforced at the Worker (early reject before buffering). PDFs without a text layer return `{ text: "", error: "no text extractable" }` and the frontend shows an error chip.

## 7. System prompt rewrite

The existing `BASE_SYSTEM_PROMPT` constant currently lives in the zip's frontend JavaScript. It is migrated to the server (`functions/_shared/system-prompt.ts`) and retained as the foundation. Frontend no longer holds a system prompt. Changes from the original wording:

- Remove every reference to QA, "valuation report review", "Quick QA review".
- Add an SI lookup capability statement.
- Reinforce voice rules: brief, scannable, plain Australian English (organise, recognise, behaviour, colour), no "Certainly!" openings, no em or en dashes.

New paragraph appended after the existing role description:

> You also have access to the bank Security Instructions matrix for NAB, CBA, Westpac, and ANZ. When asked which Security Instruction template applies, look up by lender name and property type and return the column reference and section count. When asked about specific section content, cite the matrix directly.

The cached block ordering (verbatim, server-built):

```
{BASE_SYSTEM_PROMPT}

---
SI Reference Data (do not paraphrase, return literal column refs and section counts)
---

{si-lookup-index.json content}

{bank-si-matrix.json content}

---
Document Catalogue (use to map retrieved chunks back to their source document)
---

{doc-index.json content}
```

## 8. Frontend changes from the zip

The widget HTML in the zip is the starting point. Required changes:

| Element | Change |
|---------|--------|
| PIN gate overlay (`#pin-overlay`, `submitPin()`, `fetchToken()` flow) | Remove entirely. No JWT, no token endpoint, no PIN. |
| `Authorization: Bearer ${jwtToken}` header on chat call | Remove. |
| Welcome message copy | Update to mention SI lookup explicitly. |
| Suggested questions | Replace one of the three CPV/RPC/EVP buttons with an SI lookup example, e.g. "Which SI applies to NAB shopping centre valuations?" |
| `BASE_SYSTEM_PROMPT` constant in JS | Remove. System prompt is server-built. |
| `buildSystemPrompt()` function | Remove. |
| Document upload bar | Keep. PDF + txt + md still supported. |
| Demo notice banner ("PROTOTYPE Embedded widget demo") | Keep for transparency. |
| Header text ("Internal staff reference") | Update to "Member assistant" since this is now public. |
| Title tag | Update to "API Member Assistant" |

The token endpoint (`functions/token.js`) is dropped entirely. No replacement.

## 9. Error handling

| Failure | Behaviour |
|---------|-----------|
| Gemini API error or 3-sec first-token timeout | Silent fallback to OpenAI. User sees no UI hiccup. |
| OpenAI also fails | Emit SSE error event. Frontend shows red error bubble (existing pattern). |
| Gemini cache create failure | Bypass cache. Send everything inline. Console warns. Call still succeeds. |
| flexsearch index build failure at cold start | Return all chunks unfiltered for that call. Degraded retrieval but answers. Rebuild attempted on next request. |
| PDF parse failure (`unpdf` throws) | Frontend shows error chip on the upload doc, existing pattern. |
| Origin check failure | 403, no body, no leak of allowed origins. |
| Stream connection drop mid-response | Frontend keeps the partial answer. No retry. |
| Gemini key missing | Fail fast with `500 server configuration error` on first call. |
| OpenAI key missing | Fail-soft. Gemini failures cascade to user-visible error since fallback is unavailable. |

## 10. Testing

Kept light for a 2-week demo. No CI, no automated suite.

| Stage | What |
|-------|------|
| Local dev | `wrangler pages dev` runs static + Functions with env bindings. Iterate in the browser. |
| Smoke test (pre-deploy) | 10 curated demo questions: 3 SI lookups (NAB, CBA, Westpac), 4 standards questions (CPV, RPC, EVP, ANZVGP 111), 3 edge cases ("what is your favourite colour", upload a corrupt PDF, ask a Mandarin sentence). |
| Provider failover drill | Set `GEMINI_API_KEY=invalid` in dev. Confirm OpenAI takes over with no UI hiccup. Restore key. |
| Origin allowlist drill | Curl `/api/chat` with no Origin header and with a wrong Origin. Both must return 403. |
| Pre-NPC rehearsal | Hit the live `api-chatbot-demo.pages.dev` URL on the same wifi network the demo will use. Time first-token latency from a cold start. Run the 10-question smoke test live. |

## 11. Deployment

### 11.1 Repo creation

1. `git init` in `~/api-brain/05_Projects/api-chatbot-demo/`.
2. Create GitHub repo `rong4483-sketch/api-chatbot-demo` via API or web. SSH key already on the machine.
3. Push initial commit.

### 11.2 Cloudflare Pages

1. New Pages project named `api-chatbot-demo`, connected to the GitHub repo.
2. Build settings: leave default, no build step needed (Pages auto-detects Functions).
3. Add secrets via `wrangler pages secret put`:
   - `GEMINI_API_KEY` (paste from existing source)
   - `OPENAI_API_KEY` (`head -1 "/Users/RichardOng/Downloads/from_windows/Open AI Key.txt"` piped directly into wrangler, never echoed)
4. Add plain env var `ALLOWED_ORIGINS` via dashboard.
5. Auto-deploy on push to `main`.
6. Verify deploy at `https://api-chatbot-demo.pages.dev`.

### 11.3 Vercel iframe swap

1. Clone `rong4483-sketch/api-sandbox`.
2. Find the Member Concierge component containing the iframe with `src="https://api-chatbot.pages.dev/"`.
3. Change the src to `https://api-chatbot-demo.pages.dev/`.
4. Commit on a branch, open a PR titled "Swap concierge iframe to api-chatbot-demo for NPC".
5. Once merged, Vercel auto-deploys.

## 12. Observability

- Cloudflare Pages logs via `wrangler pages deployment tail`.
- Console logs at: cache create, retrieval timing (top score, total time), provider fallback trigger, allowed-origin reject.
- No external observability tool in v1. Sentry or Logflare can be added later if this becomes a longer-lived deployment.

## 13. Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cold-start latency on first call after isolate sleep (~2-3 sec for cache build + flexsearch index) | High during quiet periods | Pre-NPC rehearsal warms the isolate just before stage time. First-token latency budget: 4 sec cold, 1 sec warm. |
| Gemini cache TTL (~5 min) re-warms during quiet demo segments | Medium | Acceptable. Re-warm is ~2 sec. Backstage banter buffer. |
| No rate limit, fully open | Medium for abuse | Origin allowlist blocks the obvious scrape path. Cloudflare's free DDoS protection covers volume floods. Add Cloudflare Rate Limiting binding if abuse appears. |
| `flexsearch` indexing 1032 chunks at cold start uses ~3MB heap | Low | Workers isolates have 128MB. Within budget. |
| Origin URL format mismatch (www vs non-www, http vs https) | Medium | Test both forms. Add www variants to allowlist proactively. |
| `unpdf` cannot parse scanned PDFs (no text layer) | High for scanned reports | Frontend chip shows clear error. Demo script avoids scanned PDFs. |
| Gemini key rate-limited or revoked during demo | Low | OpenAI fallback handles this. Provider failover drill verifies the path works. |
| `chunks.json` (3.5MB) takes time to load on first call | Low | Pages serves from edge, fetch is local-region. ~50-100ms. |

## 14. Open questions

None. All scope decisions resolved during the 2026-05-02 brainstorming session:

- QA UI strip: yes, every QA reference removed
- SI lookup UX: chat-only (option A)
- SI data depth: full matrix baked with caching (option B)
- API standards retrieval: BM25 over chunks (option A2)
- Auth: fully open with origin allowlist (option A)
- PDF support: kept, swap to `unpdf` (Workers-compatible)
- Branding: keep DM Sans + teal/yellow palette
- Naming: `api-chatbot-demo` for both repo and Pages project
- Vercel swap: I commit the iframe src change to `rong4483-sketch/api-sandbox`
- Provider fallback: OpenAI v1, GROQ v1.1

## 15. Success criteria

The demo is shippable when:

1. The widget loads at `https://api-chatbot-demo.pages.dev` with no PIN gate and no QA UI.
2. Asking "Which SI applies to NAB shopping centre valuations?" returns "NAB Shopping Centre Valuations, Column F, 23 sections" or similar.
3. Asking a question about ANZVGP 111 (or any document in the chunks corpus) returns a grounded answer that quotes or cites a chunk.
4. Uploading a PDF and asking about its content returns an answer drawn from the upload.
5. With `GEMINI_API_KEY` set to invalid, the bot still answers via OpenAI with no visible UI hiccup.
6. The Vercel api-sandbox site, after the iframe src swap, opens the new bot when the Member Concierge launcher is clicked.
7. First-token latency on a warm isolate is under 1.5 seconds.
