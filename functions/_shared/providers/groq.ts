import type { ChatMessage, StreamChatOpts } from './gemini';

const MODEL = 'llama-3.3-70b-versatile';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export async function* streamChat(opts: StreamChatOpts): AsyncIterable<string> {
  const { apiKey, systemBlockText, perCallContext, messages, signal } = opts;

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') {
    throw new Error('streamChat requires the last message to be from the user');
  }

  const userText = perCallContext
    ? `${perCallContext}\n\n=== User question ===\n${last.content}`
    : last.content;

  const apiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemBlockText },
    ...messages.slice(0, -1).map((m: ChatMessage) => ({
      role: m.role,
      content: m.content,
    })),
    { role: 'user', content: userText },
  ];

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: apiMessages,
      stream: true,
      temperature: 0.3,
      max_tokens: 2048,
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GROQ ${res.status}: ${errText.slice(0, 300)}`);
  }
  if (!res.body) {
    throw new Error('GROQ API returned empty body');
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
        const text = parsed?.choices?.[0]?.delta?.content;
        if (text) yield text as string;
      } catch {
        // skip malformed SSE line
      }
    }
  }
}
