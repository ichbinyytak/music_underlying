#!/usr/bin/env node
/**
 * scripts/sync.mjs - 从 yy-lx-hub 自动拉取并验证 extracted_apis.enc，
 * 写入 core/apis_bundle.js 供 Vercel Serverless 与本地 Node.js 零构建打包消费。
 *
 * 用法:
 *   node scripts/sync.mjs                   # 从 GitHub Release (amusic-sync) 拉取
 *   node scripts/sync.mjs --local <path>    # 从本地 extracted_apis.enc 或 .json 导入
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptJson, encryptJson, getSyncSecret } from '../core/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const BUNDLE_PATH = path.join(ROOT_DIR, 'core', 'apis_bundle.js');

const DEFAULT_ENC_URL =
  'https://github.com/ichbinyytak/yy-lx-hub/releases/download/amusic-sync/extracted_apis.enc';

function parseArgs(argv) {
  const args = { local: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--local' && argv[i + 1]) {
      args.local = argv[++i];
    } else if (argv[i] === '--url' && argv[i + 1]) {
      args.url = argv[++i];
    }
  }
  return args;
}

async function loadEnvelope(args) {
  const secret = getSyncSecret();

  if (args.local) {
    const fullPath = path.resolve(process.cwd(), args.local);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 1 && parsed.ct && parsed.mac) {
      const payload = decryptJson(parsed, secret);
      return { envelope: parsed, payload };
    }
    if (parsed && Array.isArray(parsed.endpoints)) {
      const envelope = encryptJson(parsed, secret);
      return { envelope, payload: parsed };
    }
    throw new Error(`本地文件格式无效: ${fullPath}`);
  }

  const targetUrl = (args.url || process.env.LXHUB_ENC_URL || DEFAULT_ENC_URL).trim();
  console.log(`正在从 yy-lx-hub 拉取加密音源清单: ${targetUrl}`);
  const resp = await fetch(targetUrl, {
    headers: { 'User-Agent': 'music-underlying-sync/2.0' },
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const rawText = await resp.text();
  const envelope = JSON.parse(rawText);
  const payload = decryptJson(envelope, secret);
  return { envelope, payload };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { envelope, payload } = await loadEnvelope(args);

  if (!payload || !Array.isArray(payload.endpoints) || payload.endpoints.length === 0) {
    throw new Error('解密后的 endpoints 列表为空，拒绝覆盖现有音源包');
  }

  const stats = {};
  for (const ep of payload.endpoints) {
    stats[ep.platform] = (stats[ep.platform] || 0) + 1;
  }

  const header = [
    '// 自动同步自 yy-lx-hub (amusic-sync / extracted_apis.enc)，请勿手动修改',
    `// 更新时间: ${payload.updatedAt || new Date().toISOString()} | 端点数: ${payload.endpoints.length}`,
    '',
  ].join('\n');

  const content = `${header}export default ${JSON.stringify(envelope, null, 2)};\n`;
  const tmpPath = `${BUNDLE_PATH}.tmp`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, BUNDLE_PATH);

  console.log(
    `✓ 同步并验签成功！共 ${payload.endpoints.length} 个端点 (${JSON.stringify(stats)})`
  );
  console.log(`✓ 已写入: ${BUNDLE_PATH}`);
}

main().catch((err) => {
  console.error(`❌ 同步失败: ${err.message}`);
  process.exit(1);
});
