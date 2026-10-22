// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, Discord connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as truncate from '../src/truncate-text.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as slang from '../src/slang-learner.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as stateAcl from '../src/state-acl.mjs';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {}, platform: platformOverrides = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerId: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], voices: [], confirms: [] };
  // 假的 Discord 适配层：接口与 src/platform/discord.js 的返回对象一致，只记账不联网。
  // getMessage 从 messages 里取（测试用 h.messages.set(id, inbound) 预置被引用的消息）；
  // 单个方法可用 bridgeHarness({ platform: { … } }) 覆盖。
  const messages = new Map();
  const members = [
    { userId: '111', nickname: '小明', card: '小明', role: 'member' },
    { userId: '222', nickname: '路人', card: '' },
    { userId: '123', nickname: '管理员', card: '服务器主', role: 'owner' }
  ];
  let nextMessageId = 9000;
  const fakePlatform = {
    client: null,
    start() {},
    onMessage(handler) { fakePlatform.messageHandler = handler; },
    onReady() {},
    healthSnapshot: () => ({ connected: true, lastEventAgoMs: 0, lastEventKind: 'READY', pingMs: 42, lastError: null }),
    async sendText(kind, id, text) {
      calls.sent.push({ kind, id, text });
      return { messageId: String(++nextMessageId) };
    },
    async sendMessage(kind, id, { replyTo = null, mentionUserId = null, text = '', image = null } = {}) {
      calls.sent.push({ kind, id, text, replyTo, mentionUserId, ...(image ? { image } : {}) });
      return { messageId: String(++nextMessageId) };
    },
    async sendVoice(kind, id, file) {
      calls.voices.push({ kind, id, file });
      return { messageId: String(++nextMessageId) };
    },
    async getSelfInfo() { return { userId: '999', nickname: 'fixture-bot' }; },
    async getMessage(messageId) { return messages.get(String(messageId)) ?? null; },
    async getGroupMemberList() { return members.map((m) => ({ ...m })); },
    async getGroupMemberInfo(channelId, userId) {
      const hit = members.find((m) => m.userId === String(userId));
      return hit ? { ...hit } : null;
    },
    async confirmVoiceSent(messageId) {
      calls.confirms.push(String(messageId));
      return { confirmed: true, duration: 3 };
    },
    ...platformOverrides,
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 discord-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerId 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  const stripImports = (src) => src.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  let source = stripImports(fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8'));
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  platform.onMessage((msg) => handleIncoming(msg, cfg));', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToChat, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchImageMedia, fetchMediaData, resolveMediaList,
    getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  platform.onMessage((msg) => handleIncoming(msg, cfg));`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    // 桥接自己不直接 fetch（图片走 safeFetchBuffer 注入的桩）；真有漏网的请求就让它当场失败。
    fetch: async (url) => { throw new Error(`unexpected fetch in audit harness: ${url}`); },
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    createDiscordPlatform: () => fakePlatform,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...truncate, ...sensitive, ...wait, ...safeFetch, ...slang,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'dc-chat', 'dc-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, platform: fakePlatform, messages, members, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
