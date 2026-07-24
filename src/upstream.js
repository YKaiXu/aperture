// ─── Upstream API Client ─────────────────────────────────
// Routes through Cloudflare AI Gateway for caching + analytics when configured.
//
// Gateway setup (Cloudflare Dashboard → AI → AI Gateway → opencodego):
// 1. Add a provider → OpenAI Compatible
// 2. Endpoint URL: https://opencode.ai/zen/go/v1
// 3. API Key: your OpenCode API key
// 4. Then set AI_GATEWAY_URL env var to enable routing through the gateway

import { fetchUpstream } from "./utils.js";

/**
 * Build the upstream Chat Completions URL.
 * Uses UPSTREAM_BASE_URL directly (not Gateway) for maximum reliability.
 * Gateway is used only for analytics logging (optional).
 */
function buildUpstreamUrl(env) {
  const baseUrl = env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1";
  return `${baseUrl}/chat/completions`;
}

/**
 * Choose the API key: always use OPENCODE_API_KEY for upstream requests.
 */
function chooseApiKey(env) {
  return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
}

/**
 * Send a Chat Completions request directly to the upstream API.
 * Reliable and simple — no Gateway in the request path.
 */
export async function sendChatRequest(env, chatBody) {
  const url = buildUpstreamUrl(env);
  const apiKey = chooseApiKey(env);
  const timeout = parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10);

  return fetchUpstream(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(chatBody),
    },
    timeout
  );
}

/**
 * Get the upstream URL that would be used (for diagnostics).
 */
export function getUpstreamUrl(env) {
  return buildUpstreamUrl(env);
}

export function extractUsage(upstreamData) {
  if (!upstreamData?.usage) return null;
  const u = upstreamData.usage;
  return {
    input_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    output_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
  };
}

export function getFinishReason(choice) {
  return choice?.finish_reason || null;
}

export { streamSSE } from "./utils.js";
