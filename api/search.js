import { searchMultiPlatform } from '../core/search.js';
import { jsonResponse, corsOptionsResponse } from '../core/http.js';

export function OPTIONS() {
  return corsOptionsResponse();
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') || searchParams.get('keyword') || '').trim();
  if (!q) {
    return jsonResponse([]);
  }

  const title = (searchParams.get('title') || '').trim();
  const artist = (searchParams.get('artist') || '').trim();
  const platParam = (searchParams.get('platforms') || '').trim();
  const platforms = platParam
    ? platParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : undefined;

  const candidates = await searchMultiPlatform(q, { title, artist, platforms });
  return jsonResponse(candidates, 200, {
    'Cache-Control': 'public, max-age=1800',
  });
}
