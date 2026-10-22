# Discord ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🔒 Discord 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。

把 Discord 消息接入 DSH agent：Discord 私信与服务器频道里的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 Discord。

> ⚠️ **当前版本 `v0.2.1-r1`，适配 DSH 0.2.1-rc.2**（0.2.0-rc.2 亦兼容：`npm run verify:adaptation` 逐项核对本机 DSH 安装）。
> 鉴权用 `~/.dsh` 里持久化的浏览器会话签名密钥**离线铸造 Cookie** —— DSH 0.1.7 起进程启动 token
> 只存在于内存、不再落盘。agent preset 是 DSH 0.1.7 起的 `@deepseek-ai/dsh-agent-preset` Cordis 行
> （`~/.dsh/.agent-presets/` 目录机制已废）。协议代次（Cookie 鉴权 / 斜杠 RPC / `/api/remote.mux` 事件流）
> 自 DSH `0.1.2-alpha.1` 起引入，与更早的点号 endpoint 协议不兼容。
>
> DSH 侧的逐条适配说明见 [docs/guides/DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md)（0.2.0）
> 与 [docs/guides/DSH_021_ADAPTATION.md](docs/guides/DSH_021_ADAPTATION.md)（0.2.1）。

```
Discord 消息 ──► Discord Gateway（discord.js bot）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                        ▲                      │
                                                        └── agent 回复/提问/审批 ┘
```

## 架构

- **Discord 侧**：`discord.js` v14 的 bot 客户端（自动重连），全部收发经 `src/platform/discord.js` 适配层；`bridge.js` 不直接碰 discord.js
  - 会话映射：服务器里的文字频道（含讨论串）→ `group:<频道 id>`；私信 → `private:<用户 id>`
  - 其它 bot 与 webhook 发的消息直接丢弃（两个 bot 在同一频道会互相接话停不下来）
  - 出站只有显式指定的回复对象会被提醒；文本里的 `@everyone`、身份组与其它 `<@id>` 一律不提醒
