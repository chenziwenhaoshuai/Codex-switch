# Codex Switch

English | [中文](#中文)

Codex Switch is a native macOS utility that keeps Codex connected to a stable local OpenAI-compatible endpoint while letting you switch real API providers from a small desktop app.

```text
Codex -> http://127.0.0.1:8787/v1 -> active provider
```

## Motivation

Codex usually works best when its API base URL stays stable. In real work, though, developers often switch between providers, gateways, keys, and model names.

Restarting Codex every time you change an upstream provider is annoying. Codex Switch keeps Codex pointed at one local URL and moves provider switching into a local router.

## Features

- Native macOS SwiftUI app.
- Bundled local Python router.
- Switch API providers without restarting Codex.
- Per-provider API key, base URL, default model, and model-mapping rules.
- Optional per-provider model mapping.
- One-click update for Codex's `custom` provider `base_url`.
- Local logs for debugging.

## Privacy And Safety

This repository does not include real API keys, private provider URLs, runtime logs, or local provider config.

Runtime files stay on your machine:

```text
~/Library/Application Support/Codex Switch/providers.json
~/Library/Application Support/Codex Switch/logs/
```

Provider API keys are sent upstream as:

```text
Authorization: Bearer <API Key>
```

Do not commit your local `providers.json`, `.env`, logs, DMGs, or build output. They are ignored by default.

## Configure Codex

Point Codex at the local router:

```sh
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
codex
```

Or open Codex Switch Settings and click:

```text
Set Codex custom base_url
```

That only updates `base_url` for `[model_providers.custom]` in `~/.codex/config.toml`. It does not rename or replace your provider.

Example:

```toml
model_provider = "custom"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:8787/v1"
```

## Provider Config

Provider config is stored locally at:

```text
~/Library/Application Support/Codex Switch/providers.json
```

Example shape:

```json
{
  "activeProviderId": "openai",
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "",
      "enabled": true,
      "headers": {},
      "defaultModel": "",
      "modelMapping": {
        "enabled": false,
        "targetModel": ""
      }
    }
  ]
}
```

If `modelMapping.enabled` is `true`, Codex Switch rewrites a JSON request's top-level `model` field to `modelMapping.targetModel`. If `targetModel` is empty, it falls back to `defaultModel`.

## Build

Requirements:

- macOS 13+
- Swift toolchain
- `create-dmg`

Install `create-dmg`:

```sh
brew install create-dmg
```

Build:

```sh
./scripts/build-dmg.sh
```

Output:

```text
ByteRouterApp/build/Codex Switch.app
ByteRouterApp/Codex Switch.dmg
```

The build script uses ad-hoc signing for local testing. For public distribution, sign and notarize with your own Apple Developer ID.

## Project Layout

```text
ByteRouterApp/
  ByteRouterApp/
    ContentView.swift            # macOS UI
    ProviderStore.swift          # provider config persistence
    ProxyProcessManager.swift    # launches bundled Python router
    Resources/proxy.py           # local HTTP router
scripts/build-dmg.sh             # local app and DMG build script
providers.example.json           # safe example config
```

## License

MIT. Copyright © 2026 Ziwen.

---

## 中文

Codex Switch 是一个原生 macOS 小工具。它让 Codex 始终连接到稳定的本地 OpenAI-compatible 地址，同时可以在桌面应用里切换真正的上游 API 供应商。

```text
Codex -> http://127.0.0.1:8787/v1 -> 当前选中的供应商
```

## 动机

Codex 更适合使用稳定的 API Base URL。但实际使用中，我们经常需要切换不同的 API 供应商、网关、Key 和模型名。

每次切换上游都重启 Codex 很打断工作流。Codex Switch 的思路是：让 Codex 永远访问本地地址，把供应商切换交给本地路由器。

## 功能

- 原生 macOS SwiftUI 应用。
- 内置本地 Python 路由器。
- 不重启 Codex 即可切换 API 供应商。
- 每个供应商独立配置 API Key、Base URL、默认模型和模型映射策略。
- 支持按供应商进行模型名统一映射。
- 一键更新 Codex `custom` provider 的 `base_url`。
- 本地日志，方便调试请求和响应。

## 隐私与安全

仓库不会包含真实 API Key、私有供应商地址、运行日志或本地供应商配置。

运行时文件只保存在本机：

```text
~/Library/Application Support/Codex Switch/providers.json
~/Library/Application Support/Codex Switch/logs/
```

供应商 API Key 会以如下方式转发给上游：

```text
Authorization: Bearer <API Key>
```

请不要提交本地的 `providers.json`、`.env`、日志、DMG 或构建产物。这些文件默认已被 `.gitignore` 忽略。

## 配置 Codex

让 Codex 指向本地路由：

```sh
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
codex
```

也可以打开 Codex Switch 的 Settings，点击：

```text
Set Codex custom base_url
```

这个按钮只会更新 `~/.codex/config.toml` 中 `[model_providers.custom]` 的 `base_url`，不会重命名或替换你的 provider。

示例：

```toml
model_provider = "custom"

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://127.0.0.1:8787/v1"
```

## 供应商配置

供应商配置保存在：

```text
~/Library/Application Support/Codex Switch/providers.json
```

示例结构：

```json
{
  "activeProviderId": "openai",
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "",
      "enabled": true,
      "headers": {},
      "defaultModel": "",
      "modelMapping": {
        "enabled": false,
        "targetModel": ""
      }
    }
  ]
}
```

如果 `modelMapping.enabled` 为 `true`，Codex Switch 会把 JSON 请求顶层的 `model` 字段改写为 `modelMapping.targetModel`。如果 `targetModel` 为空，则使用该供应商的 `defaultModel`。

## 构建

要求：

- macOS 13+
- Swift 工具链
- `create-dmg`

安装 `create-dmg`：

```sh
brew install create-dmg
```

构建：

```sh
./scripts/build-dmg.sh
```

输出：

```text
ByteRouterApp/build/Codex Switch.app
ByteRouterApp/Codex Switch.dmg
```

构建脚本使用 ad-hoc 签名，适合本地测试。如果要公开分发，请使用自己的 Apple Developer ID 进行签名和公证。

## 目录结构

```text
ByteRouterApp/
  ByteRouterApp/
    ContentView.swift            # macOS 界面
    ProviderStore.swift          # 供应商配置持久化
    ProxyProcessManager.swift    # 启动内置 Python 路由器
    Resources/proxy.py           # 本地 HTTP 路由器
scripts/build-dmg.sh             # 本地 App 和 DMG 构建脚本
providers.example.json           # 安全的示例配置
```

## 许可证

MIT。Copyright © 2026 Ziwen.
