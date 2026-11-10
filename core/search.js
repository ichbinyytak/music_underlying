import { safeFetch } from './net.js';
import { toSimple, cleanBrackets, calculateSongMatchScore } from './scoring.js';

let mgFailStreak = 0;
let mgLastFailAt = 0;

function parseQueryIntent(q, explicitTitle, explicitArtist) {
  const cleanQ = cleanBrackets(q) || String(q || '').trim();
  let targetTitle = String(explicitTitle || '').trim();
  let targetArtist = String(explicitArtist || '').trim();

  if (!targetTitle && !targetArtist) {
    const parts = cleanQ.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      targetTitle = parts.slice(0, parts.length - 1).join(' ');
      targetArtist = parts[parts.length - 1];
    } else {
      targetTitle = cleanQ;
    }
  }
  return { searchQ: toSimple(cleanQ), targetTitle, targetArtist };
}

async function searchKuwo(searchQ, targetTitle, targetArtist, limit, targetDuration) {
  const out = [];
  try {
    const url = `https://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(
      searchQ
    )}&pn=0&rn=${limit}&uid=794762528&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newsearch=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1`;
    const { res } = await safeFetch(url, {
      headers: { 'User-Agent': 'okhttp/3.10.0' },
      timeoutMs: 4000,
    });
    if (!res.ok) return out;
    const data = await res.json();
    for (const it of data?.abslist || []) {
      const sname = it.SONGNAME || '';
      const sart = it.ARTIST || '';
      const salb = it.ALBUM || '';
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
    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(
      searchQ
    )}&type=1&offset=0&limit=${limit}`;
    const { res } = await safeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
      timeoutMs: 4000,
    });
    if (!res.ok) return out;
    const data = await res.json();
    for (const s of data?.result?.songs || []) {
      const sname = s.name || '';
      const sart = (s.artists || []).map((a) => a.name).filter(Boolean).join('/');
      const salb = s.album?.name || '';
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
    const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=${limit}&w=${encodeURIComponent(
      searchQ
    )}&format=json`;
    const { res } = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://y.qq.com/',
      },
      timeoutMs: 4000,
    });
    if (!res.ok) return out;
    const data = await res.json();
    for (const s of data?.data?.song?.list || []) {
      const sname = s.songname || '';
      const sart = (s.singer || []).map((a) => a.name).filter(Boolean).join('/');
      const salb = s.albumname || '';
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
    for (const item of data?.data?.lists || []) {
      const sname = String(item.SongName || '').replace(/<.*?>/g, '').trim();
      const sart = String(item.SingerName || '').replace(/<.*?>/g, '').trim();
      const salb = String(item.AlbumName || '').replace(/<.*?>/g, '').trim();
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
    for (const item of data?.songResultData?.result || []) {
      const sname = String(item.name || '').trim();
      const sart = (item.singers || []).map((a) => a.name).filter(Boolean).join('/');
      const salb = item.albums?.[0]?.name || '';
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

/**
 * 五平台并发搜歌（wy / tx / kw / kg / mg），繁简归一 + 严打分去翻唱/伴奏。
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
  const targetDuration = opts.duration || 0;
  const platforms = Array.isArray(opts.platforms) && opts.platforms.length > 0
    ? opts.platforms
    : ['tx', 'kw', 'wy', 'kg', 'mg'];

  const settled = await Promise.all(
    platforms.map((p) => {
      const fn = PLATFORM_SEARCHERS[p];
      return fn
        ? fn(searchQ, targetTitle, targetArtist, limitPerPlatform, targetDuration)
        : Promise.resolve([]);
    })
  );

  const merged = [];
  const seen = new Set();
  for (const list of settled) {
    for (const item of list) {
      const key = `${item.platform}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  // 同分情况下优先排序拥有高可用 VIP/直链的平台 (tx -> kw -> wy -> kg -> mg)
  const platWeight = { tx: 5, kw: 4, wy: 3, kg: 2, mg: 1 };
  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (platWeight[b.platform] || 0) - (platWeight[a.platform] || 0);
  });

  return merged;
}
