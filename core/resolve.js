import {
  getOrderedEndpoints,
  probeEndpoint,
  recordEndpointHit,
  recordEndpointMiss,
} from './sources.js';
import { normalizePlatform } from './scoring.js';
import { searchMultiPlatform } from './search.js';
import { getSongLyric } from './lyric.js';

// 15 分钟内存热点缓存（防 Token 过期 403，重复切歌 0ms 秒开）
const RESOLVE_CACHE = new Map();
const RESOLVE_CACHE_MAX = 256;
const RESOLVE_CACHE_TTL_MS = 15 * 60 * 1000;

async function raceBatch(endpoints, songInfo, timeoutMs) {
  if (!endpoints || endpoints.length === 0 || timeoutMs < 400) return null;

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

async function resolveWithEndpoints(endpoints, songInfo, deadline, batchSize = 3, perStepCap = 2800) {
  for (let i = 0; i < endpoints.length; i += batchSize) {
    const remaining = deadline - Date.now();
    if (remaining < 500) break;
    const stepTimeout = Math.min(perStepCap, remaining - 150);
    const batch = endpoints.slice(i, i + batchSize);
    const hit = await raceBatch(batch, songInfo, stepTimeout);
    if (hit) return hit;
  }
  return null;
}

function formatWinner(hit, strategy, lyrics = [], extra = {}) {
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
    lyrics,
    ...extra,
  };
}

/**
 * 三阶梯智能寻链解析引擎（对标 Amusic，含 7.5s 全局预算、音画并行、自动跨平台容灾）：
 * - 支持传入精确 (platform + id) 或仅传入 (title + artist + duration)
 * - 并行拉取时间轴歌词并一并返回 lyrics
 */
export async function resolveBestStream(cand = {}) {
  const deadline = Date.now() + 7500;
  const hasExplicitPlatform = Boolean(cand.platform);
  const plat = normalizePlatform(cand.platform || 'kw');
  const sid = String(cand.id || cand.songmid || cand.hash || '').trim();
  const title = String(cand.title || cand.name || '').trim();
  const artist = String(cand.artist || cand.singer || '').trim();
  const duration =
    Number(cand.duration) ||
    (cand.durationMillis ? Math.round(Number(cand.durationMillis) / 1000) : 0) ||
    0;
  const forceRefresh = Boolean(cand.force_refresh);

  if (!sid && !title) {
    return { success: false, error: '缺少歌曲 ID 或歌名' };
  }

  const cacheKey = `${hasExplicitPlatform ? plat : 'any'}:${sid}:${title.toLowerCase()}:${artist.toLowerCase()}`;
  if (!forceRefresh) {
    const cached = RESOLVE_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.ts < RESOLVE_CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }
  } else {
    RESOLVE_CACHE.delete(cacheKey);
  }

  const normalizedSong = {
    ...cand,
    platform: plat,
    id: sid,
    songmid: cand.songmid || sid,
    hash: cand.hash || sid,
    title,
    artist,
    duration,
  };

  // 音画并行：提前异步并发拉取歌词
  const lyricPromise = getSongLyric({ platform: plat, id: sid, title, artist }).catch(() => []);
  const collectLyrics = async () => {
    const rem = Math.max(150, Math.min(1000, deadline - Date.now()));
    try {
      return await Promise.race([
        lyricPromise,
        new Promise((r) => setTimeout(() => r([]), rem)),
      ]);
    } catch {
      return [];
    }
  };

  const cacheAndReturn = (result) => {
    if (result.success) {
      if (RESOLVE_CACHE.size >= RESOLVE_CACHE_MAX) {
        const firstKey = RESOLVE_CACHE.keys().next().value;
        if (firstKey !== undefined) RESOLVE_CACHE.delete(firstKey);
      }
      RESOLVE_CACHE.set(cacheKey, { data: result, ts: Date.now() });
    }
    return result;
  };

  // 第 1 阶梯：若提供了明确 ID，优先走同平台 ID 精准通道
  if (sid) {
    const idEndpoints = getOrderedEndpoints(plat, 'id');
    const hit = await resolveWithEndpoints(idEndpoints, normalizedSong, deadline, 3, 2800);
    if (hit) {
      return cacheAndReturn(formatWinner(hit, 'same_platform_id', await collectLyrics()));
    }
  }

  // 第 2 阶梯：同平台 Search 通道
  if (title && sid && deadline - Date.now() > 800) {
    const searchEndpoints = getOrderedEndpoints(plat, 'search');
    const hit = await resolveWithEndpoints(searchEndpoints, normalizedSong, deadline, 2, 2600);
    if (hit) {
      return cacheAndReturn(formatWinner(hit, 'same_platform_search', await collectLyrics()));
    }
  }

  // 第 3 阶梯：无 ID（纯元数据调用）或同平台全部失败 -> 多平台并发重搜并逐平台优选竞速
  if (title && deadline - Date.now() > 1000) {
    const allEndpoints = getOrderedEndpoints();
    const activePlats = [...new Set(allEndpoints.map((ep) => ep.platform))];
    const targetPlats = sid ? activePlats.filter((p) => p !== plat) : activePlats;

    if (targetPlats.length > 0) {
      const q = `${title} ${artist}`.trim();
      const crossCands = await searchMultiPlatform(q, {
        title,
        artist,
        duration,
        platforms: targetPlats,
        limitPerPlatform: 3,
      });

      // 每平台挑选最优 1 条候选，最多尝试前 4 个平台
      const picked = [];
      const seenPlats = new Set();
      for (const c of crossCands) {
        if (!seenPlats.has(c.platform)) {
          picked.push(c);
          seenPlats.add(c.platform);
          if (picked.length >= 4) break;
        }
      }

      for (const alt of picked) {
        if (deadline - Date.now() < 800) break;
        const altIdEndpoints = getOrderedEndpoints(alt.platform, 'id');
        const hit = await resolveWithEndpoints(altIdEndpoints, alt, deadline, 2, 2400);
        if (hit) {
          return cacheAndReturn(
            formatWinner(hit, sid ? 'cross_platform_id' : 'search_then_id', await collectLyrics(), {
              matched_candidate: alt,
              ...(sid ? { fallback_from: plat } : {}),
            })
          );
        }
      }

      const searchEndpoints = allEndpoints.filter((ep) => (ep.matchMode || 'id') === 'search');
      if (searchEndpoints.length > 0 && deadline - Date.now() > 800) {
        const hit = await resolveWithEndpoints(searchEndpoints, normalizedSong, deadline, 2, 2400);
        if (hit) {
          return cacheAndReturn(
            formatWinner(hit, sid ? 'cross_platform_search' : 'search_endpoint', await collectLyrics(), {
              ...(sid ? { fallback_from: plat } : {}),
            })
          );
        }
      }
    }
  }

  return {
    success: false,
    error: '所有音源通道均未通过完整音频校验（已拦截试听与失效链接）',
  };
}
