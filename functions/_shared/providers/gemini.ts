export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatOpts {
  apiKey: string;
  systemBlockText: string;
  perCallContext: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

interface GeminiCache {
  name: string;
  expiresAt: number;
}

const MODEL = 'gemini-2.5-flash';
const CACHE_TTL_SECONDS = 300;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

declare global {
  // eslint-disable-next-line no-var
  var _geminiCache: GeminiCache | null | undefined;
  // eslint-disable-next-line no-var
  var _geminiCachePromise: Promise<GeminiCache | null> | null | undefined;
}

async function tryCreateCache(apiKey: string, content: string): Promise<GeminiCache | null> {
  try {
    const res = await fetch(`${API_BASE}/cachedContents?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${MODEL}`,
        contents: [{ role: 'user', parts: [{ text: content }] }],
        ttl: `${CACHE_TTL_SECONDS}s`,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn('Gemini cache create failed:', res.status, errText.slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { name: string };
    return { name: data.name, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
  } catch (err) {
    console.warn('Gemini cache create exception:', err);
    return null;
  }
}

async function getOrCreateCache(apiKey: string, content: string): Promise<GeminiCache | null> {
  const now = Date.now();
  if (globalThis._geminiCache && globalThis._geminiCache.expiresAt > now) {
    return globalThis._geminiCache;
  }
  if (globalThis._geminiCachePromise) {
    return globalThis._geminiCachePromise;
  }
  const promise = tryCreateCache(apiKey, content)
    .then(result => {
      globalThis._geminiCache = result;
      return result;
    })
    .finally(() => {
      globalThis._geminiCachePromise = null;
    });
  globalThis._geminiCachePromise = promise;
  return promise;
}

export async function* streamChat(opts: StreamChatOpts): AsyncIterable<string> {
  const { apiKey, systemBlockText, perCallContext, messages, signal } = opts;

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    throw new Error('streamChat requires the last message to be from the user');
  }

  const cache = await getOrCreateCache(apiKey, systemBlockText);

  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const userText = perCallContext
    ? `${perCallContext}\n\n=== User question ===\n${last.content}`
    : last.content;

  const requestBody: Record<string, unknown> = {
    contents: [...history, { role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  };

  if (cache) {
    requestBody.cachedContent = cache.name;
  } else {
    requestBody.systemInstruction = { parts: [{ text: systemBlockText }] };
  }

  const url = `${API_BASE}/models/${MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }
  if (!res.body) {
    throw new Error('Gemini API returned empty body');
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (signal?.aborted) {
      reader.cancel();
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);
      if (payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield text as string;
      } catch {
        // skip malformed SSE line
      }
    }
  }
}
