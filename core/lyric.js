import { safeFetch } from './net.js';
import {
  normalizePlatform,
  toSimple,
  cleanBrackets,
  calculateSongMatchScore,
} from './scoring.js';

export function parseLrc(lrcText) {
  if (!lrcText) return [];
  const lines = String(lrcText).split('\n');
  const result = [];
  const timeRegex = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let match;
    const times = [];
    let lastIndex = 0;

    timeRegex.lastIndex = 0;
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
      times.push(m * 60 + s + ms / 1000);
      lastIndex = timeRegex.lastIndex;
    }

    const text = line.slice(lastIndex).trim();
    if (text && times.length > 0) {
      for (const t of times) {
        result.push({ time: Math.round(t * 100) / 100, text });
      }
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
      timeoutMs: 2200,
    });
    if (!res.ok) return [];
    const data = await res.json();
    let lrc = data?.lyric || '';
    if (lrc && !lrc.trim().startsWith('[')) {
      try {
        lrc = Buffer.from(lrc, 'base64').toString('utf8');
      } catch {
        // ignore base64 decode error
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
      timeoutMs: 2200,
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
      timeoutMs: 2000,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const lrcList = data?.data?.lrclist || [];
    if (!Array.isArray(lrcList) || lrcList.length === 0) return [];
    return lrcList
      .map((it) => ({
        time: Math.round((parseFloat(it?.time || '0') || 0) * 100) / 100,
        text: String(it?.lineLyric || '').trim(),
      }))
      .filter((it) => it.text);
  } catch {
    return [];
  }
}

/**
 * 通用多平台歌词获取：同平台直取 -> 跨平台正版搜索匹配兜底。
 */
export async function getSongLyric({ platform = 'kw', id = '', title = '', artist = '' }) {
  const plat = normalizePlatform(platform);
  const sid = String(id || '').trim();

  if (plat === 'tx' && sid) {
    const lines = await fetchQqLyricByMid(sid);
    if (lines.length > 0) return lines;
  }
  if (plat === 'wy' && sid) {
    const lines = await fetchNeteaseLyricById(sid);
    if (lines.length > 0) return lines;
  }
  if (plat === 'kw' && sid) {
    const lines = await fetchKuwoLyricById(sid);
    if (lines.length > 0) return lines;
  }

  // 歌名+歌手兜底：优先 QQ 音乐官方词库（防网易野生翻唱词错位），其次酷我、网易
  const cleanTitle = cleanBrackets(toSimple(title));
  const cleanArtist = toSimple(artist);
  const q = `${cleanTitle} ${cleanArtist}`.trim();
  if (!q) return [];

  try {
    const qqSearchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=5&w=${encodeURIComponent(
      q
    )}&format=json`;
    const { res } = await safeFetch(qqSearchUrl, {
      headers: { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' },
      timeoutMs: 2000,
    });
    if (res.ok) {
      const data = await res.json();
      for (const s of data?.data?.song?.list || []) {
        const sname = s.songname || '';
        const sart = (s.singer || []).map((a) => a.name).filter(Boolean).join('/');
        const { isMatch } = calculateSongMatchScore(sname, sart, '', cleanTitle, cleanArtist);
        if (isMatch && s.songmid) {
          const lines = await fetchQqLyricByMid(s.songmid);
          if (lines.length > 0) return lines;
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const neSearchUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(
      q
    )}&type=1&limit=3`;
    const { res } = await safeFetch(neSearchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
      timeoutMs: 2000,
    });
    if (res.ok) {
      const data = await res.json();
      for (const s of data?.result?.songs || []) {
        const sname = s.name || '';
        const sart = (s.artists || []).map((a) => a.name).filter(Boolean).join('/');
        const { isMatch } = calculateSongMatchScore(sname, sart, '', cleanTitle, cleanArtist);
        if (isMatch && s.id) {
          const lines = await fetchNeteaseLyricById(s.id);
          if (lines.length > 0) return lines;
        }
      }
    }
  } catch {
    // ignore
  }

  return [];
}
