# 先登录，密钥只是备用

PocketPilot 默认使用电脑上各平台命令行**已经登录**的状态。API Key 不必填，只有命令行没登录、并且你在「平台与登录」里保存了密钥时才会用它。已经登录时，保存的密钥不会再传给子进程。

桌面程序 →「平台与登录」里每个平台都有「获取密钥指南」按钮，内容与本目录相同。

| 平台 | 指南 | 怎么开始 |
| --- | --- | --- |
| Cursor | [cursor.md](cursor.md) | 先 `cursor-agent login`，密钥备用 |
| Claude Code | [claude-code.md](claude-code.md) | 打开 `claude`，输入 `/login`，密钥备用 |
| Codex | [codex.md](codex.md) | 先 `codex login`，密钥备用 |
| Gemini CLI | [gemini.md](gemini.md) | 先运行 `gemini` 完成 Google 登录，密钥备用 |
| OpenCode | [opencode.md](opencode.md) | 先 `opencode auth login`，密钥备用 |
| Grok（xAI） | [grok.md](grok.md) | 有官方 `grok` 命令行就 `grok login`；没有则只能用密钥 |
| DeepSeek | [deepseek-harness.md](deepseek-harness.md) | 没有本机登录命令，需要密钥 |
| Trae CN | [trae-cn.md](trae-cn.md) | 编辑器只读历史；CLI 用它自己的 `login` |

图片说明：`*-steps.svg` 均为**示意图**（自绘，未登录截取）；`*-docs.png` 为官方**公开**文档页面的**真实截图**（无需登录）。
