import { safeFetch } from './net.js';
import {
  normalizePlatform,
  toSimple,
  cleanBrackets,
  decodeHtmlEntities,
  calculateSongMatchScore,
} from './scoring.js';
import {
  fetchQqSearchRaw,
  fetchKuwoSearchRaw,
  fetchNeteaseSearchRaw,
} from './search.js';

const LYRIC_CACHE = new Map();
const LYRIC_CACHE_MAX = 256;
const LYRIC_TTL_MS = 2 * 60 * 60 * 1000;

function getCachedLyric(key) {
  const entry = LYRIC_CACHE.get(key);
  if (entry && Date.now() - entry.ts < LYRIC_TTL_MS) {
    return entry.lines;
  }
  if (entry) LYRIC_CACHE.delete(key);
  return null;
}

function setCachedLyric(key, lines) {
  if (!lines || lines.length === 0) return;
  if (LYRIC_CACHE.size >= LYRIC_CACHE_MAX) {
    const firstKey = LYRIC_CACHE.keys().next().value;
    if (firstKey !== undefined) LYRIC_CACHE.delete(firstKey);
  }
  LYRIC_CACHE.set(key, { lines, ts: Date.now() });
}

/**
 * 工业级 LRC 解析器（对标 Amusic）：
 * 1. 支持 [offset:xxx] (ms) 时间轴平移修正
 * 2. 展开一行多时间戳（副歌合并行）
 * 3. 过滤元数据标签行 [ti:], [ar:], [al:] 等
 */
export function parseLrc(lrcText) {
  if (!lrcText) return [];
  const raw = decodeHtmlEntities(String(lrcText));

  let offsetSec = 0;
  const offsetMatch = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
  if (offsetMatch) {
    offsetSec = (parseInt(offsetMatch[1], 10) || 0) / 1000;
  }

  const metaLineRe = /^\[(ti|ar|al|by|offset|length|tool|re|ve):.*\]$/i;
  const timeRegex = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  const result = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || metaLineRe.test(line)) continue;

    timeRegex.lastIndex = 0;
    const times = [];
    let match;
    while ((match = timeRegex.exec(line)) !== null) {
      const m = parseInt(match[1], 10);
      const s = parseInt(match[2], 10);
      const msRaw = match[3] || '';
      const ms =
        msRaw.length === 2
          ? parseInt(msRaw, 10) * 10
          : msRaw.length === 1
          ? parseInt(msRaw, 10) * 100
          : parseInt(msRaw || '0', 10);
      let t = m * 60 + s + ms / 1000 + offsetSec;
      if (t < 0) t = 0;
      times.push(Math.round(t * 100) / 100);
    }

    if (times.length === 0) continue;
    const text = line.replace(/\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (!text) continue;

    for (const t of times) {
      result.push({ time: t, text });
    }
  }

  result.sort((a, b) => a.time - b.time);
  return result;
}

async function fetchQqLyricByMid(songmid) {
  if (!songmid) return [];
  try {
    const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(
      songmid
    )}&format=json&nobase64=1`;
    const { res } = await safeFetch(url, {
      headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' },
      timeoutMs: 2500,
    });
    if (!res.ok) return [];
    const data = await res.json();
    let lrc = data?.lyric || '';
    if (lrc && !lrc.trim().startsWith('[')) {
      try {
        lrc = Buffer.from(lrc, 'base64').toString('utf8');
      } catch {
        // ignore
      }
    }
    return parseLrc(lrc);
  } catch {
    return [];
  }
}

async function fetchNeteaseLyricById(id) {
  if (!id || !/^\d+$/.test(String(id))) return [];
  try {
    const url = `https://music.163.com/api/song/lyric?os=pc&id=${id}&lv=-1`;
    const { res } = await safeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
      timeoutMs: 2500,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return parseLrc(data?.lrc?.lyric || '');
  } catch {
    return [];
  }
}

