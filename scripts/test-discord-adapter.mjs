// Discord 适配层（src/platform/discord.js）的离线测试。
//   A. 入站正规化：toInboundMessage / splitContent 是纯函数，直接喂形状相同的普通对象；
//   B. 适配层行为：注入一个假的 discord.js Client（EventEmitter + 假频道/成员），
//      验证收消息过滤、发送载荷、读消息、成员列表、登录失败处理与健康状态。
// 不连 Discord、不需要 token。真实网关行为（intent、限流、附件上传）这里测不到。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
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
import { createDiscordPlatform, splitContent, toInboundMessage } from '../src/platform/discord.js';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const coll = (entries) => new Map(entries);
const flags = (...bits) => ({ has: (bit) => bits.includes(bit) });
const tick = () => new Promise((resolve) => setImmediate(resolve));

const SELF = '1100000000000000001';
const BOT_ROLE = '2200000000000000002';
const U1 = '1234567890123456789'; // 超过 2^53，必须全程保持字符串
const CH = '3300000000000000003';

// ── A：入站正规化 ──────────────────────────────────────────────────────────

await test('提及：用户 / 机器人身份组 / 其它身份组 / 频道 / 自定义表情 / 无权限的 @everyone', () => {
  const msg = {
    id: '9000000000000000001', channelId: CH, guildId: '44', type: MessageType.Default,
    author: { id: U1, username: 'alice', globalName: 'Alice' }, member: { nickname: '小A' },
    content: `hi <@${SELF}> <@!${U1}> <@&${BOT_ROLE}> <@&555> <#${CH}> <#777> <:pepe:111> <a:dance:222> @everyone end`,
    mentions: { roles: coll([['555', { name: '管理员' }]]), channels: coll([[CH, { name: 'general' }]]), everyone: false },
  };
  const m = toInboundMessage(msg, { selfId: SELF, selfRoleIds: [BOT_ROLE] });
  assert.equal(m.kind, 'group');
  assert.equal(m.conversationId, CH);
  assert.equal(m.messageId, '9000000000000000001');
  assert.equal(m.messageSeq, null);
  assert.deepEqual(m.sender, { userId: U1, nickname: 'Alice', card: '小A' });
  assert.equal(m.selfId, SELF);
  assert.deepEqual(m.segments, [
    { type: 'text', data: { text: 'hi ' } },
    { type: 'at', data: { id: SELF } },
    { type: 'text', data: { text: ' ' } },
    { type: 'at', data: { id: U1 } },
    { type: 'text', data: { text: ' ' } },
    { type: 'at', data: { id: SELF } },
    { type: 'text', data: { text: ' @管理员 #general #频道 ' } },
    { type: 'sticker', data: { summary: 'pepe', url: 'https://cdn.discordapp.com/emojis/111.png' } },
    { type: 'text', data: { text: ' ' } },
    { type: 'sticker', data: { summary: 'dance', url: 'https://cdn.discordapp.com/emojis/222.gif' } },
    { type: 'text', data: { text: ' @everyone end' } },
  ]);
});

await test('有权限的 @here 才是提及全体；未知身份组回退成「@身份组」；没有服务器昵称时 card 为空', () => {
  const m = toInboundMessage({ guildId: '1', channelId: CH, author: { id: U1, username: 'u' }, content: '@here <@&9>', mentions: { everyone: true } }, { selfId: SELF });
  assert.deepEqual(m.segments, [{ type: 'at', data: { id: 'all' } }, { type: 'text', data: { text: ' @身份组' } }]);
  assert.equal(m.sender.nickname, 'u');
  assert.equal(m.sender.card, '');
});

