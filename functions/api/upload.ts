import { extractText, getDocumentProxy } from 'unpdf';
import { isAllowedOrigin, corsHeaders, rejectOrigin } from '../_shared/origin-check';

interface Env {
  ALLOWED_ORIGINS: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 40000;

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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ error: 'Invalid multipart form' }, 400, request);
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return jsonResponse({ error: 'No file field' }, 400, request);
  }

  if (file.size > MAX_FILE_BYTES) {
    return jsonResponse({ error: 'File exceeds the 5 MB limit.' }, 413, request);
  }

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  let text = '';
  let truncated = false;
  try {
    if (isPdf) {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const pdf = await getDocumentProxy(buffer);
      const result = await extractText(pdf, { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join('\n') : (result.text as string);
    } else {
      text = await file.text();
    }
  } catch (err) {
    console.warn('Upload extraction failed:', err);
    return jsonResponse({ error: 'Failed to extract text from file.' }, 500, request);
  }

  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    truncated = true;
  }

  return jsonResponse({ text, truncated }, 200, request);
};

function jsonResponse(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request.headers.get('origin')),
    },
  });
}