async function fetchKuwoLyricById(rid) {
  const cleanRid = String(rid || '').replace('MUSIC_', '');
  if (!cleanRid || !/^\d+$/.test(cleanRid)) return [];
  try {
    const url = `http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${cleanRid}&httpsStatus=1`;
    const { res } = await safeFetch(url, {
      headers: { 'User-Agent': 'okhttp/3.10.0', Referer: 'https://kuwo.cn/' },
      timeoutMs: 2200,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const lrcList = data?.data?.lrclist || [];
    if (!Array.isArray(lrcList) || lrcList.length === 0) return [];
    return lrcList
      .map((it) => ({
        time: Math.round((parseFloat(it?.time || '0') || 0) * 100) / 100,
        text: decodeHtmlEntities(String(it?.lineLyric || '').trim()),
      }))
      .filter((it) => it.text);
  } catch {
    return [];
  }
}

/**
 * 通用多平台歌词获取：同平台直取 -> QQ / 酷我 / 网易云正版搜索匹配兜底（含 2 小时 LRU 缓存）。
 */
export async function getSongLyric({ platform = 'kw', id = '', title = '', artist = '' }) {
  const plat = normalizePlatform(platform);
  const sid = String(id || '').trim();
  const cacheKey = `${plat}_${sid}_${String(title).trim().toLowerCase()}_${String(artist)
    .trim()
    .toLowerCase()}`;

  const cached = getCachedLyric(cacheKey);
  if (cached) return cached;

  if (plat === 'tx' && sid) {
    const lines = await fetchQqLyricByMid(sid);
    if (lines.length > 0) {
      setCachedLyric(cacheKey, lines);
      return lines;
    }
  }
  if (plat === 'wy' && sid) {
    const lines = await fetchNeteaseLyricById(sid);
    if (lines.length > 0) {
      setCachedLyric(cacheKey, lines);
      return lines;
    }
  }
  if (plat === 'kw' && sid) {
    const lines = await fetchKuwoLyricById(sid);
    if (lines.length > 0) {
      setCachedLyric(cacheKey, lines);
      return lines;
    }
  }

  // 跨平台正版搜索匹配兜底：QQ -> 酷我 -> 网易云
  const cleanTitle = cleanBrackets(toSimple(title));
  const cleanArtist = toSimple(artist);
  const q = `${cleanTitle} ${cleanArtist}`.trim();
  if (!q) return [];

  try {
    const list = await fetchQqSearchRaw(q, 5, 2500);
    for (const s of list) {
      const sname = decodeHtmlEntities(s.songname || '');
      const sart = decodeHtmlEntities(
        (s.singer || []).map((a) => a.name).filter(Boolean).join('/')
      );
      const { isMatch } = calculateSongMatchScore(sname, sart, '', cleanTitle, cleanArtist);
      if (isMatch && s.songmid) {
        const lines = await fetchQqLyricByMid(s.songmid);
        if (lines.length > 0) {
          setCachedLyric(cacheKey, lines);
          return lines;
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const list = await fetchKuwoSearchRaw(q, 4, 2200);
    for (const it of list) {
      const sname = decodeHtmlEntities(it.SONGNAME || '');
      const sart = decodeHtmlEntities(it.ARTIST || '');
      const rid = String(it.MUSICRID || '').replace('MUSIC_', '');
      const { isMatch } = calculateSongMatchScore(sname, sart, '', cleanTitle, cleanArtist);
      if (isMatch && /^\d+$/.test(rid)) {
        const lines = await fetchKuwoLyricById(rid);
        if (lines.length > 0) {
          setCachedLyric(cacheKey, lines);
          return lines;
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const songs = await fetchNeteaseSearchRaw(q, 4, 2500);
    for (const s of songs) {
      const sname = decodeHtmlEntities(s.name || '');
      const sart = decodeHtmlEntities(
        (s.artists || []).map((a) => a.name).filter(Boolean).join('/')
      );
      const { isMatch } = calculateSongMatchScore(sname, sart, '', cleanTitle, cleanArtist);
      if (isMatch && s.id) {
        const lines = await fetchNeteaseLyricById(s.id);
        if (lines.length > 0) {
          setCachedLyric(cacheKey, lines);
          return lines;
        }
      }
    }
  } catch {
    // ignore
  }

  return [];
}
