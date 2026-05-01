export function isAllowedOrigin(request: Request, allowed: string | undefined): boolean {
  if (!allowed) return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const list = allowed.split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin);
}

export function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export function rejectOrigin(): Response {
  return new Response(null, { status: 403 });
}
