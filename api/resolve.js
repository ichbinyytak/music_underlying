import { resolveBestStream } from '../core/resolve.js';
import { jsonResponse, corsOptionsResponse } from '../core/http.js';

export function OPTIONS() {
  return corsOptionsResponse();
}

async function handleResolve(cand) {
  const result = await resolveBestStream(cand);
  return jsonResponse(result, 200, {
    'Cache-Control': 'no-store',
  });
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const cand = {
    id: searchParams.get('id') || '',
    songmid: searchParams.get('songmid') || '',
    hash: searchParams.get('hash') || '',
    platform: searchParams.get('platform') || 'kw',
    title: searchParams.get('title') || '',
    artist: searchParams.get('artist') || '',
    album: searchParams.get('album') || '',
    duration: Number(searchParams.get('duration') || '0') || 0,
  };
  return handleResolve(cand);
}

export async function POST(request) {
  let cand = {};
  try {
    cand = await request.json();
  } catch {
    return jsonResponse({ success: false, error: '请求体 JSON 格式错误' }, 400);
  }
  return handleResolve(cand || {});
}
