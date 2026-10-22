// Execute the real preset guard plugin against a captured tools service, without DSH/Discord.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
// 两个 preset 共用 bundle 里的同一份守卫；这里先确认两份 preset 源都挂了它，再执行它。
for (const preset of ['dc-chat', 'dc-chat-v2']) {
  const rows = yaml.load(fs.readFileSync(path.join(root, 'dsh/agent-presets', preset, 'agent.cordis.yml'), 'utf8'));
  assert.ok(rows.some((row) => row.id === 'discord-tool-restrict'), `${preset}: must mount discord-tool-restrict`);
}
{
  const { apply } = await import(pathToFileURL(path.join(root, 'plugins/discord-agent-presets/discord-tool-restrict.mjs')).href);
  let guard;
  const restricted = [];
  apply({ tools: {
    restrict: ({ deny }) => restricted.push(...deny),
    guard: (callback) => { guard = callback; },
  } });
  assert.equal(typeof guard, 'function');
  assert.ok(restricted.includes('dev_install_package'));
  for (const name of ['ask_user_question', 'todo_write', 'mcp__discord__chat_send_message',
    'mcp__web-search-safe__web_fetch']) {
    assert.equal(guard({ name }), undefined, `expected allowed ${name}`);
  }
  for (const name of ['web_fetch', 'web_search', 'bash', 'read_file', 'dev_future_tool',
    'mcp__untrusted__web_fetch', '', null, undefined]) {
    try { assert.equal(typeof guard({ name }), 'string', `must reject ${String(name)}`); }
    catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  console.log('discord-tool-restrict: checked allowed tools and denied inherited/local/invalid tools');
}
// ── state/ 权限收紧（Windows 上 mode 0o600 是空操作，必须动 ACL）的离线守卫 ──────────
// 这里只做"结构 + 编码"级断言：真正的 icacls/UAC 行为在这个环境里跑不了（沙箱禁止改 ACL），
// 而**假装测过**比不测更危险，所以明确只钉住下面这些不会骗人的事实。
{
  const helperPath = path.join(root, 'scripts/harden-state-acl.mjs');
  assert.ok(fs.existsSync(helperPath), 'ACL 收紧助手必须存在（start.bat 依赖它）');
  const helper = fs.readFileSync(helperPath, 'utf8');
  for (const needle of ['icacls', '/inheritance:r', '--elevated', 'isHardened', 'process.exit(0)']) {
    assert.ok(helper.includes(needle), `ACL 助手应包含 ${needle}`);
  }
  // 失败必须降级为非阻断：任何一条 sayAlways/console.log 之后都不得以非 0 退出。
  assert.ok(!/process\.exit\([1-9]/.test(helper), 'ACL 助手不得以非 0 退出码结束（否则会阻断启动）');
  // 提权递归防护：被自己拉起的那一次必须跳过提权重试。
  assert.ok(/!isElevatedRun/.test(helper), '提权重试必须被 --elevated 标记短路，防止递归');

  const bat = fs.readFileSync(path.join(root, 'start.bat'));
  const batText = bat.toString('latin1');
  const nonAscii = [...bat].filter((b) => b > 127).length;
  assert.equal(nonAscii, 0, 'start.bat 必须保持纯 ASCII（否则非 UTF-8 控制台会乱码）');
  assert.equal(batText.match(/(?<!\r)\n/g)?.length ?? 0, 0, 'start.bat 必须使用 CRLF');
  assert.ok(batText.includes('harden-state-acl.mjs'), 'start.bat 必须在启动桥接前调用 ACL 助手');
  // 助手必须排在 node src/bridge.js 之前，否则"启动时收紧"就不成立
  assert.ok(batText.indexOf('harden-state-acl.mjs') < batText.indexOf('node src/bridge.js'), 'ACL 助手必须先于桥接启动');
  console.log('state ACL hardening: helper is non-blocking, recursion-guarded, and wired into start.bat');
}

// 包元数据必须声明许可证（独立复核发现此前缺失）
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT', 'package.json 必须声明 license 字段');
  console.log('package metadata: license declared');
}

process.exitCode = failures ? 1 : 0;
