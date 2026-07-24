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

import { uid, now, errorResponse, corsHeaders, authenticate, resolveDefaultModel, createLogger, pipeEventStream, pipeChatStream } from "./utils.js";
import { sendChatRequest } from "./upstream.js";
import { translateToChat, translateStreamEvents, translateResponseJson } from "./responses.js";
import { translateAnthropicToChat, translateAnthropicStream, translateAnthropicJson } from "./anthropic.js";

/**
 * Resolve the model to send to the upstream.
 * Accepts any model ID from the client and passes it through unchanged.
 * Client model mapping is handled by the AI Gateway.
 * Only applies a fallback default if no model was provided.
 */
function resolveModel(model, env = {}) {
  return resolveDefaultModel(env);
}

export default {
  async fetch(request, env) {
    const requestId = uid("req");
    const log = createLogger(requestId);

    // ── CORS preflight ─────────────────────────────────
    if (request.method === "OPTIONS") {
      log.info("cors.preflight");
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Model discovery (GET /v1/models) ────────────────
    // AI clients (e.g. Trae) query this endpoint to discover available models.
    if (request.method === "GET" && path === "/v1/models") {
      log.info("models.discovery");
      return handleModelDiscovery(env);
    }

    if (request.method !== "POST") {
      log.warn("method.not_allowed", { method: request.method, path });
      return errorResponse("Method not allowed", "invalid_request", "METHOD_NOT_ALLOWED", 405);
    }

    log.info("request.received", { method: "POST", path });

    // ── Authentication ─────────────────────────────────
    const auth = authenticate(request, env);
    if (!auth.ok) {
      log.warn("auth.failed", { code: auth.code });
      return errorResponse(auth.error, "authentication_error", auth.code, auth.status);
    }
    log.info("auth.ok");

    // ── Parse body ─────────────────────────────────────
    let body;
    try {
      const raw = await request.text();
      body = JSON.parse(raw);
    } catch {
      log.warn("body.parse_error");
      return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400);
    }

    // ── Extract auth header for forwarding to upstream ──
    // ── Route detection ────────────────────────────────
    const route = detectRoute(path, body);
    log.info("route.detected", { route, path });

    try {
      switch (route) {
        case "chat":
          return await handleChatCompletions(body, env, log);
        case "responses":
          return await handleResponsesAPI(body, env, log);
        case "anthropic":
          return await handleAnthropicMessages(body, env, log);
        default:
          log.warn("route.unknown");
          return errorResponse("Unknown API format", "invalid_request", "FORMAT_UNKNOWN", 400);
      }
    } catch (err) {
      log.error("handler.crash", { route, error: err.message });
      return errorResponse("Internal error", "server_error", "INTERNAL", 500);
    }
  },
};

// ─── Route Detection ──────────────────────────────────

function detectRoute(path, body) {
  // Explicit paths
  if (path === "/v1/chat/completions" || path.endsWith("/chat/completions")) return "chat";
  if (path === "/v1/messages" || path.endsWith("/messages")) return "anthropic";

  // Auto-detect by body shape
  if (body.messages) return "chat";
  if (body.input !== undefined || body.instructions !== undefined) return "responses";
  if (body.anthropic_version || body.anthropic) return "anthropic";

  // Default: treat as Responses API
  return "responses";
}

// ─── Model Discovery ───────────────────────────────────

/**
 * Handle GET /v1/models — return available models for client discovery.
 * AI clients (Trae, Open WebUI, etc.) call this to populate model lists.
 */
function handleModelDiscovery(env) {
  // Claude Code/Desktop 只认 claude-* 或 anthropic/claude-* 开头的模型名。
  // 返回多个 Claude 兼容名称让客户端通过校验。
  // 注意：Worker 的 resolveModel() 会忽略客户端选的模型，
  // 永远转发的都是 DEFAULT_MODEL，所以这里返回什么名字都可以。
  const names = [
    "claude-sonnet-4-20250514",
    "claude-sonnet-4",
    "claude-3-5-sonnet-latest",
    "claude-3-haiku",
    "claude-3-opus",
  ];

  const models = names.map((id) => ({
    id,
    object: "model",
    created: 1700000000,
    owned_by: "aperture",
  }));

  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ─── Chat Completions Passthrough ──────────────────────

/**
 * Filter streaming SSE chunks to strip non-standard fields that some clients
 * (e.g. Trae IDE) cannot handle.
 *
 * DeepSeek models emit `reasoning_content` in streaming delta chunks.
 * Standard OpenAI Chat Completions clients may choke on this field.
 * This filter removes `reasoning_content`, normalizes `content: null` to `""`,
 * and skips chunks that only contain reasoning (no actual content delta).
 */
async function* filterChatStream(upstreamResponse) {
  const reader = upstreamResponse.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
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

        // Convert content: null → "" (some clients expect string content)
        if (choice.delta.content === null) {
          choice.delta.content = "";
          modified = true;
        }

        // Strip reasoning_content (DeepSeek non-standard field).
        // Must check AFTER the null→"" conversion above.
        if (choice.delta.reasoning_content !== undefined) {
          delete choice.delta.reasoning_content;
          modified = true;
        }
      }
      if (!modified) {
        yield line; // nothing changed — pass through
        continue;
      }
      // Keep the chunk if any choice has a meaningful delta or finish_reason.
      const hasContent = parsed.choices.some(c =>
        (c.delta && Object.keys(c.delta).length > 0) || c.finish_reason
      );
      if (hasContent) {
        yield `data: ${JSON.stringify(parsed)}`;
      }
      // If delta is entirely empty after stripping, skip the chunk
    }
  }
}

