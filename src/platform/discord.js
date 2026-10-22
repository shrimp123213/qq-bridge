// Discord 平台适配层（discord.js v14，bot 账号）。
//
// 接口与 QQ 适配层（./qq-onebot.js 顶部的说明）一致，bridge.js 不需要知道对面是哪个平台。
// 这里只记 Discord 自己的映射规则：
//
//   会话：服务器里的文字频道（含讨论串）→ kind='group'，conversationId = 频道 id；
//         私信 → kind='private'，conversationId = 对方的用户 id（与 QQ 私聊用 QQ 号一致）。
//         所以 config.json 的 allow.groups 填频道 id，allow.private / ownerQQ 填用户 id。
//   发送者：nickname = 全局显示名（没有就用用户名），card = 服务器昵称（相当于 QQ 群名片）。
//   消息内容 → OneBot 消息段：
//     <@id> / <@!id>        → at{qq:id}
//     <@&机器人身份组>       → at{qq:机器人 id}（在 Discord 里点「@机器人」常常选到的是它的身份组）
//     <@&其它身份组>         → 文字「@身份组名」
//     <#频道>               → 文字「#频道名」
//     @everyone / @here     → 真的提及了全体才是 at{qq:'all'}，否则保留原文
//     <:名字:id> 自定义表情 → mface{summary, url}
//     贴纸                  → mface{summary, url}（Lottie 动画贴纸没有位图，只留文字）
//     附件                  → image / record（含语音消息）/ video / file{name}
//     回复                  → reply{id}（只认同一频道内的回复）
//     转发（message snapshot）→ 文字「[转发] 」加上被转发消息的内容
//   出站：
//     · 只有 sendMessage 的 mentionUserId 会真的提醒到人；文本里的 @everyone、身份组、
//       其它 <@id> 一律不提醒（allowedMentions），对应 QQ 那边「禁止 @全体」的约束。
//     · 单条超过 2000 字（Discord 上限）时按换行/空格切成几条连发，引用只挂在第一条上。
//     · 语音以音频附件发出（不是 Discord 的「语音消息」格式，那需要 OGG/Opus 与波形数据）。
//   做不到的（能力表见 ./capabilities.js，对应的 MCP 工具不会注册）：
//     拍一拍、QQ 式合并转发、收藏表情库、语音转文字。
//
// Developer Portal 里必须打开 Message Content Intent；discord.guildMembersIntent=true 时
// 还要打开 Server Members Intent（用来拉完整的成员列表；不开就只认得发过言的人）。
import path from 'node:path';
import {
  Client,
  Events,
  GatewayCloseCodes,
  GatewayIntentBits,
  MessageFlags,
  MessageReferenceType,
  MessageType,
  Partials,
  PermissionFlagsBits,
  StickerFormatType
} from 'discord.js';

const idOrNull = (value) => (value === undefined || value === null || value === '' ? null : String(value));

// Discord 单条消息正文的上限
const DISCORD_MAX_CONTENT = 2000;

// 只收普通消息与回复；加入服务器、置顶、讨论串开启这类系统消息不进桥接。
const ACCEPTED_MESSAGE_TYPES = new Set([MessageType.Default, MessageType.Reply]);

// ── 入站正规化：discord.js Message → 桥接内部格式 ──────────────────────────
// 只读 Message 上的普通字段（不调方法），测试可以直接喂形状相同的普通对象。

const CONTENT_TOKEN_RE = /<@!?(\d{1,20})>|<@&(\d{1,20})>|<#(\d{1,20})>|<(a?):([A-Za-z0-9_~]{1,32}):(\d{1,20})>|@(everyone|here)/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

// Collection / Map / 数组都按「值的列表」读
function valuesOf(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === 'function') return [...collection.values()];
  return [];
}

function lookupName(collection, id) {
  const hit = collection?.get?.(id);
  return hit?.name ? String(hit.name) : '';
}

