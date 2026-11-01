#!/usr/bin/env node
// server.js - 极简纯 Node.js 原生 HTTP 微服务 (无任何三方 npm 依赖，零构建)
// 完美统一运行 Cloudflare Pages Functions 与 本地/VPS 生产环境

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 导入 Edge 核心处理函数
import { onRequestGet as handleSearch } from './api/search.js';
import { onRequest as handleResolve } from './api/resolve.js';
import { onRequestGet as handleLyric } from './api/lyric.js';
import { onRequestGet as handleSourcesGet, onRequestPost as handleSourcesPost } from './api/sources.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8090;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 适配 Web 标准 Request 接口
    const makeContext = async () => {
        let bodyBuffer = null;
        if (req.method === 'POST' || req.method === 'PUT') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            bodyBuffer = Buffer.concat(chunks);
        }
        const webRequest = new Request(parsedUrl.href, {
            method: req.method,
            headers: req.headers,
            body: bodyBuffer
        });
        return { request: webRequest };
    };

    const sendWebResponse = async (webResp) => {
        res.writeHead(webResp.status, Object.fromEntries(webResp.headers.entries()));
        const buf = Buffer.from(await webResp.arrayBuffer());
        res.end(buf);
    };

    try {
        // API 路由分发 (100% 复用 Cloudflare Functions)
        if (pathname === '/api/search') {
            const ctx = await makeContext();
            return await sendWebResponse(await handleSearch(ctx));
        }
        if (pathname === '/api/resolve') {
            const ctx = await makeContext();
            return await sendWebResponse(await handleResolve(ctx));
        }
        if (pathname === '/api/lyric') {
            const ctx = await makeContext();
            return await sendWebResponse(await handleLyric(ctx));
        }
        if (pathname === '/api/sources') {
            const ctx = await makeContext();
            if (req.method === 'POST') {
                return await sendWebResponse(await handleSourcesPost(ctx));
            }
            return await sendWebResponse(await handleSourcesGet(ctx));
        }
        if (pathname === '/api/sources/test') {
            const ctx = await makeContext();
            return await sendWebResponse(await handleSourcesPost(ctx));
        }

        // 静态文件服务
        let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(__dirname, 'index.html');
        }

        const ext = path.extname(filePath);
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);

    } catch (err) {
        console.error("Server error:", err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`⚡ YY-Music 极简通用服务已启动: http://localhost:${PORT}/`);
    console.log(`✨ 完美适配: Cloudflare Pages 全球边缘 + 本地 Node.js 双模运行`);
});
