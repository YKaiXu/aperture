// ─── Utilities ───────────────────────────────────────────

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
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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

/**
 * Get the upstream API key from environment, with fallback.
 */
export function getUpstreamApiKey(env) {
  return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
}

/**
 * Create an AbortController with timeout.
 */
export function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer, signal: controller.signal };
}

/**
 * Fetch upstream with timeout and error handling.
 */
export async function fetchUpstream(url, options, timeoutMs = 60000) {
  const { controller, timer, signal } = withTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Upstream request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read upstream error body.
 */
export async function readUpstreamError(response) {
  try {
    const body = await response.json();
    return body.error?.message || body.message || `Upstream returned ${response.status}`;
  } catch {
    return `Upstream returned ${response.status}`;
  }
}

/**
 * Convert a ReadableStream to an async iterable of SSE events.
 */
export async function* streamSSE(response) {
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
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed.startsWith("data: ")) {
        const payload = trimmed.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
}

// ─── Rate Limiting (in-memory) ──────────────────────

/**
 * Simple in-memory rate limiter using a sliding window.
 * No global timers (safe for Workers global scope).
 * Cleans up expired entries lazily during check().
 */
export function createRateLimiter(windowMs = 60000, maxRequests = 60) {
  const hits = new Map();

  return {
    check(key) {
      const now = Date.now();
      let record = hits.get(key);
      if (!record) {
        record = { timestamps: [] };
        hits.set(key, record);
      }
      // Remove expired timestamps (lazy cleanup)
      record.timestamps = record.timestamps.filter((t) => now - t < windowMs);
      if (record.timestamps.length >= maxRequests) {
        return { allowed: false, remaining: 0, resetAt: record.timestamps[0] + windowMs };
      }
      record.timestamps.push(now);
      return { allowed: true, remaining: maxRequests - record.timestamps.length, resetAt: now + windowMs };
    },
  };
}
