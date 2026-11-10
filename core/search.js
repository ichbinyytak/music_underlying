import { safeFetch } from './net.js';
import {
  toSimple,
  cleanBrackets,
  decodeHtmlEntities,
  calculateSongMatchScore,
} from './scoring.js';

let mgFailStreak = 0;
let mgLastFailAt = 0;

function parseJsonSafe(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    const m = /^[^(]*\(([\s\S]*)\)\s*;?$/.exec(String(rawText || '').trim());
    if (m) return JSON.parse(m[1]);
    throw new Error('Invalid JSON');
  }
}

export async function fetchKuwoSearchRaw(q, limit = 6, timeoutMs = 4000) {
  const url = `https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(
    q
  )}&pn=0&rn=${limit}&uid=794762528&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newsearch=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1`;
  const { res } = await safeFetch(url, {
    headers: { 'User-Agent': 'okhttp/3.10.0' },
    timeoutMs,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.abslist || [];
}

export async function fetchNeteaseSearchRaw(q, limit = 6, timeoutMs = 4000) {
  const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(
    q
  )}&type=1&offset=0&limit=${limit}`;
  const { res } = await safeFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
    timeoutMs,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.result?.songs || [];
}

export async function fetchQqSearchRaw(q, limit = 6, timeoutMs = 4000) {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=${limit}&w=${encodeURIComponent(
    q
  )}&format=json`;
  const { res } = await safeFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      Referer: 'https://y.qq.com/',
    },
    timeoutMs,
  });
  if (!res.ok) return [];
  const data = parseJsonSafe(await res.text());
  return data?.data?.song?.list || [];
}

