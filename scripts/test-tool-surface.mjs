// P3「工具面收敛」回归（2026-10-18）。
//
// 背景（会话实证，docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md §3 P3）：
//   一份 reserved2 会话的请求头是「58 个工具 / 45.5 KB schema（≈14k token/次）」，其中
//     · 旧的无令牌只读工具在 reserved2 下**必然** 403，白占 schema 还诱导模型误调（实测 turn10 踩过）；
//     · 而 dc-chat-v2 预设第 6 条又明确叫模型去用 chat_get_group_members 拿用户 id。
//
// 本文件验证：
//   1. chat_get_group_members 已是 v2 形态（key + token），走桥接的 /api/socialV2/group-members；
//   2. 该端点只认 group: 会话、要令牌、不在白名单就拒（与其它 v2 读工具同一套闸门）；
//   3. 旧的无令牌只读工具已不再注册（源代码级断言：DSH 侧注册需要真跑 MCP 子进程，
//      本机沙箱里 spawn EPERM，因此这里退化为结构断言 + 上面的令牌级行为断言）；
//   4. 平台查询失败时返回可读的错误，而不是把异常吞掉。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'group:456';
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

async function withBridge(run, config = {}, globals = {}, platform = {}) {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { enabled: false }, ...config } }, globals, platform });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { token = st.agentToken, consoleToken = 'fixture-console-token', key = KEY, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (token) headers['x-agent-token'] = token;
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`,
      method: 'GET', headers }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
  try { await run({ h, st, request }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 1. 端点行为 ────────────────────────────────────────────────────────────
await test('group-members 返回 userId/nickname/card，并带 count/truncated', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('group-members');
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.count, 3);
    assert.equal(out.data.returned, 3);
    assert.equal(out.data.truncated, false);
    assert.deepEqual(out.data.members.map((m) => m.userId), ['111', '222', '123'], 'userId 必须是字符串（模型要拿它 @ 人）');
    assert.equal(out.data.members[0].nickname, '小明');
    assert.equal(out.data.members[2].role, 'owner');
  });
});

await test('group-members 尊重 limit 上限并标记 truncated', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('group-members', { query: '&limit=2' });
    assert.equal(out.status, 200);
    assert.equal(out.data.returned, 2);
    assert.equal(out.data.truncated, true);
  });
});

await test('group-members 令牌校验：代理令牌错 / 什么令牌都没有，都必须拒', async () => {
  await withBridge(async ({ st, request }) => {
    // 代理令牌存在但不对 → 403（这是 v2 读工具的统一口径）
    const badToken = await request('group-members', { token: 'deadbeef' });
    assert.equal(badToken.status, 403, JSON.stringify(badToken.data));
    // 既没有代理令牌、也没有控制台令牌 → 不该被当成操作者放行
    const nothing = await request('group-members', { token: '', consoleToken: '' });
    assert.ok([401, 403].includes(nothing.status), `无凭据必须拒绝，实际 ${nothing.status}`);
    const privateKey = await request('group-members', { key: 'private:123', token: st.agentToken });
    assert.equal(privateKey.status, 400, '私聊没有群成员概念，必须明确报错而不是瞎查');
    const badKey = await request('group-members', { key: 'group:not-a-number' });
    assert.equal(badKey.status, 400);
  });
});

await test('group-members 不在白名单的群被拒（不会变成任意群枚举入口）', async () => {
  await withBridge(async ({ st, request }) => {
    const out = await request('group-members', { key: 'group:999999', token: st.agentToken });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    // 关键：**不带令牌**也不能绕过白名单（closed-agent 的代理调用正是无令牌路径）
    const noToken = await request('group-members', { key: 'group:999999', token: '' });
    assert.equal(noToken.status, 403, `无令牌也不得枚举非白名单群：${JSON.stringify(noToken.data)}`);
  });
});

await test('closed-agent（管理员私聊，无令牌）仍能查白名单群成员，但查不到别的群', async () => {
  const h = await bridgeHarness({ config: { socialV2: { proactive: { enabled: false } } } });
  h.setMode('closed-agent');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const get = (query) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/group-members?key=${encodeURIComponent(KEY)}${query}`,
      method: 'GET', headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const ok = await get('');
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.ok(ok.data.members.length > 0);
    const denied = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/socialV2/group-members?key=group%3A999999', method: 'GET',
        headers: { 'x-console-token': 'fixture-console-token' } }, (res) => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(denied.status, 403, `closed-agent 也不能枚举非白名单群：${JSON.stringify(denied.data)}`);
    assert.equal(st.agentToken.length > 0, true);
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

await test('工具开关能关掉 group-members（getGroupMembers=false）', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('group-members');
    assert.equal(out.status, 403);
    assert.match(out.data.error, /chat_get_group_members/);
  }, { tools: { getGroupMembers: false } });
});

// ── 2. 平台查询失败 ─────────────────────────────────────────────────────────
await test('平台查询成员失败时回 500 与可读原因', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('group-members');
    assert.equal(out.status, 500, JSON.stringify(out.data));
    assert.equal(out.data.ok, false);
    assert.match(out.data.error, /Missing Access/);
  }, {}, {}, { getGroupMemberList: async () => { throw new Error('Missing Access'); } });
});

// ── 3. 源码级断言：只剩 v2 形态的成员工具 ──────────────────────────────────
await test('旧无令牌只读工具不再注册，chat_get_group_members 是 v2 形态', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/mcp-discord-safe.js'), 'utf8');
  for (const name of ['chat_list_groups', 'chat_get_group_history']) {
    assert.ok(!src.includes(`'${name}'`), `${name} 不应再注册`);
  }
  assert.doesNotMatch(src, /registerLegacyReadTools/);
  // chat_get_group_members 必须是 v2 形态（带 key+token）
  const membersAt = src.indexOf("'chat_get_group_members'", src.indexOf('server.tool('));
  assert.ok(membersAt > 0);
  const membersBlock = src.slice(membersAt, membersAt + 900);
  assert.match(membersBlock, /key: z\.string\(\)/, 'v2 形态必须有 key');
  assert.match(membersBlock, /token: z\.string\(\)/, 'v2 形态必须有 token');
  assert.doesNotMatch(membersBlock, /groupId: z\./, '不应再接受裸 groupId');
  // 工具开关登记（否则控制台关不掉它）
  assert.match(src, /chat_get_group_members: 'getGroupMembers'/, '工具开关要登记 getGroupMembers');
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