await test('贴纸、附件与语音消息', () => {
  const base = { guildId: '1', channelId: CH, author: { id: U1, username: 'u' }, content: '' };
  const m = toInboundMessage({
    ...base,
    stickers: coll([
      ['1', { name: 'cat', format: StickerFormatType.PNG, url: 'https://media.discordapp.net/stickers/1.png' }],
      ['2', { name: 'wave', format: StickerFormatType.Lottie, url: 'x' }],
    ]),
    attachments: coll([
      ['a', { name: 'p.png', contentType: 'image/png', url: 'https://c/p.png' }],
      ['b', { name: 's.mp3', contentType: 'audio/mpeg', url: 'https://c/s.mp3' }],
      ['c', { name: 'v.mp4', contentType: 'video/mp4', url: 'https://c/v.mp4' }],
      ['d', { name: 'doc.pdf', contentType: 'application/pdf', url: 'https://c/doc.pdf' }],
      ['e', { name: 'noct.JPG', url: 'https://c/noct.JPG' }],
    ]),
  });
  assert.deepEqual(m.segments, [
    { type: 'sticker', data: { summary: 'cat', url: 'https://media.discordapp.net/stickers/1.png' } },
    { type: 'text', data: { text: '[贴纸:wave]' } },
    { type: 'image', data: { file: 'p.png', url: 'https://c/p.png', summary: '' } },
    { type: 'audio', data: { file: 's.mp3', url: 'https://c/s.mp3' } },
    { type: 'video', data: { file: 'v.mp4', url: 'https://c/v.mp4' } },
    { type: 'file', data: { name: 'doc.pdf' } },
    { type: 'image', data: { file: 'noct.JPG', url: 'https://c/noct.JPG', summary: '' } },
  ]);
  const voice = toInboundMessage({
    ...base,
    flags: flags(MessageFlags.IsVoiceMessage),
    attachments: [{ name: 'voice-message.ogg', contentType: 'application/octet-stream', url: 'https://c/v.ogg' }],
  });
  assert.deepEqual(voice.segments, [{ type: 'audio', data: { file: 'voice-message.ogg', url: 'https://c/v.ogg' } }]);
});

await test('回复只认同一频道；转发把快照内容展开', () => {
  const base = { guildId: '1', channelId: CH, author: { id: U1, username: 'u' } };
  const same = toInboundMessage({ ...base, content: 'yes', reference: { messageId: '777', channelId: CH, type: MessageReferenceType.Default } });
  assert.deepEqual(same.segments[0], { type: 'reply', data: { id: '777' } });
  const cross = toInboundMessage({ ...base, content: 'x', reference: { messageId: '777', channelId: '999' } });
  assert.equal(cross.segments.some((s) => s.type === 'reply'), false);
  const noChannel = toInboundMessage({ ...base, content: 'x', reference: { messageId: '777' } });
  assert.equal(noChannel.segments[0].type, 'reply');
  const forward = toInboundMessage({
    ...base, content: '',
    reference: { messageId: '888', channelId: '999', type: MessageReferenceType.Forward },
    messageSnapshots: coll([['888', { content: `original <@${U1}>`, attachments: [{ name: 'a.png', contentType: 'image/png', url: 'u' }] }]]),
  });
  assert.deepEqual(forward.segments, [
    { type: 'text', data: { text: '[转发] ' } },
    { type: 'text', data: { text: 'original ' } },
    { type: 'at', data: { id: U1 } },
    { type: 'image', data: { file: 'a.png', url: 'u', summary: '' } },
  ]);
});

await test('私信：会话 id 是对方；读回自己发的私信时也是对方', () => {
  const dm = toInboundMessage({ channelId: '5', author: { id: U1, username: 'u' }, content: 'hey', channel: { recipientId: U1 } }, { selfId: SELF });
  assert.equal(dm.kind, 'private');
  assert.equal(dm.conversationId, U1);
  const own = toInboundMessage({ channelId: '5', author: { id: SELF, username: 'bot' }, content: 'hi', channel: { recipientId: U1 } }, { selfId: SELF });
  assert.equal(own.conversationId, U1);
  assert.equal(own.sender.userId, SELF);
});

