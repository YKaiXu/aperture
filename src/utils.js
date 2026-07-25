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
    let result = "";
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (typeof part === "string") {
        result += part;
      } else if (part?.type === "text") {
        result += part.text || "";
      } else if (part?.text) {
        result += part.text;
      } else if (part?.type === "thinking") {
        result += part.thinking || "";
      } else if (part?.type === "redacted_thinking") {
        result += "[Redacted thinking]";
      }
      // Skip the fallback Object.keys().find() entirely
      // All known content block types (text, thinking, redacted_thinking) are handled above
    }
    return result;
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
    // Log config error server-side but return 401 to avoid leaking configuration state
    const log = createLogger("auth");
    log.error("auth.missing_token", { message: "AI_GATEWAY_TOKEN not configured" });
    return { ok: false, error: "Invalid or missing API key", code: "UNAUTHORIZED", status: 401 };
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
 * Parse a SSE stream from a Response into parsed JSON objects.
 * Yields each "data: {...}" line as a parsed object.
 */
export async function* streamSSE(response) {
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
      } catch { /* skip malformed */ }
    }
  }
}

/**
 * Fetch with timeout. Aborts the request after `ms` milliseconds.
 */
export async function fetchUpstream(url, options, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      return new Response(
        JSON.stringify({ error: { message: "Request timed out", type: "timeout_error" } }),
        { status: 504 }
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create an in-memory rate limiter (sliding window).
 */
export function createRateLimiter(windowMs, maxRequests) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      // Prune stale entries every ~50 checks to prevent unbounded growth
      if (hits.size > maxRequests * 2 && Math.random() < 0.02) {
        for (const [k, v] of hits) {
          if (now - v.windowStart > windowMs) hits.delete(k);
        }
      }
      const record = hits.get(key);
      if (!record || now - record.windowStart > windowMs) {
        hits.set(key, { windowStart: now, count: 1 });
        return { allowed: true, resetAt: now + windowMs };
      }
      if (record.count >= maxRequests) {
        return { allowed: false, resetAt: record.windowStart + windowMs };
      }
      record.count++;
      return { allowed: true, resetAt: record.windowStart + windowMs };
    },
  };
}

/**
 * Create an AbortController with timeout.
 */
export function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer, signal: controller.signal };
}
