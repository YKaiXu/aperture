# Aperture 🔭

> **Universal AI Protocol Adapter** — Speak OpenAI Responses API or Anthropic Messages API, translate to any OpenAI-compatible backend. Backed by Cloudflare AI Gateway.

[![Deploy to Cloudflare](https://img.shields.io/badge/Deploy-Cloudflare Workers-F38020?logo=cloudflare)](https://dash.cloudflare.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌟 Why Aperture?

AI SDKs and tools speak different protocols — OpenAI Responses API, Anthropic Messages API, Chat Completions. Aperture unifies them all into a single edge proxy so your **backend only needs one format** (OpenAI Chat Completions), while your clients can use any SDK they want.

| Client SDK → | Aperture translates → | Upstream gets |
|---|---|---|
| OpenAI Responses API | ✅ | Chat Completions |
| Anthropic Messages API | ✅ | Chat Completions |
| OpenAI Chat Completions | ✅ (passthrough) | Chat Completions |

Plus, Aperture routes everything through **Cloudflare AI Gateway** for caching, rate limiting, analytics, and automatic retries — at no extra cost.

---

## ✨ Features

- **🔄 Multi-Protocol** — OpenAI Responses API + Anthropic Messages API + Chat Completions, all on one Worker
- **🧠 Tool / Function Calling** — Full tool call translation between all formats
- **📡 Streaming** — SSE streaming for every API format
- **⚡ Edge Native** — Deploys to Cloudflare Workers, 300+ locations globally
- **☁️ AI Gateway** — Built-in Cloudflare AI Gateway integration (caching, rate limiting, logs, retries)
- **🔀 Model Mapping** — Map any client model name to any real model (e.g. `dv4f` → `deepseek-v4-flash`)
- **🔐 Pluggable Auth** — Supports API tokens, Gateway tokens, and custom auth
- **📦 Zero Dependencies** — No npm packages, pure JavaScript, fast cold starts

---

## 🚀 Quick Start

### 1. Deploy

```bash
# Install wrangler
npm install -g wrangler

# Clone and deploy
git clone https://github.com/YOUR_USER/aperture.git
cd aperture
wrangler deploy
```

### 2. Configure Secrets

```bash
# Set your upstream API key
wrangler secret put AI_GATEWAY_TOKEN

# Or for direct (non-gateway) routing:
wrangler secret put OPENCODE_API_KEY
```

### 3. Configure Gateway (optional)

Set these in `wrangler.jsonc` or Cloudflare Dashboard:

| Variable | Purpose | Example |
|---|---|---|
| `AI_GATEWAY_URL` | AI Gateway endpoint | `https://gateway.ai.cloudflare.com/v1/{acct}/{gateway}` |
| `CUSTOM_PROVIDER_SLUG` | Gateway custom provider slug | `my-provider` |
| `DEFAULT_MODEL` | Fallback model | `deepseek-v4-flash` |
| `MODEL_MAP` | Client→real model mapping | `{"dv4f":"deepseek-v4-flash"}` |

### 4. Use It

```bash
# OpenAI Responses API
curl https://aperture.your.workers.dev/ \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"dv4f","input":"Hello!"}'

# Anthropic Messages API
curl https://aperture.your.workers.dev/v1/messages \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"dv4f","messages":[{"role":"user","content":"Hello!"}]}'

# Chat Completions (passthrough)
curl https://aperture.your.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"dv4f","messages":[{"role":"user","content":"Hello!"}]}'
```

---

## 📚 API Reference

### OpenAI Responses API (`POST /`)

Full Responses API support including:

- `input` — string or array of content blocks
- `instructions` — system instructions
- `tools` — function/tool definitions
- `stream` — SSE streaming
- `max_output_tokens`
- `temperature`, `top_p`

<details>
<summary>Click for example</summary>

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

Full Messages API compatibility:

- `messages` — array of message objects
- `system` — system prompt (string or array)
- `tools` — tool definitions
- `stream` — SSE streaming
- `max_tokens`, `temperature`

<details>
<summary>Click for example</summary>

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

Standard OpenAI Chat Completions passthrough.

---

## ☁️ AI Gateway Integration

Aperture natively integrates with [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/).

### Benefits

| Feature | Description |
|---|---|
| 🗳️ **Caching** | Repeated identical requests served from cache (TTL configurable) |
| 📊 **Analytics** | Every request logged with tokens, latency, status |
| 🚦 **Rate Limiting** | Per-user or per-gateway rate limits |
| 🔁 **Auto Retry** | Automatic retries on upstream failures |
| 🛡️ **Guardrails** | Content moderation at the gateway level |

### How It Works

```
Client → Aperture Worker → AI Gateway → Upstream Provider
                ↓
           Cached? → Return cached response
```

### Cache Hit Example

From Gateway logs:

```
custom-opencode-go | deepseek-v4-flash | v1/chat/completions | 200 | cached=true
```

When `cached=true`, the response was served from Cloudflare's cache — zero latency, zero cost.

### Setup

1. Create a gateway in [Cloudflare Dashboard → AI → AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
2. Add a custom provider (OpenAI Compatible)
3. Set `AI_GATEWAY_URL` and `CUSTOM_PROVIDER_SLUG` in your Worker

---

## 🔀 Model Mapping

Map any client-facing model name to any real model:

```json
{
  "MODEL_MAP": "{\"dv4f\":\"deepseek-v4-flash\",\"gpt4\":\"deepseek-v4-flash\"}"
}
```

Clients send `dv4f` → Worker translates to `deepseek-v4-flash` → upstream receives the real model.

---

## 🏗️ Architecture

```
┌─────────────┐     ┌─────────────────────────────────────┐     ┌──────────────┐
│   Client    │────▶│         Aperture Worker              │────▶│    Upstream  │
│ (any SDK)   │     │                                       │     │  (OpenAI     │
│             │     │  ┌───────────┐  ┌─────────────────┐  │     │  Compatible) │
│ OpenAI SDK  │     │  │ Route     │  │ Translate       │  │     │              │
│ Anthropic   │     │  │ Detect    │──▶│ Responses → Chat│  │     │  e.g.        │
│ SDK         │     │  │           │  │ Anthropic → Chat│  │     │  OpenCode    │
│ Custom HTTP │     │  │ /v1/chat  │  │ Chat → Chat     │  │     │  DeepSeek    │
└─────────────┘     │  │ /v1/msg   │  └─────────────────┘  │     │  etc.        │
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

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AI_GATEWAY_TOKEN` | ✅ (one of) | — | Auth token for AI Gateway or upstream |
| `OPENCODE_API_KEY` | ✅ (one of) | — | Fallback upstream API key |
| `AI_GATEWAY_URL` | ❌ | — | Enable AI Gateway routing |
| `CUSTOM_PROVIDER_SLUG` | ❌ | — | Gateway custom provider slug |
| `UPSTREAM_BASE_URL` | ❌ | `https://opencode.ai/zen/go/v1` | Base URL for direct routing |
| `DEFAULT_MODEL` | ❌ | `deepseek-v4-flash` | Default fallback model |
| `MODEL_MAP` | ❌ | `{}` | JSON model name mappings |
| `REQUEST_TIMEOUT_MS` | ❌ | `120000` | Upstream timeout |
| `RATE_LIMIT_MAX` | ❌ | `120` | Max requests per window |
| `RATE_LIMIT_WINDOW_MS` | ❌ | `60000` | Rate limit window |

### Authentication

Clients authenticate with `Authorization: Bearer <token>` or `x-api-key: <token>`.

The expected token is set via `AI_GATEWAY_TOKEN` secret.

---

## 🛡️ Security

- **Edge Authentication** — Requests are authenticated at the Cloudflare edge before reaching your upstream
- **Secrets Management** — API keys stored as Cloudflare Secrets, not in code
- **CORS** — Full CORS support for browser-based clients
- **Rate Limiting** — Built-in sliding window rate limiter
- **Input Validation** — JSON payload size limit (1MB), structure validation

---

## 🧪 Development

```bash
# Install dependencies
npm install

# Run locally
wrangler dev

# Deploy
wrangler deploy

# Set secrets
wrangler secret put AI_GATEWAY_TOKEN
```

---

## 📦 Project Structure

```
src/
├── index.js        # Router, handlers, auth
├── upstream.js     # Upstream API client (Gateway or direct)
├── responses.js    # OpenAI Responses API ↔ Chat translation
├── anthropic.js    # Anthropic Messages API ↔ Chat translation
└── utils.js        # Auth, rate limiter, SSE helpers
```

---

## 🤝 Contributing

PRs welcome! Please ensure:

1. Tests pass for all three API formats
2. Streaming works for your changes
3. Gateway integration is tested (if applicable)

---

## 📄 License

MIT — see [LICENSE](LICENSE).

---

## 🙏 Credits

Built on [Cloudflare Workers](https://workers.cloudflare.com/) and [OpenCode](https://opencode.ai/).
