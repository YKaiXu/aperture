# Aperture 🔭

**Universal AI Protocol Adapter** — OpenAI Responses API + Anthropic Messages API → any OpenAI-compatible backend, backed by Cloudflare AI Gateway.

**通用 AI 协议适配器** — 将 OpenAI Responses API 和 Anthropic Messages API 统一转换为 OpenAI Chat Completions，通过 Cloudflare AI Gateway 转发。

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

Routes through **Cloudflare AI Gateway** for caching, rate limiting, analytics — the Worker focuses solely on protocol translation.

通过 **Cloudflare AI Gateway** 提供缓存、限速、日志分析 — Worker 只专注于协议翻译。

---

## ✨ Features / 特色

| English | 中文 |
|---|---|
| 🔄 **Multi-Protocol** — Responses API + Messages API + Chat Completions | 🔄 **多协议兼容** — 三种 API 格式统一入口 |
| 🧠 **Tool Calling** — Full function/tool translation across formats | 🧠 **工具调用** — function/tool calling 跨协议互转 |
| 📡 **Streaming** — SSE for every API format | 📡 **流式输出** — 所有格式均支持 SSE 流式 |
| ⚡ **Edge Native** — Cloudflare Workers, 300+ locations | ⚡ **边缘原生** — 部署在 Cloudflare Workers 全球 300+ 节点 |
| ☁️ **AI Gateway** — Caching, rate limiting, logging handled by Gateway | ☁️ **AI Gateway 集成** — 缓存、限速、日志由 Gateway 处理 |
| 🔐 **Auth Passthrough** — Client auth forwarded directly to Gateway | 🔐 **认证透传** — 客户端认证直接转发给 Gateway |
| 📦 **Zero Dependencies** — Pure JS, fast cold starts | 📦 **零依赖** — 纯 JavaScript，极速冷启动 |
| ✅ **Tested** — 88 unit tests covering all translation logic | ✅ **测试覆盖** — 88 个单元测试覆盖全部翻译逻辑 |

---

## 🚀 Quick Start / 快速开始

### Prerequisites / 前置条件

**English:**

