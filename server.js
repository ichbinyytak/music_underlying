#!/usr/bin/env node
/**
 * server.js - 本地 / VPS Node.js HTTP 微服务
 * 与 Vercel Serverless Functions (/api/*.js) 100% 共用 Web 标准 Request/Response 处理器。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as searchApi from './api/search.js';
import * as resolveApi from './api/resolve.js';
import * as lyricApi from './api/lyric.js';
import * as sourcesApi from './api/sources.js';
import * as sourcesTestApi from './api/sources/test.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8090);

const API_ROUTES = {
  '/api/search': searchApi,
  '/api/resolve': resolveApi,
  '/api/lyric': lyricApi,
  '/api/sources': sourcesApi,
  '/api/sources/test': sourcesTestApi,
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function toWebRequest(req, parsedUrl) {
  let bodyBuffer;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length > 0) bodyBuffer = Buffer.concat(chunks);
  }
  return new Request(parsedUrl.href, {
    method: req.method,
    headers: req.headers,
    body: bodyBuffer,
  });
}

async function sendWebResponse(res, webResp) {
  res.writeHead(webResp.status, Object.fromEntries(webResp.headers.entries()));
  if (webResp.status === 204 || !webResp.body) {
    res.end();
    return;
  }
  const buf = Buffer.from(await webResp.arrayBuffer());
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  try {
    const mod = API_ROUTES[pathname];
    if (mod) {
      const fn = mod[req.method];
      if (!fn) {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      const webReq = await toWebRequest(req, parsedUrl);
      const webResp = await fn(webReq);
      await sendWebResponse(res, webResp);
      return;
    }

    if (pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'API endpoint not found' }));
      return;
    }

    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(__dirname, relPath);
    const safeFile =
      candidate.startsWith(__dirname + path.sep) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile() &&
      !relPath.startsWith('core/') &&
      !relPath.startsWith('scripts/') &&
      !relPath.startsWith('api/')
        ? candidate
        : path.join(__dirname, 'index.html');

    const ext = path.extname(safeFile);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(safeFile).pipe(res);
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ music_underlying 服务已启动: http://localhost:${PORT}/`);
});
