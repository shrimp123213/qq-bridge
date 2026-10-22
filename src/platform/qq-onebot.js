// QQ 平台适配层（SnowLuma / OneBot v11）。
//
// 桥接主程序（bridge.js）与聊天平台之间只经过这里：连接、断线自愈、上游健康、
// 收消息事件、发消息、查询（成员/消息/图片/表情/合并转发）都由适配层负责，
// bridge.js 里不再直接出现 `@snowluma/sdk`、OneBot HTTP 请求或 OneBot 消息段的构造。
//
// 平台适配层对 bridge.js 提供的接口（其它平台的适配层照这份实现）：
//
//   生命周期
//     start()                     连接并开始上游健康探测；只调一次
//     onMessage(handler)          handler(message)：message 为 InboundMessage（见下）；
//                                 机器人自己发的消息不会进来
//     onPoke(handler)             handler(poke)：poke 为 InboundPoke（见下）；平台没有这个概念就永不触发
//     onReady(handler)            每次连接成功后触发（重连也会）
//     healthSnapshot()            上游健康快照，供 /api/status 给操作者看
//   发送
//     sendText(kind, id, text)    一条纯文本
//     sendMessage(kind, id, { replyTo, mentionUserId, text, image })
//                                 引用 / @ / 文本或图片（image 为 Buffer）；返回网关的 data
//     sendVoice(kind, id, file)   一条语音（本机音频文件路径）；返回网关的 data
//     poke(kind, id, userId)      拍一拍
//   查询
//     getSelfInfo()               机器人自己：{ userId, nickname }（userId 可能为 null）
//     getMessage(messageId)       按 id 读回一条消息：InboundMessage 或 null（引用解析用）
//     getImage(file)  getFace(faceId)  getForwardMessage(id)
//     getGroupMemberList(groupId)  getGroupMemberInfo(groupId, userId)
//     getGroupMemberListWithFallback(groupId)   WS 失败时改走 HTTP；返回网关响应信封
//     confirmVoiceSent(messageId)  voiceToText(messageId)
//   收藏表情（QQ 独有；其它平台可以直接抛「不支持」）
//     fetchStickerLibrary(count)  addSticker(image)  setStickerRemark(emojiId, desc)
//
// 入站格式（所有 id 都是字符串）：
//
//   InboundMessage {
//     kind: 'private' | 'group',
//     conversationId,             私聊对方 / 群
//     messageId,                  平台消息 id（引用、看图、收藏用）；可能为 null
//     messageSeq,                 QQ 的 message_seq（只作媒体索引的别名）；其它平台给 null
//     sender: { userId, nickname, card },      card 为群名片（服务器内昵称），可为空串
//     selfId,                     机器人自己的 id；可能为 null
//     segments,                   消息内容：OneBot v11 消息段数组（见下）
//   }
//   InboundPoke { kind, conversationId, senderId, targetId, selfId, action, suffix }
//
//   消息内容沿用 OneBot v11 消息段，bridge.js 认得的段：text{text}、at{qq}（qq='all' 为
//   @全体）、reply{id}、image{file,url,sub_type,summary,emoji_id,emoji_package_id,key}、
//   mface{summary,…}、face{id}、record、video、file{name}、json、markdown{text|content}、
//   forward{id}。其它平台的适配层把自己的消息转成这些段即可。
//
// ID 格式：会话对象与用户的 id 是 1~20 位十进制数字字符串（bridge.js 去掉前导零后用作
// `group:<id>` / `private:<id>` 会话 key），超过 2^53 也行（例如 Discord snowflake）——
// bridge.js 不会把它们转成 Number。消息 id 是不透明字符串，格式由各平台自己校验。
//
// ⚠️ 查询结果（成员、合并转发、图片、表情、收藏表情）仍是 OneBot v11 的形状。
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from '../snowluma-conn.js';

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// ── 入站正规化：OneBot 事件 → 桥接内部格式 ─────────────────────────────────
// 消息内容原样保留（OneBot 消息段）；这里只把「谁、在哪、哪一则、机器人是谁」整理成统一字段，
// 各网关实现的字段差异（msg_id / message_seq、groupId、sender_id、target_id…）都在这里消化。
const idOrNull = (value) => (value === undefined || value === null ? null : String(value));

