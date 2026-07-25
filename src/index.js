// ─── OpenCode Go Proxy ─────────────────────────────────
// Universal proxy: OpenAI Responses API + Anthropic Messages API → OpenCode Chat Completions
//
// Routes:
//   POST /                    → Auto-detect (Responses API by default)
//   POST /v1/chat/completions → OpenAI Chat Completions passthrough
//   POST /v1/messages         → Anthropic Messages API
//
// Authentication:
//   Authorization: Bearer <token>  (OpenAI style)
//   x-api-key: <token>             (Anthropic style)

import { uid, now, errorResponse, corsHeaders, authenticate, withTimeout, createRateLimiter } from "./utils.js";
import { sendChatRequest } from "./upstream.js";
import { translateToChat, translateStreamEvents, translateResponseJson } from "./responses.js";
import { translateAnthropicToChat, translateAnthropicStream, translateAnthropicJson } from "./anthropic.js";

// ── Rate limiter (per-worker instance, in-memory) ────
const rateLimiter = createRateLimiter(60000, 120);

/**
 * Map client-provided model names to actual upstream model names.
 * Supports:
 * 1. Known provider names (go, go_proxy, default, auto) → DEFAULT_MODEL
 * 2. Explicit model mappings via MODEL_MAP env var (JSON object)
 * 3. Everything else passes through (real model names like deepseek-v4-flash)
 */
function mapModelName(model, env = {}) {
  if (!model) return env.DEFAULT_MODEL || "deepseek-v4-flash";

  const trimmed = model.toLowerCase().trim();
  const knownProviders = ["go", "go_proxy", "default", "auto"];
  if (knownProviders.includes(trimmed)) {
    return env.DEFAULT_MODEL || "deepseek-v4-flash";
  }

  // Parse custom model map from environment (case-insensitive keys)
  if (env.MODEL_MAP) {
    try {
      const map = JSON.parse(env.MODEL_MAP);
      if (map[trimmed]) return map[trimmed];
    } catch {
      // ignore invalid JSON
    }
  }

  // Fallback to default model for any unrecognized name
  // (so clients can use any arbitrary model alias)
  return env.DEFAULT_MODEL || "deepseek-v4-flash";
}

export default {
  async fetch(request, env) {
    // ── CORS preflight ─────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return errorResponse("Method not allowed", "invalid_request", "METHOD_NOT_ALLOWED", 405);
    }

    // ── Rate Limiting (before auth to throttle brute force) ──────────────────────────────────
    const rateLimiter = createRateLimiter(
      Math.max(1000, parseInt(env.RATE_LIMIT_WINDOW_MS || "60000", 10) || 60000),
      Math.max(1, parseInt(env.RATE_LIMIT_MAX || "120", 10) || 120)
    );
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateCheck = rateLimiter.check(clientIp);
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded. Try again later.", type: "rate_limit_error", code: "RATE_LIMITED" } }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil((rateCheck.resetAt - Date.now()) / 1000)),
            ...corsHeaders(),
          },
        }
      );
    }

    // ── Parse body ─────────────────────────────────────
    let body;
    try {
      const raw = await request.text();
      body = JSON.parse(raw);
    } catch {
      return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400);
    }

    // ── Route detection ────────────────────────────────
    const path = new URL(request.url).pathname;
    const route = detectRoute(path, body);

    switch (route) {
      case "chat":     return handleChatCompletions(body, env);
      case "responses": return handleResponsesAPI(body, env);
      case "anthropic": return handleAnthropicMessages(body, env);
      default:         return errorResponse("Unknown API format", "invalid_request", "FORMAT_UNKNOWN", 400);
    }
  },
};

// ─── Route Detection ──────────────────────────────────

function detectRoute(path, body) {
  // Explicit paths
  if (path === "/v1/chat/completions" || path.endsWith("/chat/completions")) return "chat";
  if (path === "/v1/messages" || path.endsWith("/messages")) return "anthropic";

  // Auto-detect by body shape
  if (body.messages) return "chat"; // Chat Completions is default for raw messages
  if (body.input !== undefined || body.instructions !== undefined) return "responses";
  if (body.anthropic_version || body.anthropic) return "anthropic";

  // Default: treat as Responses API
  return "responses";
}

// ─── Chat Completions Passthrough ──────────────────────

/**
 * Pipe an async generator of event objects to a SSE Response.
 * Each event object should have { event, data } properties.
 * Shared across Chat/Responses/Anthropic streaming handlers.
 */
function pipeEventStream(stream, extraHeaders = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const log = createLogger("stream");

  (async () => {
    try {
      for await (const { event, data } of stream) {
        const raw = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        await writer.write(encoder.encode(raw));
      }
    } catch (err) {
      log.error("stream.error", { message: err.message, stack: err.stack });
      try {
        await writer.write(
          encoder.encode(`event: error\ndata: {"type":"error","error":{"message":"Internal stream error"}}\n\n`)
        );
      } catch { /* ignore */ }
    } finally {
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...extraHeaders,
      ...corsHeaders(),
    },
  });
}

