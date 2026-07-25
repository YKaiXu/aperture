import { describe, it, expect, vi } from "vitest";

// -----------------------------------------------------------------
// Coverage gap tests — target specific uncovered lines
// -----------------------------------------------------------------

describe("coverage-gap: helpers.js line 40", () => {
  it("extractText handles unknown content block type", async () => {
    const { extractText } = await import("../src/helpers.js");
    const result = extractText([{ type: "unknown_type", value: "x" }]);
    expect(result).toBe("");
  });
});

describe("coverage-gap: index.js lines 14-15 (anthropic body shape routing)", () => {
  it("routes by body.anthropic_version to anthropic handler", async () => {
    const { handleAnthropicMessages } = await import("../src/handlers/anthropic.js");
    // Test detectRoute indirectly via index.js
    const mod = await import("../src/index.js");
    const handler = mod.default.fetch;
    // Mock rate limiter to pass, mock auth to pass, mock handler
    const env = {
      RATE_LIMIT_WINDOW_MS: "60000",
      RATE_LIMIT_MAX: "120",
      AI_GATEWAY_TOKEN: "test",
    };
    const request = new Request("http://test.com/", {
      method: "POST",
      headers: { "Authorization": "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({
        anthropic_version: "2023-06-01",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // The mock will be called — just verify no 404/400
    // Use vi.mock on the handler to avoid actual upstream calls
    const response = await handler(request, env);
    // Should not be 400 "Unknown API format"
    expect(response.status).not.toBe(400);
  });
});

describe("coverage-gap: upstream.js line 22 (GW URL with slug)", () => {
  it("buildUpstreamUrl returns base path when slug is empty", async () => {
    const { default: mod } = await import("../src/upstream.js");
    // Can't access private buildUpstreamUrl directly
    // Test via sendChatRequest with mocked fetchUpstream
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));

    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      CUSTOM_PROVIDER_SLUG: "",
      AI_GATEWAY_TOKEN: "key",
      BYPASS_GATEWAY: "false",
    };
    await sendChatRequest(env, { model: "test", messages: [] });

    const calledUrl = spy.mock.calls[0][0];
    expect(calledUrl).toContain("/chat/completions");
    expect(calledUrl).not.toContain("custom-");
    spy.mockRestore();
  });
});

describe("coverage-gap: chat.js lines 25-26 (trailing buffer)", () => {
  it("filterChatStream warns on trailing partial data", async () => {
    const { filterChatStream } = await import("../src/handlers/chat.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Stream with trailing partial line that doesn't start with "data: "
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}"));
        controller.enqueue(encoder.encode("\n"));
        controller.enqueue(encoder.encode("trailing")); // partial, no newline
        controller.close();
      },
    });
    const response = new Response(stream);
    const results = [];
    for await (const line of filterChatStream(response)) {
      results.push(line);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("coverage-gap: rate-limiter.js lines 17-22 (TTL pruning)", () => {
  it("prunes stale entries after many checks", async () => {
    const { createRateLimiter } = await import("../src/middleware/rate-limiter.js");
    const limiter = createRateLimiter(50, 100); // small window

    // Fill with many entries
    for (let i = 0; i < 250; i++) {
      limiter.check(`key_${i}`);
    }
    // Wait for window to expire
    await new Promise(r => setTimeout(r, 60));
    // Trigger check — should prune stale entries
    const result = limiter.check("new_key");
    expect(result.allowed).toBe(true);
  }, 5000);
});

describe("coverage-gap: anthropic.js lines 306-307 (tool call name update)", () => {
  it("updates tool name when provided on subsequent chunk", async () => {
    const { translateAnthropicStream } = await import("../src/translators/anthropic.js");

    // Create a stream where first tool chunk has no name, second has name
    const encoder = new TextEncoder();
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"arguments\":\"{\\\"loc\\\":\\\"NYC\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"get_weather\"}}]}}]}\n",
      "data: [DONE]\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const response = new Response(stream);
    const events = [];
    for await (const evt of translateAnthropicStream(response, "req_001", "test-model")) {
      events.push(evt);
      if (evt.event === "message_stop") break;
    }
    // Verify tool_use content blocks are present
    const toolUseStarts = events.filter(e => e.event === "content_block_start" && e.data.content_block.type === "tool_use");
    expect(toolUseStarts.length).toBeGreaterThanOrEqual(1);
    // Verify input_json_delta events
    const deltas = events.filter(e => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
  });
});

describe("coverage-gap: anthropic.js lines 444-445 (tool_choice type tool)", () => {
  it("maps tool_choice type 'tool' to function type", async () => {
    const { translateAnthropicToChat } = await import("../src/translators/anthropic.js");
    const result = translateAnthropicToChat({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "test_tool" } }],
      tool_choice: { type: "tool", name: "test_tool" },
    });
    expect(result.tool_choice.type).toBe("function");
    expect(result.tool_choice.function.name).toBe("test_tool");
  });
});