async function handleChatCompletions(body, env, log) {
  // Override model and passthrough
  body.model = resolveModel(body.model, env);
  log.info("chat.mapped_model", { model: body.model });

  const upstreamResponse = await sendChatRequest(env, body, log);
  if (!upstreamResponse.ok) {
    const errBody = await readUpstreamErrorBody(upstreamResponse);
    log.warn("upstream.error", { status: upstreamResponse.status, detail: errBody });
    return errorResponse(
      `Upstream returned ${upstreamResponse.status} - ${errBody}`,
      "upstream_error", "UPSTREAM", upstreamResponse.status
    );
  }

  // Stream passthrough (filtering reasoning_content for Trae compat)
  if (body.stream) {
    log.info("chat.streaming");
    return pipeChatStream(filterChatStream(upstreamResponse));
  }

  // Non-streaming: try DSML normalization, fallback to raw pass-through
  try {
    const responseBody = await upstreamResponse.json();
    const normalizedBody = normalizeDsmlToolCalls(responseBody);
    log.info("chat.completed", { dsml: normalizedBody !== responseBody });
    return new Response(JSON.stringify(normalizedBody), {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch {
    // If JSON parsing fails, pass through raw response
    log.info("chat.raw_passthrough");
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}

// ─── Responses API Handler ────────────────────────────

async function handleResponsesAPI(body, env, log) {
  const respId = uid("resp");

  // Translate to Chat Completions format
  const chatReq = translateToChat(body);
  chatReq.model = resolveModel(chatReq.model, env);
  log.info("responses.translated", { respId, model: chatReq.model, stream: !!chatReq.stream });

  const upstreamResponse = await sendChatRequest(env, chatReq, log);
  if (!upstreamResponse.ok) {
    const errMsg = await readUpstreamErrorBody(upstreamResponse);
    log.warn("responses.upstream_error", { status: upstreamResponse.status, detail: errMsg });
    return new Response(
      JSON.stringify({
        id: respId,
        object: "response",
        created_at: now(),
        model: chatReq.model,
        output: [],
        error: { message: errMsg, type: "invalid_request_error", code: "invalid_request_error" },
      }),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      }
    );
  }

  if (chatReq.stream) {
    log.info("responses.streaming", { respId });
    return pipeEventStream(translateStreamEvents(upstreamResponse, respId));
  }

  const result = await translateResponseJson(upstreamResponse, respId);
  log.info("responses.completed", { respId });
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ─── Anthropic Messages API Handler ───────────────────

async function handleAnthropicMessages(body, env, log) {
  const requestId = uid("msg");

  // Translate Anthropic request → Chat Completions
  const chatReq = translateAnthropicToChat(body);
  chatReq.model = resolveModel(chatReq.model, env);
  log.info("anthropic.translated", { requestId, model: chatReq.model, stream: chatReq.stream });

  const upstreamResponse = await sendChatRequest(env, chatReq, log);
  if (!upstreamResponse.ok) {
    const errMsg = await readUpstreamErrorBody(upstreamResponse);
    log.warn("anthropic.upstream_error", { status: upstreamResponse.status, detail: errMsg });
    return new Response(
      JSON.stringify({
        id: requestId,
        type: "error",
        error: { type: "invalid_request_error", message: errMsg },
      }),
      {
        status: upstreamResponse.status,
        headers: anthropicHeaders(),
      }
    );
  }

  if (chatReq.stream) {
    log.info("anthropic.streaming", { requestId });
    return pipeEventStream(translateAnthropicStream(upstreamResponse, requestId), {
      "x-request-id": requestId,
      "request-id": requestId,
    });
  }

  const result = await translateAnthropicJson(upstreamResponse, requestId);
  log.info("anthropic.completed", { requestId });
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

function anthropicHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "x-request-id": uid("req"),
    "request-id": uid("req"),
    ...extra,
    ...corsHeaders(),
  };
}

/**
 * Detect and convert Console Go DSML tool calls to standard OpenAI tool_calls format.
 */
function normalizeDsmlToolCalls(responseBody) {
  if (!responseBody?.choices?.[0]?.message) return responseBody;
  const choice = responseBody.choices[0];
  const msg = choice.message;
  const content = msg.content || "";

  const dsmlDetect = (
    content.includes("DSML") &&
    (content.includes("tool_calls") || content.includes("invoke name"))
  );
  if (!dsmlDetect) return responseBody;

  const toolCalls = [];

  const sections = content.split(/(?=invoke\s+name\s*=)/gi);
  for (const section of sections) {
    const invokeMatch = section.match(/invoke\s+name\s*=\s*"([^"]+)"/i);
    if (!invokeMatch) continue;

    const fnName = invokeMatch[1];
    const args = {};
    const paramRe = /parameter\s+name\s*=\s*"([^"]+)"[^>]*>([^<]*)<\//gi;
    let pMatch;
    while ((pMatch = paramRe.exec(section)) !== null) {
      if (pMatch[1]) args[pMatch[1]] = pMatch[2] || "";
    }

    toolCalls.push({
      index: toolCalls.length,
      id: `call_dsml_${uid("")}`,
      type: "function",
      function: { name: fnName, arguments: JSON.stringify(args) },
    });
  }

  if (toolCalls.length === 0) return responseBody;

  msg.content = "";
  msg.tool_calls = toolCalls;
  if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
    choice.finish_reason = "tool_calls";
  }

  return responseBody;
}

/**
 * Safely extract error message from an upstream error response.
 */
async function readUpstreamErrorBody(response) {
  try {
    const text = await response.text();
    if (!text) return "(empty body)";
    try {
      const json = JSON.parse(text);
      return json.error?.message || json.message || text.slice(0, 500);
    } catch {
      return text.slice(0, 500) || "(empty)";
    }
  } catch {
    return "(unreadable)";
  }
}