/**
 * Pipe filtered SSE lines to a Response for Chat Completions streaming.
 */
function pipeChatStream(stream) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const log = createLogger("stream");

  (async () => {
    try {
      for await (const line of stream) {
        await writer.write(encoder.encode(line + "\n"));
      }
    } catch (err) {
      log.error("stream.error", { message: err.message, stack: err.stack });
    } finally {
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

/**
 * Filter streaming SSE chunks to strip non-standard fields that some clients
 * (e.g. Trae IDE) cannot handle.
 *
 * DeepSeek models emit `reasoning_content` in streaming delta chunks.
 * Standard OpenAI Chat Completions clients may choke on this field.
 * This filter removes `reasoning_content` and skips chunks that only
 * contain reasoning (no actual content delta).
 */
async function* filterChatStream(upstreamResponse) {
  const reader = upstreamResponse.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const MAX_BUFFER = 2 * 1024 * 1024; // 2 MB cap to prevent memory exhaustion
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    if (buffer.length > MAX_BUFFER) {
      throw new Error("SSE buffer exceeded maximum size");
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      // Pass through non-data lines (e.g. empty line separators, event: lines)
      if (!trimmed.startsWith("data: ")) {
        yield line;
        continue;
      }
      const payload = trimmed.slice(6).trim();
      // Pass through [DONE] signal unchanged
      if (payload === "[DONE]") {
        yield line;
        continue;
      }
      // Try to parse and filter reasoning_content
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        yield line; // malformed JSON — pass through
        continue;
      }
      if (!parsed.choices || !Array.isArray(parsed.choices)) {
        yield line; // no choices — pass through
        continue;
      }
      let modified = false;
      for (const choice of parsed.choices) {
        if (!choice.delta) continue;
        // Strip reasoning_content (DeepSeek non-standard field)
        if (choice.delta.reasoning_content !== undefined) {
          delete choice.delta.reasoning_content;
          modified = true;
        }
        // Convert content: null → "" (some clients expect string content)
        if (choice.delta.content === null) {
          choice.delta.content = "";
          modified = true;
        }
      }
      if (!modified) {
        yield line; // nothing changed — pass through
        continue;
      }
      // Keep meaningful chunks only — skip empty deltas that only had reasoning.
      const hasContent = parsed.choices.some(c => {
        if (c.finish_reason) return true;
        if (!c.delta) return false;
        const d = c.delta;
        return (typeof d.content === 'string' && d.content.length > 0)
            || d.role !== undefined
            || d.tool_calls !== undefined;
      });
      if (hasContent) {
        yield `data: ${JSON.stringify(parsed)}`;
      }
      // If delta is empty after stripping reasoning_content, skip it
    }
  }
}

async function handleChatCompletions(body, env) {
  // Override model and passthrough
  body.model = mapModelName(body.model || env.DEFAULT_MODEL || "deepseek-v4-flash", env);

  const upstreamResponse = await sendChatRequest(env, body);
  if (!upstreamResponse.ok) {
    const errBody = await safeReadUpstreamBody(upstreamResponse);
    // Log detailed upstream error server-side, return generic message to client
    const log = createLogger("chat");
    log.error("upstream.failed", { status: upstreamResponse.status, detail: errBody });
    return errorResponse(
      "Upstream request failed",
      "upstream_error", "UPSTREAM", upstreamResponse.status
    );
  }

  // Stream passthrough (filtering reasoning_content for Trae compat)
  if (body.stream) {
    return pipeChatStream(filterChatStream(upstreamResponse));
  }

  // Non-streaming: try DSML normalization, fallback to raw pass-through
  try {
    const responseBody = await upstreamResponse.json();
    // Strip non-standard reasoning_content for Trae compatibility
    for (const choice of responseBody.choices || []) {
      if (choice.message?.reasoning_content !== undefined) {
        delete choice.message.reasoning_content;
      }
    }
    const normalizedBody = normalizeDsmlToolCalls(responseBody);
    return new Response(JSON.stringify(normalizedBody), {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch {
    // If JSON parsing fails, pass through raw response
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}

// ─── Responses API Handler ────────────────────────────

async function handleResponsesAPI(body, env) {
  const respId = uid("resp");

  // Translate to Chat Completions format
  const chatReq = translateToChat(body);
  // Map Codex provider names to actual model names
  chatReq.model = mapModelName(chatReq.model || env.DEFAULT_MODEL || "deepseek-v4-flash", env);

  // Send upstream
  const upstreamResponse = await sendChatRequest(env, chatReq);
  if (!upstreamResponse.ok) {
    const errMsg = await readUpstreamErrorSafe(upstreamResponse);
    // Log detailed upstream error server-side, return generic message to client
    const log = createLogger("responses");
    log.error("upstream.failed", { status: upstreamResponse.status, detail: errMsg });
    return new Response(
      JSON.stringify({
        id: respId,
        object: "response",
        created_at: now(),
        model: chatReq.model,
        output: [],
        error: { message: "Upstream request failed", type: "invalid_request_error", code: "invalid_request_error" },
      }),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      }
    );
  }

  // Streaming
  if (chatReq.stream) {
    return pipeEventStream(translateStreamEvents(upstreamResponse, respId));
  }

  // Non-streaming
  const result = await translateResponseJson(upstreamResponse, respId);
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ─── Anthropic Messages API Handler ───────────────────

function anthropicHeaders(extra = {}) {
  const reqId = uid("req");
  return {
    "Content-Type": "application/json",
    "x-request-id": reqId,
    "request-id": reqId,
    ...extra,
    ...corsHeaders(),
  };
}

async function handleAnthropicMessages(body, env) {
  const requestId = uid("msg");

  // Translate Anthropic request → Chat Completions
  const chatReq = translateAnthropicToChat(body);
  chatReq.model = mapModelName(chatReq.model || env.DEFAULT_MODEL || "deepseek-v4-flash", env);

  // Send upstream
  const upstreamResponse = await sendChatRequest(env, chatReq);
  if (!upstreamResponse.ok) {
    const errMsg = await readUpstreamErrorSafe(upstreamResponse);
    // Log detailed upstream error server-side, return generic message to client
    const log = createLogger("anthropic");
    log.error("upstream.failed", { status: upstreamResponse.status, detail: errMsg });
    return new Response(
      JSON.stringify({
        id: requestId,
        type: "error",
        error: { type: "invalid_request_error", message: "Upstream request failed" },
      }),
      {
        status: upstreamResponse.status,
        headers: anthropicHeaders(),
      }
    );
  }

  // Streaming
  if (chatReq.stream) {
    return pipeEventStream(translateAnthropicStream(upstreamResponse, requestId), {
      "x-request-id": requestId,
      "request-id": requestId,
    });
  }

  // Non-streaming
  const result = await translateAnthropicJson(upstreamResponse, requestId);
  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "x-request-id": requestId,
      "request-id": requestId,
      ...corsHeaders(),
    },
  });
}

// ─── Internal Helpers ─────────────────────────────────

/**
 * Detect and convert Console Go DSML tool calls to standard OpenAI tool_calls format.
 * 
 * Console Go sometimes returns tool calls as DSML XML embedded in the content text
 * (with finish_reason: "stop") instead of standard message.tool_calls format.
 * This function detects this pattern and normalizes it.
 */
function normalizeDsmlToolCalls(responseBody) {
  if (!responseBody?.choices?.[0]?.message) return responseBody;
  const choice = responseBody.choices[0];
  const msg = choice.message;
  const content = msg.content || "";

  // Detect DSML-style tool calls by checking for invoke name pattern
  // DSML format: invoke name="funcName" ... parameter name="..." values
  // Cap content length before regex to avoid ReDoS on malicious upstream responses
  if (content.length > 10000) return responseBody;
  if (!/invoke\s+name\s*=\s*"/i.test(content)) return responseBody;

  const toolCalls = [];

  // Extract all invoke blocks and their parameters
  const invokeRegex = /invoke\s+name\s*=\s*"([^"]+)"([\s\S]*?)(?=invoke\s+name\s*=\s*"|$)/gi;
  let invokeMatch;
  while ((invokeMatch = invokeRegex.exec(content)) !== null) {
    const fnName = invokeMatch[1];
    const blockContent = invokeMatch[2];

    const args = {};
    const paramRegex = /parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/parameter/gi;
    let pMatch;
    while ((pMatch = paramRegex.exec(blockContent)) !== null) {
      if (pMatch[1]) args[pMatch[1]] = pMatch[2].trim() || "";
    }

    toolCalls.push({
      index: toolCalls.length,
      id: `call_dsml_${uid("")}`,
      type: "function",
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }

  if (toolCalls.length === 0) return responseBody;

  // Build cleaned response
  msg.content = ""; // DSML content replaced with empty string
  msg.tool_calls = toolCalls;
  if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
    choice.finish_reason = "tool_calls";
  }

  return responseBody;
}

async function readUpstreamErrorSafe(response) {
  try {
    const body = await response.json();
    return body.error?.message || body.message || `Upstream returned ${response.status}`;
  } catch {
    return `Upstream returned ${response.status}`;
  }
}

/**
 * Safely read upstream error response body for diagnostic purposes.
 */
async function safeReadUpstreamBody(response) {
  try {
    const text = await response.text();
    return (text || "(empty)").slice(0, 500);
  } catch {
    return "(unreadable)";
  }
}
