import { decryptJson, getSyncSecret } from './crypto.js';
import { safeFetch, verifyAudioStream, isPublicHttpUrl } from './net.js';
import { isEndpointResponseValid, normalizePlatform } from './scoring.js';
import ENCRYPTED_BUNDLE from './apis_bundle.js';

export const TEST_TRACKS = {
  kw: {
    platform: 'kw',
    id: '5886682',
    songmid: '5886682',
    title: '海阔天空',
    artist: 'Beyond',
    album: '乐与怒',
    duration: 326,
    interval: '05:26',
  },
  wy: {
    platform: 'wy',
    id: '347230',
    songmid: '347230',
    title: '海阔天空',
    artist: 'Beyond',
    album: '乐与怒',
    duration: 326,
    interval: '05:26',
  },
  tx: {
    platform: 'tx',
    id: '0039MnYb0qxYhV',
    songmid: '0039MnYb0qxYhV',
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    duration: 269,
    interval: '04:29',
  },
  kg: {
    platform: 'kg',
    id: '596E403326AFD24A38E95A5225E1A139',
    songmid: '596E403326AFD24A38E95A5225E1A139',
    hash: '596E403326AFD24A38E95A5225E1A139',
    title: '海阔天空',
    artist: 'Beyond',
    album: '乐与怒',
    duration: 326,
    interval: '05:26',
  },
  mg: {
    platform: 'mg',
    id: '6005752DXKE',
    songmid: '6005752DXKE',
    title: '海阔天空',
    artist: 'Beyond',
    album: '乐与怒',
    duration: 326,
    interval: '05:26',
  },
};

let cachedCatalog = null;
const runtimeStats = new Map();

function ensureCatalog() {
  if (cachedCatalog) return cachedCatalog;
  if (!ENCRYPTED_BUNDLE || !ENCRYPTED_BUNDLE.ct) {
    cachedCatalog = { version: '2.0.0', updatedAt: null, endpoints: [] };
    return cachedCatalog;
  }
  const decoded = decryptJson(ENCRYPTED_BUNDLE, getSyncSecret());
  const endpoints = Array.isArray(decoded?.endpoints) ? decoded.endpoints : [];
  cachedCatalog = {
    version: decoded?.version || '2.0.0',
    updatedAt: decoded?.updatedAt || null,
    endpoints,
  };
  return cachedCatalog;
}

function getStat(id) {
  let st = runtimeStats.get(id);
  if (!st) {
    st = {
      status: 'untested',
      latencyMs: null,
      bytes: 0,
      error: null,
      successCount: 0,
      failCount: 0,
      consecutiveFails: 0,
      testedAt: null,
    };
    runtimeStats.set(id, st);
  }
  return st;
}

export function recordEndpointHit(id, latencyMs, bytes = 0) {
  const st = getStat(id);
  st.status = 'ok';
  st.latencyMs =
    st.latencyMs != null
      ? Math.round(st.latencyMs * 0.6 + latencyMs * 0.4)
      : Math.round(latencyMs);
  if (bytes > 0) st.bytes = bytes;
  st.error = null;
  st.successCount += 1;
  st.consecutiveFails = 0;
  st.testedAt = Date.now();
}

export function recordEndpointMiss(id, reason = 'failed') {
  const st = getStat(id);
  st.failCount += 1;
  st.consecutiveFails += 1;
  st.error = reason;
  if (st.consecutiveFails >= 2) {
    st.status = 'fail';
  }
}

export function getCatalogMeta() {
  const cat = ensureCatalog();
  return {
    version: cat.version,
    updatedAt: cat.updatedAt,
    total: cat.endpoints.length,
  };
}

export function getOrderedEndpoints(platform = null, matchMode = null) {
  const cat = ensureCatalog();
  let list = cat.endpoints;
  if (platform) {
    const plat = normalizePlatform(platform);
    list = list.filter((ep) => ep.platform === plat);
  }
  if (matchMode) {
    list = list.filter((ep) => (ep.matchMode || 'id') === matchMode);
  }

  return [...list].sort((a, b) => {
    const sa = getStat(a.id);
    const sb = getStat(b.id);
    const weight = (ep, st) => {
      const modePenalty = (ep.matchMode || 'id') === 'id' ? 0 : 10000;
      const failPenalty =
        (st.status === 'fail' ? 50000 : 0) + st.consecutiveFails * 800;
      const lat =
        st.latencyMs != null ? st.latencyMs : ep.sampleLatencyMs || 1000;
      const bonus = Math.min(200, st.successCount * 20);
      return modePenalty + failPenalty + Math.max(1, lat - bonus);
    };
    return weight(a, sa) - weight(b, sb);
  });
}

export function getSourcesSummary() {
  const cat = ensureCatalog();
  return getOrderedEndpoints().map((ep) => {
    const st = getStat(ep.id);
    return {
      id: ep.id,
      name: ep.name,
      platform: ep.platform,
      matchMode: ep.matchMode || 'id',
      supportQualities: ep.supportQualities || ['320k'],
      status: st.status,
      latency_ms: st.latencyMs,
      sample_latency_ms: ep.sampleLatencyMs ?? null,
      consecutive_fails: st.consecutiveFails,
      success_count: st.successCount,
      hit_count: ep.hitCount ?? 1,
      error: st.error,
      updated_at: cat.updatedAt,
    };
  });
}

