# Aperture Optimization Session

**Session ID:** `ses_0686f5a64ffeZaOgcVoNyW6NUQ`
**Date:** 2026-07-25
**Duration:** ~1 hour
**Agents:** Prometheus (Planner), Atlas (Executor), Sisyphus (Worker)

## Summary

Full-cycle optimization of the Aperture Cloudflare Worker — from initial complaint analysis through live API testing, code changes, high-accuracy audit, deployment, and final Claude CLI integration.

---

## 1. Initial Complaint Analysis

**Symptoms (from user):**
- Claude CLI used with Aperture worker was "反映非常缓慢" (very slow to respond)
- Tool calling had issues

**Root causes identified:**
1. `filterChatStream` was emitting ~30 empty `content:""` SSE chunks per streaming request
   - DeepSeek model sends `reasoning_content` tokens as empty `content:""` deltas
   - After stripping `reasoning_content`, `Object.keys({content:""}).length > 0` = true, so chunks passed through
2. Traffic routed through Cloudflare AI Gateway added ~50ms extra latency per request
3. Upstream (opencode.ai) **rejects** `role:tool` and `tool_calls` in conversation history (HTTP 400)
4. Streaming tool call names could be empty in the first chunk

---

## 2. Key Technical Findings (Verified by Live Testing)

| Test | Endpoint | Result | Finding |
|------|----------|--------|--------|
| 1 | Gateway simple chat | ✅ 200 | Baseline works |
| 2 | Gateway multi-turn with role:tool | ❌ 400 | Upstream rejects tool history |
| 3 | Gateway streaming + tools | ✅ 200 | ~30 empty chunks per request |
| 4 | Worker simple chat | ✅ 200 | Worker proxies correctly |
| 5 | Worker Anthropic streaming | ✅ 200 | Thinking + text blocks stream correctly |

**Critical insight:** The original code's `delete m.tool_calls` and `tool_result→user` mapping was CORRECT — upstream really doesn't support native tool calling in history. Our initial fix attempt (role:tool) would have broken multi-turn conversations.

---

## 3. Changes Implemented

### Code Changes (commit `bf64380`)

| File | Change | Lines |
|------|--------|-------|
| `src/index.js` | Fix `filterChatStream` `hasContent` check — skip empty `content:""` deltas | 8 |
| `src/index.js` | Improve DSML regex — `[\s\S]*?` instead of `[^<]*`, scoped per-invoke | ~40 |
| `src/anthropic.js` | Streaming tool name fallback — `tool_${id.slice(0,8)}` instead of empty | 3 |
| `src/responses.js` | Migrate to shared `streamSSE` parser | -24 |
| `src/upstream.js` | Add `BYPASS_GATEWAY` support — direct upstream option | ~15 |
| `src/utils.js` | Add `streamSSE`, `fetchUpstream`, `createRateLimiter`, `withTimeout` exports | ~70 |
| `src/utils.js` | Optimize `extractText` — O(n\*k)→O(n), remove Object.keys().find() | ~15 |
| `wrangler.jsonc` | Rename worker to `g2o`, add `BYPASS_GATEWAY=true`, timeout, rate-limit vars | ~5 |

### Infrastructure Changes

| Item | Change |
|------|--------|
| Worker name | `opencode-go-proxy` → `g2o` (to match existing secrets) |
| AI_GATEWAY_TOKEN | Updated from Gateway token to OpenCode API key |
| BYPASS_GATEWAY | Set to `true` — skips AI Gateway, direct to opencode.ai |
| Claude CLI | `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` configured in `~/.bashrc` |

---

## 4. Verification Results

### F1: Zero Empty Chunks ✅
- Before: ~30 empty `content:""` chunks per streaming request
- After: **0** empty chunks
- Total data chunks: 12 (1 role + 10 content + 1 finish_reason)

### F2: Tool Calling ✅
- Tool calls stream correctly: 11 `tool_calls` chunks detected
- `finish_reason: "tool_calls"` — correct

### F3: Anthropic Endpoint ✅
- All SSE events present: `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`
- HTTP 200

### F4: Auth ✅
- Bad token → HTTP 401 `UNAUTHORIZED`
- Valid token → HTTP 200

### Final Claude CLI Compatibility ✅
| Test | Result |
|------|--------|
| Streaming chat | ✅ HTTP 200 — "Hello to you" |
| Streaming tool calling | ✅ HTTP 200 — `web_search` tool_use |
| Non-streaming | ✅ HTTP 200 — thinking + text blocks |

---

## 5. Architecture (Final)

```
Claude CLI ──→ g2o.blogger.workers.dev (Aperture) ──→ opencode.ai/zen/go/v1
                    │                                        │
               Auth: Bearer                              Model:
               BYPASS_GATEWAY=true                    deepseek-v4-flash
               filterChatStream fix
```

- **No AI Gateway** — direct connection removes ~50ms latency
- **No empty SSE chunks** — 30→0 per request
- **Tool calls work** — proper name fallback for streaming chunks
- **Multi-turn works** — tool_result→user mapping preserved (upstream limitation)
- **Auth** — single key (OpenCode API key) for both client→worker and worker→upstream

---

## 6. Files Modified

- `src/index.js` — Main router, filterChatStream, DSML normalize
- `src/anthropic.js` — Anthropic↔Chat translation, streaming
- `src/responses.js` — Responses API↔Chat translation
- `src/upstream.js` — Upstream fetch with BYPASS_GATEWAY
- `src/utils.js` — Shared utilities, SSE parser, rate limiter
- `wrangler.jsonc` — Worker config, env vars
- `~/.bashrc` — Claude CLI env vars

---

## 7. Decisions Log

| Decision | Rationale |
|----------|-----------|
| Keep tool_result→user | Upstream rejects role:tool (HTTP 400) — confirmed by live test |
| BYPASS_GATEWAY=true | Single-tenant proxy, Gateway latency > benefit |
| Worker name = g2o | Existing secrets (AI_GATEWAY_TOKEN) configured on g2o |
| Single auth key | OpenCode API key used for both auth and upstream — simplifies config |