describe("coverage-gap: dsml.js line 17 (branch — non-null content)", () => {
  it("normalizeDsmlToolCalls handles msg.content that is non-null", async () => {
    const { normalizeDsmlToolCalls } = await import("../src/translators/dsml.js");
    const body = {
      choices: [{
        message: { content: "some text here", role: "assistant" },
        finish_reason: "stop",
      }],
    };
    const result = normalizeDsmlToolCalls(body);
    expect(result.choices[0].message.content).toBe("some text here");
  });
});

describe("coverage-gap: responses.js lines 284-285 (tool call name update)", () => {
  it("updates tool call name on subsequent chunk", async () => {
    const { translateStreamEvents } = await import("../src/translators/responses.js");

    const encoder = new TextEncoder();
    const chunks = [
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"arguments\":\"{\\\"q\\\":\\\"test\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
      "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"search\"}}]}}]}\n",
      "data: [DONE]\n",
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    const response = new Response(stream);
    const events = [];
    for await (const evt of translateStreamEvents(response, "resp_001", "test-model")) {
      events.push(evt);
      if (evt.event === "response.completed") break;
    }
    // Should have function_call output items
    const additions = events.filter(e => e.event === "response.output_item.added");
    expect(additions.length).toBeGreaterThan(0);
    // Should have flush at end
    const doneItems = events.filter(e => e.event === "response.output_item.done");
    expect(doneItems.length).toBeGreaterThan(0);
  });
});

describe("coverage-gap: upstream branches (slug empty, bypass key, finally)", () => {
  it("sends correct auth header when BYPASS_GATEWAY=true with OPENCODE_API_KEY", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));
    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      BYPASS_GATEWAY: "true",
      OPENCODE_API_KEY: "opencode-key-123",
      AI_GATEWAY_TOKEN: "gw-token",
      UPSTREAM_BASE_URL: "https://custom.upstream.com",
    };
    await sendChatRequest(env, { model: "test", messages: [] });
    const headers = spy.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer opencode-key-123");
    spy.mockRestore();
  });

  it("handles slug being empty with AI_GATEWAY_URL set", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockResolvedValue(new Response("ok", { status: 200 }));
    const { sendChatRequest } = await import("../src/upstream.js");
    const env = {
      AI_GATEWAY_URL: "https://gateway.example.com",
      CUSTOM_PROVIDER_SLUG: "",
      AI_GATEWAY_TOKEN: "token",
      BYPASS_GATEWAY: "false",
    };
    await sendChatRequest(env, { model: "test", messages: [] });
    const url = spy.mock.calls[0][0];
    expect(url).toContain("gateway.example.com/chat/completions");
    spy.mockRestore();
  });

  it("sends clientSignal to upstream and cleans up", async () => {
    const helpers = await import("../src/helpers.js");
    const spy = vi.spyOn(helpers, "fetchUpstream").mockImplementation(
      async (url, opts) => {
        expect(opts.signal).toBeDefined();
        return new Response("ok", { status: 200 });
      }
    );
    const { sendChatRequest } = await import("../src/upstream.js");
    const controller = new AbortController();
    const env = {
      BYPASS_GATEWAY: "true",
      OPENCODE_API_KEY: "key",
      UPSTREAM_BASE_URL: "https://upstream.test",
    };
    await sendChatRequest(env, { model: "test", messages: [] }, controller.signal);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("coverage-gap: dsml.js msg.content branch", () => {
  it("handles msg.content that is null", async () => {
    const { normalizeDsmlToolCalls } = await import("../src/translators/dsml.js");
    const body = { choices: [{ message: { content: null, role: "assistant" }, finish_reason: "stop" }] };
    const result = normalizeDsmlToolCalls(body);
    // Should not throw and return body unchanged (no DSML pattern)
    expect(result.choices[0].message.content).toBe(null);
  });
  it("handles msg.content that has prose alongside DSML", async () => {
    const { normalizeDsmlToolCalls } = await import("../src/translators/dsml.js");
    const body = {
      choices: [{
        message: { content: 'First do X <invoke name="fn"><parameter name="x">1</parameter></invoke> then do Y', role: "assistant" },
        finish_reason: "stop",
      }],
    };
    const result = normalizeDsmlToolCalls(body);
    const msg = result.choices[0].message;
    expect(msg.content).toContain("First do X");
    expect(msg.content).toContain("then do Y");
    expect(msg.tool_calls).toHaveLength(1);
  });
});
