import net from 'node:net';

export const MIN_VALID_BYTES = 1200000; // 1.2MB 严格防试听门禁
export const FAKE_AUDIO_LENGTHS = new Set([81629, 181521]);

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STRIP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'date',
]);

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIp(host) {
  const clean = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  const ver = net.isIP(clean);
  if (ver === 4) return isPrivateIpv4(clean);
  if (ver === 6) {
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd')) {
      return true;
    }
    if (clean.startsWith('::ffff:')) {
      return isPrivateIpv4(clean.slice(7));
    }
    return false;
  }
  return false;
}

/**
 * 校验目标 URL 是否为公网 HTTP/HTTPS 地址，防止 SSRF 探测内网服务。
 */
export function isPublicHttpUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!host) return false;
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    if (isPrivateIp(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function sanitizeHeaders(rawHeaders, extra = {}) {
  const out = {};
  const seen = new Set();
  const merge = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (STRIP_HEADERS.has(lk) || v == null || String(v).length === 0) continue;
      if (seen.has(lk)) {
        for (const ek of Object.keys(out)) {
          if (ek.toLowerCase() === lk) delete out[ek];
        }
      }
      seen.add(lk);
      out[k] = String(v);
    }
  };
  merge(rawHeaders);
  merge(extra);
  if (!seen.has('user-agent')) {
    out['User-Agent'] = DEFAULT_UA;
  }
  return out;
}

/**
 * 带共享超时与重定向 SSRF 检查的安全 HTTP 请求。
 */
export async function safeFetch(rawUrl, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 5;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const deadline = Date.now() + timeoutMs;

  let currentUrl = rawUrl;
  let method = (opts.method || 'GET').toUpperCase();
  let body = opts.body;
  let headers = sanitizeHeaders(opts.headers);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isPublicHttpUrl(currentUrl)) {
      throw new Error(`Blocked non-public URL: ${currentUrl}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Request timeout (${timeoutMs}ms)`);
    }

    const res = await fetch(currentUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining),
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        // ignore cancel error
      }
      if (!loc) return { res, finalUrl: currentUrl };
      currentUrl = new URL(loc, currentUrl).href;
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }

    return { res, finalUrl: currentUrl };
  }

  throw new Error('Too many redirects');
}

export function looksAudio(buf) {
  if (!buf || buf.length < 8) return false;
  const ascii4 = buf.subarray(0, 4).toString('ascii');
  if (ascii4.startsWith('ID3')) return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  if (ascii4 === 'fLaC' || ascii4 === 'OggS' || ascii4 === 'RIFF') return true;
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  return false;
}

async function readHeadUpTo(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    const u8 = new Uint8Array(ab);
    return { buf: Buffer.from(u8.subarray(0, maxBytes)), eof: true, rawLen: u8.length };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let eof = false;
  try {
    while (total < maxBytes) {
      const step = await reader.read();
      if (step.done) {
        eof = true;
        break;
      }
      if (step.value && step.value.length > 0) {
        chunks.push(Buffer.from(step.value));
        total += step.value.length;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 提前中断，避免下载完整音频
    }
  }
  const combined = Buffer.concat(chunks);
  return {
    buf: combined.subarray(0, Math.min(combined.length, maxBytes)),
    eof,
    rawLen: total,
  };
}

/**
 * 音频直链物理真机门禁：
 * 1. Range: bytes=0-16383 仅嗅探首包 16KB
 * 2. 音频文件头魔数验证（拦截 HTML/JSON 报错页与假直链）
 * 3. 文件大小 >= 1.2MB（拦截 30s 试听截断与 81KB 语音提示）
 */
export async function verifyAudioStream(url, opts = {}) {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 2500;
  const minBytes = opts.minBytes ?? MIN_VALID_BYTES;

  if (!isPublicHttpUrl(url)) {
    return { ok: false, reason: 'invalid_url', latencyMs: Date.now() - t0 };
  }

  try {
    const headers = sanitizeHeaders(opts.headers, { Range: 'bytes=0-16383' });
    const { res, finalUrl } = await safeFetch(url, {
      method: 'GET',
      headers,
      timeoutMs,
    });

    if (res.status !== 200 && res.status !== 206) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      return {
        ok: false,
        reason: `http_${res.status}`,
        latencyMs: Date.now() - t0,
      };
    }

    let totalBytes = 0;
    const contentRange = res.headers.get('content-range') || '';
    const crMatch = /\/(\d+)/.exec(contentRange);
    if (crMatch) {
      totalBytes = parseInt(crMatch[1], 10) || 0;
    } else if (res.status === 200) {
      totalBytes = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    }

    if (FAKE_AUDIO_LENGTHS.has(totalBytes)) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      return {
        ok: false,
        reason: 'fake_audio_stub',
        bytes: totalBytes,
        latencyMs: Date.now() - t0,
      };
    }

    if (totalBytes > 0 && totalBytes < minBytes) {
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      return {
        ok: false,
        reason: `preview_too_small_${totalBytes}`,
        bytes: totalBytes,
        latencyMs: Date.now() - t0,
      };
    }

    const { buf, eof, rawLen } = await readHeadUpTo(res, 16384);
    if (!looksAudio(buf)) {
      return {
        ok: false,
        reason: 'invalid_audio_magic',
        bytes: totalBytes || rawLen,
        latencyMs: Date.now() - t0,
      };
    }

    // 无大小响应头（Chunked）时，如果短时间内就已经 EOF 且读取不足 1.2MB，则属于残卷
    if (totalBytes === 0 && eof && rawLen < minBytes) {
      return {
        ok: false,
        reason: `chunked_too_small_${rawLen}`,
        bytes: rawLen,
        latencyMs: Date.now() - t0,
      };
    }

    return {
      ok: true,
      finalUrl,
      bytes: totalBytes || rawLen,
      contentType: res.headers.get('content-type') || '',
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || 'network_error',
      latencyMs: Date.now() - t0,
    };
  }
}