function parseQueryIntent(q, explicitTitle, explicitArtist) {
  const simplifiedK = toSimple(cleanBrackets(q));
  let targetTitle = explicitTitle ? toSimple(cleanBrackets(explicitTitle)) : '';
  let targetArtist = explicitArtist ? toSimple(explicitArtist) : '';

  if (!targetTitle && !targetArtist) {
    const parts = simplifiedK.split(/\s*[\-_/|]\s*|\s+/).filter(Boolean);
    if (parts.length >= 2) {
      targetTitle = parts.slice(0, -1).join(' ');
      targetArtist = parts[parts.length - 1];
    } else {
      targetTitle = simplifiedK;
    }
  } else if (!targetTitle) {
    targetTitle = simplifiedK;
  }

  let queryK = simplifiedK.replace(/[\-_&/、+|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!queryK) queryK = simplifiedK;
  if (targetArtist && !queryK.toLowerCase().includes(targetArtist.toLowerCase())) {
    queryK = `${queryK} ${targetArtist}`.trim();
  }

  return { searchQ: queryK, targetTitle, targetArtist };
}

async function searchKuwo(searchQ, targetTitle, targetArtist, limit, targetDuration) {
  const out = [];
  try {
    const list = await fetchKuwoSearchRaw(searchQ, limit, 4000);
    for (let idx = 0; idx < list.length; idx++) {
      const it = list[idx];
      const sname = decodeHtmlEntities(it.SONGNAME || '');
      const sart = decodeHtmlEntities(it.ARTIST || '');
      const salb = decodeHtmlEntities(it.ALBUM || '');
      const sdur = parseInt(it.DURATION || '0', 10) || 0;
      const rid = String(it.MUSICRID || '').replace('MUSIC_', '');
      if (!rid) continue;
      const { score, isMatch } = calculateSongMatchScore(
        sname,
        sart,
        salb,
        targetTitle,
        targetArtist,
        sdur,
        targetDuration
      );
      if (isMatch) {
        out.push({
          platform: 'kw',
          id: rid,
          songmid: rid,
          title: sname,
          artist: sart,
          album: salb,
          duration: sdur,
          score: Math.round(score * 10) / 10,
          _rank: idx,
        });
      }
    }
  } catch {
    // ignore single-platform error
  }
  return out;
}

async function searchNetease(searchQ, targetTitle, targetArtist, limit, targetDuration) {
  const out = [];
  try {
    const songs = await fetchNeteaseSearchRaw(searchQ, limit, 4000);
    for (let idx = 0; idx < songs.length; idx++) {
      const s = songs[idx];
      const sname = decodeHtmlEntities(s.name || '');
      const sart = decodeHtmlEntities(
        (s.artists || []).map((a) => a.name).filter(Boolean).join('/')
      );
      const salb = decodeHtmlEntities(s.album?.name || '');
      const sdur = s.duration ? Math.round(s.duration / 1000) : 0;
      const sid = s.id ? String(s.id) : '';
      if (!sid) continue;
      const { score, isMatch } = calculateSongMatchScore(
        sname,
        sart,
        salb,
        targetTitle,
        targetArtist,
        sdur,
        targetDuration
      );
      if (isMatch) {
        out.push({
          platform: 'wy',
          id: sid,
          songmid: sid,
          title: sname,
          artist: sart,
          album: salb,
          duration: sdur,
          score: Math.round(score * 10) / 10,
          _rank: idx,
        });
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function searchQQ(searchQ, targetTitle, targetArtist, limit, targetDuration) {
  const out = [];
  try {
    const list = await fetchQqSearchRaw(searchQ, limit, 4000);
    for (let idx = 0; idx < list.length; idx++) {
      const s = list[idx];
      const sname = decodeHtmlEntities(s.songname || '');
      const sart = decodeHtmlEntities(
        (s.singer || []).map((a) => a.name).filter(Boolean).join('/')
      );
      const salb = decodeHtmlEntities(s.albumname || '');
      const sdur = Number(s.interval) || 0;
      const smid = s.songmid || '';
      if (!smid) continue;
      const { score, isMatch } = calculateSongMatchScore(
        sname,
        sart,
        salb,
        targetTitle,
        targetArtist,
        sdur,
        targetDuration
      );
      if (isMatch) {
        out.push({
          platform: 'tx',
          id: smid,
          songmid: smid,
          title: sname,
          artist: sart,
          album: salb,
          duration: sdur,
          score: Math.round(score * 10) / 10,
          _rank: idx,
        });
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function searchKugou(searchQ, targetTitle, targetArtist, limit, targetDuration) {
  const out = [];
  try {
    const url = `http://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(
      searchQ
    )}&page=1&pagesize=${limit}&filter=2&iscorrection=1`;
    const { res } = await safeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeoutMs: 4000,
    });
    if (!res.ok) return out;
    const data = await res.json();
    const lists = data?.data?.lists || [];
    for (let idx = 0; idx < lists.length; idx++) {
      const item = lists[idx];
      const sname = decodeHtmlEntities(String(item.SongName || '').replace(/<.*?>/g, '').trim());
      const sart = decodeHtmlEntities(String(item.SingerName || '').replace(/<.*?>/g, '').trim());
      const salb = decodeHtmlEntities(String(item.AlbumName || '').replace(/<.*?>/g, '').trim());
      const sdur = Number(item.Duration) || 0;
      const hash = item.FileHash || '';
      if (!hash) continue;
      const { score, isMatch } = calculateSongMatchScore(
        sname,
        sart,
        salb,
        targetTitle,
        targetArtist,
        sdur,
        targetDuration
      );
      if (isMatch) {
        out.push({
          platform: 'kg',
          id: hash,
          songmid: hash,
          hash,
          title: sname,
          artist: sart,
          album: salb,
          duration: sdur,
          score: Math.round(score * 10) / 10,
          _rank: idx,
        });
      }
    }
  } catch {
    // ignore
  }
  return out;
}

async function searchMigu(searchQ, targetTitle, targetArtist, limit, targetDuration) {
  if (mgFailStreak >= 2 && Date.now() - mgLastFailAt < 300_000) {
    return [];
  }
  const out = [];
  try {
    const url = `https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?runmode=prod&text=${encodeURIComponent(
      searchQ
    )}&pageNo=1&pageSize=${limit}&searchSwitch=%7B%22song%22%3A1%7D`;
    const { res } = await safeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', channel: '0146951' },
      timeoutMs: 2000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    mgFailStreak = 0;
    const list = data?.songResultData?.result || [];
    for (let idx = 0; idx < list.length; idx++) {
      const item = list[idx];
      const sname = decodeHtmlEntities(String(item.name || '').trim());
      const sart = decodeHtmlEntities(
        (item.singers || []).map((a) => a.name).filter(Boolean).join('/')
      );
      const salb = decodeHtmlEntities(item.albums?.[0]?.name || '');
      const sdur = Number(item.interval) || 0;
      const cid = String(item.copyrightId || item.id || '');
      if (!cid) continue;
      const { score, isMatch } = calculateSongMatchScore(
        sname,
        sart,
        salb,
        targetTitle,
        targetArtist,
        sdur,
        targetDuration
      );
      if (isMatch) {
        out.push({
          platform: 'mg',
          id: cid,
          songmid: cid,
          title: sname,
          artist: sart,
          album: salb,
          duration: sdur,
          score: Math.round(score * 10) / 10,
          _rank: idx,
        });
      }
    }
  } catch {
    mgFailStreak += 1;
    mgLastFailAt = Date.now();
  }
  return out;
}

const PLATFORM_SEARCHERS = {
  kw: searchKuwo,
  wy: searchNetease,
  tx: searchQQ,
  kg: searchKugou,
  mg: searchMigu,
};

async function runConcurrentSearch(platforms, searchQ, targetTitle, targetArtist, limit, targetDuration) {
  const settled = await Promise.all(
    platforms.map((p) => {
      const fn = PLATFORM_SEARCHERS[p];
      return fn
        ? fn(searchQ, targetTitle, targetArtist, limit, targetDuration)
        : Promise.resolve([]);
    })
  );
  return settled.flat();
}

/**
 * 五平台并发搜歌（tx / kw / wy / kg / mg），对标 Amusic：
 * 多分隔符意图拆解 + 繁简归一 + 严打分去翻唱/伴奏 + 热度排序 + 多艺人降维重试。
 */
export async function searchMultiPlatform(q, opts = {}) {
  const rawQ = String(q || '').trim();
  if (!rawQ) return [];

  const { searchQ, targetTitle, targetArtist } = parseQueryIntent(
    rawQ,
    opts.title,
    opts.artist
  );
  const limitPerPlatform = opts.limitPerPlatform ?? 6;
  const targetDuration = Number(opts.duration) || 0;
  const platforms =
    Array.isArray(opts.platforms) && opts.platforms.length > 0
      ? opts.platforms
      : ['tx', 'kw', 'wy', 'kg', 'mg'];

  let rawResults = await runConcurrentSearch(
    platforms,
    searchQ,
    targetTitle,
    targetArtist,
    limitPerPlatform,
    targetDuration
  );

  // 多歌手合唱或 feat 降维重试
  if (rawResults.length === 0 && targetArtist) {
    const primaryArtist = cleanBrackets(
      targetArtist.split(/[,/&、]|feat\.?/i)[0] || ''
    ).trim();
    const cleanT = cleanBrackets(targetTitle).trim();
    if (primaryArtist && cleanT && (primaryArtist !== targetArtist || cleanT !== targetTitle)) {
      rawResults = await runConcurrentSearch(
        platforms,
        `${cleanT} ${primaryArtist}`,
        cleanT,
        primaryArtist,
        limitPerPlatform,
        targetDuration
      );
    }
  }

  const merged = [];
  const seen = new Set();
  for (const item of rawResults) {
    const key = `${item.platform}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  // 排序：分数优先 -> 平台官方搜索热度位次 (_rank) -> 平台可用权重
  const platWeight = { tx: 5, kw: 4, wy: 3, kg: 2, mg: 1 };
  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((a._rank ?? 99) !== (b._rank ?? 99)) return (a._rank ?? 99) - (b._rank ?? 99);
    return (platWeight[b.platform] || 0) - (platWeight[a.platform] || 0);
  });

  return merged.map(({ _rank, ...rest }) => rest);
}
