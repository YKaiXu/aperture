# Test Results Log

## Test 1: Gateway Simple Chat
- **Endpoint:** `gateway.ai.cloudflare.com/v1/.../custom-opencode-go/v1/chat/completions`
- **Result:** HTTP 200 ✅
- **Key finding:** Baseline works. Model returns `reasoning_content` in non-streaming mode.

## Test 2: Gateway Multi-turn with role:tool
- **Endpoint:** Same Gateway
- **Result:** HTTP 400 ❌
- **Key finding:** Upstream (Console Go / opencode.ai) **rejects** pre-populated `role:tool` and `tool_calls` in conversation history. Error: "Error from provider (Console Go): Upstream request failed"

## Test 3: Gateway Streaming + Tools
- **Endpoint:** Same Gateway
- **Result:** HTTP 200 ✅
- **Key finding:** Streaming tool calls work correctly. But ~30 empty `content:""` chunks per request due to `reasoning_content` stripping.

## Test 4: Worker Simple Chat
- **Endpoint:** `g2o.blogger.workers.dev/v1/chat/completions`
- **Result:** HTTP 200 ✅
- **Key finding:** Worker proxies correctly to Gateway/upstream.

## Test 5: Worker Anthropic Streaming
- **Endpoint:** `g2o.blogger.workers.dev/v1/messages`
- **Result:** HTTP 200 ✅
- **Key finding:** Anthropic-compatible streaming works end-to-end with correct thinking + text blocks.

## Post-Fix Verification

### F1: Empty Chunks
- **Command:** `curl ... stream | grep -c '"content":""'`
- **Result:** 0 ✅ (was ~30 before fix)
- **Total chunks:** 12

### F2: Tool Calling
- **Command:** `curl ... stream + tools | grep -c 'tool_calls'`
- **Result:** 11 ✅ (tool calls present)
- **finish_reason:** "tool_calls" ✅

### F3: Anthropic Endpoint
- **Command:** `curl ... /v1/messages stream`
- **Result:** HTTP 200 ✅
- **Events:** message_start → content_block_start ×2 → content_block_delta ×N → message_delta → message_stop

### F4: Auth
- **Command:** `curl ... Authorization: Bearer bad_token`
- **Result:** HTTP 401 ✅
- **Error:** `{"error":{"message":"Invalid or missing API key","type":"authentication_error","code":"UNAUTHORIZED"}}`

### Claude CLI Compatibility
| Test | Result |
|------|--------|
| Streaming chat | ✅ HTTP 200 |
| Streaming tool calling | ✅ HTTP 200, `stop_reason: tool_use` |
| Non-streaming | ✅ HTTP 200, thinking + text blocks |
