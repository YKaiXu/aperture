// ─── Utility Function Tests ────────────────────────────
// Tests for: uid, now, extractText, resolveDefaultModel,
//            corsHeaders, errorResponse, authenticate

import { describe, it, expect, vi } from "vitest";
import {
  uid, now, extractText, resolveDefaultModel, DEFAULT_MODEL,
  corsHeaders, errorResponse, authenticate, createLogger,
} from "../src/utils.js";

describe("uid()", () => {
  it("generates a string with the given prefix", () => {
    const id = uid("test");
    expect(id).toMatch(/^test_[0-9a-f]{24}$/);
  });

  it("defaults to resp_ prefix", () => {
    const id = uid();
    expect(id).toMatch(/^resp_[0-9a-f]{24}$/);
  });

  it("generates unique IDs on successive calls", () => {
    const a = uid("r");
    const b = uid("r");
    expect(a).not.toBe(b);
  });
});

describe("now()", () => {
  it("returns a Unix timestamp (seconds)", () => {
    const ts = now();
    expect(Number.isInteger(ts)).toBe(true);
    expect(ts).toBeGreaterThan(1700000000); // reasonable min for 2024+
    expect(ts).toBeLessThan(2000000000);   // reasonable max
  });
});

describe("extractText()", () => {
  it("returns the string as-is for string input", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("joins text parts from an array of content blocks (Anthropic style)", () => {
    const input = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(extractText(input)).toBe("Hello world");
  });

  it("extracts text from OpenAI-style content blocks", () => {
    const input = [
      { type: "image_url", image_url: { url: "data:..." } },
      { type: "text", text: "desc" },
    ];
    expect(extractText(input)).toBe("desc");
  });

  it("returns empty string for unsupported content", () => {
    expect(extractText(123)).toBe("");
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("returns empty string for content without text keys", () => {
    expect(extractText([{ type: "image", source: { media_type: "image/png" } }])).toBe("");
  });
});

describe("resolveDefaultModel()", () => {
  it("returns env.DEFAULT_MODEL when provided", () => {
    expect(resolveDefaultModel({ DEFAULT_MODEL: "custom-model" })).toBe("custom-model");
  });

  it("returns the built-in default when env is empty", () => {
    expect(resolveDefaultModel({})).toBe(DEFAULT_MODEL);
  });

  it("returns the built-in default when env is undefined", () => {
    expect(resolveDefaultModel()).toBe(DEFAULT_MODEL);
  });
});

describe("corsHeaders()", () => {
  it("returns standard CORS headers", () => {
    const h = corsHeaders();
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Access-Control-Allow-Methods"]).toContain("POST");
    expect(h["Access-Control-Allow-Headers"]).toContain("Authorization");
  });

  it("merges extra headers", () => {
    const h = corsHeaders({ "X-Custom": "test" });
    expect(h["X-Custom"]).toBe("test");
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
  });
});

describe("errorResponse()", () => {
  it("returns a Response with JSON error body", async () => {
    const res = errorResponse("Bad request", "invalid_request", "PARSE_ERROR", 400);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toBe("Bad request");
    expect(body.error.type).toBe("invalid_request");
    expect(body.error.code).toBe("PARSE_ERROR");
  });

  it("uses status 400 by default", () => {
    const res = errorResponse("Bad", "err", "E");
    expect(res.status).toBe(400);
  });

  it("includes CORS headers", () => {
    const res = errorResponse("Bad", "err", "E", 500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("authenticate()", () => {
  const makeReq = (authHeader, apiKey) => {
    const headers = new Map();
    if (authHeader) headers.set("authorization", authHeader);
    if (apiKey) headers.set("x-api-key", apiKey);
    return { headers: { get: (k) => headers.get(k.toLowerCase()) } };
  };

  it("returns ok for valid Bearer token", () => {
    const result = authenticate(makeReq("Bearer valid-token"), {
      AI_GATEWAY_TOKEN: "valid-token",
    });
    expect(result.ok).toBe(true);
  });

  it("returns ok for valid x-api-key", () => {
    const result = authenticate(makeReq(null, "valid-token"), {
      AI_GATEWAY_TOKEN: "valid-token",
    });
    expect(result.ok).toBe(true);
  });

  it("returns 401 for invalid token", () => {
    const result = authenticate(makeReq("Bearer wrong"), {
      AI_GATEWAY_TOKEN: "valid",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when no token provided", () => {
    const result = authenticate(makeReq(), { AI_GATEWAY_TOKEN: "valid" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("returns 500 when server has no config", () => {
    const result = authenticate(makeReq("Bearer token"), {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.code).toBe("CONFIG_ERROR");
  });

  it("prefers Bearer token over x-api-key", () => {
    // If both are present, Bearer wins
    const result = authenticate(makeReq("Bearer bearer-tok", "key-tok"), {
      AI_GATEWAY_TOKEN: "bearer-tok",
    });
    expect(result.ok).toBe(true);
  });
});

describe("createLogger()", () => {
  it("returns logger with info, warn, error methods", () => {
    const log = createLogger("req_123");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("emits JSON to console.log on info", () => {
    const log = createLogger("req_1");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("test.event", { foo: "bar" });
    expect(spy).toHaveBeenCalledOnce();
    const called = spy.mock.calls[0][0];
    const parsed = JSON.parse(called);
    expect(parsed.level).toBe("info");
    expect(parsed.event).toBe("test.event");
    expect(parsed.foo).toBe("bar");
    expect(parsed.requestId).toBe("req_1");
    spy.mockRestore();
  });

  it("emits to console.error on error", () => {
    const log = createLogger("req_2");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("err.event", { status: 500 });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
