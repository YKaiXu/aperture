// ─── Upstream API Client ─────────────────────────────────
// Minimal fetch wrapper. Sends translated Chat Completions payload
// to the configured upstream or AI Gateway and returns raw Response.
// Zero policy logic — no fallback, no retry, no custom timeout.

const DEFAULT_UPSTREAM_URL = "https://opencode.ai/zen/go/v1";

function buildUpstreamUrl(env) {
  const gwUrl = (env.AI_GATEWAY_URL || "").trim();
  if (gwUrl) {
    const base = gwUrl.replace(/\/+$/, "");
    const slug = env.CUSTOM_PROVIDER_SLUG || "";
    return slug
      ? `${base}/custom-${slug}/v1/chat/completions`
      : `${base}/chat/completions`;
  }
  const baseUrl = env.UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_URL;
  return `${baseUrl}/chat/completions`;
}

/**
 * Send a Chat Completions request to the upstream.
 * Forwards the client's Authorization header to the upstream/Gateway.
 * No Worker-side secrets required — auth is handled by the AI Gateway.
 *
 * @param {object} env - Workers environment bindings
 * @param {object} chatBody - Translated Chat Completions payload
 * @param {object} [log] - Optional logger (from createLogger)
 * @returns {Promise<Response>}
 */
export async function sendChatRequest(env, chatBody, log = { info(){}, warn(){}, error(){} }) {
  const url = buildUpstreamUrl(env);
  const apiKey = env.AI_GATEWAY_TOKEN || env.OPENCODE_API_KEY;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const startTime = Date.now();
  log.info("upstream.send", { url, model: chatBody.model, hasAuth: !!apiKey });

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(chatBody),
  });

  log.info("upstream.done", {
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startTime,
  });

  return response;
}

/**
 * Extract usage statistics from an upstream completion response.
 */
export function extractUsage(upstreamData) {
  if (!upstreamData?.usage) return null;
  const u = upstreamData.usage;
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
  };
}
