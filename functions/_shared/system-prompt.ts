export const BASE_SYSTEM_PROMPT = `You are an internal knowledge retrieval tool for the Australian Property Institute (API). Members and staff use this tool to answer questions about API standards, the Valuation Protocol, the Rules of Professional Conduct, CPV and RPV requirements, the Emergency Valuation Protocol, and bank Security Instructions for NAB, CBA, Westpac, and ANZ.

Your role:
- Retrieve and summarise relevant information from the API standards corpus and the bank Security Instructions matrix.
- When asked which Security Instruction template applies, look up the matrix by lender name and property type, and return the column reference and section count.
- When asked about specific section content, cite the matrix directly.
- If a document has been uploaded, treat it as the primary source and reference it directly.

Behaviour rules:
- Responses must be brief and scannable. Lead with the direct answer; supporting detail follows.
- Use plain Australian English (organise, recognise, behaviour, colour).
- Do not editorialise or hedge. State what the standards say.
- If the answer is not in the provided sources, say so in one sentence and suggest the user contact the relevant API technical manager.
- Do not begin a response with "Certainly" or "Great question" or similar fillers.
- Do not use em dashes or en dashes. Use plain hyphens, commas, or full stops.`;

interface CachedBlockSources {
  siLookupIndex: unknown;
  siMatrix: unknown;
  docIndex: unknown;
}

export function buildCachedSystemBlock(sources: CachedBlockSources): string {
  return [
    BASE_SYSTEM_PROMPT,
    '',
    '---',
    'SI Reference Data (do not paraphrase; return literal column refs and section counts)',
    '---',
    '',
    JSON.stringify(sources.siLookupIndex, null, 2),
    '',
    JSON.stringify(sources.siMatrix, null, 2),
    '',
    '---',
    'Document Catalogue (use to map retrieved chunks back to their source document)',
    '---',
    '',
    JSON.stringify(sources.docIndex, null, 2),
  ].join('\n');
}

// Slim variant for fallback providers (OpenAI 128K, GROQ 128K) that cannot
// fit the full 130K-token bank-si-matrix.json. Drops the matrix; keeps the
// lookup index (so "which SI applies" still works) and the doc-index.
export function buildSlimSystemBlock(sources: CachedBlockSources): string {
  return [
    BASE_SYSTEM_PROMPT,
    '',
    '(Capability note for this path. Section text is not loaded here, so quoting it is not possible. ' +
      'You still have the lookup index, so you can return the column reference, section count, and ' +
      'lender to property type mapping. If the user asks for specific section text, return the column ' +
      'reference and section count, then ask them to retry in a moment or to open the named template ' +
      'directly (for example, NAB Shopping Centre Valuations, column F).)',
    '',
    '---',
    'SI Lookup Index (lender to property type to column ref + section count)',
    '---',
    '',
    JSON.stringify(sources.siLookupIndex, null, 2),
    '',
    '---',
    'Document Catalogue',
    '---',
    '',
    JSON.stringify(sources.docIndex, null, 2),
  ].join('\n');
}

export function buildPerCallContext(retrievedChunks: string, uploadedDocs: { name: string; text: string }[]): string {
  const parts: string[] = [];
  if (retrievedChunks) {
    parts.push('Retrieved API standards passages relevant to the user\'s latest message:');
    parts.push(retrievedChunks);
  }
  if (uploadedDocs.length > 0) {
    parts.push('');
    parts.push('User-uploaded documents (treat as primary source):');
    for (const doc of uploadedDocs) {
      parts.push(`=== Document: ${doc.name} ===`);
      parts.push(doc.text);
    }
  }
  return parts.join('\n');
}

let cachedSources: CachedBlockSources | null = null;
let cachedSourcesPromise: Promise<CachedBlockSources> | null = null;

async function loadSources(origin: string): Promise<CachedBlockSources> {
  const [siLookupIndex, siMatrix, docIndex] = await Promise.all([
    fetch(`${origin}/data/si-lookup-index.json`).then(r => r.json()),
    fetch(`${origin}/data/bank-si-matrix.json`).then(r => r.json()),
    fetch(`${origin}/data/doc-index.json`).then(r => r.json()),
  ]);
  return { siLookupIndex, siMatrix, docIndex };
}

export async function getCachedSources(origin: string): Promise<CachedBlockSources> {
  if (cachedSources) return cachedSources;
  if (cachedSourcesPromise) return cachedSourcesPromise;
  cachedSourcesPromise = loadSources(origin)
    .then(s => {
      cachedSources = s;
      return s;
    })
    .finally(() => {
      cachedSourcesPromise = null;
    });
  return cachedSourcesPromise;
}
