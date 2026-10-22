// 语音系统整体自检（结构层）：把桥接语音系统的所有入口、依赖、端点、开关、文档
// 一次列全并逐项验证存在性与一致性。
// 这是"完整检查"的机器可读版本，避免只靠人工翻文件漏项。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

console.log('## 文件清单');
for (const rel of ['src/voice-core.js', 'src/send-voice-lib.js',
  'scripts/send-voice.mjs', 'scripts/test-voice.mjs', 'scripts/test-voice-core.mjs',
  'scripts/test-console-static.mjs']) {
  ok(exists(rel), rel);
}

console.log('## 模块依赖解析');
{
  // 每个 entry 都能独立 import（语法 + 相对路径 + 符号都存在）
  const checks = [
    ['src/voice-core.js', 'voice-core'],
    ['src/send-voice-lib.js', 'send-voice-lib（薄转发）'],
  ];
  for (const [rel, label] of checks) {
    try {
      const m = await import(pathToFileURL(path.join(ROOT, rel)).href);
      ok(Object.keys(m).length > 5, `${label} 可 import`, `${Object.keys(m).length} 个导出`);
    } catch (e) { ok(false, `${label} 可 import`, e.message); }
  }
  const core = await import(pathToFileURL(path.join(ROOT, 'src/voice-core.js')).href);
  const shim = await import(pathToFileURL(path.join(ROOT, 'src/send-voice-lib.js')).href);
  const coreKeys = Object.keys(core).sort();
  const shimKeys = Object.keys(shim).sort();
  ok(coreKeys.every((k) => shimKeys.includes(k)), 'shim 覆盖 voice-core 全部导出',
    shimKeys.length >= coreKeys.length ? `${shimKeys.length} 个` : `core=${coreKeys.length} shim=${shimKeys.length}`);
  // shim 必须是转发而不是实现（防止两份实现again 漂移）
  const shimSrc = read('src/send-voice-lib.js');
  ok(/export\s*\{[\s\S]*\}\s*from\s*'\.\/voice-core\.js'/.test(shimSrc), 'send-voice-lib.js 是纯转发（无独立实现）');
  ok(!/function\s+\w+\s*\(/.test(shimSrc), 'send-voice-lib.js 里没有函数实现');
}

console.log('## 各入口 import 的符号都真实存在');
{
  const core = await import(pathToFileURL(path.join(ROOT, 'src/voice-core.js')).href);
  for (const rel of ['scripts/send-voice.mjs', 'src/bridge.js']) {
    const src = read(rel);
    const blocks = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']*(?:voice-core|send-voice-lib)[^']*)'/g)];
    if (!blocks.length) { ok(true, `${rel} 不直接依赖语音共享库`); continue; }
    const names = blocks.flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    const missing = names.filter((n) => !(n in core));
    ok(missing.length === 0, `${rel} 的共享库符号都存在`, missing.length ? `缺：${missing.join(', ')}` : `${names.length} 个`);
  }
}

console.log('## 桥接语音系统：路由与开关');
{
  const bridge = read('src/bridge.js');
  for (const route of ["'/api/voice/send'", "'/api/send/voice'", "'/api/socialV2/send-voice'", "'/api/voice/list'", "'/api/socialV2/voices'"]) {
    ok(bridge.includes(route), `路由 ${route}`);
  }
  ok(/v2ToolEnabled\('sendVoice'\)/.test(bridge), 'AI 路由受 tools.sendVoice 开关控制');
  ok(/voiceBudgetCheck/.test(bridge) && /voiceBudgetCommit/.test(bridge), '语音额度：检查与记账分离');
  ok(/assertOutboundAuditOk/.test(bridge), '语音文件名审计存在');
  ok(/verifyVoiceMessageSent/.test(bridge), '发送后回读校验存在');
  ok(/shouldBlockSilentReply\(key\)/.test(bridge), 'AI 语音尊重静默模式');
  ok(/allowAbsolutePath/.test(bridge), 'AI 绝对路径受配置约束');
  // 操作者通道不应被 AI 开关挡住（否则默认关闭时你自己也发不了）
  const opSection = bridge.slice(bridge.indexOf("url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice'"), bridge.indexOf("'/api/socialV2/send-voice'"));
  ok(!/if \(!voice\.enabled\)/.test(opSection), '操作者通道不被 voice.enabled 挡住（默认关闭时仍可手动试发）');
  const agentSection = bridge.slice(bridge.indexOf("url.pathname === '/api/socialV2/send-voice'"), bridge.indexOf("url.pathname === '/api/socialV2/voices'"));
  ok(/if \(!voice\.enabled\)/.test(agentSection), 'AI 通道受 voice.enabled 挡住');
}