function contentToSegments(content, mentions, ctx) {
  const segments = [];
  const pushText = (text) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last?.type === 'text') last.data.text += text;
    else segments.push({ type: 'text', data: { text } });
  };
  const source = String(content ?? '');
  let cursor = 0;
  for (const m of source.matchAll(CONTENT_TOKEN_RE)) {
    pushText(source.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    if (m[1]) {
      segments.push({ type: 'at', data: { qq: m[1] } });
    } else if (m[2]) {
      if (ctx.selfId && ctx.selfRoleIds.includes(m[2])) segments.push({ type: 'at', data: { qq: ctx.selfId } });
      else pushText(`@${lookupName(mentions?.roles, m[2]) || '身份组'}`);
    } else if (m[3]) {
      pushText(`#${lookupName(mentions?.channels, m[3]) || '频道'}`);
    } else if (m[6]) {
      segments.push({ type: 'mface', data: { summary: m[5], url: `https://cdn.discordapp.com/emojis/${m[6]}.${m[4] ? 'gif' : 'png'}` } });
    } else if (m[7]) {
      // 没有权限的人打出来的 @everyone 只是普通文字，不算提及全体
      if (mentions?.everyone === true) segments.push({ type: 'at', data: { qq: 'all' } });
      else pushText(m[0]);
    }
  }
  pushText(source.slice(cursor));
  return segments;
}

function attachmentToSegment(attachment, isVoiceMessage) {
  const contentType = String(attachment?.contentType ?? '').toLowerCase();
  const name = String(attachment?.name ?? '');
  const url = String(attachment?.url ?? '');
  if (isVoiceMessage || contentType.startsWith('audio/')) return { type: 'record', data: { file: name, url } };
  if (contentType.startsWith('image/') || (!contentType && IMAGE_EXT_RE.test(name))) {
    return { type: 'image', data: { file: name, url, summary: '' } };
  }
  if (contentType.startsWith('video/')) return { type: 'video', data: { file: name, url } };
  return { type: 'file', data: { name } };
}

// 正文 + 贴纸 + 附件（转发的快照也走这里）
function bodySegments(message, ctx) {
  const segments = contentToSegments(message?.content, message?.mentions, ctx);
  for (const sticker of valuesOf(message?.stickers)) {
    const name = String(sticker?.name ?? '');
    if (sticker?.format === StickerFormatType.Lottie || !sticker?.url) {
      segments.push({ type: 'text', data: { text: `[贴纸${name ? `:${name}` : ''}]` } });
    } else {
      segments.push({ type: 'mface', data: { summary: name, url: String(sticker.url) } });
    }
  }
  const isVoiceMessage = message?.flags?.has?.(MessageFlags.IsVoiceMessage) === true;
  for (const attachment of valuesOf(message?.attachments)) {
    segments.push(attachmentToSegment(attachment, isVoiceMessage));
  }
  return segments;
}

/**
 * discord.js Message → InboundMessage。
 * @param {object} ctx - { selfId, selfRoleIds }：机器人自己的用户 id 与它在该服务器的身份组 id
 */
export function toInboundMessage(message, { selfId = null, selfRoleIds = [] } = {}) {
  const ctx = { selfId: idOrNull(selfId), selfRoleIds: selfRoleIds.map(String) };
  const authorId = idOrNull(message?.author?.id);
  const kind = message?.guildId ? 'group' : 'private';
  // 私信的会话对象是「对方」：读回机器人自己发的私信时，对方是频道的 recipient。
  const peerId = authorId !== null && authorId === ctx.selfId ? idOrNull(message?.channel?.recipientId) : authorId;

  const segments = [];
  const ref = message?.reference;
  if (ref?.messageId
    && (ref.type ?? MessageReferenceType.Default) === MessageReferenceType.Default
    && (!ref.channelId || String(ref.channelId) === String(message.channelId))) {
    segments.push({ type: 'reply', data: { id: String(ref.messageId) } });
  }
  segments.push(...bodySegments(message, ctx));
  for (const snapshot of valuesOf(message?.messageSnapshots)) {
    segments.push({ type: 'text', data: { text: '[转发] ' } }, ...bodySegments(snapshot, ctx));
  }

  return {
    kind,
    conversationId: kind === 'group' ? idOrNull(message?.channelId) : peerId,
    messageId: idOrNull(message?.id),
    messageSeq: null,
    sender: {
      userId: authorId,
      nickname: String(message?.author?.globalName || message?.author?.username || ''),
      card: String(message?.member?.nickname ?? '')
    },
    selfId: ctx.selfId,
    segments
  };
}