await test('splitContent：换行优先、其次空格、实在不行硬切，不拆代理对、不丢字', () => {
  assert.deepEqual(splitContent(''), ['']);
  assert.deepEqual(splitContent('short'), ['short']);
  assert.deepEqual(splitContent('a'.repeat(1500) + '\n' + 'b'.repeat(1000)).map((c) => c.length), [1500, 1000]);
  assert.deepEqual(splitContent('a'.repeat(1200) + ' ' + 'b'.repeat(1200)).map((c) => c.length), [1200, 1200]);
  const early = 'a'.repeat(100) + '\n' + 'b'.repeat(2500); // 换行太靠前 → 硬切
  const parts = splitContent(early);
  assert.equal(parts[0].length, 2000);
  assert.equal(parts.join(''), early);
  const emoji = splitContent('x'.repeat(1999) + '😀' + 'y');
  assert.equal(emoji[0].length, 1999);
  assert.equal(emoji[1], '😀y');
  const long = splitContent('z'.repeat(5000));
  assert.ok(long.every((c) => c.length <= 2000));
  assert.equal(long.join(''), 'z'.repeat(5000));
});

// ── B：注入假 client ───────────────────────────────────────────────────────

function makeWorld() {
  const sent = [];
  let nextId = 5000000000000000000n;
  const store = new Map(); // messageId → message
  let fullFetches = 0;
  const members = coll([
    [U1, { id: U1, nickname: '服务器昵称', user: { username: 'alice', globalName: 'Alice' }, permissions: { has: () => false } }],
    ['42', { id: '42', nickname: null, user: { username: 'owner' }, permissions: { has: () => true } }],
    ['43', { id: '43', nickname: null, user: { username: 'admin' }, permissions: { has: (bit) => bit === PermissionFlagsBits.Administrator } }],
    ['44', { id: '44', nickname: null, user: { username: 'hidden' }, permissions: { has: () => false }, canView: false }],
  ]);
  const guild = {
    id: '700', ownerId: '42',
    members: {
      cache: members,
      me: { roles: { botRole: { id: BOT_ROLE } } },
      async fetch(arg) {
        if (arg === undefined) { fullFetches++; return members; }
        if (members.has(arg)) return members.get(arg);
        const error = new Error('Unknown Member'); error.code = 10007; throw error;
      },
    },
  };
  const makeChannel = (id, { inGuild = false, dm = false, text = true } = {}) => ({
    id, guild: inGuild ? guild : null, recipientId: dm ? U1 : undefined,
    isTextBased: () => text, isDMBased: () => dm,
    async send(payload) {
      const msg = {
        id: String(nextId++), channelId: id, guildId: inGuild ? guild.id : null, guild: inGuild ? guild : null,
        type: MessageType.Default, author: { id: SELF, username: 'botty' }, content: payload.content ?? '',
        channel: { recipientId: dm ? U1 : undefined },
        attachments: coll((payload.files ?? []).map((file, i) => [String(i), { name: file.name, duration: 3.5 }])),
      };
      store.set(msg.id, msg);
      sent.push({ channel: id, payload, id: msg.id });
      return msg;
    },
    messages: {
      async fetch(messageId) {
        if (store.get(messageId)?.channelId === id) return store.get(messageId);
        const error = new Error('Unknown Message'); error.code = 10008; throw error;
      },
    },
    permissionsFor: (member) => ({ has: (bit) => bit === PermissionFlagsBits.ViewChannel && member.canView !== false }),
  });
  const channels = new Map([
    [CH, makeChannel(CH, { inGuild: true })],
    ['600', makeChannel('600', { inGuild: true, text: false })], // 语音频道
  ]);
  const dmChannel = makeChannel('601', { dm: true });
  channels.set(dmChannel.id, dmChannel);
  const client = new EventEmitter();
  client.user = { id: SELF, username: 'botty', globalName: null, tag: 'botty#0' };
  client.ws = { ping: 42 };
  client.loginCalls = [];
  client.loginImpl = async () => {};
  client.login = async (token) => { client.loginCalls.push(token); return client.loginImpl(token); };
  client.channels = {
    async fetch(id) {
      if (!channels.has(String(id))) { const error = new Error('Unknown Channel'); error.code = 10003; throw error; }
      return channels.get(String(id));
    },
  };
  client.users = { async fetch(id) { return { id, createDM: async () => dmChannel }; } };
  return { client, sent, store, guild, dmChannel, fullFetches: () => fullFetches };
}