console.log('## 桥接语音系统：MCP 工具与开关映射');
{
  const mcp = read('src/mcp-discord-safe.js');
  ok(mcp.includes("'chat_send_voice'"), '注册 chat_send_voice');
  ok(mcp.includes("'chat_list_voices'"), '注册 chat_list_voices');
  ok(/chat_send_voice: 'sendVoice'/.test(mcp) && /chat_list_voices: 'sendVoice'/.test(mcp), '两个工具都受 sendVoice 开关控制');
  ok(/voice\?\.enabled !== false/.test(mcp), '注册期也检查 voice.enabled（关闭时不注册，省 token）');
  const bridge = read('src/bridge.js');
  ok(/sendVoice: 'chat_send_voice \/ chat_list_voices'/.test(bridge), 'chat_get_prompt 的 toolMap 含语音工具');
  ok(/'sendVoice'\]/.test(bridge), 'config API 的 toolFlags 含 sendVoice');
  const ex = JSON.parse(read('config.example.json'));
  // 这一段查的是**「出厂默认就该是关的」**这类契约 —— 权威声明是随仓库发布的
  // config.example.json。**刻意不查用户的 config.json**（早期版本查的是它，两个毛病）：
  //   ① 它是 .gitignore 的本机配置，全新 clone 里不存在 ⇒ 读取直接崩；
  //   ② AI 发语音是受支持的功能，用户按文档打开后，断言**用户当前状态**的测试会变红
  //      —— 测试不该因为用户用了功能而失败；
  //   ③ 用户编辑器给 config.json 写个 UTF-8 BOM 也会让裸 JSON.parse 崩
  //      （桥接自己的 readJsonSafe 有去 BOM，所以生产路径不受影响，但脚本读法粗糙）。
  // 用户当前值只提示、不判定（见下）。
  ok(ex.socialV2?.tools?.sendVoice === false, 'config.example.json: tools.sendVoice=false（出厂默认关）');
  ok(ex.socialV2?.voice?.enabled === false, 'config.example.json: voice.enabled=false（出厂默认关）');
  try {
    const local = JSON.parse(read('config.json').replace(/^\uFEFF/, ''));
    console.log(`  ℹ  你本机的值（仅供参考，不参与判定）：tools.sendVoice=${local.socialV2?.tools?.sendVoice} / voice.enabled=${local.socialV2?.voice?.enabled}`);
  } catch {
    console.log('  ℹ  本机没有 config.json（不入库）—— 本段只查随仓库发布的出厂默认');
  }
}

console.log('## 桥接语音系统：控制台与 preset');
{
  const html = read('public/console.html');
  ok(html.includes('data-v2-tool="sendVoice"'), '控制台有 sendVoice 工具开关');
  ok(html.includes('id="voiceList"') && html.includes('id="voiceSendBtn"'), '控制台有语音库调试面板');
  ok(/api\/voice\/list/.test(html) && /api\/voice\/send/.test(html), '面板调用操作者端点');
  const preset = read(path.join('dsh', 'agent-presets', 'dc-chat-v2', 'agent.cordis.yml'));
  ok(preset.includes('chat_send_voice') && preset.includes('chat_list_voices'), 'dc-chat-v2 人设描述语音能力');
  ok(/语音\*\*默认是关闭的\*\*/.test(preset), '人设说明默认关闭');
  // DSH 0.1.7 起守卫的权威实现只有一份，在 discord-agent-presets bundle 里。
  ok(read(path.join('plugins', 'discord-agent-presets', 'discord-tool-restrict.mjs')).includes("'mcp__discord__'"),
    'preset 白名单前缀放行语音工具');
}

console.log('## 文档');
{
  const voice = read(path.join('docs', 'guides', 'VOICE.md'));
  ok(voice.includes('默认是关的'), 'docs/guides/VOICE.md 提到「默认是关的」');
  const readme = read('README.md');
  ok(/AI 发语音默认关闭/.test(readme), 'README 已知限制说明默认关闭');
  ok(read('docs/README.md').includes('FOLDER_MAP.md'), 'docs/README.md 索引链接到 FOLDER_MAP.md');
  ok(exists(path.join('docs', 'FOLDER_MAP.md')), 'docs/FOLDER_MAP.md 存在');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
