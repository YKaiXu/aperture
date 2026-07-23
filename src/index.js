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

    // ── Authentication ─────────────────────────────────
    const auth = authenticate(request, env);
    if (!auth.ok) {
      return errorResponse(auth.error, "authentication_error", auth.code, auth.status);
    }

    // ── Rate Limiting ──────────────────────────────────
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

async function handleChatCompletions(body, env) {
  // Override model and passthrough
  body.model = mapModelName(body.model || env.DEFAULT_MODEL || "deepseek-v4-flash", env);

  const upstreamResponse = await sendChatRequest(env, body);
  if (!upstreamResponse.ok) {
    const errMsg = await readUpstreamErrorSafe(upstreamResponse);
    return errorResponse(errMsg, "upstream_error", "UPSTREAM", upstreamResponse.status);
  }

  // Stream passthrough
  if (body.stream) {
    return new Response(upstreamResponse.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(),
      },
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
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

  // Streaming
  if (chatReq.stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        for await (const event of translateStreamEvents(upstreamResponse, respId)) {
          const raw = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
          await writer.write(encoder.encode(raw));
        }
      } catch (err) {
        try {
          await writer.write(
            encoder.encode(`event: error\ndata: {"type":"error","error":{"message":"Internal error"}}\n\n`)
          );
        } catch {
          // ignore
        }
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

  // Non-streaming
  const result = await translateResponseJson(upstreamResponse, respId);
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ─── Anthropic Messages API Handler ───────────────────

async function handleAnthropicMessages(body, env) {
  const requestId = uid("msg");

  // Translate Anthropic request → Chat Completions
  const chatReq = translateAnthropicToChat(body);
  chatReq.model = mapModelName(chatReq.model || env.DEFAULT_MODEL || "deepseek-v4-flash", env);

  // Send upstream
  const upstreamResponse = await sendChatRequest(env, chatReq);
  if (!upstreamResponse.ok) {
    const errMsg = await readUpstreamErrorSafe(upstreamResponse);
    return new Response(
      JSON.stringify({
        id: requestId,
        type: "error",
        error: { type: "invalid_request_error", message: errMsg },
      }),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      }
    );
  }

  // Streaming
  if (chatReq.stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        for await (const event of translateAnthropicStream(upstreamResponse, requestId)) {
          const raw = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
          await writer.write(encoder.encode(raw));
        }
      } catch (err) {
        try {
          await writer.write(
            encoder.encode(`event: error\ndata: {"type":"error","error":{"message":"Internal error"}}\n\n`)
          );
        } catch {
          // ignore
        }
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

  // Non-streaming
  const result = await translateAnthropicJson(upstreamResponse, requestId);
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ─── Internal Helpers ─────────────────────────────────

async function readUpstreamErrorSafe(response) {
  try {
    const body = await response.json();
    return body.error?.message || body.message || `Upstream returned ${response.status}`;
  } catch {
    return `Upstream returned ${response.status}`;
  }
}