export function isValidIdForPlatform(plat, id) {
  const s = String(id || '').trim();
  if (!s) return false;
  if (plat === 'kw' || plat === 'wy') return /^\d+$/.test(s);
  if (plat === 'kg') return /^[0-9a-fA-F]{16,}$/.test(s);
  if (plat === 'tx') return /^[0-9A-Za-z]{8,}$/.test(s);
  return s.length > 0;
}

function formatInterval(songInfo) {
  if (songInfo.interval) return String(songInfo.interval);
  const sec = Number(songInfo.duration);
  if (Number.isFinite(sec) && sec > 0) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return '';
}

function renderTemplate(tpl, songInfo, mode = 'url') {
  if (!tpl) return '';
  const info = songInfo && typeof songInfo === 'object' ? songInfo : {};
  const sid = String(info.id || info.songmid || info.hash || '');
  const smid = String(info.songmid || sid);
  const shash = String(info.hash || sid);
  const title = String(info.title || info.name || '');
  const artist = String(info.artist || info.singer || '');
  const album = String(info.album || info.albumName || '');
  const interval = formatInterval(info);

  const fmt = (val) => {
    if (mode === 'json') return JSON.stringify(val).slice(1, -1);
    return encodeURIComponent(val);
  };

  return String(tpl)
    .replaceAll('{id}', fmt(sid))
    .replaceAll('{songmid}', fmt(smid))
    .replaceAll('{hash}', fmt(shash))
    .replaceAll('{copyrightId}', fmt(sid))
    .replaceAll('{name}', fmt(title))
    .replaceAll('{singer}', fmt(artist))
    .replaceAll('{album}', fmt(album))
    .replaceAll('{interval}', fmt(interval));
}

