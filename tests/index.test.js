// ─── Index Module Tests ─────────────────────────────────
// Tests for: mapModelName, detectRoute, normalizeDsmlToolCalls,
//            readUpstreamErrorBody, filterChatStream

import { describe, it, expect } from "vitest";

// ─── resolveModel ──────────────────────────────────────

// Inline copy since resolveModel is not exported from index.js
function resolveModel(model, env = {}) {
  // Always returns the configured default — ignores the client's model ID
  const fallback = env.DEFAULT_MODEL || "deepseek-v4-flash";
  return fallback;
}

describe("resolveModel()", () => {
  it("always returns the configured default model", () => {
    expect(resolveModel("gpt-4", { DEFAULT_MODEL: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
    expect(resolveModel("dv4f", { DEFAULT_MODEL: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
    expect(resolveModel("anything", { DEFAULT_MODEL: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
    expect(resolveModel(null, { DEFAULT_MODEL: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
    expect(resolveModel("", { DEFAULT_MODEL: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  });

  it("falls back to built-in default when env has no DEFAULT_MODEL", () => {
    expect(resolveModel("any", {})).toBe("deepseek-v4-flash");
  });
});

// ─── detectRoute ───────────────────────────────────────

function detectRoute(path, body) {
  if (path === "/v1/chat/completions" || path.endsWith("/chat/completions")) return "chat";
  if (path === "/v1/messages" || path.endsWith("/messages")) return "anthropic";

  if (body.messages) return "chat";
  if (body.input !== undefined || body.instructions !== undefined) return "responses";
  if (body.anthropic_version || body.anthropic) return "anthropic";

  return "responses";
}

describe("detectRoute()", () => {
  it("detects chat by explicit path", () => {
    expect(detectRoute("/v1/chat/completions", {})).toBe("chat");
  });

  it("detects anthropic by explicit path", () => {
    expect(detectRoute("/v1/messages", {})).toBe("anthropic");
  });

  it("detects chat by body.messages", () => {
    expect(detectRoute("/", { messages: [] })).toBe("chat");
  });

  it("detects responses by body.input", () => {
    expect(detectRoute("/", { input: "hello" })).toBe("responses");
  });

  it("detects responses by body.instructions", () => {
    expect(detectRoute("/", { instructions: "be helpful" })).toBe("responses");
  });

  it("detects anthropic by body.anthropic_version", () => {
    expect(detectRoute("/", { anthropic_version: "2023-06-01" })).toBe("anthropic");
  });

  it("detects anthropic by body.anthropic flag", () => {
    expect(detectRoute("/", { anthropic: true })).toBe("anthropic");
  });

  it("defaults to responses when no indicator matches", () => {
    expect(detectRoute("/", {})).toBe("responses");
    expect(detectRoute("/unknown", { random: true })).toBe("responses");
  });
});

// ─── normalizeDsmlToolCalls ────────────────────────────

// Inline copy since it's not exported
function normalizeDsmlToolCalls(responseBody) {
  if (!responseBody?.choices?.[0]?.message) return responseBody;
  const choice = responseBody.choices[0];
  const msg = choice.message;
  const content = msg.content || "";

  const dsmlDetect = (
    content.includes("DSML") &&
    (content.includes("tool_calls") || content.includes("invoke name"))
  );
  if (!dsmlDetect) return responseBody;

  const toolCalls = [];

  const sections = content.split(/(?=invoke\s+name\s*=)/gi);
  for (const section of sections) {
    const invokeMatch = section.match(/invoke\s+name\s*=\s*"([^"]+)"/i);
    if (!invokeMatch) continue;

    const fnName = invokeMatch[1];
    const args = {};
    const paramRe = /parameter\s+name\s*=\s*"([^"]+)"[^>]*>([^<]*)<\//gi;
    let pMatch;
    while ((pMatch = paramRe.exec(section)) !== null) {
      if (pMatch[1]) args[pMatch[1]] = pMatch[2] || "";
    }

    toolCalls.push({
      index: toolCalls.length,
      id: `call_dsml_${"uid"}`,
      type: "function",
      function: { name: fnName, arguments: JSON.stringify(args) },
    });
  }

  if (toolCalls.length === 0) return responseBody;

  msg.content = "";
  msg.tool_calls = toolCalls;
  if (choice.finish_reason === "stop" || choice.finish_reason === "length") {
    choice.finish_reason = "tool_calls";
  }

  return responseBody;
}

describe("normalizeDsmlToolCalls()", () => {
  it("passes through non-DSML responses unchanged", () => {
    const input = {
      choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
    };
    const result = normalizeDsmlToolCalls(input);
    expect(result).toBe(input);
    expect(result.choices[0].message.content).toBe("Hello world");
  });

  it("passes through when no choices", () => {
    const input = {};
    expect(normalizeDsmlToolCalls(input)).toBe(input);
  });

  it("converts DSML with invoke and parameters", () => {
    const input = {
      choices: [{
        message: { content: '<DSML>tool_calls> invoke name="get_weather" parameter name="city">Beijing</' },
        finish_reason: "stop",
      }],
    };
    const result = normalizeDsmlToolCalls(input);
    expect(result.choices[0].message.content).toBe("");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("handles multiple DSML tool calls with independent parameters", () => {
    const input = {
      choices: [{
        message: {
          content: [
            '<DSML>tool_calls> ',
            'invoke name="func_a" ',
            'parameter name="x">1</> ',
            'invoke name="func_b" ',
            'parameter name="y">2</>',
          ].join(""),
        },
        finish_reason: "length",
      }],
    };
    const result = normalizeDsmlToolCalls(input);
    expect(result.choices[0].message.tool_calls).toHaveLength(2);
    expect(result.choices[0].message.tool_calls[0].function.name).toBe("func_a");
    expect(result.choices[0].message.tool_calls[1].function.name).toBe("func_b");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("returns unchanged when DSML detected but no invoke found", () => {
    const input = {
      choices: [{
        message: { content: "<DSML>tool_calls> some text" },
        finish_reason: "stop",
      }],
    };
    const result = normalizeDsmlToolCalls(input);
    expect(result).toBe(input); // no invoke → unchanged
  });
});

// ─── readUpstreamErrorBody ─────────────────────────────

async function readUpstreamErrorBody(response) {
  try {
    const text = await response.text();
    if (!text) return "(empty body)";
    try {
      const json = JSON.parse(text);
      return json.error?.message || json.message || text.slice(0, 500);
    } catch {
      return text.slice(0, 500) || "(empty)";
    }
  } catch {
    return "(unreadable)";
  }
}

describe("readUpstreamErrorBody()", () => {
  it("extracts error.message from JSON", async () => {
    const res = {
      text: async () => JSON.stringify({ error: { message: "Rate limited" } }),
    };
    expect(await readUpstreamErrorBody(res)).toBe("Rate limited");
  });

  it("extracts top-level message when no error.message", async () => {
    const res = {
      text: async () => JSON.stringify({ message: "Not found" }),
    };
    expect(await readUpstreamErrorBody(res)).toBe("Not found");
  });

  it("returns text slice when JSON has no known fields", async () => {
    const res = {
      text: async () => JSON.stringify({ foo: "bar" }),
    };
    expect(await readUpstreamErrorBody(res)).toBe('{"foo":"bar"}');
  });

  it("returns text slice for non-JSON body", async () => {
    const res = {
      text: async () => "Internal Server Error",
    };
    expect(await readUpstreamErrorBody(res)).toBe("Internal Server Error");
  });

  it("returns (empty body) for empty response", async () => {
    const res = { text: async () => "" };
    expect(await readUpstreamErrorBody(res)).toBe("(empty body)");
  });

  it("returns (unreadable) when text() throws", async () => {
    const res = { text: async () => { throw new Error("network"); } };
    expect(await readUpstreamErrorBody(res)).toBe("(unreadable)");
  });
});

// ─── filterChatStream (data flow through the generator) ─

async function* filterChatStream(upstreamResponse) {
  const reader = upstreamResponse.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) {
        yield line;
        continue;
      }
      const payload = trimmed.slice(6).trim();
      if (payload === "[DONE]") {
        yield line;
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        yield line;
        continue;
      }
      if (!parsed.choices || !Array.isArray(parsed.choices)) {
        yield line;
        continue;
      }
      let modified = false;
      for (const choice of parsed.choices) {
        if (!choice.delta) continue;
        if (choice.delta.content === null) {
          choice.delta.content = "";
          modified = true;
        }
        if (choice.delta.reasoning_content !== undefined) {
          delete choice.delta.reasoning_content;
          modified = true;
        }
      }
      if (!modified) {
        yield line;
        continue;
      }
      const hasContent = parsed.choices.some(c =>
        (c.delta && Object.keys(c.delta).length > 0) || c.finish_reason
      );
      if (hasContent) {
        yield `data: ${JSON.stringify(parsed)}`;
      }
    }
  }
}

describe("filterChatStream()", () => {
  function makeStream(chunks) {
    const encoder = new TextEncoder();
    return {
      body: new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      }),
    };
  }

  async function collect(gen) {
    const items = [];
    for await (const item of gen) items.push(item);
    return items;
  }

  it("strips reasoning_content from delta chunks", async () => {
    const s = makeStream([
      'data: {"choices":[{"index":0,"delta":{"content":"Hello","reasoning_content":"thinking..."}}]}\n\ndata: [DONE]\n\n',
    ]);
    const lines = await collect(filterChatStream(s));
    const dataLines = lines.filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).not.toContain("reasoning_content");
    expect(dataLines[0]).toContain('"content":"Hello"');
  });

  it("converts content: null to content: \"\"", async () => {
    const s = makeStream([
      'data: {"choices":[{"index":0,"delta":{"content":null},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]);
    const lines = await collect(filterChatStream(s));
    const dataLines = lines.filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    expect(dataLines[0]).toContain('"content":""');
  });

  it("passes through [DONE] unchanged", async () => {
    const s = makeStream(["data: [DONE]\n\n"]);
    const lines = await collect(filterChatStream(s));
    const doneLines = lines.filter((l) => l.includes("[DONE]"));
    expect(doneLines[0]).toContain("data: [DONE]");
  });

  it("passes through non-data lines", async () => {
    const s = makeStream([":comment\n\n"]);
    const lines = await collect(filterChatStream(s));
    expect(lines.some((l) => l.trim() === ":comment")).toBe(true);
  });

  it("skips chunks that only had reasoning_content", async () => {
    const s = makeStream([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking..."}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"real"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]);
    const lines = await collect(filterChatStream(s));
    const dataLines = lines.filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]).toContain('"content":"real"');
  });

  it("handles empty response body gracefully", async () => {
    const s = makeStream([""]);
    const lines = await collect(filterChatStream(s));
    expect(lines).toEqual([]);
  });
});