/**
 * OneBot 消息事件（或 get_msg 读回的消息）→ InboundMessage。
 * kind 省略时按有没有群号判断（get_msg 的返回不带「从哪个回调来」的信息）。
 */
export function toInboundMessage(event, kind = null) {
  const groupId = event?.group_id ?? event?.groupId;
  const userId = idOrNull(event?.user_id ?? event?.userId ?? event?.sender?.user_id);
  const resolvedKind = kind ?? (groupId != null ? 'group' : 'private');
  return {
    kind: resolvedKind,
    conversationId: resolvedKind === 'group' ? idOrNull(groupId) : userId,
    messageId: idOrNull(event?.message_id ?? event?.msg_id),
    messageSeq: idOrNull(event?.message_seq),
    sender: {
      userId,
      nickname: String(event?.sender?.nickname ?? ''),
      card: String(event?.sender?.card ?? '')
    },
    selfId: idOrNull(event?.self_id),
    // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）；原样交给 segmentsToText 兼容。
    segments: event?.message ?? []
  };
}

/** OneBot notify/poke 通知 → InboundPoke；不是拍一拍、是自己拍的、或找不到会话对象时返回 null。 */
export function toInboundPoke(event) {
  if (!event || event.sub_type !== 'poke') return null;
  const selfId = event.self_id;
  const groupId = event.group_id ?? event.groupId ?? null;
  const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
  const targetIdRaw = event.target_id ?? event.targetId ?? null;
  const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
  const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
  // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
  if (senderId && selfId != null && String(senderId) === String(selfId)) return null;
  let kind;
  let conversationId;
  if (groupId != null) {
    kind = 'group';
    conversationId = String(groupId);
  } else {
    const peer = event.user_id ?? senderId;
    if (!peer) return null;
    kind = 'private';
    conversationId = String(peer);
  }
  return {
    kind,
    conversationId,
    senderId,
    targetId,
    selfId: idOrNull(selfId),
    action: event.action,
    suffix: event.suffix
  };
}

const HTTP_426_HINT = '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）';
const HTTP_426_HINT_DETAILED = '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）';

/**
 * @param {object} options
 * @param {object} options.cfg - 桥接的运行配置（与 bridge.js 共用同一个对象；token 自愈会改写 cfg.snowluma）
 * @param {Function} options.log - 桥接的日志函数
 * @param {string} options.configPath - config.json 路径（token/端点自愈写回用）
 */
