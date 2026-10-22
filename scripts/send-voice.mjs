#!/usr/bin/env node
// 快速把「准备好的音频」当音频附件发到指定 Discord 频道/私信。
//
// 用法（在仓库根目录下执行）：
//   node scripts/send-voice.mjs list                       # 白名单里有哪些频道/私信可发
//   node scripts/send-voice.mjs list-voice                 # 语音库里有哪些音频
//   node scripts/send-voice.mjs send <音频> <目标> [选项]   # 发一条语音
//   node scripts/send-voice.mjs check <音频>               # 只探测音频（不发送）
//   node scripts/send-voice.mjs status                     # 桥接与 Discord 连接状态
//
// 目标写法：`group:频道id` | `private:用户id` | 纯数字（在白名单里唯一命中时）
//
// 设计：一律走桥接的 /api/voice/send —— 白名单、限流、审计、发送链路都在桥接里，
// 与 AI 用的工具完全同一条路径（避免 CLI 成为绕过闸门的后门）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles,
  parseTargetKey, resolveAudioSource
} from '../src/send-voice-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags.set(k, v);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags.set(k, argv[++i]); }
    else flags.set(k, true);
  } else if (a.startsWith('-') && a.length > 1) {
    const [k, v] = a.slice(1).split('=');
    flags.set(k, v ?? true);
  } else positional.push(a);
}

const has = (k) => flags.has(k);
const val = (k, d = undefined) => (flags.has(k) ? (flags.get(k) === true ? '' : String(flags.get(k))) : d);
const num = (k, d) => {
  if (!flags.has(k)) return d;
  const n = Number(flags.get(k));
  return Number.isFinite(n) ? n : d;
};

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();
const consolePort = Number(val('console-port', cfg.consolePort)) || 3100;
const consoleToken = String(
  val('console-token', cfg.consoleToken || process.env.BRIDGE_CONSOLE_TOKEN || readConsoleTokenFile() || '')
).trim();
const voiceDir = path.resolve(val('voice-dir', cfg.voice?.dir ? path.resolve(ROOT, cfg.voice.dir) : path.join(ROOT, 'audio')));
const revealToken = has('reveal-token');
const quiet = has('q') || has('quiet');

function readConsoleTokenFile() {
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const maskToken = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}（${t.length} 字符）` : '(未配置)');
const out = (...a) => { if (!quiet) console.log(...a); };
const fail = (msg, code = 1) => { console.error(`❌ ${msg}`); process.exit(code); };

async function bridgeApi(pathname, init = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(init.headers ?? {})
  };
  const res = await fetch(`http://127.0.0.1:${consolePort}${pathname}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? 60000)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── 目标表和解析 ────────────────────────────────────────────────────────────
function allowedSet() {
  const allow = cfg.allow ?? {};
  const deny = cfg.deny ?? {};
  return {
    groups: new Set((allow.groups ?? []).map(String)),
    private: new Set((allow.private ?? []).map(String)),
    denyGroups: new Set((deny.groups ?? []).map(String)),
    denyPrivate: new Set((deny.private ?? []).map(String)),
    allowAllWhenEmpty: cfg.allowAllWhenEmpty === true
  };
}

function isAllowedKey(key) {
  const t = parseTargetKey(key);
  if (!t) return false;
  const a = allowedSet();
  if (t.kind === 'group') {
    if (a.denyGroups.has(t.id)) return false;
    if (a.groups.size > 0) return a.groups.has(t.id);
    return a.allowAllWhenEmpty;
  }
  if (a.denyPrivate.has(t.id)) return false;
  if (a.private.size > 0) return a.private.has(t.id);
  return a.allowAllWhenEmpty;
}

/**
 * 把用户输入解析成目标 key。
 * 支持：group:123 / private:123 / 纯数字（只在白名单里唯一命中时才认）。
 */
function resolveTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) fail('缺少目标（group:频道id / private:用户id）');

  const direct = parseTargetKey(raw);
  if (direct) return direct;

  if (/^\d+$/.test(raw)) {
    // 纯数字：频道 id 与用户 id 长得一样，只在白名单里唯一命中时才替你猜
    const a = allowedSet();
    const hits = [];
    if (a.groups.has(raw)) hits.push({ kind: 'group', id: raw, key: `group:${raw}` });
    if (a.private.has(raw)) hits.push({ kind: 'private', id: raw, key: `private:${raw}` });
    if (hits.length === 1) return hits[0];
  }
  fail(`无法确定「${raw}」是频道还是私信，请写成 group:频道id 或 private:用户id`);
}

// ── 子命令 ──────────────────────────────────────────────────────────────────
async function cmdList() {
  const a = allowedSet();
  console.log('【频道】（config.json allow.groups）');
  if (!a.groups.size) console.log('  (空)');
  for (const id of a.groups) console.log(`  group:${id}${a.denyGroups.has(id) ? '  ⛔ 同时在 deny 里' : ''}`);
  console.log('\n【私信】（config.json allow.private）');
  if (!a.private.size) console.log('  (空)');
  for (const id of a.private) console.log(`  private:${id}${a.denyPrivate.has(id) ? '  ⛔ 同时在 deny 里' : ''}`);
  if (a.allowAllWhenEmpty) console.log('\n⚠️ allowAllWhenEmpty=true：白名单为空时全部放行');
  const first = a.groups.values().next().value;
  console.log(`\n发送示例：node scripts/send-voice.mjs send "<音频文件>" ${first ? `group:${first}` : 'private:<用户id>'}`);
}

async function cmdListVoice() {
  if (!fs.existsSync(voiceDir)) {
    console.log(`语音库目录不存在：${voiceDir}`);
    console.log('（把音频放进去，或用 --voice-dir 指定别的目录；也可以 send 时直接给任意路径）');
    return;
  }
  const files = listAudioFiles(voiceDir);
  console.log(`语音库：${voiceDir}`);
  if (files.length === 0) {
    console.log('（目录为空 —— 把 .mp3/.wav/.ogg/.m4a 等音频放进来即可）');
    return;
  }
  console.log(`共 ${files.length} 个音频：\n`);
  const probe = !has('no-probe');
  for (const f of files) {
    const rel = path.relative(voiceDir, f);
    if (!probe) {
      console.log(`  ${rel}  (${formatBytes(fs.statSync(f).size)})`);
      continue;
    }
    const info = await inspectAudio(f, { maxBytes: Infinity, maxSeconds: Infinity });
    console.log(`  ${rel.padEnd(34)} ${describeAudio({ size: info.size, duration: info.duration, codec: info.codec })}`);
  }
  console.log(`\n发送示例：node scripts/send-voice.mjs send "${path.relative(voiceDir, files[0])}" <目标>`);
}

async function cmdStatus() {
  console.log(`配置文件：${CONFIG_PATH}`);
  console.log(`  桥接控制台         = http://127.0.0.1:${consolePort}`);
  console.log(`  consoleToken       = ${revealToken ? consoleToken : maskToken(consoleToken)}`);
  console.log(`  语音库目录         = ${voiceDir}`);
  try {
    const st = await bridgeApi('/api/status');
    console.log(`\n✅ 桥接在线：mode=${st.mode ?? '?'} role=${st.role ?? '?'} dshReady=${st.dshReady ?? '?'} paused=${st.socialV2Paused ?? '?'}`);
    if (st.discord) {
      console.log(st.discord.connected
        ? `✅ Discord 已连接${st.discord.pingMs != null ? `（延迟 ${st.discord.pingMs}ms）` : ''}`
        : `❌ Discord 未连接${st.discord.lastError ? `：${st.discord.lastError}` : ''}`);
    }
  } catch (error) {
    console.log(`\n⚠️ 桥接不可达（http://127.0.0.1:${consolePort}）：${error?.message ?? error}`);
    console.log('   → 发送语音需要桥接在线（它负责白名单/限流/审计与 Discord 连接）。');
  }
}

