# Aperture 🔭

**Universal AI Protocol Adapter** — OpenAI Responses API + Anthropic Messages API → any OpenAI-compatible backend, backed by Cloudflare AI Gateway.

**通用 AI 协议适配器** — 将 OpenAI Responses API 和 Anthropic Messages API 统一转换为 OpenAI Chat Completions，通过 Cloudflare AI Gateway 提供缓存/限速/日志能力。

[![Deploy to Cloudflare](https://img.shields.io/badge/Deploy-Cloudflare_Workers-F38020?logo=cloudflare)](https://dash.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌟 Why Aperture? / 为什么选择 Aperture?

AI SDKs and tools speak different protocols. Aperture unifies them into a single edge proxy so your **backend only needs one format**, while clients can use any SDK.

AI SDK 和工具使用不同的协议。Aperture 将它们统一到一个边缘代理，**后端只需支持一种格式**（Chat Completions），客户端可以使用任意 SDK。

| Client SDK → | Aperture translates → | Upstream gets |
|---|---|---|
| OpenAI Responses API | ✅ | Chat Completions |
| Anthropic Messages API | ✅ | Chat Completions |
| OpenAI Chat Completions | ✅ (passthrough) | Chat Completions |

Plus, routes through **Cloudflare AI Gateway** for caching, rate limiting, analytics, and auto retries.

同时通过 **Cloudflare AI Gateway** 提供缓存、限速、日志和自动重试能力。

---

## ✨ Features / 特色

| English | 中文 |
|---|---|
| 🔄 **Multi-Protocol** — Responses API + Messages API + Chat Completions | 🔄 **多协议兼容** — 三种 API 格式统一入口 |
| 🧠 **Tool Calling** — Full function/tool translation across formats | 🧠 **工具调用** — function/tool calling 跨协议互转 |
| 📡 **Streaming** — SSE for every API format | 📡 **流式输出** — 所有格式均支持 SSE 流式 |
| ⚡ **Edge Native** — Cloudflare Workers, 300+ locations | ⚡ **边缘原生** — 部署在 Cloudflare Workers 全球 300+ 节点 |
| ☁️ **AI Gateway** — Built-in caching, rate limiting, logs, retries | ☁️ **AI Gateway 集成** — 缓存、限速、日志、重试开箱即用 |
| 🔀 **Model Mapping** — Map any client model (e.g. `dv4f` → `deepseek-v4-flash`) | 🔀 **模型映射** — 任意客户端模型名映射到真实模型 |
| 🔐 **Pluggable Auth** — Bearer token or x-api-key | 🔐 **灵活认证** — 支持 Bearer token 或 x-api-key |
| 📦 **Zero Dependencies** — Pure JS, fast cold starts | 📦 **零依赖** — 纯 JavaScript，极速冷启动 |

---

## 🚀 Quick Start / 快速开始

### Prerequisites / 前置条件

**English:**

| Requirement | Details |
|---|---|
| **Cloudflare Account** | Required for Workers deployment. [Sign up](https://dash.cloudflare.com/sign-up) |
| **Wrangler CLI** | `npm install -g wrangler` — Cloudflare Workers CLI tool |
| **Node.js 18+** | Required for wrangler, not for the Worker itself |
| **Upstream API Key** | API key from your AI provider (e.g., OpenCode, OpenAI, etc.) |
| **AI Gateway** (optional) | Cloudflare AI Gateway for caching/analytics. [Setup guide](https://developers.cloudflare.com/ai-gateway/) |

**中文：**

| 条件 | 说明 |
|---|---|
| **Cloudflare 账号** | 部署 Worker 必需。[注册](https://dash.cloudflare.com/sign-up) |
| **Wrangler CLI** | `npm install -g wrangler` — Cloudflare Workers 命令行工具 |
| **Node.js 18+** | wrangler 需要，Worker 本身不需要 |
| **上游 API Key** | 你的 AI 提供商 API 密钥 |
| **AI Gateway**（可选） | Cloudflare AI Gateway，提供缓存和分析能力 |

### Deploy / 部署

```bash
# 1. Clone
git clone https://github.com/YKaiXu/aperture.git
cd aperture

# 2. Install wrangler (if not installed)
npm install -g wrangler

# 3. Authenticate
wrangler login

# 4. Configure wrangler.jsonc
#    Edit the file to set your upstream URL, model mapping, etc.

# 5. Set secrets (required)
wrangler secret put AI_GATEWAY_TOKEN

# 6. Deploy
wrangler deploy
```

### Client Usage / 客户端使用

```bash
# OpenAI Responses API
curl https://aperture.your.workers.dev/ \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"dv4f","input":"Hello!"}'

# Anthropic Messages API
curl https://aperture.your.workers.dev/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"dv4f","messages":[{"role":"user","content":"Hello!"}]}'

# Chat Completions
curl https://aperture.your.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"dv4f","messages":[{"role":"user","content":"Hello!"}]}'
```

---

## 📋 Deployment Guide / 部署指南

### Step 1: Configure wrangler.jsonc

Edit `wrangler.jsonc` in the project root:

```jsonc
{
  "name": "aperture",                    // Your Worker name
  "main": "src/index.js",
  "compatibility_date": "2026-07-22",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "UPSTREAM_BASE_URL": "https://opencode.ai/zen/go/v1",  // Your upstream API
    "AI_GATEWAY_URL": "",                // Set to enable AI Gateway routing
    "CUSTOM_PROVIDER_SLUG": "",          // Gateway custom provider slug
    "DEFAULT_MODEL": "deepseek-v4-flash",// Fallback model
    "MODEL_MAP": "{}",                   // Client→real model mapping
    "REQUEST_TIMEOUT_MS": "120000",      // Upstream timeout
    "RATE_LIMIT_MAX": "120",            // Max requests per window
    "RATE_LIMIT_WINDOW_MS": "60000"     // Rate limit window
  }
}
```

### Step 2: Set Secrets

```bash
# Required: Set the auth token clients will use
wrangler secret put AI_GATEWAY_TOKEN

# Optional: Upstream API key (used as fallback or for direct routing)
wrangler secret put OPENCODE_API_KEY
```

**Secrets reference / 密钥说明：**

| Secret | Required | Purpose |
|---|---|---|
| `AI_GATEWAY_TOKEN` | ✅ Yes | Token used for client authentication. Also used as Gateway auth when `AI_GATEWAY_URL` is set. |
| `OPENCODE_API_KEY` | ❌ Optional | Upstream API key. Used as fallback when `AI_GATEWAY_TOKEN` is not set, or for direct (non-gateway) routing. |

### Step 3: Two Routing Modes / 两种路由模式

#### Mode A: Direct Routing (Simple) / 直连模式（简单）

Worker → Upstream API directly.

```
Client → Aperture Worker → Upstream API
```

**Setup:**
1. Leave `AI_GATEWAY_URL` empty in wrangler.jsonc
2. Set `OPENCODE_API_KEY` secret with your upstream API key
3. Set `UPSTREAM_BASE_URL` to your provider's base URL (defaults to OpenCode)

#### Mode B: AI Gateway Routing (Recommended) / AI Gateway 路由（推荐）

Worker → Cloudflare AI Gateway → Upstream API. Provides caching, analytics, rate limiting.

```
Client → Aperture Worker → AI Gateway → Upstream API
                              ↓
                         Cached? → Return cached response
```

**Setup:**
1. **Create a Gateway** in [Cloudflare Dashboard → AI → AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
2. **Add a Custom Provider** (OpenAI Compatible):
   - Provider Slug: e.g., `my-provider`
   - Base URL: your upstream API base URL (e.g., `https://opencode.ai/zen/go/v1`)
3. **Set env vars** in wrangler.jsonc:
   - `AI_GATEWAY_URL`: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}`
   - `CUSTOM_PROVIDER_SLUG`: your provider slug (e.g., `my-provider`)
4. **Set `AI_GATEWAY_TOKEN`** secret to your Gateway token (or any token for client auth)
5. Deploy

**Important:** When using AI Gateway, the Worker constructs the upstream URL as:
```
{AI_GATEWAY_URL}/custom-{slug}/v1/chat/completions
```
Make sure your custom provider's `base_url` and the path `/v1/chat/completions` combine to form the correct upstream endpoint. For example:
- `base_url` = `https://opencode.ai/zen/go/v1`
- Worker constructs: `{gateway_url}/custom-opencode-go/v1/chat/completions`
- Gateway proxies to: `https://opencode.ai/zen/go/v1/v1/chat/completions` (double `/v1/` is handled gracefully)

**Gateway 模式重要说明：** Worker 构建的上游 URL 格式为 `{AI_GATEWAY_URL}/custom-{slug}/v1/chat/completions`。确保自定义 Provider 的 `base_url` 与路径 `/v1/chat/completions` 组合后能正确访问上游。

### Step 4: Model Mapping / 模型映射

Map any client-facing model name to a real model:

```jsonc
"MODEL_MAP": "{\"dv4f\":\"deepseek-v4-flash\",\"gpt4\":\"deepseek-v4-flash\"}"
```

Clients send `dv4f` → Worker translates to `deepseek-v4-flash` → upstream receives the real model name.

---

## 📚 API Reference / API 参考

### OpenAI Responses API (`POST /`)

**English:**
Full Responses API support with tool calling and streaming.

**中文：**
完整的 Responses API 支持，含工具调用和流式输出。

| Parameter | Type | Description |
|---|---|---|
| `input` | string \| array | Input text or content blocks |
| `instructions` | string | System instructions |
| `tools` | array | Function/tool definitions |
| `stream` | boolean | SSE streaming |
| `max_output_tokens` | number | Max tokens |
| `temperature` | number | Sampling temperature |
| `top_p` | number | Nucleus sampling |

<details>
<summary>Example / 示例</summary>

```json
{
  "model": "dv4f",
  "input": "What's the weather in Tokyo?",
  "instructions": "You are a helpful assistant.",
  "tools": [{
    "type": "function",
    "name": "get_weather",
    "description": "Get weather for a city",
    "parameters": {
      "type": "object",
      "properties": {
        "location": { "type": "string" }
      },
      "required": ["location"]
    }
  }],
  "stream": true
}
```
</details>

### Anthropic Messages API (`POST /v1/messages`)

**English:**
Full Messages API compatibility with tool calling and streaming.

**中文：**
完整的 Messages API 兼容，含工具调用和流式输出。

| Parameter | Type | Description |
|---|---|---|
| `messages` | array | Message objects |
| `system` | string \| array | System prompt |
| `tools` | array | Tool definitions |
| `stream` | boolean | SSE streaming |
| `max_tokens` | number | Max tokens |
| `temperature` | number | Sampling temperature |

<details>
<summary>Example / 示例</summary>

```json
{
  "model": "dv4f",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "system": "You are Claude, but powered by Aperture.",
  "max_tokens": 1024,
  "stream": true
}
```
</details>

### Chat Completions (`POST /v1/chat/completions`)

Standard OpenAI Chat Completions passthrough. / 标准 OpenAI Chat Completions 直通。

---

## ☁️ AI Gateway Integration / AI Gateway 集成

### Benefits / 优势

| Feature | English | 中文 |
|---|---|---|
| 🗳️ **Caching** | Repeated identical requests served from cache (TTL configurable) | 相同请求从缓存返回（TTL 可配置） |
| 📊 **Analytics** | Every request logged with tokens, latency, status | 每次请求记录 tokens、延迟、状态 |
| 🚦 **Rate Limiting** | Per-user or per-gateway rate limits | 用户级或网关级限速 |
| 🔁 **Auto Retry** | Automatic retries on upstream failures | 上游失败时自动重试 |
| 🛡️ **Guardrails** | Content moderation at gateway level | 网关级内容审查 |

### Verify Gateway Logs / 查看 Gateway 日志

```bash
# Replace ACCOUNT_ID and GATEWAY_ID with your values
curl "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

Sample log entry:
```
custom-opencode-go | deepseek-v4-flash | v1/chat/completions | 200 | cached=true
```
`cached=true` means the response was served from Cloudflare's cache — zero latency, zero cost.

---

## ⚙️ Configuration Reference / 配置说明

### Environment Variables / 环境变量

| Variable | Required | Default | English | 中文 |
|---|---|---|---|---|
| `AI_GATEWAY_TOKEN` | ✅ (one of) | — | Auth token for clients & Gateway | 客户端和 Gateway 认证令牌 |
| `OPENCODE_API_KEY` | ✅ (one of) | — | Upstream API key (fallback) | 上游 API 密钥（备用） |
| `AI_GATEWAY_URL` | ❌ | — | Enable AI Gateway routing | 启用 AI Gateway 路由 |
| `CUSTOM_PROVIDER_SLUG` | ❌ | — | Gateway custom provider slug | Gateway 自定义 Provider slug |
| `UPSTREAM_BASE_URL` | ❌ | `https://opencode.ai/zen/go/v1` | Upstream API base URL | 上游 API 基础 URL |
| `DEFAULT_MODEL` | ❌ | `deepseek-v4-flash` | Fallback model | 默认模型 |
| `MODEL_MAP` | ❌ | `{}` | JSON model mappings | JSON 模型映射 |
| `REQUEST_TIMEOUT_MS` | ❌ | `120000` | Upstream timeout (ms) | 上游超时（毫秒） |
| `RATE_LIMIT_MAX` | ❌ | `120` | Max requests per window | 窗口内最大请求数 |
| `RATE_LIMIT_WINDOW_MS` | ❌ | `60000` | Rate limit window (ms) | 限速窗口（毫秒） |

### Model Mapping Examples / 模型映射示例

```jsonc
// wrangler.jsonc
"MODEL_MAP": "{\"dv4f\":\"deepseek-v4-flash\",\"gpt4\":\"deepseek-v4-flash\"}"
```

```bash
# Client sends:
curl -d '{"model":"dv4f","messages":[...]}'

# Worker translates to: deepseek-v4-flash
# Upstream receives: deepseek-v4-flash
```

---

## 🏗️ Architecture / 架构

```
┌─────────────┐     ┌─────────────────────────────────────┐     ┌──────────────┐
│   Client    │────▶│         Aperture Worker              │────▶│   Upstream   │
│ (any SDK)   │     │                                       │     │  (OpenAI     │
│             │     │  ┌───────────┐  ┌─────────────────┐  │     │  Compatible) │
│ OpenAI SDK  │     │  │ Route     │  │ Translate       │  │     │              │
│ Anthropic   │     │  │ Detect    │──▶│ Responses→Chat  │  │     │  OpenCode    │
│ SDK         │     │  │           │  │ Anthropic→Chat  │  │     │  DeepSeek    │
│ Custom HTTP │     │  │ /v1/chat  │  │ Chat→Chat       │  │     │  or any      │
└─────────────┘     │  │ /v1/msg   │  └─────────────────┘  │     │  provider    │
                    │  │ / (resp)  │  ┌─────────────────┐  │     └──────┬───────┘
                    │  └───────────┘  │ Model Mapping   │  │            │
                    │                 │ dv4f→real model │  │     ┌──────▼───────┐
                    │                 └─────────────────┘  │     │  AI Gateway  │
                    │  ┌────────────────────────────────┐  │     │  (optional)  │
                    │  │ Auth / Rate Limit / CORS       │  │     │  cache/logs  │
                    │  └────────────────────────────────┘  │     └──────────────┘
                    └─────────────────────────────────────┘
```

---

## 📦 Project Structure / 项目结构

```
aperture/
├── src/
│   ├── index.js        # Router, handlers, auth / 路由、处理、认证
│   ├── upstream.js     # Upstream API client / 上游 API 客户端
│   ├── responses.js    # Responses API ↔ Chat translation / Responses 转换
│   ├── anthropic.js    # Anthropic Messages ↔ Chat translation / Anthropic 转换
│   └── utils.js        # Auth, rate limiter, SSE / 认证、限速、SSE
├── wrangler.jsonc      # Worker config / Worker 配置
├── package.json        # Project metadata / 项目元数据
└── README.md           # This file / 本文件
```

---

## 🛡️ Security / 安全

| English | 中文 |
|---|---|
| **Edge Authentication** — Requests authenticated at Cloudflare edge before reaching your upstream | **边缘认证** — 在 Cloudflare 边缘验证请求，不直接暴露上游 |
| **Secrets Management** — API keys stored as Cloudflare Secrets, never in code | **密钥管理** — API 密钥通过 Cloudflare Secrets 存储，不入代码 |
| **CORS** — Full CORS support for browser clients | **CORS** — 浏览器客户端完整跨域支持 |
| **Rate Limiting** — Built-in sliding window rate limiter | **速率限制** — 内置滑动窗口限速器 |
| **Input Validation** — JSON payload size limit (1MB), structure validation | **输入验证** — JSON 载荷限制 1MB，结构验证 |

---

## 🧪 Development / 本地开发

```bash
# Run locally
wrangler dev

# Deploy
wrangler deploy

# Set secrets
wrangler secret put AI_GATEWAY_TOKEN
wrangler secret put OPENCODE_API_KEY
```

---

## 🤝 Contributing / 贡献

PRs welcome! / 欢迎提交 PR！

1. Ensure all three API formats work / 确保三种 API 格式正常工作
2. Streaming should work for your changes / 流式输出正常
3. Gateway integration tested if applicable / 如有涉及 Gateway 需测试

---

## 📄 License / 许可证

MIT — see [LICENSE](LICENSE).

---

## 🙏 Credits / 致谢

Built on [Cloudflare Workers](https://workers.cloudflare.com/). Inspired by the need for universal AI protocol compatibility.

基于 [Cloudflare Workers](https://workers.cloudflare.com/) 构建。
