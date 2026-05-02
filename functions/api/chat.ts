import { isAllowedOrigin, corsHeaders, rejectOrigin } from '../_shared/origin-check';
import { retrieve, formatChunksForPrompt } from '../_shared/retriever';
import {
  buildCachedSystemBlock,
  buildPerCallContext,
  getCachedSources,
} from '../_shared/system-prompt';
import { streamChat as geminiStreamChat, type ChatMessage, type StreamChatOpts } from '../_shared/providers/gemini';
import { streamChat as openaiStreamChat } from '../_shared/providers/openai';
import { streamChat as groqStreamChat } from '../_shared/providers/groq';

interface Env {
  GEMINI_API_KEY: string;
  OPENAI_API_KEY: string;
  GROQ_API_KEY: string;
  ALLOWED_ORIGINS: string;
}

interface RequestBody {
  messages: ChatMessage[];
  uploadedDocs?: { name: string; text: string }[];
}

const FIRST_TOKEN_TIMEOUT_MS = 3000;

type ProviderFn = (opts: StreamChatOpts) => AsyncIterable<string>;

interface Provider {
  name: string;
  apiKey: string | undefined;
  fn: ProviderFn;
}

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request.headers.get('origin')),
  });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!isAllowedOrigin(request, env.ALLOWED_ORIGINS)) {
    return rejectOrigin();
  }
  if (!env.GEMINI_API_KEY) {
    return new Response('Server configuration error: GEMINI_API_KEY missing', { status: 500 });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response('messages array is required', { status: 400 });
  }
  const last = body.messages[body.messages.length - 1];
  if (!last || last.role !== 'user' || !last.content?.trim()) {
    return new Response('last message must be from user with non-empty content', { status: 400 });
  }

  const origin = new URL(request.url).origin;
  const uploadedDocs = body.uploadedDocs ?? [];

  const [retrieved, sources] = await Promise.all([
    retrieve(last.content, origin, 8).catch(err => {
      console.warn('Retrieval failed, continuing without chunks:', err);
      return [];
    }),
    getCachedSources(origin),
  ]);

  const systemBlockText = buildCachedSystemBlock(sources);
  const perCallContext = buildPerCallContext(formatChunksForPrompt(retrieved), uploadedDocs);

  const providers: Provider[] = [
    { name: 'gemini', apiKey: env.GEMINI_API_KEY, fn: geminiStreamChat },
    { name: 'openai', apiKey: env.OPENAI_API_KEY, fn: openaiStreamChat },
    { name: 'groq', apiKey: env.GROQ_API_KEY, fn: groqStreamChat },
  ].filter(p => p.apiKey);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const sendDone = () => controller.enqueue(encoder.encode('data: [DONE]\n\n'));

      const sharedOpts = { systemBlockText, perCallContext, messages: body.messages };

      let firstTokenSent = false;
      let lastError: Error | null = null;

      try {
        for (const provider of providers) {
          if (firstTokenSent) break;

          const ac = new AbortController();
          const timeoutId = setTimeout(() => {
            if (!firstTokenSent) {
              console.warn(`${provider.name} first-token timeout, falling back`);
              ac.abort();
            }
          }, FIRST_TOKEN_TIMEOUT_MS);

          try {
            for await (const text of provider.fn({
              ...sharedOpts,
              apiKey: provider.apiKey as string,
              signal: ac.signal,
            })) {
              if (!firstTokenSent) {
                firstTokenSent = true;
                clearTimeout(timeoutId);
              }
              send({ text });
            }
            sendDone();
            clearTimeout(timeoutId);
            return;
          } catch (err) {
            clearTimeout(timeoutId);
            if (firstTokenSent) {
              throw err;
            }
            console.warn(`${provider.name} failed pre-first-token:`, (err as Error).message);
            lastError = err as Error;
          }
        }

        throw lastError ?? new Error('All providers failed or none configured');
      } catch (err) {
        send({ error: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(request.headers.get('origin')),
    },
  });
};
