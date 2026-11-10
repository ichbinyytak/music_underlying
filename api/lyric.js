import { getSongLyric } from '../core/lyric.js';
import { jsonResponse, corsOptionsResponse } from '../core/http.js';

export function OPTIONS() {
  return corsOptionsResponse();
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const lines = await getSongLyric({
    platform: searchParams.get('platform') || 'kw',
    id: searchParams.get('id') || '',
    title: searchParams.get('title') || '',
    artist: searchParams.get('artist') || '',
  });
  return jsonResponse(lines, 200, {
    'Cache-Control': 'public, max-age=604800',
  });
}
