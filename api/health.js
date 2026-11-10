import { getCatalogMeta } from '../core/sources.js';
import { jsonResponse, corsOptionsResponse } from '../core/http.js';

export function OPTIONS() {
  return corsOptionsResponse();
}

export async function GET() {
  const meta = getCatalogMeta();
  return jsonResponse({
    ok: meta.total > 0,
    version: meta.version,
    updatedAt: meta.updatedAt,
    totalEndpoints: meta.total,
  });
}