function makePlatform(world, discord = {}) {
  const logs = [];
  const platform = createDiscordPlatform({
    cfg: { discord: { token: 'tok', ...discord } },
    log: (...args) => logs.push(args.join(' ')),
    client: world.client,
  });
  return { p: platform, logs };
}

await test('收消息：丢掉自己、系统消息与其它 bot/webhook；ready 只在 ClientReady 之后的 ShardReady 重发', async () => {
  const w = makeWorld();
  const { p } = makePlatform(w);
  const got = [];
  let readies = 0;
  p.onMessage((m) => got.push(m));
  p.onReady(() => readies++);
  p.start();
  await tick();
  assert.deepEqual(w.client.loginCalls, ['tok']);
  w.client.emit(Events.ShardReady, 0);
  assert.equal(readies, 0, 'ClientReady 之前的 ShardReady 不算');
  w.client.emit(Events.ClientReady, { user: w.client.user });
  assert.equal(readies, 1);
  w.client.emit(Events.ClientReady, { user: w.client.user });
  assert.equal(readies, 1, 'ClientReady 只处理一次');
  w.client.emit(Events.ShardReady, 0);
  assert.equal(readies, 2, '重新 identify 后再通知一次');

  const guildMsg = { id: '9100', channelId: CH, guildId: '700', guild: w.guild, type: MessageType.Default, author: { id: U1, username: 'alice' }, content: `<@&${BOT_ROLE}> 在吗` };
  w.client.emit(Events.MessageCreate, guildMsg);
  w.client.emit(Events.MessageCreate, { ...guildMsg, id: '9101', author: { id: SELF } });
  w.client.emit(Events.MessageCreate, { ...guildMsg, id: '9102', type: MessageType.ChannelPinnedMessage });
  w.client.emit(Events.MessageCreate, { ...guildMsg, id: '9103', type: MessageType.Reply, reference: { messageId: '9100', channelId: CH } });
  w.client.emit(Events.MessageCreate, { ...guildMsg, id: '9104', author: { id: '555', username: 'otherbot', bot: true } });
  w.client.emit(Events.MessageCreate, { ...guildMsg, id: '9105', webhookId: '66', author: { id: '66', username: 'hook', bot: true } });
  w.client.emit(Events.MessageCreate, { ...guildMsg, id: '9106', author: { id: '777', username: 'human', bot: false } });
  await tick();
  assert.deepEqual(got.map((m) => m.messageId), ['9100', '9103', '9106']);
  assert.deepEqual(got[0].segments[0], { type: 'at', data: { id: SELF } }, '@机器人身份组 = @机器人');
  assert.equal(got[0].selfId, SELF);

  const health = p.healthSnapshot();
  assert.deepEqual(Object.keys(health).sort(), ['connected', 'lastError', 'lastEventAgoMs', 'lastEventKind', 'pingMs']);
  assert.equal(health.connected, true);
  assert.equal(health.pingMs, 42);
  assert.equal(health.lastEventKind, 'MESSAGE_CREATE');
  assert.equal(health.lastError, null);
  assert.ok(Number.isFinite(health.lastEventAgoMs) && health.lastEventAgoMs >= 0);
});