/** 按 Discord 的 2000 字上限切分正文：优先在换行处切，其次空格，实在没有就硬切（不拆代理对）。 */
export function splitContent(text, max = DISCORD_MAX_CONTENT) {
  const chunks = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, '');
  }
  chunks.push(rest);
  return chunks;
}

function imageFileName(buffer) {
  if (buffer?.length >= 12) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image.png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image.jpg';
    if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image.gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image.webp';
  }
  return 'image.png';
}

function unsupported(what) {
  return new Error(`Discord 不支持${what}`);
}

/**
 * @param {object} options
 * @param {object} options.cfg - 桥接的运行配置（读 cfg.discord.token / guildMembersIntent）
 * @param {Function} options.log - 桥接的日志函数
 * @param {object} [options.client] - 测试用：注入一个假的 discord.js Client
 */
export function createDiscordPlatform({ cfg, log, client: injectedClient = null }) {
  const membersIntent = cfg.discord?.guildMembersIntent === true;
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ];
  if (membersIntent) intents.push(GatewayIntentBits.GuildMembers);
  // 私信频道不在缓存里，收私信必须开 Channel partial
  const client = injectedClient ?? new Client({ intents, partials: [Partials.Channel] });

  let messageHandler = null;
  let readyHandler = null;
  let readyOnce = false;

  // ── 消息 id → 频道 id ──────────────────────────────────────────────────────
  // Discord 按「频道 + 消息 id」读消息，而 confirmVoiceSent 之类的接口只给消息 id。
  // 见过的消息（收到的、自己发的）都记一笔，有界，最旧的先丢。
  const MESSAGE_CHANNEL_CACHE_MAX = 5000;
  const messageChannels = new Map();
  function rememberMessage(messageId, channelId) {
    if (!messageId || !channelId) return;
    const key = String(messageId);
    messageChannels.delete(key);
    messageChannels.set(key, String(channelId));
    if (messageChannels.size > MESSAGE_CHANNEL_CACHE_MAX) messageChannels.delete(messageChannels.keys().next().value);
  }

  // ── 健康状态（给 /api/status 与控制台）────────────────────────────────────
  const health = { connected: false, lastEventAt: 0, lastEventKind: '', lastError: '' };
  function noteEvent(kind) {
    health.lastEventAt = Date.now();
    health.lastEventKind = kind;
  }
  function healthSnapshot() {
    return {
      platform: 'discord',
      connected: health.connected,
      accountOnline: health.connected,
      good: null,
      goodSource: null,
      goodError: health.lastError || null,
      lastPacketAgoMs: health.lastEventAt ? Date.now() - health.lastEventAt : null,
      lastPacketKind: health.lastEventKind || null,
      pingMs: Number.isFinite(client.ws?.ping) && client.ws.ping >= 0 ? client.ws.ping : null,
      silent: false,
      degraded: false,
      hint: null
    };
  }

  // ── 会话 → 频道 ───────────────────────────────────────────────────────────
  async function resolveChannel(kind, id) {
    if (kind === 'private') {
      const user = await client.users.fetch(String(id));
      return user.createDM();
    }
    const channel = await client.channels.fetch(String(id));
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.()) {
      throw new Error(`Discord 频道 ${id} 不存在，或不是服务器里的文字频道`);
    }
    return channel;
  }

  async function guildChannel(channelId) {
    const channel = await resolveChannel('group', channelId);
    if (!channel.guild) throw new Error(`Discord 频道 ${channelId} 不属于任何服务器`);
    return channel;
  }

  // ── 发送 ───────────────────────────────────────────────────────────────────
  // 返回 { message_id }（第一条的 id），与 OneBot 发送接口的 data 同形。
  async function sendPayloads(kind, id, { content = '', replyTo = null, mentionUserId = null, files = null } = {}) {
    const channel = await resolveChannel(kind, id);
    const mention = mentionUserId !== null && mentionUserId !== undefined ? String(mentionUserId) : null;
    const body = `${mention ? `<@${mention}> ` : ''}${String(content ?? '')}`;
    const chunks = splitContent(body);
    let firstId = null;
    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        // 只提醒调用方明确点名的那一个人；文本里的 @everyone / 身份组 / 其它 <@id> 都不提醒。
        allowedMentions: { parse: [], users: mention ? [mention] : [], repliedUser: true }
      };
      if (chunks[i]) payload.content = chunks[i];
      if (i === 0 && replyTo !== null && replyTo !== undefined) {
        payload.reply = { messageReference: String(replyTo), failIfNotExists: false };
      }
      if (i === 0 && files) payload.files = files;
      if (!payload.content && !payload.files) continue;
      const sent = await channel.send(payload);
      rememberMessage(sent?.id, sent?.channelId ?? channel.id);
      if (firstId === null) firstId = idOrNull(sent?.id);
    }
    return { message_id: firstId };
  }

  function sendText(kind, id, content) {
    return sendPayloads(kind, id, { content });
  }

  // replyTo / mentionUserId 由调用方校验过格式；image 与 text 二选一，image 优先（与 QQ 一致）。
  function sendMessage(kind, id, { replyTo = null, mentionUserId = null, text: content = '', image = null } = {}) {
    if (image) {
      return sendPayloads(kind, id, { replyTo, mentionUserId, files: [{ attachment: image, name: imageFileName(image) }] });
    }
    return sendPayloads(kind, id, { replyTo, mentionUserId, content });
  }

  function sendVoice(kind, id, file) {
    return sendPayloads(kind, id, { files: [{ attachment: String(file), name: path.basename(String(file)) }] });
  }

  async function poke() {
    throw unsupported('拍一拍');
  }

  // ── 查询 ───────────────────────────────────────────────────────────────────
  async function getSelfInfo() {
    const user = client.user;
    if (!user) return null;
    return { userId: idOrNull(user.id), nickname: String(user.globalName || user.username || '') };
  }

  function selfContext(message) {
    const botRoleId = message?.guild?.members?.me?.roles?.botRole?.id;
    return { selfId: client.user?.id ?? null, selfRoleIds: botRoleId ? [String(botRoleId)] : [] };
  }

  async function fetchMessage(messageId, where = {}) {
    const id = String(messageId ?? '');
    if (!/^\d{1,20}$/.test(id)) return null;
    let channel = null;
    if (where.kind && where.conversationId) {
      channel = await resolveChannel(where.kind, where.conversationId);
    } else if (messageChannels.has(id)) {
      channel = await client.channels.fetch(messageChannels.get(id));
    }
    if (!channel?.messages) return null;
    const message = await channel.messages.fetch(id);
    if (message) rememberMessage(message.id, message.channelId);
    return message ?? null;
  }

  // where = { kind, conversationId }：Discord 的消息只能在所属频道里读，所以要带上会话；
  // 没带时只能读最近见过的消息（rememberMessage 记下的那些）。
  async function getMessage(messageId, where = {}) {
    try {
      const message = await fetchMessage(messageId, where);
      return message ? toInboundMessage(message, selfContext(message)) : null;
    } catch (error) {
      // 10008 Unknown Message / 50001 Missing Access：当作读不到，交给调用方按「无法解析」处理
      if (error?.code === 10008 || error?.code === 50001) return null;
      throw error;
    }
  }

  // Discord 的图片段都带 url，桥接直接按 url 下载，这里不需要网关缓存。
  async function getImage() {
    return null;
  }

  // Discord 没有 QQ 的系统小表情（face 段）
  async function getFace() {
    return null;
  }

  async function getForwardMessage() {
    throw unsupported('QQ 式合并转发');
  }

  function memberRole(guild, member) {
    if (guild?.ownerId && String(guild.ownerId) === String(member.id)) return 'owner';
    if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return 'admin';
    return 'member';
  }

  // OneBot 成员信息的形状（user_id / nickname / card / role），bridge.js 按这个读。
  function toMemberInfo(guild, member) {
    return {
      user_id: String(member.id),
      nickname: String(member.user?.globalName || member.user?.username || ''),
      card: String(member.nickname ?? ''),
      role: memberRole(guild, member)
    };
  }

  // 完整成员列表要 Server Members Intent；拉一次很重，同一服务器 5 分钟内只拉一次。
  const MEMBER_FETCH_TTL_MS = 5 * 60 * 1000;
  const memberFetchedAt = new Map();
  async function refreshGuildMembers(guild) {
    if (!membersIntent) return;
    const last = memberFetchedAt.get(guild.id) ?? 0;
    if (Date.now() - last < MEMBER_FETCH_TTL_MS) return;
    try {
      await guild.members.fetch();
      memberFetchedAt.set(guild.id, Date.now());
    } catch (error) {
      log(`拉取 Discord 服务器成员失败（改用已缓存的成员）：${error?.message ?? error}`);
    }
  }

  // 「群成员」= 能看到这个频道的服务器成员
  async function getGroupMemberList(channelId) {
    const channel = await guildChannel(channelId);
    const guild = channel.guild;
    await refreshGuildMembers(guild);
    return valuesOf(guild.members.cache)
      .filter((member) => channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel))
      .map((member) => toMemberInfo(guild, member));
  }

  async function getGroupMemberInfo(channelId, userId) {
    const channel = await guildChannel(channelId);
    const member = await channel.guild.members.fetch(String(userId)).catch(() => null);
    return member ? toMemberInfo(channel.guild, member) : null;
  }

  async function getGroupMemberListWithFallback(channelId) {
    return { status: 'ok', retcode: 0, data: await getGroupMemberList(channelId) };
  }

  // 语音是以音频附件发的：读回这条消息、确认附件还在，就算落地。
  async function confirmVoiceSent(messageId) {
    const message = await fetchMessage(messageId).catch(() => null);
    const attachment = valuesOf(message?.attachments)[0];
    if (!attachment) return null;
    return { confirmed: true, duration: Number.isFinite(attachment.duration) ? attachment.duration : null };
  }

  async function voiceToText() {
    return null;
  }

  async function fetchStickerLibrary() {
    throw unsupported('收藏表情库');
  }

  async function addSticker() {
    throw unsupported('收藏表情库');
  }

  async function setStickerRemark() {
    throw unsupported('收藏表情库');
  }

  // ── 连接与事件 ─────────────────────────────────────────────────────────────
  function onMessage(handler) { messageHandler = handler; }
  function onPoke() {} // Discord 没有拍一拍，永不触发
  function onReady(handler) { readyHandler = handler; }

  // token 无效、intent 没开这两种情况重试也没用，直接说清楚怎么修。
  async function login(attempt = 0) {
    const token = String(cfg.discord?.token ?? '').trim();
    if (!token) {
      log('⚠️ config.json 的 discord.token 为空：不会连接 Discord');
      return;
    }
    try {
      await client.login(token);
    } catch (error) {
      health.lastError = error?.message ?? String(error);
      if (error?.code === 'TokenInvalid') {
        log('❌ Discord bot token 无效：请到 Developer Portal → Bot 重新生成，填进 config.json 的 discord.token');
        return;
      }
      // 4014：@discordjs/ws 抛的是普通 Error("Used disallowed intents")，没有 code 可认
      if (/disallowed intents/i.test(health.lastError)) {
        log(`❌ Discord 拒绝了特权 intent：请到 Developer Portal → Bot 打开 Message Content Intent${membersIntent ? ' 与 Server Members Intent' : ''}`);
        return;
      }
      const delayMs = Math.min(60_000, 5000 * 2 ** attempt);
      log(`Discord 登录失败，${Math.round(delayMs / 1000)} 秒后重试：${health.lastError}`);
      setTimeout(() => { void login(attempt + 1); }, delayMs);
    }
  }

  function start() {
    client.on(Events.MessageCreate, async (message) => {
      noteEvent('MESSAGE_CREATE');
      if (!ACCEPTED_MESSAGE_TYPES.has(message?.type)) return;
      if (client.user && String(message?.author?.id) === String(client.user.id)) return;
      rememberMessage(message.id, message.channelId);
      try {
        await messageHandler?.(toInboundMessage(message, selfContext(message)));
      } catch (error) {
        log('处理 Discord 消息出错:', error?.message ?? error);
      }
    });
    client.once(Events.ClientReady, (ready) => {
      health.connected = true;
      health.lastError = '';
      noteEvent('READY');
      log(`Discord 已连接：${ready?.user?.tag ?? ready?.user?.username ?? '?'}`);
      readyOnce = true;
      readyHandler?.();
    });
    // 首次连上时 ShardReady 先于 ClientReady；之后的重新 identify 只有 ShardReady。
    client.on(Events.ShardReady, () => {
      health.connected = true;
      if (readyOnce) readyHandler?.();
    });
    client.on(Events.ShardResume, () => { health.connected = true; noteEvent('RESUMED'); });
    // ShardDisconnect 只在**不会再重连**的关闭码上触发（可恢复的断线走 ShardReconnecting）。
    client.on(Events.ShardDisconnect, (event) => {
      health.connected = false;
      const code = event?.code;
      const why = code === GatewayCloseCodes.AuthenticationFailed ? 'bot token 无效，请更新 config.json 的 discord.token'
        : code === GatewayCloseCodes.DisallowedIntents ? `请到 Developer Portal → Bot 打开 Message Content Intent${membersIntent ? ' 与 Server Members Intent' : ''}`
          : 'Discord 不再自动重连，请检查配置后重启桥接';
      health.lastError = `连接已关闭（code=${code ?? '?'}）：${why}`;
      log(`❌ Discord ${health.lastError}`);
    });
    client.on(Events.ShardReconnecting, () => {
      health.connected = false;
      log('Discord 连接断开，重连中…');
    });
    client.on(Events.Invalidated, () => {
      health.connected = false;
      log('❌ Discord 会话已失效（token 被重置？）：请更新 config.json 的 discord.token 后重启桥接');
    });
    client.on(Events.Error, (error) => {
      health.lastError = error?.message ?? String(error);
      log(`Discord 错误：${health.lastError}`);
    });
    client.on(Events.Warn, (message) => log(`Discord 警告：${message}`));
    void login();
  }

  return {
    // Discord 专属：原始 discord.js 客户端。只给测试与诊断用，bridge.js 不应直接调它。
    client,
    start,
    onMessage,
    onPoke,
    onReady,
    healthSnapshot,
    sendText,
    sendMessage,
    sendVoice,
    poke,
    getSelfInfo,
    getMessage,
    getImage,
    getFace,
    getForwardMessage,
    getGroupMemberList,
    getGroupMemberInfo,
    getGroupMemberListWithFallback,
    confirmVoiceSent,
    voiceToText,
    fetchStickerLibrary,
    addSticker,
    setStickerRemark
  };
}
