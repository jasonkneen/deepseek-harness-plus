# 示例

[English](README.md) | 中文

展示多 provider 包与 engine-session 实验的可运行演示。每个子目录负责自己的配置、前置条件、命令和详细行为。

## multi-provider

多 provider 包叠加在 agent spine 之上：Gemini、MiniMax 与 Kimi 作为基于密钥的 LLM provider，外加 Claude Code（Agent SDK）与 Codex（app-server）委派后端。详见 [multi-provider 示例参考](multi-provider/README.zh.md)。

## engine-session

实验性整会话引擎：用原生 OAuth 通过 Claude Code 或 Codex 完整驱动一个持久化的 harness 会话，并把对话记录写入 harness 会话日志。详见 [engine-session 示例参考](engine-session/README.zh.md)。
