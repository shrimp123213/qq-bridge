// 图片/表情链路 + 联网搜索的离线回归。
//
// 背景（真实故障，见 2026-10-17 的会话日志）：
//   1. 图片 CDN 同时有 AAAA/A 记录，而本机只有 IPv4 出口 —— 抢到 AAAA 的那次请求会一直
//      等到 20s 超时，于是「图片时好时坏」。修复在 safe-fetch 的地址故障切换。
//   2. 贴纸字段（url/summary）以前被丢弃，模型只看到「图片」；现在保留 kind/url/summary，
//      取图只走附件/CDN 的 http(s) 地址。
//   3. 搜索以前是抓 Bing HTML（结果空/噪声大、部分 query 直接退化）；现在优先复用
//      DSH 同一路 DeepSeek 联网搜索，Bing RSS 仅作兜底。
//
// 本文件不访问网络：CDN 下载用注入的 safeFetchBuffer 桩，搜索只测纯函数与参数校验。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import {
  bingSearch,
  clearSearchCache,
  deepseekSearch,
  loadSearchConfig,
  mapDeepSeekResponse,
  parseBingHtml,
  parseBingRss,
  readDshCredential,
  resolveSearchApiKey,
  webSearch
} from '../src/web-search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 1×1 GIF / PNG / WebP（足够通过签名与尺寸解析）
const GIF = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
const WEBP_VP8X = (() => {
  const buf = Buffer.alloc(40);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(32, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  // width-1 = 1919 (0x77f), height-1 = 1079 (0x437)，24 位小端
  buf[24] = 0x7f; buf[25] = 0x07; buf[26] = 0x00;
  buf[27] = 0x37; buf[28] = 0x04; buf[29] = 0x00;
  return buf;
})();

// ── 消息段 → 媒体元数据 ─────────────────────────────────────────────────────
await test('extractMediaFromSegments 保留贴纸字段（image / sticker）', async () => {
  const h = await bridgeHarness();
  try {
    const media = h.extractMediaFromSegments([
      { type: 'image', data: { file: 'cat.png', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png' } },
      { type: 'sticker', data: { url: 'https://media.discordapp.net/stickers/3.png', summary: '给你糖吃' } },
      { type: 'text', data: { text: '普通文字' } },
      { type: 'video', data: { file: 'a.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/a.mp4' } }
    ]);
    assert.equal(media.length, 2, '只收图片与贴纸');
    assert.equal(media[0].kind, 'image');
    assert.equal(media[0].file, 'cat.png');
    assert.equal(media[0].url, 'https://cdn.discordapp.com/attachments/1/2/cat.png');
    assert.equal(media[1].kind, 'sticker', '贴纸必须被识别为表情');
    assert.equal(media[1].summary, '给你糖吃');

    assert.equal(await h.segmentsToText([{ type: 'sticker', data: { summary: '给你糖吃' } }]), '[表情:给你糖吃]');
  } finally { await h.close(); }
});

await test('fetchMediaData 标注表情/图片，并保留 summary 与 url', async () => {
  const STICKER_URL = 'https://media.discordapp.net/stickers/3.gif';
  const h = await bridgeHarness({
    globals: {
      safeFetchBuffer: async (url) => {
        if (String(url) === STICKER_URL) return { buffer: GIF };
        throw new Error('网络不可用');
      }
    }
  });
  try {
    const out = await h.fetchMediaData([{ kind: 'sticker', url: STICKER_URL, summary: '给你糖吃' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'sticker');
    assert.equal(out[0].summary, '给你糖吃');
    assert.equal(out[0].url, STICKER_URL);
    assert.equal(out[0].mimeType, 'image/gif');
    assert.ok(out[0].data?.length, '应带 base64 图片数据');
    assert.equal(out[0].text, '');

    const failed = await h.fetchMediaData([{ kind: 'image', file: 'abc.jpg', url: 'https://cdn.discordapp.com/attachments/1/2/abc.jpg' }]);
    assert.equal(failed[0].kind, 'image');
    assert.match(String(failed[0].text), /图片获取失败/, '失败必须明确标注为图片');

    const noUrl = await h.fetchMediaData([{ kind: 'image', file: 'abc.jpg' }]);
    assert.match(String(noUrl[0].text), /图片获取失败/, '没有地址时同样明确标注失败');
  } finally { await h.close(); }
});

await test('getImageDimensions / acceptImageBuffer 覆盖 GIF 与 WebP，并拦截非图片', async () => {
  const h = await bridgeHarness();
  try {
    const gif = h.getImageDimensions(GIF);
    assert.equal(gif?.width, 1);
    assert.equal(gif?.height, 1);
    const webp = h.getImageDimensions(WEBP_VP8X);
    assert.equal(webp?.width, 1920);
    assert.equal(webp?.height, 1080);
    assert.ok(h.acceptImageBuffer(GIF, 'gif'), 'GIF 必须通过');
    assert.ok(h.acceptImageBuffer(WEBP_VP8X, 'webp'), 'WebP 必须通过');
    assert.equal(h.acceptImageBuffer(Buffer.from('not an image at all')), null, '非图片必须拒绝');
  } finally { await h.close(); }
});

// ── 搜索：配置 / 凭据 / 结果映射 / 解析 ─────────────────────────────────────
await test('loadSearchConfig 默认值与越界收敛', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      webSearch: { provider: 'bing', maxResults: 99, maxUses: 9, timeoutMs: 1, apiKeyEnv: ' MY_KEY ' }
    }));
    const cfg = loadSearchConfig(dir);
    assert.equal(cfg.provider, 'bing');
    assert.equal(cfg.maxResults, 20, 'maxResults 上限 20');
    assert.equal(cfg.maxUses, 5, 'maxUses 上限 5');
    assert.equal(cfg.timeoutMs, 5000, 'timeoutMs 下限 5s');
    assert.equal(cfg.apiKeyEnv, 'MY_KEY');
    assert.equal(cfg.model, 'deepseek-v4-flash');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'nonsense' } }));
    assert.equal(loadSearchConfig(dir).provider, 'auto', '未知 provider 回退 auto');
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken json');
    assert.equal(loadSearchConfig(dir).provider, 'auto', '坏配置不得让搜索崩溃');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('resolveSearchApiKey 的优先级：config > env > DSH 凭据', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.BRIDGE_TEST_SEARCH_KEY;
  try {
    fs.writeFileSync(path.join(home, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  BRIDGE_TEST_SEARCH_KEY: sk-from-dsh-credentials',
      'records: {}',
      ''
    ].join('\n'));
    process.env.DSH_HOME = home;
    delete process.env.BRIDGE_TEST_SEARCH_KEY;

    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'BRIDGE_TEST_SEARCH_KEY' }).source, 'dsh-credentials');
    assert.equal(readDshCredential('BRIDGE_TEST_SEARCH_KEY'), 'sk-from-dsh-credentials');

    process.env.BRIDGE_TEST_SEARCH_KEY = 'sk-from-env';
    assert.deepEqual(resolveSearchApiKey({ apiKeyEnv: 'BRIDGE_TEST_SEARCH_KEY' }), { key: 'sk-from-env', source: 'env' });

    assert.deepEqual(
      resolveSearchApiKey({ apiKey: 'sk-from-config', apiKeyEnv: 'BRIDGE_TEST_SEARCH_KEY' }),
      { key: 'sk-from-config', source: 'config' }
    );

    delete process.env.BRIDGE_TEST_SEARCH_KEY;
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n');
    assert.equal(resolveSearchApiKey({ apiKeyEnv: 'BRIDGE_TEST_SEARCH_KEY' }).source, 'none');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.BRIDGE_TEST_SEARCH_KEY; else process.env.BRIDGE_TEST_SEARCH_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('mapDeepSeekResponse：去重、去 #N 锚点、引用摘要', async () => {
  const response = {
    content: [
      { type: 'thinking', thinking: '...' },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', title: '鲸鱼娘', url: 'https://example.com/a#1', page_age: '2026-10-01' },
          { type: 'web_search_result', title: '重复', url: 'https://example.com/a#2' },
          { type: 'web_search_result', title: '鲸鱼娘（二）', url: 'https://example.com/b' }
        ]
      },
      { type: 'text', text: '答案', citations: [{ url: 'https://example.com/b', cited_text: '这是引用片段' }] }
    ]
  };
  const results = mapDeepSeekResponse(response, 8);
  assert.equal(results.length, 2, '同一 URL 必须去重');
  assert.equal(results[0].url, 'https://example.com/a', '必须去掉 #1 锚点');
  assert.equal(results[0].publishedAt, '2026-10-01');
  assert.equal(results[1].snippet, '这是引用片段');
  assert.throws(() => mapDeepSeekResponse({ content: [{ type: 'text', text: '没有结果块' }] }), /web_search_tool_result/);
});