await test('发送：引用 + 点名 + allowedMentions；超长切分；私信；图片；语音', async () => {
  const w = makeWorld();
  const { p } = makePlatform(w);
  const r = await p.sendMessage('group', CH, { replyTo: '777', mentionUserId: U1, text: 'hello @everyone <@&555>' });
  assert.match(r.messageId, /^\d+$/);
  assert.deepEqual(w.sent[0].payload, {
    allowedMentions: { parse: [], users: [U1], repliedUser: true },
    content: `<@${U1}> hello @everyone <@&555>`,
    reply: { messageReference: '777', failIfNotExists: false },
  });

  w.sent.length = 0;
  const r2 = await p.sendMessage('group', CH, { replyTo: '1', text: 'a'.repeat(1500) + '\n' + 'b'.repeat(1500) });
  assert.equal(w.sent.length, 2);
  assert.equal(r2.messageId, w.sent[0].id, '返回第一条的 id');
  assert.ok(w.sent[0].payload.reply && !w.sent[1].payload.reply, '引用只挂在第一条');
  assert.deepEqual(w.sent[1].payload.allowedMentions, { parse: [], users: [], repliedUser: true });

  w.sent.length = 0;
  await p.sendText('private', U1, '私聊');
  assert.equal(w.sent[0].channel, w.dmChannel.id);

  w.sent.length = 0;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
  await p.sendMessage('group', CH, { image: png, text: 'ignored' });
  assert.equal(w.sent[0].payload.files[0].name, 'image.png');
  assert.equal(w.sent[0].payload.content, undefined, '图片与文字二选一，图片优先');
  w.sent.length = 0;
  await p.sendMessage('group', CH, { image: Buffer.from('GIF89a000000') });
  assert.equal(w.sent[0].payload.files[0].name, 'image.gif');

  w.sent.length = 0;
  const voice = await p.sendVoice('group', CH, '/tmp/x/voice.mp3');
  assert.deepEqual(w.sent[0].payload.files, [{ attachment: '/tmp/x/voice.mp3', name: 'voice.mp3' }]);
  assert.deepEqual(await p.confirmVoiceSent(voice.messageId), { confirmed: true, duration: 3.5 });

  await assert.rejects(p.sendText('group', '600', 'x'), /不是服务器里的文字频道/);
  await assert.rejects(p.sendText('group', w.dmChannel.id, 'x'), /不是服务器里的文字频道/);
  w.sent.length = 0;
  assert.deepEqual(await p.sendText('group', CH, ''), { messageId: null });
  assert.equal(w.sent.length, 0, '空消息不发');
});

await test('读消息：带会话 / 走缓存 / 读不到 → null；非法 id → null', async () => {
  const w = makeWorld();
  const { p } = makePlatform(w);
  const sent = await p.sendText('group', CH, 'remember me');
  const viaCache = await p.getMessage(sent.messageId);
  assert.equal(viaCache.messageId, sent.messageId);
  assert.equal(viaCache.kind, 'group');
  assert.equal(viaCache.conversationId, CH);

  w.store.set('8888', { id: '8888', channelId: CH, guildId: '700', guild: w.guild, author: { id: U1, username: 'a' }, content: 'x' });
  assert.equal(await p.getMessage('8888'), null, '没见过、也没带会话 → 读不到');
  const viaWhere = await p.getMessage('8888', { kind: 'group', conversationId: CH });
  assert.equal(viaWhere.kind, 'group');
  assert.equal((await p.getMessage('8888')).messageId, '8888', '带会话读过一次后会记住');
  assert.equal(await p.getMessage('123', { kind: 'group', conversationId: CH }), null, '10008 → null');
  assert.equal(await p.getMessage('abc', { kind: 'group', conversationId: CH }), null);
  assert.equal(await p.confirmVoiceSent('999'), null);
});

await test('成员：按频道可见性过滤、角色映射、单人查询、自身信息', async () => {
  const w = makeWorld();
  const { p } = makePlatform(w);
  assert.deepEqual(await p.getGroupMemberList(CH), [
    { userId: U1, nickname: 'Alice', card: '服务器昵称', role: 'member' },
    { userId: '42', nickname: 'owner', card: '', role: 'owner' },
    { userId: '43', nickname: 'admin', card: '', role: 'admin' },
  ]);
  assert.equal(w.fullFetches(), 0, '没开 Server Members Intent 时不拉完整列表');
  assert.deepEqual(await p.getGroupMemberInfo(CH, U1), { userId: U1, nickname: 'Alice', card: '服务器昵称', role: 'member' });
  assert.equal(await p.getGroupMemberInfo(CH, '999'), null);
  assert.deepEqual(await p.getSelfInfo(), { userId: SELF, nickname: 'botty' });
  await assert.rejects(p.getGroupMemberList(w.dmChannel.id), /不是服务器里的文字频道/);
});

