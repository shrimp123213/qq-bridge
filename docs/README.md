# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档，其余全部在本目录下。
> 仓库目录结构与 `scripts/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。
>
> **状态标记**：✅ 仍然有效（按它做就对） · ⚠️ 部分过时（见备注）
>
> `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/` 以及 `guides/PROJECT_GUIDE.md`、`guides/VOICE.md`
> 被 `.gitignore` 排除，只是本地工作文档，**不在公开仓库里**，本索引也不再列出。

---

## guides/ —— 面向使用者 / 运维

| 文档 | 一句话说明 | 状态 |
| --- | --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装说明：`dc-chat` / `dc-chat-v2` preset 与两个 MCP server 怎么挂到目标设备的 DSH 上 | ✅ |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API、配置 | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`）怎么用 | ✅ |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：威胁主体、已实现的边界（准入/工具面/出站/控制台/落盘/网络）、已知残余风险、发布前回归清单、改动检查单 | ✅ **改动安全相关代码前必读** |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 提交前的隐私扫描（`npm run privacy-scan`）：内置规则、本地规则模板、误报怎么处理 | ✅ |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | **DSH 0.2.1 适配改动记录**（0.2.0 → 0.2.1）：P0 `{{cwd}}` 提示词变量被删（每回合直接 error、完全不回）、P1 `working_directory` 进全局层；含协议面零漂移的实测结论与逐条"判定无需改动"表 | ✅ **最新**；升级 DSH 前先看 §6 的增量清单 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | **DSH 0.2.0 适配改动记录**（v0.1.7 → v0.2.0）：逐条列出为适配 0.2.0-rc.2 做的改动（现象/为什么必须改/证据/怎么验证），以及「复核后判定兼容、因此没改」的部分 | ✅ 仍有效（0.2.1 未推翻其中任何结论）；升级 DSH 前先读 §10 的操作清单 |

---

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 从零装好并跑起来 | [../README.md](../README.md) 的「完整启动流程」 |
| 在新设备上把桥接接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 看 AI 烧了多少钱 / 计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| 升级 DSH 前先知道有哪些坑 | [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md)、[guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 提交前确认没把个人信息带进仓库 | [guides/PRIVACY.md](guides/PRIVACY.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
