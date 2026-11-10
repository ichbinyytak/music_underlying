import { getCatalogMeta, getSourcesSummary, testAllSources } from '../core/sources.js';
import { jsonResponse, corsOptionsResponse } from '../core/http.js';

export function OPTIONS() {
  return corsOptionsResponse();
}

export async function GET() {
  const meta = getCatalogMeta();
  const list = getSourcesSummary();
  return jsonResponse(list, 200, {
    'Cache-Control': 'no-store',
    'X-Hub-Updated-At': meta.updatedAt || '',
    'X-Hub-Total': String(meta.total),
  });
}

export async function POST() {
  const meta = getCatalogMeta();
  const results = await testAllSources();
  return jsonResponse(results, 200, {
    'Cache-Control': 'no-store',
    'X-Hub-Updated-At': meta.updatedAt || '',
    'X-Hub-Total': String(meta.total),
  });
}