| Requirement | Details |
|---|---|
| **Cloudflare Account** | Required for Workers deployment. [Sign up](https://dash.cloudflare.com/sign-up) |
| **Wrangler CLI** | `npm install -g wrangler` — Cloudflare Workers CLI tool |
| **Node.js 18+** | Required for wrangler, not for the Worker itself |
| **AI Gateway** | Cloudflare AI Gateway for caching/analytics. [Setup guide](https://developers.cloudflare.com/ai-gateway/) |
| **Gateway API Key** | API key from your AI Gateway configuration |

**中文：**

| 条件 | 说明 |
|---|---|
| **Cloudflare 账号** | 部署 Worker 必需。[注册](https://dash.cloudflare.com/sign-up) |
| **Wrangler CLI** | `npm install -g wrangler` — Cloudflare Workers 命令行工具 |
| **Node.js 18+** | wrangler 需要，Worker 本身不需要 |
| **AI Gateway** | 提供缓存和分析能力。[配置指南](https://developers.cloudflare.com/ai-gateway/) |
| **Gateway API Key** | 你的 AI Gateway API 密钥 |

### Deploy / 部署

```bash
# 1. Clone
git clone https://github.com/YKaiXu/aperture.git
cd aperture

# 2. Install dependencies
npm install

# 3. Authenticate with Cloudflare
wrangler login

# 4. Set secrets (your AI Gateway auth token)
wrangler secret put AI_GATEWAY_TOKEN
wrangler secret put AI_GATEWAY_URL

# 5. Deploy
wrangler deploy
```

### Client Usage / 客户端使用

```bash
# Chat Completions (OpenAI SDK / any tool)
curl https://g2o.blogger.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"messages":[{"role":"user","content":"Hello!"}],"stream":true}'

# Anthropic Messages API (Claude Code, etc.)
curl https://g2o.blogger.workers.dev/v1/messages \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI Responses API
curl https://g2o.blogger.workers.dev/ \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"input":"Hello!"}'
```

**Model ID:** The Worker ignores the client's model ID and always forwards the configured `DEFAULT_MODEL` (default: `deepseek-v4-flash`). Model mapping is handled by the AI Gateway.

**认证：** Worker 将客户端的 `Authorization: Bearer` 头原样转发给 AI Gateway，由 Gateway 负责鉴权。Worker 本身不管理 API Key。

---

## 📋 Deployment Guide / 部署指南

### Step 1: Configure wrangler.jsonc

Edit `wrangler.jsonc` in the project root:

```jsonc
{
  "name": "g2o",                              // Your Worker name
  "main": "src/index.js",
  "compatibility_date": "2026-07-22",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "UPSTREAM_BASE_URL": "https://opencode.ai/zen/go/v1",
    "CUSTOM_PROVIDER_SLUG": "opencode-go",    // AI Gateway custom provider slug
    "DEFAULT_MODEL": "deepseek-v4-flash"      // Always forwarded to upstream
  }
}
```

### Step 2: Set Secrets

```bash
# Required: AI Gateway auth token (client sends this, Worker forwards it)
wrangler secret put AI_GATEWAY_TOKEN

# Required: AI Gateway base URL
wrangler secret put AI_GATEWAY_URL

# Optional: Upstream API key (fallback when AI_GATEWAY_TOKEN is not set)
wrangler secret put OPENCODE_API_KEY
```

**Secrets reference / 密钥说明：**

| Secret | Required | Purpose |
|---|---|---|
| `AI_GATEWAY_TOKEN` | ✅ Yes | Forwarded to AI Gateway as Bearer token. Client must send this. |
| `AI_GATEWAY_URL` | ✅ Yes | AI Gateway URL (e.g., `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}`) |
| `OPENCODE_API_KEY` | ❌ Optional | Upstream API key fallback |

### Step 3: AI Gateway Routing

```
Client → Aperture Worker → AI Gateway → Upstream API
                              ↓
                         Cached? → Return cached response
```

The Worker constructs the upstream URL as:
```
{AI_GATEWAY_URL}/custom-{CUSTOM_PROVIDER_SLUG}/v1/chat/completions
```

**Setup:**
1. **Create a Gateway** in [Cloudflare Dashboard → AI → AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
2. **Add a Custom Provider** (OpenAI Compatible):
   - Provider Slug: matches `CUSTOM_PROVIDER_SLUG` (e.g., `opencode-go`)
   - Base URL: your upstream API base URL (e.g., `https://opencode.ai/zen/go/v1`)
3. **Set env vars** in wrangler.jsonc:
   - `AI_GATEWAY_URL`: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}`
   - `CUSTOM_PROVIDER_SLUG`: your provider slug
4. **Set `AI_GATEWAY_TOKEN`** secret to your Gateway API key
5. **Set `AI_GATEWAY_URL`** secret to your Gateway URL
6. Deploy

---

## 📚 API Reference / API 参考

### OpenAI Responses API (`POST /`)

| Parameter | Type | Description |
|---|---|---|
| `input` | string \| array | Input text or content blocks |
| `instructions` | string | System instructions |
| `tools` | array | Function/tool definitions |
| `stream` | boolean | SSE streaming |
| `max_output_tokens` | number | Max tokens |
| `temperature` | number | Sampling temperature |
| `top_p` | number | Nucleus sampling |

### Anthropic Messages API (`POST /v1/messages`)

| Parameter | Type | Description |
|---|---|---|
| `messages` | array | Message objects |
| `system` | string \| array | System prompt |
| `tools` | array | Tool definitions |
| `thinking` | object | Thinking/reasoning config |
| `max_tokens` | number | Max tokens |
| `temperature` | number | Sampling temperature |

### Chat Completions (`POST /v1/chat/completions`)

Standard OpenAI Chat Completions passthrough. / 标准 OpenAI Chat Completions 直通。

---

## 🏗️ Architecture / 架构

```
Client ──→ Aperture Worker ──→ AI Gateway ──→ Upstream API
              │                     │
              │  Protocol            │  Caching
              │  Translation         │  Rate limiting
              │  - Responses → Chat  │  Logging
              │  - Anthropic → Chat  │  Auth verification
              │  - Chat passthrough  │  Model mapping
              │                     │
              │  Auth passthrough    │
              │  Logging (console)   │
```

**Aperture Worker 职责：** 纯协议翻译，不做策略决策。

| 做 | 不做 |
|---|---|
| 协议检测与路由 | 限速（交给 Gateway） |
| 请求格式翻译 | 模型映射（交给 Gateway） |
| 响应格式翻译 | 请求体大小检查（交给 Cloudflare 平台） |
| 流式 SSE 管道 | 重试/fallback（直接返回上游错误） |
| DeepSeek DSML 格式适配 | |
| 结构化日志（Observability） | |

---

## 📦 Project Structure / 项目结构

```
aperture/
├── src/
│   ├── index.js        # Router, handlers, DSML, logging
│   ├── upstream.js     # Minimal fetch wrapper to AI Gateway
│   ├── responses.js    # Responses API ↔ Chat translation
│   ├── anthropic.js    # Anthropic Messages ↔ Chat translation
│   └── utils.js        # Auth, CORS, SSE, structured logger
├── tests/
│   ├── setup.js        # Workers API mocks for Node.js
│   ├── utils.test.js   # Utility function tests (27 tests)
│   ├── responses.test.js
│   ├── anthropic.test.js
│   └── index.test.js   # Routing, DSML, stream filter (32 tests)
├── wrangler.jsonc
├── vitest.config.mjs
├── package.json
├── CODEBUDDY.md        # Project rules / 项目开发守则
└── README.md
```

---

## 🧪 Testing / 测试

```bash
# Run all 88 unit tests
npm test

# Watch mode
npm run test:watch
```

Tests cover pure translation functions (no Workers runtime needed). All tests use mocked Workers APIs via `tests/setup.js`.

---

## ⚙️ Configuration Reference / 配置说明

### Environment Variables / 环境变量

| Variable | Required | Default | English | 中文 |
|---|---|---|---|---|
| `AI_GATEWAY_TOKEN` | ✅ Yes | — | Forwarded to AI Gateway as Bearer token | 转发给 AI Gateway 的 Bearer token |
| `AI_GATEWAY_URL` | ✅ Yes | — | AI Gateway base URL | AI Gateway 基础 URL |
| `CUSTOM_PROVIDER_SLUG` | ❌ | — | Gateway custom provider slug | Gateway 自定义 Provider slug |
| `UPSTREAM_BASE_URL` | ❌ | `https://opencode.ai/zen/go/v1` | Upstream API base URL | 上游 API 基础 URL |
| `DEFAULT_MODEL` | ❌ | `deepseek-v4-flash` | Default model (always forwarded) | 默认模型（始终转发该值） |
| `OPENCODE_API_KEY` | ❌ | — | Upstream API key (fallback) | 上游 API 密钥（备用） |

---

## 🧪 Development / 本地开发

```bash
# Run tests
npm test

# Run locally
wrangler dev

# Deploy
wrangler deploy

# View live logs
npx wrangler tail g2o --format json

# Set secrets
wrangler secret put AI_GATEWAY_TOKEN
```

---

## 📄 License / 许可证

MIT — see [LICENSE](LICENSE).