- **DSH 侧**：适配 DSH 0.1.2 起引入、**0.2.1-rc.2 上逐项复核**的协议——用本机持久化签名密钥铸造会话 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流（`session/control` 的队列读 `value.projections[<id>].values.inbox`，另有一元 `session/projections` 主路径）；复用 `AbstractApiClient` 传输层但不再依赖旧版 zod value schema。会话模型由桥接按 `config.json` 的 `dsh.model` 逐会话 `session.selectModel` 固定（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 Discord**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入两个 MCP server：
  - `discord`（桥接自带 `src/mcp-discord-safe.js`）：Discord 动作的**安全子集**（查成员/发消息/引用回复等，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）。它不直接连 Discord，所有动作都经桥接的本地 API 走同一套白名单与限流
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料。
    **搜索优先复用 DSH 原本的联网搜索**（同一个 DeepSeek Anthropic 兼容端点 + `web_search` 服务端工具，凭据按 `config.webSearch.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → DSH 的 `.credentials.yaml` 顺序解析），
    因而结果质量与 DSH 内的搜索一致、且**不默认把聊天关键词发给 Bing**（Bing RSS 只在 DeepSeek 不可用时兜底）。
    抓取仍由桥接自己做 SSRF 校验并限制正文大小；**黑话学习默认开启**，会把聊天里提取的词条交给所选的搜索后端。
    数据出机清单见 [LICENSE](LICENSE) 的「数据出机清单」，不需要就关掉黑话自动研究（`slang.autoResearch`）或把 `webSearch.provider` 设为 `bing`。
- **会话模型**：每个 Discord 会话（私信/频道）对应一个独立的 DSH 会话，统一归组到「聊天」工作区；映射持久化在 `state/sessions.json`
- **性格定制**：聊天会话默认使用 `dc-chat` agent preset，`reserved2` 使用 `dc-chat-v2`。preset 由 `plugins/discord-agent-presets/` bundle 生成并插入 profile 的一条 `@deepseek-ai/dsh-agent-preset` 行（重启 DSH 后生效）；人格与默认 DSH 一致（coding agent），仅附加聊天场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（其他成员无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——左侧按操作任务分为「运行总览 / 会话与审批 / 人格与角色 / 二代仿真 / 一代仿真 / 黑话词库 / 令牌与花费 / 访问与安全 / 调试与运维 / 工具参考」十个页面，右上角搜索框可跨页定位任意功能项；支持**浅色 / 深色双主题**（顶栏一键切换，未选择时跟随系统）；切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关、查看活动日志、修改管理员/控制台令牌，全部即时生效；「运行总览」显示 Discord 连接状态（是否已连接、网关延迟、最近一个事件）；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）
  - **令牌与花费看板**：实时显示 AI 的 token 消耗与折算金额（元），可下钻到**每个频道 / 每个私信 / 每一轮对话**（轮次、步数、缓存命中/未命中输入、输出、命中率、花费、峰谷时段），并有**按时间的消耗走势图**（24 小时 / 3 天 / 7 天 / 30 天，柱子按高峰/空闲着色）。累计总量取自 DSH 的 `tokenUsage` 投影（精确，含桥接启动前的历史），逐轮明细由 `assistant/message` 的 `usage` 折叠而来；金额按 DeepSeek 官方价目表折算并区分**高峰 / 空闲时段**（高峰单价为空闲的 2 倍，已内置中国法定节假日）。详见 [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；超过注入上限或含一代专用指令会实时提示
  - **两层提示词可分别查看与修改**：「仿真提示词」（预设内置，管行为与协议，保存后同步到 DSH，需重启生效）与「人格提示词」（`roles/*.md`，管人设与语气，保存即生效）；仿真层保存前做安全不变量校验与自动备份，可一键还原
  - **会话初始提示词**（二代仿真）：「二代仿真 → 初始提示词」里可以给某个频道/私信预写一段环境说明（社群主题、氛围、常见话题、忌讳），AI **只在该会话第一次唤醒时收到一次**（之后已在会话上下文里，不再重复注入）。AI 既读不到也改不了这份设置（仅控制台接口）。会话被重置后，下一次首次唤醒会重新带上它。字数上限见 `socialV2.initialPromptMaxChars`
  - **DSH 思考强度**：默认 `max`，可选 `high` / `low`，档位从 DSH 实际公布的能力读取，保存后下一条消息生效；控制台会明示该设置同时写入 DSH 全局默认（`~/.dsh/settings.yaml`）
- **运行模式**：
  - `chat`：白名单频道 + 白名单私信 → `dc-chat` 安全聊天
  - `closed-agent`：仅私信 owner（config.json 的 ownerId，可在控制台设置）→ 完整工具（默认用 DSH 自己声明的默认 preset，即 `standard`；可在控制台「closed-agent preset」下拉改为任意 DSH preset），可在 Discord 私信里操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `chat_get_unread_messages` / `chat_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `dc-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 Discord，回复即自动应答
  - agent 请求工具审批时，转发到 Discord，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - Discord 的「回复」会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的；回复机器人自己的消息时会被视为必回
  - **图片/表情（含动图 GIF）**：附件图片、自定义表情与贴纸（Lottie 动画贴纸只留文字）经同一套 SSRF 防护传输下载后交给多模态模型；单条消息上限默认 8MB / 64MP / 5 张（`socialV2.media`）
  - MCP 发送工具支持可选 `replyToMessageId`，另有专用 `chat_reply` 工具（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `chat_send_message` 数组）

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
2. 一个 Discord bot 账号（[Developer Portal](https://discord.com/developers/applications) 里建 Application → Bot），并且：
   - 在 **Bot → Privileged Gateway Intents** 打开 **Message Content Intent**（必需）；
     想让 AI 拿到完整的服务器成员列表时再打开 **Server Members Intent**，并把 `discord.guildMembersIntent` 设为 `true`
   - 用 OAuth2 URL Generator（scope 选 `bot`）把 bot 邀请进你的服务器，至少给它目标频道的「查看频道 / 发送消息 / 读取消息历史 / 附加文件」权限
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。`config.json` 里是真实的 bot token，别发给任何人。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（进程启动凭据）。**通常应留空**：留空时桥接用 `~/.dsh/.credentials.yaml` 里持久化的签名密钥**离线铸造**会话 Cookie，不依赖任何进程期状态。只有显式填了才会优先走 token 交换 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `discord.token` | Discord bot token（Developer Portal → Bot → Reset Token）。留空时桥接照常启动，但不会连接 Discord |
| `discord.guildMembersIntent` | 默认 `false`。设为 `true` 时请求 Server Members Intent，用来拉完整成员列表（Developer Portal 里也要打开）；不开就只认得发过言的人 |
| `ownerId` | 管理员的 Discord **用户 id**（closed-agent 模式只接受此人的私信） |
| `agentPreset` | 聊天会话使用的 DSH agent preset，默认 `dc-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `dc-chat-v2` |
| `socialV2.initialPromptMaxChars` | 会话「初始提示词」（控制台为某个频道/私信预写的环境说明）的字数上限，默认 2000，允许 100~8000。越界值会在启动时收敛并保持原文件不动 |
| `socialV2.media` | 图片/表情的上限：`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）。越界值启动时收敛 |
| `webSearch.provider` | 联网搜索后端：`auto`（默认，优先 DeepSeek、失败回退 Bing）/ `deepseek`（仅 DeepSeek，无凭据时报错）/ `bing` |
| `webSearch.apiKeyEnv` / `apiKey` | 搜索凭据的环境变量名（默认 `DEEPSEEK_API_KEY`）/ 直接写死 key（不推荐）。都不设置时读 DSH 的 `$DSH_HOME/.credentials.yaml` 里同名 ref |
| `webSearch.baseURL` / `model` / `maxUses` / `maxResults` | 搜索端点（默认 `https://api.deepseek.com/anthropic/v1`，必须 https 且解析到公网）、模型（默认 `deepseek-v4-flash`）、单次搜索最多用几次工具、返回条数上限 |
| `workspaceTitle` | Discord 会话在 DSH 界面中的归组名称，默认「聊天」 |
| `allow.groups` / `allow.private` | 白名单：`allow.groups` 填**频道 id**，`allow.private` 填**用户 id**；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | 连续发送间隔，防止触发 Discord 频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |

> 💡 取 id：Discord「用户设置 → 高级」打开**开发者模式**，之后右键频道/用户 →「复制 ID」。

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 Discord 等于把 bot 的发言权交给了模型，建议先填白名单。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`dc-chat` / `dc-chat-v2`）并挂载 MCP。**单机新装同样必须执行这一步**（不是只有「另一台设备」才需要），装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `chat_send_message` 等工具收发消息时，DSH 会自动使用 `dc-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖。之后可在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换模式，控制台会同时写入 DSH 设置与本地兜底文件。

详细步骤见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 5 步。DSH 已安装并运行（**第 3 步最容易漏，漏了 Discord 上会毫无反应**）：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **装桥接并复制配置**
   ```bash
   git clone <本仓库地址> discord-bridge
   cd discord-bridge
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   **示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（这是刻意的 fail-closed 默认值）。白名单在第 4 步填。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但会话拿不到 `dc-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现同样是 Discord 上没反应。

4. **建 bot 并填写桥接配置**
   - 按「前置条件」建好 bot、打开 Message Content Intent、把 bot 邀请进服务器
   - 把 bot token 填进 `config.json` 的 `discord.token`，并把 `allow.groups` / `allow.private` 换成**你自己的频道 id / 用户 id**：

     ```json
     "discord": { "token": "你的 bot token", "guildMembersIntent": false },
     "allow": { "groups": ["频道 id"], "private": ["你的用户 id"] }
     ```

   Discord 的 id 是 17~20 位数字，超过 JavaScript 的安全整数范围，**请写成字符串**。

5. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `Discord 已连接：<bot 名>` 即成功；然后在白名单频道里 @ 机器人，或给它发私信测试。
   Windows 想要「崩溃自动重启」请改用 `start.bat`（见下节）。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启 DSH 通常不需要动桥接**：每 5 秒探活，DSH 不可用期间收到的 Discord 消息在桥接进程内排队（最多 50 条/会话，满后丢最旧项），恢复后尝试补投。桥接进程退出会丢失内存队列；断线期间已经结束的回复暂不保证补发。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `dsh/agent-presets/`（改完要跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] Discord 已连接：MyBot#1234
12:00:02 [bridge] 新会话 private:123456789012345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:123456789012345678: 你好
12:00:20 [bridge] agent 回复 (private:123456789012345678) 42 字
```

常见启动错误（都会打在日志里）：

| 日志 | 处理 |
| --- | --- |
| `config.json 的 discord.token 为空` | 填 `discord.token` 后重启桥接 |
| `Discord bot token 无效` | Developer Portal → Bot 重新生成 token |
| `Discord 拒绝了特权 intent` | Developer Portal → Bot 打开 Message Content Intent（开了 `guildMembersIntent` 还要打开 Server Members Intent） |
| `Discord 会话已失效（token 被重置？）` | 更新 `discord.token` 后重启桥接 |

## 自测（不需要 Discord）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 Discord 消息）：

```bash
npm run test:audit
npm run test:discord       # Discord 适配层（假 client，不连网）
```

reserved2 的 token 开销优化、消息水位协议专项离线回归可运行 `npm run test:token`，已包含在上面的完整回归中。

控制台「令牌与花费」看板的账本与价目表回归（峰谷分时、幂等折叠、基线合并、压缩与容错）：

```bash
npm run test:tokens        # 单元测试
npm run test:console-ui    # 离线浏览器回归（含看板渲染与逐轮下钻）
```

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 目录结构

```
discord-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  README.md / README.en.md / RULES.md   # 根目录只留这三个文档，其余全在 docs/
  docs/
    README.md           # 文档索引（每篇一句话 + 是否仍然有效）
    FOLDER_MAP.md       # 目录结构与 scripts/ 命名约定
    guides/             # 面向使用者/运维：DSH_SETUP / TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING / PRIVACY / SECURITY_BASELINE …
  audio/                # 语音库：把准备好的音频放这里，AI 可作音频附件发出（不入库）
  dsh/agent-presets/    # dc-chat / dc-chat-v2 的 DSH agent preset 模板
  plugins/
    discord-agent-presets  # DSH bundle：生成 preset 行 + 工具白名单守卫
    discord-mode-console   # DSH 插件：注册 discord-mode 设置命名空间
  roles/                # 人格提示词（角色扮演）
  src/
    bridge.js           # 主程序
    platform/discord.js # Discord 平台适配层（唯一碰 discord.js 的地方）
    mcp-discord-safe.js # 给 DSH 的 Discord 安全工具（MCP server）
    mcp-web-search-safe.js  # 给 DSH 的只读联网搜索（MCP server）
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    self-test.js        # DSH 侧自测
  scripts/              # 测试/运维脚本
  state/                # 运行时数据（不入库）
```

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）自动按句读/URL 边界分段；单条超过 Discord 的 2000 字上限时再按换行/空格切开
- 图片、自定义表情与贴纸可以通过安全下载接入多模态模型；音频/视频/普通文件以占位文本表示
- **发**语音是支持的（AI 工具与 `scripts/send-voice.mjs`）：以**音频附件**发出，不是 Discord 的「语音消息」格式（那需要 OGG/Opus 与波形数据）；**收**到的语音目前只显示占位文本，不做语音转写
- **AI 发语音默认关闭**（`socialV2.voice.enabled` 与 `tools.sendVoice` 默认 `false`）：先把音频放进 `audio/`，再到控制台打开开关
- Discord 自己渲染 Markdown，agent 的回复原文照发
- 不开 Server Members Intent 时，成员列表只包含发过言或已缓存的人

## 合规提醒

使用前请阅读并遵守 [Discord 开发者条款](https://discord.com/developers/docs/policies-and-agreements/developer-terms-of-service)、[开发者政策](https://discord.com/developers/docs/policies-and-agreements/developer-policy) 与所在服务器的规则。本项目会把 Discord 消息交给大语言模型处理，并让模型以 bot 身份发言——请事先告知服务器成员。
