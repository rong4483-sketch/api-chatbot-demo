import FlexSearch from 'flexsearch';

export interface Chunk {
  id: string;
  docId: string;
  title: string;
  category: string;
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  page: number;
  text: string;
}

export interface RetrievedChunk extends Chunk {
  score: number;
}

interface IndexState {
  chunks: Chunk[];
  byId: Map<string, Chunk>;
  index: FlexSearch.Document<{ id: string; title: string; text: string }>;
  builtAt: number;
}

let cached: IndexState | null = null;
let buildPromise: Promise<IndexState> | null = null;

async function buildIndex(origin: string): Promise<IndexState> {
  const res = await fetch(`${origin}/data/chunks.json`);
  if (!res.ok) {
    throw new Error(`Failed to load chunks.json: ${res.status}`);
  }
  const chunks = (await res.json()) as Chunk[];

  const index = new FlexSearch.Document<{ id: string; title: string; text: string }>({
    document: {
      id: 'id',
      index: ['title', 'text'],
      store: false,
    },
    tokenize: 'forward',
    cache: true,
  });

  const byId = new Map<string, Chunk>();
  for (const c of chunks) {
    byId.set(c.id, c);
    index.add({ id: c.id, title: c.title, text: c.text });
  }

  return { chunks, byId, index, builtAt: Date.now() };
}

async function getIndex(origin: string): Promise<IndexState> {
  if (cached) return cached;
  if (buildPromise) return buildPromise;
  buildPromise = buildIndex(origin)
    .then(state => {
      cached = state;
      return state;
    })
    .finally(() => {
      buildPromise = null;
    });
  return buildPromise;
}

export async function retrieve(query: string, origin: string, topK = 8): Promise<RetrievedChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const state = await getIndex(origin);
  const results = state.index.search(trimmed, { limit: topK, enrich: false });

  const ids = new Set<string>();
  for (const field of results) {
    for (const id of field.result as unknown as string[]) {
      ids.add(id);
      if (ids.size >= topK) break;
    }
    if (ids.size >= topK) break;
  }

  const out: RetrievedChunk[] = [];
  for (const id of ids) {
    const chunk = state.byId.get(id);
    if (chunk) out.push({ ...chunk, score: 1 });
  }
  return out;
}

export function formatChunksForPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  return chunks
    .map(c =>
      `--- Source: ${c.title} (${c.category}, page ${c.page}, chunk ${c.chunkIndex + 1}/${c.totalChunks}) ---\n${c.text}`
    )
    .join('\n\n');
}
