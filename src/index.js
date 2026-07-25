import { authenticate } from "./middleware/auth.js";
import { createRateLimiter } from "./middleware/rate-limiter.js";
import { errorResponse } from "./helpers.js";
import { handleChatCompletions } from "./handlers/chat.js";
import { handleResponsesAPI } from "./handlers/responses.js";
import { handleAnthropicMessages } from "./handlers/anthropic.js";

function detectRoute(path, body) {
  if (path === "/v1/chat/completions" || path.endsWith("/chat/completions")) return "chat";
  if (path === "/v1/messages" || path.endsWith("/messages")) return "anthropic";
  if (body.messages) return "chat";
  if (body.input !== undefined || body.instructions !== undefined) return "responses";
  if (body.anthropic_version || body.anthropic) return "anthropic";
  return "responses";
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    if (request.method !== "POST") return errorResponse("Method not allowed", "invalid_request", "METHOD_NOT_ALLOWED", 405);

    const rateLimiter = createRateLimiter(
      Math.max(1000, parseInt(env.RATE_LIMIT_WINDOW_MS || "60000", 10) || 60000),
      Math.max(1, parseInt(env.RATE_LIMIT_MAX || "120", 10) || 120)
    );
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateCheck = rateLimiter.check(clientIp);
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded. Try again later.", type: "rate_limit_error", code: "RATE_LIMITED" } }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil((rateCheck.resetAt - Date.now()) / 1000)), ...cors } }
      );
    }

    const authResponse = authenticate(request, env);
    if (authResponse) return authResponse;

    let body;
    try {
      const raw = await request.text();
      body = JSON.parse(raw);
    } catch {
      return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("Invalid JSON body", "invalid_request", "PARSE_ERROR", 400);
    }

    const path = new URL(request.url).pathname;
    switch (detectRoute(path, body)) {
      case "chat":      return handleChatCompletions(body, env, request.signal);
      case "responses": return handleResponsesAPI(body, env, request.signal);
      case "anthropic": return handleAnthropicMessages(body, env, request.signal);
      default:          return errorResponse("Unknown API format", "invalid_request", "FORMAT_UNKNOWN", 400);
    }
  },
};
