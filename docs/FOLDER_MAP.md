# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`scripts/` 里的命名约定是什么。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)。
>
> 新增目录/脚本时请顺手补一行。

---

## 一、顶层布局

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核**：主程序、Discord 适配层、DSH 客户端、两个 MCP server、黑话/语音/媒体共享库 | 不能动。`bridge.js` 是主程序（约 10,200 行）；`platform/discord.js` 是唯一直接碰 discord.js 的地方；`core/session-router.mjs` 管会话 key 的规范化。**目录里只应有源码** |
| `scripts/` | 测试 / 安装 / 探针 / 运维脚本（见第二节命名约定） | 测试脚本不能删 |
| `dsh/` | 要装进 DSH 的东西：`agent-presets/dc-chat`、`agent-presets/dc-chat-v2`（preset 的**权威源**）。DSH 0.1.7 起 preset 以 bundle patch 形式安装，patch 由 `scripts/build-agent-preset-patches.mjs` 从这里的源生成到 `plugins/discord-agent-presets/presets/` | 改 preset 会影响所有人设行为；改完必须重新生成 patch |
| `plugins/` | DSH 插件：`discord-mode-console`（暴露 `discord-mode` 设置命名空间；**只有 host 半**，浏览器 UI 卡片未实现）、`discord-agent-presets`（生成两个 preset 行 + 携带唯一的 `discord-tool-restrict.mjs` 工具守卫） | 改了要重装/重启 DSH |
| `public/` | 浏览器静态资源：`console.html`（桥接自带控制台，127.0.0.1:3100） | 目录里只应有这一个文件 |
| `roles/` | 人格卡（`小鲸鱼.md` / `傲娇助手.md` / `README.md`）：控制台「人格与角色」页可编辑，保存即生效 | 用户内容，别乱动 |
| `assets/` | 仓库用图片等资源（`deepseek娘.png`） | 别加体积大的二进制 |
| `audio/` | **语音库**（用户的真实音频）。AI 的语音工具与 `scripts/send-voice.mjs` 只能发这里的文件。`.gitignore` 排除 | **用户文件，绝不删除/移动** |
| `state/` | **运行时数据**（会话映射、模式、角色、黑话库、日志、锁、令牌）。`.gitignore` 排除 | **用户数据，绝不删除/移动** |
| `docs/` | 全部文档（见第三节） | 见第三节 |
| `node_modules/` | 依赖 | 忽略 |
| `config.json` | 运行配置（含 Discord bot token，**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

---

## 二、`scripts/` 命名约定

