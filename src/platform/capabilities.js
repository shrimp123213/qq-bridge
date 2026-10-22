// 各聊天平台的能力表：bridge.js（调用期）与 MCP server（注册期）共用这一份，避免两边判断漂移。
//
// ⚠️ 本文件不能 import 任何平台 SDK：MCP server 是 DSH spawn 的独立进程，
//    只为查表就把 discord.js / @snowluma/sdk 拉进来，既慢又会让缺依赖的环境直接起不来。

export const PLATFORMS = Object.freeze(['qq', 'discord']);

/** config.json 的 platform 字段（缺省为 qq）；不认识的值原样返回，由调用方报错。 */
export function platformOf(config) {
  const value = String(config?.platform ?? '').trim().toLowerCase();
  return value || 'qq';
}

// 平台做不到的二代工具，按 socialV2.tools 的开关名登记（与 MCP 的 TOOL_CONFIG_FLAGS 同一套名字）。
// 不在表里的平台视为全部支持。
const UNSUPPORTED_TOOL_FLAGS = {
  discord: new Set([
    'sendPoke',          // Discord 没有拍一拍
    'getForwardMsg',     // 没有 QQ 式合并转发；转发的消息在入站时已经展开成文字
    // 收藏表情是 QQ 账号自带的表情库（fetch_custom_face_detail），Discord 没有对应物
    'listStickers',
    'getStickerImage',
    'sendSticker',
    'collectSticker',
    'stickerNote',
    'setStickerRemark',
  ]),
};

// 没有开关、直接打 OneBot HTTP 的旧工具：只有 QQ 能用。
const PLATFORM_ONLY_TOOLS = {
  chat_status: 'qq',
  chat_list_groups: 'qq',
  chat_get_group_history: 'qq',
};

/** 该平台能否实现某个二代工具开关（flag 为 socialV2.tools 的键名）。 */
export function platformSupportsToolFlag(platform, flag) {
  return !UNSUPPORTED_TOOL_FLAGS[platform]?.has(flag);
}

/** 该平台能否注册某个 MCP 工具（按工具名，只管没有开关的平台专属工具）。 */
export function platformSupportsTool(platform, toolName) {
  const only = PLATFORM_ONLY_TOOLS[toolName];
  return !only || only === platform;
}

/** 平台做不到的工具开关与工具名（控制台据此隐藏对应设置；与注册期、调用期同一份表）。 */
export function platformUnsupported(platform) {
  return {
    toolFlags: [...(UNSUPPORTED_TOOL_FLAGS[platform] ?? [])],
    tools: Object.keys(PLATFORM_ONLY_TOOLS).filter((name) => PLATFORM_ONLY_TOOLS[name] !== platform),
  };
}

/** 平台是否有「收藏表情库」（QQ 账号的 custom face）。 */
export function platformHasStickerLibrary(platform) {
  return platformSupportsToolFlag(platform, 'listStickers');
}

// 同一模式在不同平台用的 DSH preset：Discord 版由 build-agent-preset-patches.mjs 从 QQ 版派生，
// 只去掉 Discord 没有的工具说明、换掉 QQ 用语，安全守卫行完全相同。不在表里的照用原名。
const PLATFORM_PRESETS = {
  discord: { 'qq-chat-v2': 'dc-chat-v2' },
};

/** 按平台换成对应的 preset 名（配置里写的仍是 QQ 版的名字）。 */
export function platformPreset(platform, preset) {
  return PLATFORM_PRESETS[platform]?.[preset] ?? preset;
}
