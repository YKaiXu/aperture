// --- Upstream API Client ---------------------------------
// Routes through Cloudflare AI Gateway for caching + analytics.
// Falls back to direct upstream on Gateway failure.

import { fetchUpstream } from "./utils.js";

function buildUpstreamUrl(env) {
  // Direct mode: skip AI Gateway entirely
  const bypass = env.BYPASS_GATEWAY === "true" || env.BYPASS_GATEWAY === "1";
  if (bypass) {
    const baseUrl = env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1";
    return `${baseUrl}/chat/completions`;
  }

  // AI Gateway route
  const gwUrl = (env.AI_GATEWAY_URL || "").trim();
  if (gwUrl) {
    const base = gwUrl.replace(/\/+$/, "");
    const slug = env.CUSTOM_PROVIDER_SLUG || "";
    return slug ? `${base}/custom-${slug}/v1/chat/completions` : `${base}/chat/completions`;
  }
  // Direct route (fallback)
  const baseUrl = env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1";
  return `${baseUrl}/chat/completions`;
}

function chooseApiKey(env) {
  const bypass = env.BYPASS_GATEWAY === "true" || env.BYPASS_GATEWAY === "1";
  if (bypass) {
    return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
  }

  // In Gateway mode, use Gateway token (Gateway stores upstream API key)
  const gwUrl = (env.AI_GATEWAY_URL || "").trim();
  if (gwUrl) {
    return env.AI_GATEWAY_TOKEN || env.OPENCODE_API_KEY;
  }
  return env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;
}

export async function sendChatRequest(env, chatBody) {
  const url = buildUpstreamUrl(env);
  const apiKey = chooseApiKey(env);
  const timeout = Math.max(1000, parseInt(env.REQUEST_TIMEOUT_MS || "120000", 10) || 120000);

  const response = await fetchUpstream(
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

  // Pass through successful responses
  if (response.ok) return response;

  // Gateway error (5xx) -> fallback directly to upstream
  const bypass = env.BYPASS_GATEWAY === "true" || env.BYPASS_GATEWAY === "1";
  const usingGateway = !bypass && (env.AI_GATEWAY_URL || "").trim();

  if (response.status >= 500 && usingGateway) {
    const fallbackUrl = (env.UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1") + "/chat/completions";
    const fallbackKey = env.OPENCODE_API_KEY || env.AI_GATEWAY_TOKEN;

    return fetchUpstream(
      fallbackUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${fallbackKey}`,
        },
        body: JSON.stringify(chatBody),
      },
      timeout
    );
  }

  // Non-retryable error — return as-is to the caller
  return response;
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


