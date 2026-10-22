// reserved2 提示词与插件边界的静态契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力被误删，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

test('reserved2 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量（0.2.0 还有 cwd），
  // 未知变量会让 system prompt 装配直接抛错 ⇒ 每回合 error、模型一次都不跑。
  // 这里钉住「只用已注册变量」，而不只是「有 {{model}}」。
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('local/admin tool restrictions and existing compaction budgets stay intact', () => {
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
  for (const text of ['你没有本地工具', '群友没有管理权限', 'API 令牌', '角色由桥接注入']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
});

test('snapshots are optional, partial snapshots require reading, and watermarks are not message IDs', () => {
  assert.match(prefix, /可能附带【本次消息快照】/);
  assert.match(prefix, /partial=true[^。]*继续读取/);
  assert.match(prefix, /readThroughSeq 是桥接本地的 seq，不是平台的 messageId/);
  assert.match(prefix, /没有水位[^。]*省略 throughSeq/);
  assert.match(prefix, /首次进入会话、角色变化[^。]*chat_get_prompt/);
});

test('one closing action can acknowledge the read watermark after the full observation', () => {
  assert.match(prefix, /chat_mark_read\(throughSeq=/);
  assert.match(prefix, /chat_set_wake_config\(config=[^)]*throughSeq=/);
  assert.match(prefix, /不需先 mark_read/);
  assert.match(prefix, /chat_wait_for_messages\(timeoutMs=300000\)/);
  assert.match(prefix, /短等待不能代替/);
  assert.match(prefix, /preSleepWaitRemainingMs[^。]*继续等待/);
  assert.match(prefix, /若你参与回复[^。]*重新观察/);
});

test('pre-reply quiet checks, waiting for replies and pre-sleep observation have distinct instructions', () => {
  assert.match(prefix, /先理解并处理当前消息/);
  assert.match(prefix, /【首答前】[^\n]*chat_wait_for_messages\(purpose="reply", quietMs=10000\)/);
  assert.match(prefix, /读取和思考花掉的时间也算，已安静足够就立即返回/);
  assert.match(prefix, /不要再重开一次普通长等待/);
  assert.match(prefix, /预算到但 quiet=false 不等于对方说完/);
  assert.match(prefix, /【等下文】[^\n]*purpose="messages", timeoutMs=60000~120000/);
  assert.match(prefix, /【回复后】[^\n]*chat_wait_for_messages\(purpose="messages"\)/);
  assert.match(prefix, /短静默不算沉睡前观察/);
  assert.match(prefix, /5 分钟观察不是回复的前置条件/);
  assert.match(prefix, /只有准备收尾时[^。]*preSleepWaitRemainingMs/);
});

test('social autonomy and visual, forwarding, sticker and web capabilities remain described', () => {
  for (const text of [
    '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【学习群友策略】',
    '【不要当群管家/主持人】', '普通对话默认 1 条，最多 2 条', '不要用空格断句',
    '不会自动发送到聊天', 'chat_get_message_images', 'chat_get_forward_msg', 'nestedForwardIds',
    'chat_send_poke', 'chat_list_stickers', 'chat_get_sticker_image', 'chat_send_sticker',
    'chat_collect_sticker', 'chat_sticker_note', 'chat_get_self_image',
    'chat_set_sticker_remark', '只有管理端明确开启后才能用',
    'chat_list_voices', 'chat_send_voice', 'verified=true 才代表这条语音确实落地',
    '语音**默认是关闭的**', '不要假装发了语音',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('autonomy limits and the observation escape hatch stay described', () => {
  // These rules were previously unguarded: deleting any of them left every test green.
  for (const text of [
    // 沉睡前观察唯一的逃生口：明确结束语可以跳过 5 分钟等待。
    '除非对方明确“不聊了/晚安/下了/拜拜”等结束语',
    // [SILENT] 是桥接的退出标记，误用会静默吞掉回复。
    '不要用 [SILENT]',
    // 记忆面
    '【记忆卫生】', 'chat_memory_append', 'chat_memory_query', 'chat_memory_remove', 'chat_memory_clear',
    // 黑话面
    'chat_slang_query', 'chat_slang_submit', '不重复提交',
    // 频率上限
    '普通闲聊约 3~5 轮一张', '别刷屏', '每条只能一张，不能附带文字', '不要频繁拍',
    // 会话令牌是硬前置，漏传会被拒绝。
    '作为 token 参数传入',
    // 指定成员唤醒
    'triggers.speakerIds', '不凭记忆乱填',
  ]) assert.ok(prefix.includes(text), `missing rule: ${text}`);
});

test('the Discord variant drops tools Discord lacks and keeps the shared protocol', () => {
  // dc-chat-v2 由 build-agent-preset-patches.mjs 从本预设派生（见 dc-chat-v2/derive.yml），这里读生成的 patch。
  const patch = yaml.load(fs.readFileSync(
    new URL('../plugins/qq-agent-presets/presets/dc-chat-v2.patch.yml', import.meta.url), 'utf8',
  ));
  const dcPrefix = patch[0].insert[0].config.plugins.find((row) => row.id === 'persona')?.config?.prefix ?? '';
  // 这些工具在 Discord 不注册（src/platform/capabilities.js），留着说明只会诱导模型去调。
  for (const text of [
    'chat_send_poke', 'chat_get_forward_msg', 'nestedForwardIds', 'chat_list_stickers', 'chat_get_sticker_image',
    'chat_send_sticker', 'chat_collect_sticker', 'chat_sticker_note', 'chat_set_sticker_remark',
    '拍一拍', '斗图', '[转发消息', '群名片', '语音条', 'QQ',
  ]) assert.ok(!dcPrefix.includes(text), `Discord prompt still mentions: ${text}`);
  for (const text of [
    '{{model}}', '不会自动发送到聊天', '作为 token 参数传入', 'triggers.speakerIds', '不凭记忆乱填', '不要用 [SILENT]',
    'chat_send_message', 'chat_get_prompt', 'chat_wait_for_messages', 'chat_mark_read', 'chat_set_wake_config',
    'chat_get_message_images', 'chat_get_self_image', 'chat_list_voices', 'chat_send_voice', '不要假装发了语音',
    'chat_memory_append', 'chat_slang_query', '【记忆卫生】', '【反 AI 味：拒绝有求必应】',
    '除非对方明确“不聊了/晚安/下了/拜拜”等结束语', '改服务器昵称', '【Discord 场景规则】', '不要用 Markdown 排版',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(dcPrefix.includes(text), `Discord prompt is missing: ${text}`);
  // 删掉条目后工具协议仍从 1 连续编号，不留空号。
  const protocol = dcPrefix.split('\n').find((p) => p.startsWith('【二代仿真模式 —— 工具协议'));
  const numbers = [...protocol.matchAll(/ (\d+)\. /g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1));
  assert.ok(numbers.length < prefix.split('\n').find((p) => p.startsWith('【二代仿真模式 —— 工具协议')).match(/ \d+\. /g).length);
});

console.log(`reserved2 persona prefix: ${prefix.length} characters (not a model-token estimate)`);