脚本共 73 个文件（70 个 `.mjs` + 2 个控制台回归 JSON 基线 + 1 个隐私规则模板）。按前缀区分用途：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | **自动化测试**。其中被 `scripts/test-audit.mjs` 列进 `tests[]` 的那些会跑在 `npm run test:audit` 里（离线、不发真 Discord 消息、不用生产凭据） | 保留，改动需同步 test-audit 清单 |
| `test-discord-adapter.mjs` | Discord 适配层回归（假 client，不连网）：入站消息段、bot 过滤、提醒限制、超长切分等（`npm run test:discord`） | 保留 |
| `test-dsh-*.mjs` | **需要活的 DSH**（不在 `test:audit` 里）：`test-dsh-auth.mjs`（鉴权链路）、`test-dsh-inbox-projection.mjs`（会话队列投影解析，离线）、`test-dsh-session-retire.mjs`（退役会话的端到端回归）、`test-dsh-v2-wait.mjs`（preset 工具面） | 保留（改 DSH 契约时必须跑） |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-protocol` / `-security` / `-setup` 及其 `-guards` / `-security-mcp` / `-regressions`），被上一个直接运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` | 控制台**离线浏览器回归**与基线（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 保留（基线只在后端契约真变时才重录） |
| `test-console.mjs` | 对**运行中的桥接**跑控制台 API；其中「测试发送」会真的发一条消息到测试频道 | 保留，但注意会真的发消息 |
| `send-voice.mjs` | **真发送**小工具：把语音库里的音频当附件发到白名单频道/私信，走桥接的 `/api/voice/send`（与 AI 工具同一条白名单/限流路径） | 保留，但注意会真的发消息 |
| `setup-dsh.mjs` | **安装/初始化**：把 preset、MCP 挂载写进目标设备的 DSH（幂等） | 保留 |
| `build-agent-preset-patches.mjs` | 从 `dsh/agent-presets/` 生成 `plugins/discord-agent-presets/presets/*.patch.yml` | 保留（改 preset 后必跑） |
| `verify-*.mjs` | **一致性校验**：`verify-dsh-021-adaptation.mjs`（DSH 适配；`npm run verify:adaptation`）、`verify-persona-config.mjs`（人格配置）、`verify-agent-presets-017.mjs`（在运行中的 DSH 上确认 preset 已注册） | 保留 |
| `probe-*.mjs` | **探针**：用来问 DSH「实际支持什么」（RPC 形状、工具清单、事件流、工作区、模型、协议帧、settings 命名空间）。鉴权统一走 `probe-auth.mjs` | 保留，按需重跑 |
| `probe-020-protocol.mjs` / `probe-020-settings.mjs` | 0.2.0 版探针：前者采样 `session/control` baseline、`session/projections`、`session/follow`、`$events`、`session/cancel` 的**原始帧结构**；后者列 settings 命名空间并**幂等写回**验证 `discord-mode` 可写。控制台「改模式不生效」时的第一手诊断 | 保留（`npm run probe:protocol` / `probe:settings`） |
| `scan-dsh-tool-names.mjs` + `dsh-tool-names.mjs` | **工具名对账**：从已安装的 DSH 包里抽真实工具名，与工具守卫的 restrict 名单双向求差（防拼错假名静默失效 / 防新版本新增能力漏隐藏）。抽取实现只有 `dsh-tool-names.mjs` 一份，`test-preset-local-tools.mjs` 与 `scan-dsh-tool-names.mjs` 共用 | 保留（每次升级 DSH 后跑一次） |
| `audit-bridge-harness.mjs` | 虚拟平台 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` 使用） | 保留 |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `diagnose-acl.mjs` | 只读盘点：列出仓库里所有被**切断 ACL 继承**的路径，分「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类，并对后者打印恢复继承的命令。背景见 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) §2.6。**必须在无沙箱终端跑**（沙箱禁止以管道 stdio 拉起 icacls） | 保留（`npm run diagnose:acl`） |
| `privacy-scan.mjs` + `privacy-rules.example.json` | 提交前隐私扫描，见 [guides/PRIVACY.md](guides/PRIVACY.md) | 保留 |
| `dsh-modules.mjs` | 小工具：按路径加载 DSH 安装内的模块 | 保留 |

---

## 三、`docs/` 结构

```
docs/
├── README.md     # 文档索引（每篇一句话 + 是否仍然有效）  ← 先看这个
├── FOLDER_MAP.md # 本文件
└── guides/       # 面向使用者/运维：DSH_SETUP / DSH_020_ADAPTATION / DSH_021_ADAPTATION / SECURITY_BASELINE / TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING / PRIVACY
```

> ⚠️ `.gitignore` 把 `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/` 以及
> `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` **整体排除**了（这批本地文档里扫出过含本机真实路径的内容）。
> **要公开的新文档请放 `docs/guides/`**；放进那几处 = 只在本机可见，`git add` 会直接被 .gitignore 挡下。

规则：**根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档**，其余一律进 `docs/` 对应子目录，
并在 [README.md](README.md) 索引里登记一行（含「仍然有效 / 被谁取代」）。

**千万别当"过期脚本"清掉**：

- `scripts/test-audit.mjs` 清单里的每一个（完整清单见该文件 `tests[]` 数组）
- `scripts/console-ui-*.json` / `console-ui-fixture.mjs`（控制台回归基线）
- `scripts/audit-bridge-harness.mjs`、`scripts/dsh-modules.mjs`、`scripts/dsh-tool-names.mjs`（被测试/工具引用）
- `scripts/harden-state-acl.mjs`（`start.bat` 依赖）
