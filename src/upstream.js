// ─── Upstream API Client ─────────────────────────────────
// Routes through Cloudflare AI Gateway for caching + analytics when configured.
//
// Gateway setup (Cloudflare Dashboard → AI → AI Gateway → opencodego):
// 1. Add a provider → OpenAI Compatible
// 2. Endpoint URL: https://opencode.ai/zen/go/v1
// 3. API Key: your OpenCode API key
// 4. Then set AI_GATEWAY_URL env var to enable routing through the gateway

import { fetchUpstream } from "./utils.js";

function buildUpstreamUrl(env) {
  // AI Gateway: routes through CF AI Gateway (adds caching, analytics, retries)
  // Only active when AI_GATEWAY_URL is non-empty.
  const gwUrl = env.AI_GATEWAY_URL || "";
  if (gwUrl.trim()) {
    const base = gwUrl.replace(/\/+$/, "");
    const slug = env.CUSTOM_PROVIDER_SLUG || "";
    if (slug) {
      return `${base}/custom-${slug}/v1/chat/completions`;
    }
    return `${base}/chat/completions`;
  }
  // Direct/transit route
  const baseUrl = env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1";
  return `${baseUrl}/chat/completions`;
}

/**
 * Choose the API key for upstream requests.
 * - Gateway mode (AI_GATEWAY_URL set): use Gateway token (cfut)
 * - Direct/transit mode: use OPENCODE_API_KEY
 */
function chooseApiKey(env) {
  const gwUrl = env.AI_GATEWAY_URL || "";
  if (gwUrl.trim()) {
    return env.AI_GATEWAY_TOKEN || env.OPENCODE_API_KEY;
  }
  return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
}

/**
 * Send a Chat Completions request to the upstream API.
 * When routing through AI Gateway, sends OPENCODE_API_KEY as auth
 * (gateway forwards it to the configured upstream provider).
 * When routing directly, sends the upstream API key.
 */
export async function sendChatRequest(env, chatBody) {
  // Try primary route (Gateway or direct based on config)
  const primaryUrl = buildUpstreamUrl(env);
  const timeout = parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10);
  const primaryApiKey = chooseApiKey(env);

  const response = await fetchUpstream(
    primaryUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${primaryApiKey}`,
      },
      body: JSON.stringify(chatBody),
    },
    timeout
  );

  // If primary route succeeds or is not a 400 (client error), return as-is
  if (response.ok || response.status !== 400) return response;

  // --- Fallback: Gateway 400 → retry directly to Console Go ---
  // This handles intermittent issues with the Gateway's stored API key.
  const gwUrl = (env.AI_GATEWAY_URL || "").trim();
  if (!gwUrl) return response; // already in direct mode, nothing to fallback to

  // Read the error body to confirm it's a Console Go error
  try {
    const errBody = await response.clone().text();
    if (!errBody.includes("Console Go")) return response; // not a Console Go error, don't retry
  } catch {
    return response; // can't read body, don't retry
  }

  // Build fallback URL and API key for direct route
  const fallbackUrl = (env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1") + "/chat/completions";
  const fallbackApiKey = env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;

  console.log(`Gateway 400 → falling back to direct: ${fallbackUrl}`);

  return fetchUpstream(
    fallbackUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${fallbackApiKey}`,
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
