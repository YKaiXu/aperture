// ─── Utilities ───────────────────────────────────────────
// Shared defaults
export const DEFAULT_MODEL = "deepseek-v4-flash";
export const MIN_MAX_TOKENS = 1024;
export const DEFAULT_MAX_TOKENS = 16384;

/**
 * Generate a unique ID with a given prefix.
 */
export function uid(prefix = "resp") {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

/**
 * Unix timestamp in seconds.
 */
export function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Resolve the effective default model from env or built-in fallback.
 */
export function resolveDefaultModel(env) {
  return env?.DEFAULT_MODEL || DEFAULT_MODEL;
}

/**
 * Extract plain text from a mixed content value.
 * Handles string, array of content parts, or structured objects.
 */
export function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        // Support both Anthropic and OpenAI content block styles
        if (part.type === "text") return part.text;
        if (part.text) return part.text;
        // Fallback: any key ending with _text
        const textKey = Object.keys(part).find((k) => k.endsWith("_text") || k === "text");
        return textKey ? part[textKey] : "";
      })
      .join("");
  }
  return "";
}

/**
 * Standard error response helper.
 */
export function errorResponse(message, type, code, status = 400) {
  return new Response(
    JSON.stringify({
      error: { message, type, code },
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    }
  );
}

/**
 * CORS headers for all responses.
 */
export function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

/**
 * Validate authentication.
 * Supports: Authorization: Bearer <token> (OpenAI style) and x-api-key (Anthropic style)
 */
export function authenticate(request, env) {
  const expected = env.AI_GATEWAY_TOKEN;
  if (!expected) {
    return { ok: false, error: "Server configuration error", code: "CONFIG_ERROR", status: 500 };
  }
  // Try Authorization: Bearer first, then x-api-key
  let token = null;
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }
  if (!token) {
    token = request.headers.get("x-api-key");
  }
  if (!token || token !== expected) {
    return { ok: false, error: "Invalid or missing API key", code: "UNAUTHORIZED", status: 401 };
  }
  return { ok: true };
}



// ─── Structured Logger ────────────────────────────────

/**
 * Create a structured JSON logger for Cloudflare Workers observability.
 * Every log entry is a single line of JSON, ingestible by Cloudflare's
 * logging pipeline, Grafana, or any log aggregation system.
 *
 * Usage:
 *   const log = createLogger("req_abc123");
 *   log.info("route.detected", { route: "chat", path: "/v1/chat/completions" });
 *   log.error("upstream.failed", { status: 502 });
 *
 * @param {string} requestId - Unique request identifier for correlation.
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
export function createLogger(requestId = "unknown") {
  function emit(level, event, data = {}) {
    const entry = JSON.stringify({
      level,
      event,
      requestId,
      timestamp: Date.now(),
      ...data,
    });
    if (level === "error") {
      console.error(entry);
    } else {
      console.log(entry);
    }
  }

  return {
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
    error: (event, data) => emit("error", event, data),
  };
}

// ─── SSE Stream Utilities (shared across handlers) ────

/**
 * Parse a ReadableStream into an async generator of parsed JSON chunks
 * (Chat Completions SSE format — "data: {...}").
 */
export async function* parseChatSSE(response) {
  if (!response?.body) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch { /* skip malformed chunks */ }
    }
  }
}

/**
 * Create a pipe function that writes items from an async generator to a SSE Response.
 *
 * @param {(item: any) => string} serialize - Converts a generator item to a text line (without trailing newline).
 * @returns {(stream: AsyncGenerator, extraHeaders?: object) => Response}
 */
function createPipeStream(serialize) {
  return (stream, extraHeaders = {}) => {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        for await (const item of stream) {
          await writer.write(encoder.encode(serialize(item) + "\n"));
        }
      } catch { /* ignore write errors if client disconnected */ }
      finally {
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
  };
}

/** Pipe an async generator of { event, data } objects as SSE events. */
export const pipeEventStream = createPipeStream(
  ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`
);

/** Pipe an async generator of raw text lines. */
export const pipeChatStream = createPipeStream(
  (line) => line
);


