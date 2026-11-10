import {
  getOrderedEndpoints,
  probeEndpoint,
  recordEndpointHit,
  recordEndpointMiss,
} from './sources.js';
import { normalizePlatform } from './scoring.js';
import { searchMultiPlatform } from './search.js';

/**
 * 在一批端点中并发竞速，返回第一个通过完整音频校验的结果。
 */
async function raceBatch(endpoints, songInfo, timeoutMs = 3000) {
  if (!endpoints || endpoints.length === 0) return null;

  const attempts = endpoints.map((ep) =>
    probeEndpoint(ep, songInfo, { timeoutMs }).then((res) => {
      if (res.ok) {
        recordEndpointHit(ep.id, res.latencyMs, res.bytes);
        return { ep, res };
      }
      recordEndpointMiss(ep.id, res.reason);
      throw new Error(res.reason || 'miss');
    })
  );

  try {
    return await Promise.any(attempts);
  } catch {
    return null;
  }
}

async function resolveWithEndpoints(endpoints, songInfo, batchSize = 2, timeoutMs = 3000) {
  for (let i = 0; i < endpoints.length; i += batchSize) {
    const batch = endpoints.slice(i, i + batchSize);
    const hit = await raceBatch(batch, songInfo, timeoutMs);
    if (hit) return hit;
  }
  return null;
}

function formatWinner(hit, strategy, fallbackFrom = null) {
  const { ep, res } = hit;
  return {
    success: true,
    url: res.url,
    bytes: res.bytes,
    latency_ms: res.latencyMs,
    source_id: ep.id,
    source_name: ep.name,
    platform: ep.platform,
    match_mode: ep.matchMode || 'id',
    quality: ep.supportQualities?.[0] || '320k',
    strategy,
    ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
  };
}

/**
 * 三阶梯智能寻链解析引擎：
 * 1. 同平台精准 ID 通道竞速（matchMode === 'id'，零翻唱风险）
 * 2. 同平台关键词搜索通道（matchMode === 'search'，内置歌名/歌手一致性防线）
 * 3. 跨平台同名正版自动兜底（如 kw 失败自动去 tx VIP / wy / kg 重搜并竞速解析）
 */
export async function resolveBestStream(cand = {}) {
  const plat = normalizePlatform(cand.platform || 'kw');
  const sid = String(cand.id || cand.songmid || cand.hash || '').trim();
  const title = String(cand.title || cand.name || '').trim();
  const artist = String(cand.artist || cand.singer || '').trim();
  const duration = Number(cand.duration) || 0;

  if (!sid && !title) {
    return { success: false, error: '缺少歌曲 ID 或歌名' };
  }

  const normalizedSong = {
    ...cand,
    platform: plat,
    id: sid,
    songmid: cand.songmid || sid,
    hash: cand.hash || sid,
    title,
    artist,
  };

  // 第 1 阶梯：同平台 ID 精准通道
  if (sid) {
    const idEndpoints = getOrderedEndpoints(plat, 'id');
    const hit = await resolveWithEndpoints(idEndpoints, normalizedSong, 3, 2800);
    if (hit) return formatWinner(hit, 'same_platform_id');
  }

  // 第 2 阶梯：同平台 Search 通道
  if (title) {
    const searchEndpoints = getOrderedEndpoints(plat, 'search');
    const hit = await resolveWithEndpoints(searchEndpoints, normalizedSong, 2, 2800);
    if (hit) return formatWinner(hit, 'same_platform_search');
  }

  // 第 3 阶梯：跨平台同名正版自动重搜兜底（充分发挥 5 平台优势）
  if (title) {
    const allOtherEndpoints = getOrderedEndpoints().filter((ep) => ep.platform !== plat);
    const activeOtherPlats = [...new Set(allOtherEndpoints.map((ep) => ep.platform))];

    if (activeOtherPlats.length > 0) {
      const q = `${title} ${artist}`.trim();
      const crossCands = await searchMultiPlatform(q, {
        title,
        artist,
        duration,
        platforms: activeOtherPlats,
        limitPerPlatform: 2,
      });

      for (const alt of crossCands.slice(0, 4)) {
        const altIdEndpoints = getOrderedEndpoints(alt.platform, 'id');
        const hit = await resolveWithEndpoints(altIdEndpoints, alt, 2, 2600);
        if (hit) return formatWinner(hit, 'cross_platform_id', plat);
      }

      const otherSearchEndpoints = allOtherEndpoints.filter(
        (ep) => (ep.matchMode || 'id') === 'search'
      );
      if (otherSearchEndpoints.length > 0) {
        const hit = await resolveWithEndpoints(otherSearchEndpoints, normalizedSong, 2, 2600);
        if (hit) return formatWinner(hit, 'cross_platform_search', plat);
      }
    }
  }

  return {
    success: false,
    error: '所有音源通道均未通过完整音频校验（已拦截试听与失效链接）',
  };
}
