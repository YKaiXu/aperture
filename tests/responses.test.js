// ─── Responses API Translation Tests ───────────────────
// Tests for translateToChat() matching actual code behavior

import { describe, it, expect } from "vitest";
import { translateToChat } from "../src/responses.js";

describe("translateToChat()", () => {
  /* ── Input as array of items (string elements) ───── */
  it("converts string items in input array to user messages", () => {
    const result = translateToChat({
      input: ["Hello"],
      model: "test-model",
    });
    expect(result.model).toBe("test-model");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello");
    expect(result.stream).toBe(false);
  });

  /* ── Message items with role/content ─────────────── */
  it("converts message items with role and content", () => {
    const result = translateToChat({
      input: [
        { type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
        { type: "message", role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("hi");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toBe("hello");
  });

  /* ── function_call items ─────────────────────────── */
  it("converts function_call items to tool_calls", () => {
    const result = translateToChat({
      input: [
        { type: "message", role: "user", content: "whats weather" },
        { type: "function_call", name: "get_weather", call_id: "call_123", arguments: '{"city":"Beijing"}' },
        { type: "function_call_output", call_id: "call_123", output: '{"temp":25}' },
      ],
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("user");
    // function_call → tool_calls on assistant message
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].tool_calls).toHaveLength(1);
    expect(result.messages[1].tool_calls[0].function.name).toBe("get_weather");
    expect(result.messages[1].tool_calls[0].function.arguments).toBe('{"city":"Beijing"}');
    // function_call_output → tool role
    expect(result.messages[2].role).toBe("tool");
    expect(result.messages[2].tool_call_id).toBe("call_123");
  });

  /* ── instructions → system message, prepended ────── */
  it("converts instructions to system message", () => {
    const result = translateToChat({
      input: [{ type: "message", role: "user", content: "Hi" }],
      instructions: "You are a helpful assistant.",
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("You are a helpful assistant.");
    expect(result.messages[1].role).toBe("user");
  });

  /* ── tools → function definitions (with tool_choice auto) ── */
  it("converts tools to function definitions with auto tool_choice", () => {
    const result = translateToChat({
      input: [{ type: "message", role: "user", content: "Hi" }],
      tools: [
        { type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object" } },
      ],
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].function.name).toBe("get_weather");
    expect(result.tool_choice).toBe("auto");
  });

  /* ── tool_choice passed through when tools exist ──── */
  it("passes tool_choice when tools are defined", () => {
    const result = translateToChat({
      input: [{ type: "message", role: "user", content: "Hi" }],
      tool_choice: { type: "function", name: "get_weather" },
      tools: [{ type: "function", name: "get_weather", parameters: {} }],
    });
    expect(result.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  it("passes tool_choice = auto when tools defined", () => {
    const result = translateToChat({
      input: [{ type: "message", role: "user", content: "Hi" }],
      tool_choice: "auto",
      tools: [{ type: "function", name: "test", parameters: {} }],
    });
    expect(result.tool_choice).toBe("auto");
  });

  /* ── parallel_tool_calls passed when tools exist ── */
  it("passes parallel_tool_calls when tools exist", () => {
    const result = translateToChat({
      input: ["Hi"],
      parallel_tool_calls: false,
      tools: [{ type: "function", name: "test", parameters: {} }],
    });
    expect(result.parallel_tool_calls).toBe(false);
  });

  /* ── reasoning.effort → thinking object ──────────── */
  it("converts reasoning.effort to thinking object", () => {
    const result = translateToChat({
      input: ["Think"],
      reasoning: { effort: "high" },
    });
    expect(result.thinking).toEqual({
      type: "enabled",
      reasoning_effort: "high",
    });
  });

  /* ── max_output_tokens ───────────────────────────── */
  it("maps max_output_tokens to max_tokens", () => {
    const result = translateToChat({
      input: ["Hi"],
      max_output_tokens: 4096,
    });
    expect(result.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(result.max_tokens).toBe(4096);
  });

  /* ── stream = true ──────────────────────────────── */
  it("sets stream: true when explicitly passed", () => {
    const result = translateToChat({
      input: ["Hi"],
      stream: true,
    });
    expect(result.stream).toBe(true);
  });

  /* ── stream defaults to false for Responses API ──── */
  it("defaults stream to false", () => {
    const result = translateToChat({ input: ["Hi"] });
    expect(result.stream).toBe(false);
  });

  /* ── Pass-through parameters ─────────────────────── */
  it("passes temperature, top_p, stop, response_format", () => {
    const result = translateToChat({
      input: ["Hi"],
      temperature: 0.7,
      top_p: 0.9,
      stop: ["END"],
      response_format: { type: "json_object" },
    });
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.stop).toEqual(["END"]);
    expect(result.response_format).toEqual({ type: "json_object" });
  });

  /* ── developer role goes to systemParts ──────────── */
  it("converts developer role messages to system", () => {
    const result = translateToChat({
      input: [
        { type: "message", role: "developer", content: [{ type: "text", text: "be concise" }] },
        { type: "message", role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("be concise");
  });

  /* ── reasoning items ─────────────────────────────── */
  it("converts reasoning items to assistant summary", () => {
    const result = translateToChat({
      input: [
        { type: "reasoning", summary: "I need to think step by step", content: "detailed" },
        { type: "message", role: "user", content: "done" },
      ],
    });
    expect(result.messages[0].role).toBe("assistant");
    expect(result.messages[0].content).toContain("step by step");
  });

  /* ── local_shell_call items ─────────────────────── */
  it("converts local_shell_call to tool call", () => {
    const result = translateToChat({
      input: [
        { type: "local_shell_call", call_id: "sh_1", action: { cmd: "ls" } },
      ],
    });
    const asst = result.messages.find((m) => m.role === "assistant");
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0].function.name).toBe("shell");
  });

  /* ── Empty/missing input ─────────────────────────── */
  it("handles missing input gracefully", () => {
    const result = translateToChat({});
    expect(result.messages).toEqual([]);
    expect(result.model).toBeDefined();
  });
});