export function createQQPlatform({ cfg, log, configPath }) {
  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  let messageHandler = null;
  let pokeHandler = null;
  let readyHandler = null;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）

  // ── OneBot HTTP ────────────────────────────────────────────────────────────
  // 发语音、带引用/@ 的发送、表情、转写、回读校验都直接走网关的 HTTP 口。
  // httpUrl 与 token 每次现读 cfg：自愈会在运行中改写它们。
  async function postAction(action, params, timeoutMs) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }

  // ── 读接口的 HTTP 兜底：WS 挂了不等于网关挂了 ──────────────────────────────
  //
  // 为什么要有：`fetch_custom_face_detail` 原来只走 SnowLuma 的 WS action，于是
  // 「WS 正在重连」这段时间里表情库同步必然失败。日志实测 33 次同步里 16 次失败（≈48%），
  // 全是 `SnowLuma WebSocket closed before opening`；表现就是操作者说的
  // 「有时读群友的表情包会失败」——库里没有新收藏 ⇒ qq_get_sticker_image 直接报「找不到表情」。
  //
  // 而**同一个网关的 HTTP 口一直是可用的**（sendMessage 发消息、voiceToText 转写都直接用它）。
  // 读接口没有理由单点依赖 WS。这里只在 WS 失败时兜底，不改变正常路径的延迟。
  async function onebotHttpAction(action, params = {}, { timeoutMs = 15000 } = {}) {
    const { res, body } = await postAction(action, params, timeoutMs);
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? HTTP_426_HINT : '';
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body;
  }

  // send_private_msg / send_group_msg：失败时抛错（带 426 端口误配提示），成功返回 data。
  async function sendSegments(kind, id, segments, timeoutMs, hint426) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const { res, body } = await postAction(action, params, timeoutMs);
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? hint426 : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 发送 ───────────────────────────────────────────────────────────────────
  function sendText(kind, id, content) {
    return kind === 'private'
      ? bot.sendPrivateMessage(Number(id), text(escapeCqText(content)))
      : bot.sendGroupMessage(Number(id), text(escapeCqText(content)));
  }

  // replyTo / mentionUserId 由调用方校验过格式（不允许 @all）；image 与 text 二选一，image 优先。
  function sendMessage(kind, id, { replyTo = null, mentionUserId = null, text: content = '', image = null } = {}) {
    const segments = [];
    if (replyTo !== null && replyTo !== undefined) segments.push({ type: 'reply', data: { id: String(replyTo) } });
    if (mentionUserId !== null && mentionUserId !== undefined) segments.push({ type: 'at', data: { qq: String(mentionUserId) } });
    if (image) segments.push({ type: 'image', data: { file: 'base64://' + image.toString('base64') } });
    else segments.push({ type: 'text', data: { text: escapeCqText(content) } });
    return sendSegments(kind, id, segments, 15000, HTTP_426_HINT_DETAILED);
  }

  // 语音条比图片大、要过一次 SILK 转码，给 60s 预算。
  function sendVoice(kind, id, file) {
    return sendSegments(kind, id, [{ type: 'record', data: { file } }], 60000, HTTP_426_HINT);
  }

  async function poke(kind, id, userId) {
    if (kind === 'group') {
      await bot.raw('group_poke', { group_id: Number(id), user_id: Number(userId) });
    } else {
      // 私聊拍一拍：send_poke 自动路由到当前私聊对象
      await bot.raw('send_poke', { user_id: Number(id) });
    }
  }

  // ── 查询 ───────────────────────────────────────────────────────────────────
  async function getSelfInfo() {
    const login = await bot.getLoginInfo();
    if (!login) return null;
    return {
      userId: idOrNull(login.user_id),
      nickname: login.nickname ? String(login.nickname) : ''
    };
  }

  async function getMessage(messageId) {
    // QQ 的消息 id 是（可能为负的）整数；超出安全整数范围的转成 Number 会变成另一条消息的 id。
    const numericId = Number(messageId);
    if (!Number.isSafeInteger(numericId)) {
      log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
      return null;
    }
    const raw = await bot.getMessage(numericId);
    return raw ? toInboundMessage(raw) : null;
  }

  function getImage(file) {
    return bot.getImage({ file: String(file) });
  }

  function getFace(faceId) {
    return bot.fetchFaceEntity(faceId);
  }

  function getForwardMessage(id) {
    return bot.raw('get_forward_msg', { id });
  }

  function getGroupMemberList(groupId) {
    return bot.getGroupMemberList(Number(groupId));
  }

  function getGroupMemberInfo(groupId, userId) {
    return bot.getGroupMemberInfo(Number(groupId), Number(userId));
  }

  async function getGroupMemberListWithFallback(groupId) {
    try {
      return await bot.request('get_group_member_list', { group_id: Number(groupId) });
    } catch (wsError) {
      // 与表情库同步同一条原则：WS 挂了不代表网关挂了，读接口走 HTTP 兜底。
      return await onebotHttpAction('get_group_member_list', { group_id: Number(groupId) });
    }
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, duration } 或 null；网络错误照常抛出，由调用方决定怎么记。
   */
  async function confirmVoiceSent(messageId) {
    const { res, body } = await postAction('get_msg', { message_id: Number(messageId) }, 30000);
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
    const segments = Array.isArray(body.data?.message) ? body.data.message : [];
    const record = segments.find((s) => s?.type === 'record');
    if (!record) return null;
    // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
    // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
    // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
    return {
      confirmed: true,
      duration: record.data?.duration != null ? Number(record.data.duration) : null
    };
  }

  // 语音转写（fetch_ptt_text）：成功返回文本（可能是空串），网关拒绝返回 null；网络错误照常抛出。
  async function voiceToText(messageId) {
    const { res, body } = await postAction('fetch_ptt_text', { message_id: String(messageId) }, 30000);
    return res.ok && body.status === 'ok' && body.retcode === 0 ? (body.data?.text ?? '') : null;
  }

  // ── 收藏表情（QQ 账号的 custom face） ─────────────────────────────────────
  // 返回 { response, via }：response 是网关响应信封，via 为 'ws' | 'http'。
  async function fetchStickerLibrary(count) {
    try {
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      return { response, via: 'ws' };
    } catch (wsError) {
      // WS 失败 ⇒ 立刻用 HTTP 再问一次同一个 action（语义相同，token 可能不同但同一账号）。
      log(`[sticker] WS 同步不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
      return { response: await onebotHttpAction('fetch_custom_face_detail', { count }), via: 'http' };
    }
  }

  // add_custom_face：image 为 Buffer；返回网关响应信封（成功时 data.emoji_id 是新表情 id）。
  function addSticker(image) {
    return bot.request('add_custom_face', { file: 'base64://' + image.toString('base64') });
  }

  // modify_custom_face：返回网关响应信封。
  function setStickerRemark(emojiId, desc) {
    return bot.request('modify_custom_face', { emoji_id: emojiId, desc });
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— bridge.js 第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护）。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 连接与事件 ─────────────────────────────────────────────────────────────
  function onMessage(handler) { messageHandler = handler; }
  function onPoke(handler) { pokeHandler = handler; }
  function onReady(handler) { readyHandler = handler; }

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(configPath, {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(configPath, cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  function start() {
    bot.onPrivateMessage(async (event) => {
      // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
      // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
      if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
      try { await messageHandler?.(toInboundMessage(event, 'private')); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
    });
    bot.onGroupMessage(async (event) => {
      if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
        || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
      try { await messageHandler?.(toInboundMessage(event, 'group')); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
    });
    bot.onNotice('notify', async (event) => {
      try {
        const poke = toInboundPoke(event);
        if (poke) await pokeHandler?.(poke);
      } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
    });

    // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
    // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
    //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
    //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
    //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
    //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
    //     免费、及时，且**不依赖较新的运行时**。
    // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
    try {
      bot.onEvent((event) => {
        const post = event?.post_type;
        noteUpstreamPacket(post
          ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
          : 'event');
        if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
          // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
          // 但 OneBotBaseEvent 是 JsonObject，读取合法。
          noteReceiveHealth(event.status?.good, 'heartbeat');
          if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
          reportSnowlumaHealth();
        }
      });
    } catch (error) {
      log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
    }

    // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
    // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
    try {
      bot.onBotStatus((event) => {
        noteUpstreamPacket('notice/bot_status');
        const sub = String(event?.sub_type ?? '');
        snowlumaHealth.accountOnline = sub === 'online';
        if (sub === 'offline') {
          log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
            + '在重新登录之前群里不会有任何消息进来。');
        } else if (sub === 'online') {
          log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
        }
      });
    } catch (error) {
      log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
    }

    bot.on('open', () => {
      // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
      const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
      snowlumaHealth.connected = true;
      log(`SnowLuma 已连接：${connectedUrl}`);
      // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
      // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
      void pollSnowlumaStatus();
      // 连接就绪回调（bridge.js 在这里读取机器人昵称/号码；重连后也会刷新）
      readyHandler?.();
      // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
      // 让 MCP 工具（另一个进程）也能拿到正确的 token。
      void syncTokenToFile();
    });

    bot.on('close', (info) => {
      snowlumaHealth.connected = false;
      log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
      // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
      // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
      // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
      void healTokenIfStale(`close code=${info?.code ?? '?'}`);
    });
    bot.on('error', (error) => {
      // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
      // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
      // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
      const detail = error && typeof error === 'object'
        ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
        : String(error ?? '');
      log(`SnowLuma 错误：${detail || '(无详情)'}`);
      void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
    });

    // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
    bot.connect().catch((error) => {
      // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
      // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
      // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
      // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
      // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
      // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
      // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
      log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
    });

    startSnowlumaWatch();
  }

  return {
    // QQ 专属：原始 SDK 客户端。只给测试桩与诊断用，bridge.js 不应直接调它。
    client: bot,
    start,
    onMessage,
    onPoke,
    onReady,
    healthSnapshot: snowlumaHealthSnapshot,
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