async function cmdCheck() {
  const src = positional[1];
  if (!src) fail('用法：node scripts/send-voice.mjs check <音频文件>');
  const r = resolveAudioSource(src, { voiceDir });
  if (!r.path) {
    const hint = r.candidates.length ? `\n   语音库里的近似匹配：${r.candidates.map((c) => path.relative(voiceDir, c.path)).join('、')}` : '';
    fail(`找不到音频「${src}」${hint}`);
  }
  const info = await inspectAudio(r.path, {
    maxBytes: num('max-bytes', undefined) ?? undefined,
    maxSeconds: num('max-seconds', undefined) ?? undefined,
    ffprobePath: val('ffprobe', process.env.FFPROBE_PATH || 'ffprobe')
  });
  console.log(`音频：${r.path}`);
  console.log(`  来源：${r.via}`);
  console.log(`  信息：${describeAudio(info)}`);
  if (info.formatName) console.log(`  容器：${info.formatName}`);
  for (const w of info.warnings ?? []) console.log(`  ⚠️ ${w}`);
  if (!info.ok) fail(info.error);
  console.log('\n✅ 音频可用于发送');
}

async function cmdSend() {
  const src = positional[1];
  const targetInput = positional[2] ?? val('to', '');
  if (!src) fail('用法：node scripts/send-voice.mjs send <音频文件> <目标> [--dry-run]');
  if (!targetInput) fail('缺少目标：group:频道id / private:用户id');

  const r = resolveAudioSource(src, { voiceDir });
  if (!r.path) {
    const hint = r.candidates.length ? `\n   语音库里的近似匹配：${r.candidates.map((c) => path.relative(voiceDir, c.path)).join('、')}` : '';
    fail(`找不到音频「${src}」${hint}`);
  }
  const info = await inspectAudio(r.path, {
    maxBytes: num('max-bytes', undefined) ?? undefined,
    maxSeconds: num('max-seconds', undefined) ?? undefined
  });
  if (!info.ok) fail(info.error);

  const target = resolveTarget(targetInput);
  const allowed = isAllowedKey(target.key);
  const dryRun = has('dry-run') || has('n');

  console.log('─'.repeat(60));
  console.log(`音频  : ${r.path}`);
  console.log(`        ${describeAudio(info)}${info.formatName ? ` · ${info.formatName}` : ''}`);
  console.log(`目标  : ${target.kind === 'group' ? '频道' : '私信'} ${target.key}`);
  console.log(`白名单: ${allowed ? '✅ 命中' : '⛔ 未命中'}${has('force') ? '（--force 已指定，仍会被桥接拒绝）' : ''}`);
  for (const w of info.warnings ?? []) console.log(`⚠️  ${w}`);
  console.log('─'.repeat(60));

  if (dryRun) {
    // 走桥接的 dry-run：把「桥接会怎么判」原样跑一遍（白名单/限流/尺寸/时长），只是不落消息。
    // 桥接不可达时退回本地判断，保证离线也能做参数检查。
    try {
      const data = await bridgeApi('/api/voice/send', {
        method: 'POST',
        body: JSON.stringify({ target: target.key, file: r.path, dryRun: true })
      });
      console.log('DRY-RUN（经桥接校验）：未发送。');
      if (data?.limits) {
        console.log(`  桥接上限：时长 ≤ ${formatDuration(data.limits.maxSeconds)} · 体积 ≤ ${formatBytes(data.limits.maxBytes)} · ${data.limits.maxPerMinute}/分钟 · ${data.limits.maxPerHour}/小时`);
      }
      console.log(`  桥接解析：${data?.file ?? r.path}`);
      return;
    } catch (error) {
      if (error?.status === 404) {
        console.log('⚠️  桥接还没有 /api/voice/send 端点（需重启桥接）；以下为本地校验结果。');
      } else {
        console.log(`⚠️  桥接校验不可用（${error?.message ?? error}）；以下为本地校验结果。`);
      }
    }
    console.log('DRY-RUN：未发送。去掉 --dry-run 即真发。');
    return;
  }
  if (!allowed) {
    fail(`目标 ${target.key} 不在白名单（config.json allow.groups/allow.private），请先把目标加进白名单。`);
  }

  let result;
  try {
    result = await bridgeApi('/api/voice/send', {
      method: 'POST',
      body: JSON.stringify({
        target: target.key,
        file: r.path,
        dryRun: false,
        verify: !has('no-verify'),
        // 音量交给桥接处理（与前端面板、图形界面同一条路径）
        volume: has('volume') ? Number(val('volume')) : 1,
        normalize: has('normalize'),
        loudness: has('loudness') ? String(val('loudness')) : 'normal',
        source: 'cli'
      }),
      timeoutMs: 240000
    });
  } catch (error) {
    if (error?.status === 404) {
      fail('桥接还没有 /api/voice/send 端点（需要重启桥接加载新版本 bridge.js）。');
    }
    fail(`发送失败：${error?.message ?? error}`);
  }

  console.log(`✅ 已作为音频附件发出（messageId=${result?.messageId ?? '未知'}）`);
  if (result?.detail) console.log(`   ${result.detail}`);
  if (result?.audioProcessing && result.audioProcessing !== '原始音量') {
    console.log(`   🔊 ${result.audioProcessing}`);
  }
  if (result && 'verified' in result) {
    console.log(result.verified
      ? '   ✅ 已回读校验：Discord 上这条消息带着音频附件'
      : '   ⚠️ 未能回读校验（消息应已发出，但没读回音频附件；可在 Discord 里肉眼确认）');
  }
}