await test('Bing RSS / HTML 解析：CDATA、实体、去重、上限', async () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[第一条 & 摘要]]></title><link>https://example.com/1</link><description><![CDATA[<b>加粗</b> 内容 &#x4e2d;]]></description></item>
    <item><title>第二条</title><link>https://example.com/2</link><description>&amp; 转义</description></item>
    <item><title>重复</title><link>https://example.com/1</link></item>
  </channel></rss>`;
  const fromRss = parseBingRss(rss, 8);
  assert.equal(fromRss.length, 2);
  assert.equal(fromRss[0].title, '第一条 & 摘要');
  assert.equal(fromRss[0].snippet, '加粗 内容 中');
  assert.equal(fromRss[1].snippet, '& 转义');

  const html = `<li class="b_algo"><h2><a href="https://example.com/x">X 标题</a></h2><p>X 摘要</p></li>
    <li class="b_algo"><h2><a href="https://example.com/x">重复</a></h2><p>dup</p></li>
    <li class="b_algo"><h2><a href="https://example.com/y">Y</a></h2><p>Y 摘要</p></li>`;
  const fromHtml = parseBingHtml(html, 8);
  assert.equal(fromHtml.length, 2);
  assert.equal(fromHtml[0].url, 'https://example.com/x');
  assert.equal(parseBingRss(rss, 1).length, 1, 'maxResults 必须生效');
});

await test('deepseekSearch：没有 key 时报 NO_KEY；非 https 端点直接拒绝', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home2-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    const noKey = await deepseekSearch('测试', { provider: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' }).catch((e) => e);
    assert.equal(noKey?.code, 'NO_KEY');

    const insecure = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'http://api.deepseek.com/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(insecure?.message), /https/, 'API key 不允许发往 http 端点');

    const privateHost = await deepseekSearch('测试', {
      provider: 'deepseek',
      apiKey: 'sk-test-only-for-unit-test',
      baseURL: 'https://127.0.0.1/anthropic/v1'
    }).catch((e) => e);
    assert.match(String(privateHost?.message), /内网|本机|禁止/, 'API key 不允许发往内网/本机端点');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('webSearch：provider=deepseek 且无 key 时不静默回退（明确报错）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home3-'));
  const oldHome = process.env.DSH_HOME;
  const oldKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    clearSearchCache();
    const error = await webSearch('测试', {
      root: ROOT,
      provider: 'deepseek',
      config: { provider: 'deepseek', apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY' }
    }).catch((e) => e);
    assert.equal(error?.code, 'NO_KEY', '显式指定 deepseek 时不能悄悄回退 Bing');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = oldKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test('MCP 服务器复用 web-search 模块（不再自己抓 Bing HTML）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-web-search-safe.js'), 'utf8');
  assert.match(source, /from '\.\/web-search\.js'/, 'MCP 必须复用统一搜索模块');
  assert.match(source, /webSearch\(/, 'MCP 必须调用 webSearch()');
  assert.ok(!/b_algo/.test(source), 'MCP 里不得再有一份 Bing HTML 解析（会与模块实现漂移）');
  assert.ok(!/bingSearch/.test(source), 'MCP 里不得再有一份 bingSearch 实现');
});

await test('safe-fetch：多地址时按 IPv4 优先并在失败后切换', async () => {
  // 直接验证纯函数（不联网）：一个 IPv6 在前、IPv4 在后的应答，必须排出 IPv4 优先的顺序。
  const { default: dns } = await import('node:dns');
  const original = dns.promises.lookup;
  dns.promises.lookup = async () => ([
    { address: '2408:8756:f50:4::17', family: 6 },
    { address: '116.162.45.14', family: 4 }
  ]);
  try {
    // 用动态 import 拿到"用这份 DNS 桩解析"的实例：模块在导入时捕获 lookup 引用，
    // 所以先替换再导入（与 test-audit-security 的做法一致）。
    const mod = await import(`../src/safe-fetch.js?failover=${Date.now()}`);
    assert.deepEqual(await mod.resolveSafeAddresses('cdn.discordapp.com'), ['116.162.45.14', '2408:8756:f50:4::17']);
  } finally {
    dns.promises.lookup = original;
  }
});

// ── 搜索：空结果 note 必须进入缓存（否则 5 分钟内重复查询拿不到提示） ────────────
// 不能真联网，所以这里是**结构断言**：note 走的是 `value = {...value, note}`（新建对象），
// 而缓存存的是引用；先 cache.set 再加 note ⇒ 命中缓存时拿到的正是那个没有 note 的旧对象，
// 而「同一句 query 连着问几次」恰恰是模型最容易开始重试的场景（issue #17 的修复点）。
await test('webSearch：空结果提示在写缓存之前生成（缓存命中也要带 note）', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'web-search.js'), 'utf8');
  const noteAt = source.indexOf('没有搜到结果');
  const cacheAt = source.indexOf('cache.set(cacheKey');
  assert.ok(noteAt > 0, 'webSearch 必须给空结果附 note');
  assert.ok(cacheAt > 0, 'webSearch 必须有 5 分钟查询缓存');
  assert.ok(noteAt < cacheAt, 'note 必须在 cache.set 之前生成：缓存存的是 value 的引用，反过来写会让缓存命中丢掉提示');
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