export function extractByPath(obj, expr) {
  if (!obj || !expr) return null;
  const tokens = [];
  const re = /([^.\[\]]+)|\[(\d+|"[^"]+"|'[^']+')\]/g;
  let m;
  while ((m = re.exec(expr))) {
    if (m[1] !== undefined) tokens.push(m[1]);
    else if (m[2] !== undefined) tokens.push(m[2].replace(/^['"]|['"]$/g, ''));
  }
  let cur = obj;
  for (const t of tokens) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[t];
  }
  return typeof cur === 'string' ? cur : cur != null ? String(cur) : null;
}

function pickReturnedMeta(jsonObj, ep) {
  let title = '';
  let artist = '';
  if (ep.metaFields?.title) {
    title = extractByPath(jsonObj, ep.metaFields.title) || '';
  }
  if (ep.metaFields?.artist) {
    artist = extractByPath(jsonObj, ep.metaFields.artist) || '';
  }
  if (!title && jsonObj && typeof jsonObj === 'object') {
    const d =
      jsonObj.data && typeof jsonObj.data === 'object' && !Array.isArray(jsonObj.data)
        ? jsonObj.data
        : null;
    const arr0 =
      Array.isArray(jsonObj.data) && jsonObj.data[0] && typeof jsonObj.data[0] === 'object'
        ? jsonObj.data[0]
        : null;
    for (const box of [d, arr0, jsonObj]) {
      if (!box) continue;
      for (const k of ['song', 'song_name', 'songName', 'title', 'name']) {
        if (typeof box[k] === 'string' && box[k].trim()) {
          title = box[k].trim();
          break;
        }
      }
      if (title) break;
    }
  }
  return { title, artist };
}

/**
 * 使用单个 yy-lx-hub 萃取端点解析指定歌曲，并执行魔数 + >=1.2MB + 防串曲门禁。
 */
export async function probeEndpoint(ep, songInfo, opts = {}) {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 2800;
  const mode = ep.matchMode || 'id';

  const sid = String(songInfo?.id || songInfo?.songmid || songInfo?.hash || '');
  const title = String(songInfo?.title || songInfo?.name || '');
  const artist = String(songInfo?.artist || songInfo?.singer || '');

  if (mode === 'id' && !isValidIdForPlatform(ep.platform, sid)) {
    return { ok: false, reason: 'id_format_mismatch', latencyMs: 0 };
  }
  if (mode === 'search' && !title) {
    return { ok: false, reason: 'missing_title_for_search', latencyMs: 0 };
  }

  const reqUrl = renderTemplate(ep.urlTemplate, songInfo, 'url');
  if (!isPublicHttpUrl(reqUrl)) {
    return { ok: false, reason: 'invalid_endpoint_url', latencyMs: Date.now() - t0 };
  }

  if (ep.type === 'redirect') {
    const vr = await verifyAudioStream(reqUrl, {
      headers: ep.headers,
      timeoutMs,
    });
    return vr.ok
      ? {
          ok: true,
          url: vr.finalUrl,
          bytes: vr.bytes,
          latencyMs: Date.now() - t0,
          endpoint: ep,
        }
      : { ok: false, reason: vr.reason, latencyMs: Date.now() - t0 };
  }

  const method = (ep.method || 'GET').toUpperCase();
  let body;
  if (method !== 'GET' && method !== 'HEAD' && ep.bodyTemplate) {
    const ct = String(
      ep.headers?.['Content-Type'] || ep.headers?.['content-type'] || ''
    ).toLowerCase();
    const isJson = ct.includes('application/json') || ep.bodyTemplate.trim().startsWith('{');
    body = renderTemplate(ep.bodyTemplate, songInfo, isJson ? 'json' : 'url');
  }

  try {
    const { res } = await safeFetch(reqUrl, {
      method,
      headers: ep.headers,
      body,
      timeoutMs,
    });

    if (!res.ok) {
      return { ok: false, reason: `api_http_${res.status}`, latencyMs: Date.now() - t0 };
    }

    const rawCt = (res.headers.get('content-type') || '').toLowerCase();
    if (rawCt.startsWith('audio/') || rawCt === 'application/octet-stream') {
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      const vr = await verifyAudioStream(reqUrl, {
        headers: {},
        timeoutMs: Math.max(1200, timeoutMs - (Date.now() - t0) + 800),
      });
      return vr.ok
        ? {
            ok: true,
            url: vr.finalUrl,
            bytes: vr.bytes,
            latencyMs: Date.now() - t0,
            endpoint: ep,
          }
        : { ok: false, reason: vr.reason, latencyMs: Date.now() - t0 };
    }

    const rawText = await res.text();
    let audioUrl = '';

    if (ep.type === 'text') {
      const m = /https?:\/\/[^\s"'<>]+/.exec(rawText);
      audioUrl = m ? m[0] : rawText.trim();
    } else if (ep.type === 'regex' && ep.responseExtractor) {
      const re = new RegExp(ep.responseExtractor);
      const m = re.exec(rawText);
      if (m) audioUrl = m[1] || m[0] || '';
    } else {
      let jsonObj;
      try {
        jsonObj = JSON.parse(rawText);
      } catch {
        return { ok: false, reason: 'invalid_json', latencyMs: Date.now() - t0 };
      }

      if (title) {
        const meta = pickReturnedMeta(jsonObj, ep);
        if (!isEndpointResponseValid(mode, meta.title, meta.artist, title, artist)) {
          return {
            ok: false,
            reason: `song_mismatch(${meta.title || '?'})`,
            latencyMs: Date.now() - t0,
          };
        }
      }

      audioUrl = extractByPath(jsonObj, ep.responseExtractor || 'url') || '';
    }

    if (audioUrl && ep.urlPrefix && !audioUrl.startsWith('http')) {
      try {
        audioUrl = new URL(audioUrl.replace(/^\/+/, ''), ep.urlPrefix).href;
      } catch {
        audioUrl = ep.urlPrefix + audioUrl;
      }
    }

    if (!isPublicHttpUrl(audioUrl)) {
      return { ok: false, reason: 'no_audio_url', latencyMs: Date.now() - t0 };
    }

    const cdnHeaders = {};
    if (ep.headers) {
      for (const [k, v] of Object.entries(ep.headers)) {
        if (k.toLowerCase() !== 'content-type') cdnHeaders[k] = v;
      }
    }

    const remaining = Math.max(1200, timeoutMs - (Date.now() - t0) + 800);
    const vr = await verifyAudioStream(audioUrl, {
      headers: cdnHeaders,
      timeoutMs: remaining,
    });

    if (!vr.ok) {
      return { ok: false, reason: vr.reason, latencyMs: Date.now() - t0 };
    }

    return {
      ok: true,
      url: vr.finalUrl,
      bytes: vr.bytes,
      latencyMs: Date.now() - t0,
      endpoint: ep,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || 'probe_error',
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * 真实并发测速所有 yy-lx-hub 音源（绝不伪造成功状态）。
 */
export async function testAllSources(opts = {}) {
  const endpoints = ensureCatalog().endpoints;
  const concurrency = opts.concurrency ?? 8;
  const timeoutMs = opts.timeoutMs ?? 4000;

  let cursor = 0;
  async function worker() {
    while (cursor < endpoints.length) {
      const idx = cursor++;
      const ep = endpoints[idx];
      const track = TEST_TRACKS[ep.platform] || TEST_TRACKS.kw;
      const res = await probeEndpoint(ep, track, { timeoutMs });
      const st = getStat(ep.id);
      st.testedAt = Date.now();
      if (res.ok) {
        st.status = 'ok';
        st.latencyMs = res.latencyMs;
        st.bytes = res.bytes;
        st.error = null;
        st.consecutiveFails = 0;
        st.successCount += 1;
      } else {
        st.status = 'fail';
        st.latencyMs = null;
        st.bytes = 0;
        st.error = res.reason || 'failed';
        st.consecutiveFails += 1;
        st.failCount += 1;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, endpoints.length)) },
    () => worker()
  );
  await Promise.all(workers);
  return getSourcesSummary();
}