function usage() {
  console.log(`把准备好的音频当音频附件发到 Discord（经桥接）

用法：
  node scripts/send-voice.mjs list                       列出白名单里可发的频道/私信
  node scripts/send-voice.mjs list-voice [--no-probe]    列出语音库里的音频
  node scripts/send-voice.mjs check <音频>              只探测音频（时长/大小/编码）
  node scripts/send-voice.mjs send <音频> <目标> [选项]   发送语音
  node scripts/send-voice.mjs status                     桥接 + Discord 连接 + 配置状态

目标写法：
  group:<频道id> / private:<用户id> / 纯数字（在白名单里唯一命中时）

send 选项：
  --dry-run        只解析不发送（走桥接的真实校验路径）
  --volume 2       音量倍数（0.1~4，1 = 原样）；手机外放听不清就调到 2~3
  --normalize      智能音量：按 EBU R128 把整体响度拉到目标（录音忽大忽小时最有效）
  --loudness loud  智能音量档位：quiet(-20) / normal(-16) / loud(-13)，默认 normal
  --no-verify      跳过发送后的回读校验（默认会回读确认音频附件真的落地）
  --voice-dir DIR  指定语音库目录（默认 config.voice.dir 或 <repo>/audio）
  --max-seconds N  时长上限（默认 300）
  --max-bytes N    体积上限（默认 20MiB）
  --reveal-token   在 status 里显示完整令牌（默认打码）
`);
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const cmd = positional[0] || 'list';
try {
  switch (cmd) {
    case 'list': case 'ls': await cmdList(); break;
    case 'list-voice': case 'voices': await cmdListVoice(); break;
    case 'check': case 'probe': await cmdCheck(); break;
    case 'send': case 'voice': await cmdSend(); break;
    case 'status': await cmdStatus(); break;
    case 'help': case '-h': case '--help': usage(); break;
    default:
      console.error(`未知命令：${cmd}\n`);
      usage();
      process.exit(2);
  }
} catch (error) {
  fail(error?.stack && has('debug') ? error.stack : (error?.message ?? String(error)));
}
