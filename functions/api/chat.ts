import { isAllowedOrigin, corsHeaders, rejectOrigin } from '../_shared/origin-check';
import { retrieve, formatChunksForPrompt } from '../_shared/retriever';
import {
  buildCachedSystemBlock,
  buildPerCallContext,
  getCachedSources,
} from '../_shared/system-prompt';
import { streamChat as geminiStreamChat, type ChatMessage } from '../_shared/providers/gemini';
import { streamChat as openaiStreamChat } from '../_shared/providers/openai';

interface Env {
  GEMINI_API_KEY: string;
  OPENAI_API_KEY: string;
  ALLOWED_ORIGINS: string;
}

interface RequestBody {
  messages: ChatMessage[];
  uploadedDocs?: { name: string; text: string }[];
}

const FIRST_TOKEN_TIMEOUT_MS = 3000;

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

  // Retrieval and prompt build run in parallel for cold-start speed.
  const [retrieved, sources] = await Promise.all([
    retrieve(last.content, origin, 8).catch(err => {
      console.warn('Retrieval failed, continuing without chunks:', err);
      return [];
    }),
    getCachedSources(origin),
  ]);

  const systemBlockText = buildCachedSystemBlock(sources);
  const perCallContext = buildPerCallContext(formatChunksForPrompt(retrieved), uploadedDocs);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const sendDone = () => controller.enqueue(encoder.encode('data: [DONE]\n\n'));

      const sharedOpts = {
        systemBlockText,
        perCallContext,
        messages: body.messages,
      };

      try {
        let firstToken = false;
        const ac = new AbortController();
        const timeoutId = setTimeout(() => {
          if (!firstToken) {
            console.warn('Gemini first-token timeout, falling back');
            ac.abort();
          }
        }, FIRST_TOKEN_TIMEOUT_MS);

        try {
          for await (const text of geminiStreamChat({
            ...sharedOpts,
            apiKey: env.GEMINI_API_KEY,
            signal: ac.signal,
          })) {
            if (!firstToken) {
              firstToken = true;
              clearTimeout(timeoutId);
            }
            send({ text });
          }
          sendDone();
          return;
        } catch (err) {
          clearTimeout(timeoutId);
          if (firstToken) {
            // Mid-stream error, no fallback possible
            throw err;
          }
          console.warn('Gemini failed pre-first-token, falling back to OpenAI:', (err as Error).message);
        }

        if (!env.OPENAI_API_KEY) {
          throw new Error('Primary provider failed and no fallback configured');
        }

        for await (const text of openaiStreamChat({
          ...sharedOpts,
          apiKey: env.OPENAI_API_KEY,
        })) {
          send({ text });
        }
        sendDone();
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
