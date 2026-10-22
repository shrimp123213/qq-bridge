// 测试安全版聊天 MCP server：工具清单 + 白名单发送校验
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
function currentMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8')).mode;
  } catch {
    return 'chat';
  }
}
const MODE = currentMode();
const RESERVED2 = MODE === 'reserved2';

const entry = fileURLToPath(new URL('../src/mcp-discord-safe.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ 安全 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  // 白名单外发送：应被拒绝（isError）
  const denied = await client.callTool({ name: 'chat_send_group_message', arguments: { groupId: 100003, message: '测试' } });
  console.log('🚫 白名单外发送结果:', denied.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', denied.content?.[0]?.text?.slice(0, 120));

  // 新能力：发送工具应暴露可选 replyToMessageId
  const tools2 = await client.listTools();
  const sendTool = tools2.tools.find((t) => t.name === 'chat_send_group_message');
  const schemaText = JSON.stringify(sendTool?.inputSchema ?? {});
  console.log('✅ replyToMessageId 参数:', schemaText.includes('replyToMessageId') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ chat_reply 工具:', tools2.tools.some((t) => t.name === 'chat_reply') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ chat_slang_query 工具:', tools2.tools.some((t) => t.name === 'chat_slang_query') ? '存在 ✓' : '缺失 ✗');
  console.log('✅ chat_slang_submit 工具:', tools2.tools.some((t) => t.name === 'chat_slang_submit') ? '存在 ✓' : '缺失 ✗');

  // 白名单内但 replyToMessageId 非法：应在发送前被参数校验拒绝（不会真实发消息）
  const invalidReply = await client.callTool({
    name: 'chat_send_group_message',
    arguments: { groupId: 123456789, message: '测试', replyToMessageId: 'abc' }
  });
  console.log('🚫 非法引用 id(abc) 结果:', invalidReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', invalidReply.content?.[0]?.text?.slice(0, 120));

  const zeroReply = await client.callTool({
    name: 'chat_send_group_message',
    arguments: { groupId: 123456789, message: '测试', replyToMessageId: 0 }
  });
  console.log('🚫 非法引用 id(0) 结果:', zeroReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', zeroReply.content?.[0]?.text?.slice(0, 120));

  // Discord 消息 id 是超过 2^53 的雪花 id，必须以字符串原样通过参数校验
  // （这里用白名单外频道，应被白名单拦截而非参数拦截）
  const snowflakeReply = await client.callTool({
    name: 'chat_send_group_message',
    arguments: { groupId: 100003, message: '测试', replyToMessageId: '1234567890123456789' }
  });
  const snowText = snowflakeReply.content?.[0]?.text ?? '';
  console.log('🚫 雪花 id + 白名单外 结果:', snowflakeReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', snowText.slice(0, 120), '| 校验阶段:', snowText.includes('白名单') ? '白名单（参数已通过）' : (RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数'));

  // 专用引用工具 chat_reply：白名单外 + 雪花 id 应被白名单拦截（参数已通过）
  const replyDenied = await client.callTool({
    name: 'chat_reply',
    arguments: { groupId: 100003, replyToMessageId: '1234567890123456789', message: '测试' }
  });
  const replyText = replyDenied.content?.[0]?.text ?? '';
  console.log('🚫 chat_reply 白名单外 结果:', replyDenied.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', replyText.slice(0, 120), '| 校验阶段:', replyText.includes('白名单') ? '白名单（参数已通过）' : (RESERVED2 ? 'token/模式（reserved2 要求 agent token）' : '参数'));

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