await test('开了 Server Members Intent：同一服务器 TTL 内只拉一次完整列表', async () => {
  const w = makeWorld();
  const { p } = makePlatform(w, { guildMembersIntent: true });
  await p.getGroupMemberList(CH);
  await p.getGroupMemberList(CH);
  assert.equal(w.fullFetches(), 1);
});

await test('适配层只暴露 Discord 有的能力', () => {
  const { p } = makePlatform(makeWorld());
  assert.deepEqual(Object.keys(p).sort(), [
    'client', 'confirmVoiceSent', 'getGroupMemberInfo', 'getGroupMemberList', 'getMessage', 'getSelfInfo',
    'healthSnapshot', 'onMessage', 'onReady', 'sendMessage', 'sendText', 'sendVoice', 'start',
  ]);
});

await test('登录：空 token / token 无效 / intent 没开 / 其它错误退避重试；不可恢复的断线', async () => {
  {
    const w = makeWorld();
    const { p, logs } = makePlatform(w, { token: '  ' });
    p.start();
    await tick();
    assert.equal(w.client.loginCalls.length, 0);
    assert.match(logs.join('\n'), /discord\.token 为空/);
  }
  {
    const w = makeWorld();
    w.client.loginImpl = async () => { const error = new Error('An invalid token was provided.'); error.code = 'TokenInvalid'; throw error; };
    const { p, logs } = makePlatform(w);
    p.start();
    await tick();
    assert.match(logs.join('\n'), /token 无效/);
    assert.equal(p.healthSnapshot().lastError, 'An invalid token was provided.');
  }
  {
    const w = makeWorld();
    w.client.loginImpl = async () => { throw new Error('Used disallowed intents'); };
    const { p, logs } = makePlatform(w, { guildMembersIntent: true });
    p.start();
    await tick();
    assert.match(logs.join('\n'), /Message Content Intent 与 Server Members Intent/);
  }
  {
    const w = makeWorld();
    w.client.loginImpl = async () => { throw new Error('getaddrinfo ENOTFOUND discord.com'); };
    const { p, logs } = makePlatform(w);
    const realSetTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (fn, ms) => { delays.push(ms); return 0; };
    try {
      p.start();
      await tick();
    } finally { globalThis.setTimeout = realSetTimeout; }
    assert.deepEqual(delays, [5000]);
    assert.match(logs.join('\n'), /5 秒后重试/);
  }
  {
    const w = makeWorld();
    const { p, logs } = makePlatform(w);
    p.start();
    w.client.emit(Events.ClientReady, { user: w.client.user });
    w.client.emit(Events.ShardDisconnect, { code: GatewayCloseCodes.DisallowedIntents }, 0);
    assert.equal(p.healthSnapshot().connected, false);
    assert.match(logs.join('\n'), /code=4014.*Message Content Intent/);
    w.client.emit(Events.ShardDisconnect, { code: GatewayCloseCodes.AuthenticationFailed }, 0);
    assert.match(logs.join('\n'), /code=4004.*token 无效/);
    assert.match(p.healthSnapshot().lastError, /code=4004/);
  }
});

await test('真实 Client（不登录）带上需要的 intent 与 Channel partial', () => {
  const withMembers = createDiscordPlatform({ cfg: { discord: { token: '', guildMembersIntent: true } }, log: () => {} });
  const intents = withMembers.client.options.intents;
  for (const bit of [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers]) {
    assert.ok(intents.has(bit), `缺少 intent ${bit}`);
  }
  assert.ok(withMembers.client.options.partials.includes(Partials.Channel), '收私信要 Channel partial');
  const plain = createDiscordPlatform({ cfg: { discord: {} }, log: () => {} });
  assert.equal(plain.client.options.intents.has(GatewayIntentBits.GuildMembers), false);
  withMembers.client.destroy();
  plain.client.destroy();
});

console.log(failures === 0 ? `\nALL PASS  tests=${tests}` : `\n${failures}/${tests} FAILED`);
process.exit(failures === 0 ? 0 : 1);
