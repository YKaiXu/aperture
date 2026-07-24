# Aperture 🔭

**通用 AI 协议适配器** — 将 OpenAI Responses API 和 Anthropic Messages API 统一转换为 OpenAI Chat Completions，通过 Cloudflare AI Gateway 转发。

[![部署到 Cloudflare](https://img.shields.io/badge/部署-Cloudflare_Workers-F38020?logo=cloudflare)](https://dash.cloudflare.com)
[![许可证: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 为什么选择 Aperture?

AI SDK 和工具使用不同的协议。Aperture 将它们统一到一个边缘代理，**后端只需支持一种格式**（Chat Completions），客户端可以使用任意 SDK。

| 客户端 SDK → | Aperture 翻译 → | 上游收到的格式 |
|---|---|---|
| OpenAI Responses API | ✅ | Chat Completions |
| Anthropic Messages API | ✅ | Chat Completions |
| OpenAI Chat Completions | ✅ (直通) | Chat Completions |

请求经过 **Cloudflare AI Gateway** 提供缓存、限速、日志分析 — Worker 只专注于协议翻译。

---

## 特色

- 🔄 **多协议兼容** — 三种 API 格式统一入口
- 🧠 **工具调用** — function/tool calling 跨协议互转
- 📡 **流式输出** — 所有格式均支持 SSE 流式
- ⚡ **边缘原生** — 部署在 Cloudflare Workers 全球 300+ 节点
- ☁️ **AI Gateway 集成** — 缓存、限速、日志由 Gateway 处理
- 🔐 **认证透传** — 客户端认证直接转发给 Gateway
- 📦 **零依赖** — 纯 JavaScript，极速冷启动
- ✅ **测试覆盖** — 88 个单元测试覆盖全部翻译逻辑

---

## 快速开始

### 前置条件

| 条件 | 说明 |
|---|---|
| **Cloudflare 账号** | 部署 Worker 必需。[注册](https://dash.cloudflare.com/sign-up) |
| **Wrangler CLI** | `npm install -g wrangler` — Cloudflare Workers 命令行工具 |
| **Node.js 18+** | wrangler 需要，Worker 本身不需要 |
| **AI Gateway** | 提供缓存和分析能力。[配置指南](https://developers.cloudflare.com/ai-gateway/) |
| **Gateway API Key** | 你的 AI Gateway API 密钥 |

### 部署

```bash
# 1. 克隆
git clone https://github.com/YKaiXu/aperture.git
cd aperture

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare
wrangler login

# 4. 设置密钥（你的 AI Gateway 认证信息）
wrangler secret put AI_GATEWAY_TOKEN
wrangler secret put AI_GATEWAY_URL

# 5. 部署
wrangler deploy
```

### 客户端使用

```bash
# Chat Completions（OpenAI SDK / 通用）
curl https://g2o.blogger.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"messages":[{"role":"user","content":"你好！"}],"stream":true}'

# Anthropic Messages API（Claude Code 等）
curl https://g2o.blogger.workers.dev/v1/messages \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"max_tokens":1024,"messages":[{"role":"user","content":"你好！"}]}'

# OpenAI Responses API
curl https://g2o.blogger.workers.dev/ \
  -H "Authorization: Bearer $AI_GATEWAY_TOKEN" \
  -d '{"input":"你好！"}'
```

**模型 ID：** Worker 忽略客户端传的模型名，始终转发 `DEFAULT_MODEL`（默认 `deepseek-v4-flash`）。模型映射由 AI Gateway 处理。

**认证：** Worker 将客户端的 `Authorization: Bearer` 头原样转发给 AI Gateway，由 Gateway 负责鉴权。Worker 本身不管理 API Key。

---

## 部署指南

### 第一步：配置 wrangler.jsonc

编辑项目根目录的 `wrangler.jsonc`：

```jsonc
{
  "name": "g2o",                              // Worker 名称
  "main": "src/index.js",
  "compatibility_date": "2026-07-22",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "UPSTREAM_BASE_URL": "https://opencode.ai/zen/go/v1",
    "CUSTOM_PROVIDER_SLUG": "opencode-go",    // AI Gateway 自定义 Provider slug
    "DEFAULT_MODEL": "deepseek-v4-flash"      // 始终转发该模型名到上游
  }
}
```

### 第二步：设置 Secrets

```bash
# 必需：AI Gateway 认证 token（客户端发送此 token，Worker 转发）
wrangler secret put AI_GATEWAY_TOKEN

# 必需：AI Gateway 基础 URL
wrangler secret put AI_GATEWAY_URL

# 可选：上游 API 密钥（当 AI_GATEWAY_TOKEN 未设置时作为备用）
wrangler secret put OPENCODE_API_KEY
```

**密钥说明：**

| Secret | 必需 | 用途 |
|---|---|---|
| `AI_GATEWAY_TOKEN` | ✅ 是 | 转发给 AI Gateway 的 Bearer token，客户端必须发送此值 |
| `AI_GATEWAY_URL` | ✅ 是 | AI Gateway URL（例如 `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}`） |
| `OPENCODE_API_KEY` | ❌ 否 | 上游 API 密钥（备用） |

### 第三步：AI Gateway 路由

```
客户端 → Aperture Worker → AI Gateway → 上游 API
                              ↓
                         缓存命中？→ 直接返回缓存结果
```

Worker 构造的上游 URL 格式为：
```
{AI_GATEWAY_URL}/custom-{CUSTOM_PROVIDER_SLUG}/v1/chat/completions
```

**配置步骤：**
1. 在 [Cloudflare Dashboard → AI → AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) 创建 Gateway
2. 添加自定义 Provider（OpenAI 兼容）：
   - Provider Slug：与 `CUSTOM_PROVIDER_SLUG` 一致（例如 `opencode-go`）
   - Base URL：上游 API 基础 URL（例如 `https://opencode.ai/zen/go/v1`）
3. 设置环境变量：
   - `AI_GATEWAY_URL`：`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}`
   - `CUSTOM_PROVIDER_SLUG`：你的 provider slug
4. 设置 `AI_GATEWAY_TOKEN` 和 `AI_GATEWAY_URL` secrets
5. 部署

---

## API 参考

### OpenAI Responses API（`POST /`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `input` | string \| array | 输入文本或内容块 |
| `instructions` | string | 系统指令 |
| `tools` | array | 函数/工具定义 |
| `stream` | boolean | SSE 流式输出 |
| `max_output_tokens` | number | 最大输出 token 数 |
| `temperature` | number | 采样温度 |
| `top_p` | number | 核心采样 |

### Anthropic Messages API（`POST /v1/messages`）

| 参数 | 类型 | 说明 |
|---|---|---|
| `messages` | array | 消息对象 |
| `system` | string \| array | 系统提示词 |
| `tools` | array | 工具定义 |
| `thinking` | object | 思考/推理配置 |
| `max_tokens` | number | 最大 token 数 |
| `temperature` | number | 采样温度 |

### Chat Completions（`POST /v1/chat/completions`）

标准 OpenAI Chat Completions 直通。

---

## 架构

```
客户端 ──→ Aperture Worker ──→ AI Gateway ──→ 上游 API
              │                     │
              │  协议翻译             │  缓存
              │  - Responses → Chat  │  限速
              │  - Anthropic → Chat  │  日志
              │  - Chat 直通         │  认证校验
              │                     │  模型映射
              │  认证透传            │
              │  日志输出            │
```

**Aperture Worker 职责：** 纯协议翻译，不做策略决策。

| 做 | 不做 |
|---|---|
| 协议检测与路由 | 限速（交给 Gateway） |
| 请求格式翻译 | 模型映射（交给 Gateway） |
| 响应格式翻译 | 请求体大小检查（交给 Cloudflare 平台） |
| 流式 SSE 管道 | 重试/回退（直接返回上游错误） |
| DeepSeek DSML 格式适配 | |
| 结构化日志（Observability） | |

---

## 项目结构

```
aperture/
├── src/
│   ├── index.js        # 路由、处理、DSML 适配、日志
│   ├── upstream.js     # 极简 fetch 包装，转发到 AI Gateway
│   ├── responses.js    # Responses API ↔ Chat 翻译
│   ├── anthropic.js    # Anthropic Messages ↔ Chat 翻译
│   └── utils.js        # 认证、CORS、SSE、结构化日志
├── wrangler.jsonc      # Worker 配置
├── package.json        # 项目元数据
└── README.md           # 本文件
```

---

## 测试

```bash
npm test          # 运行全部 88 个单元测试
npm run test:watch # 监听模式
```

测试覆盖纯翻译函数（无需 Workers 运行时）。所有测试通过 `tests/setup.js` 提供 Workers API mock。

---

## 配置说明

### 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `AI_GATEWAY_TOKEN` | ✅ 是 | — | 转发给 AI Gateway 的 Bearer token |
| `AI_GATEWAY_URL` | ✅ 是 | — | AI Gateway 基础 URL |
| `CUSTOM_PROVIDER_SLUG` | ❌ 否 | — | Gateway 自定义 Provider slug |
| `UPSTREAM_BASE_URL` | ❌ 否 | `https://opencode.ai/zen/go/v1` | 上游 API 基础 URL |
| `DEFAULT_MODEL` | ❌ 否 | `deepseek-v4-flash` | 默认模型（始终转发该值） |
| `OPENCODE_API_KEY` | ❌ 否 | — | 上游 API 密钥（备用） |

---

## 本地开发

```bash
npm test                        # 运行测试
npx wrangler dev                # 本地运行
npx wrangler deploy             # 部署
npx wrangler tail g2o --format json  # 查看实时日志
npx wrangler secret put AI_GATEWAY_TOKEN  # 设置密钥
```

---

## 许可证

MIT — 见 [LICENSE](LICENSE)。
