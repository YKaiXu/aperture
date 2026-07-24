// ─── Anthropic Messages API Translation Tests ──────────
// Tests for translateAnthropicToChat() matching actual code behavior

import { describe, it, expect } from "vitest";
import { translateAnthropicToChat } from "../src/anthropic.js";

describe("translateAnthropicToChat()", () => {
  /* ── Basic messages ─────────────────────────────── */
  it("converts simple user message", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello");
  });

  /* ── Multi-turn conversation ───────────────────── */
  it("converts multi-turn messages", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
  });

  /* ── System prompt (string) ─────────────────────── */
  it("converts string system prompt", () => {
    const result = translateAnthropicToChat({
      system: "You are Claude.",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("You are Claude.");
  });

  /* ── System prompt (array of strings) ───────────── */
  it("converts array system prompt of strings", () => {
    const result = translateAnthropicToChat({
      system: ["You are Claude.", "Be helpful."],
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("You are Claude.");
    expect(result.messages[0].content).toContain("Be helpful.");
  });

  /* ── Structured content blocks (text + tool_use) in assistant ── */
  it("converts text and tool_use in assistant messages", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Calculate" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "The answer is 42" },
            { type: "tool_use", id: "tu_1", name: "calculator", input: { expr: "6*7" } },
          ],
        },
      ],
    });
    const asst = result.messages[1];
    expect(asst.role).toBe("assistant");
    expect(asst.content).toContain("42");
    // tool_use blocks should become tool_calls on the assistant message
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0].function.name).toBe("calculator");
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({ expr: "6*7" });
  });

  /* ── tool_result blocks → user text (compat mode) ── */
  it("converts tool_result to user text", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "user", content: "Use tool" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Beijing" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "25°C" },
          ],
        },
      ],
    });
    // tool_result is converted to user message text (compat)
    const lastMsg = result.messages[2];
    expect(lastMsg.role).toBe("user"); // compat mode
    expect(lastMsg.content).toContain("25°C");
  });

  /* ── Image blocks (base64 → images array) ───────── */
  it("converts image blocks to images array on message", () => {
    const result = translateAnthropicToChat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    });
    expect(result.messages[0].content).toContain("What's in this image?");
    expect(result.messages[0].images).toHaveLength(1);
    expect(result.messages[0].images[0].type).toBe("image_url");
    expect(result.messages[0].images[0].image_url.url).toContain("data:image/png;base64,iVBORw0KGgo=");
  });

  /* ── Tools with input_schema → parameters ───────── */
  it("maps anthropic input_schema to parameters", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(result.tools).toHaveLength(1);
    const fn = result.tools[0].function;
    expect(fn.name).toBe("get_weather");
    expect(fn.parameters).toEqual({ type: "object", properties: { city: { type: "string" } } });
    expect(fn.input_schema).toBeUndefined();
  });

  /* ── max_tokens defaults ────────────────────────── */
  it("defaults max_tokens to 8192", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.max_tokens).toBe(8192);
  });

  /* ── max_tokens minimum enforcement ─────────────── */
  it("enforces minimum max_tokens", () => {
    const result = translateAnthropicToChat({
      max_tokens: 10,
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.max_tokens).toBeGreaterThanOrEqual(1024);
  });

  /* ── Parameters pass-through ────────────────────── */
  it("passes temperature, top_p, top_k, stop_sequences", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.8,
      top_p: 0.95,
      top_k: 40,
      stop_sequences: ["END"],
    });
    expect(result.temperature).toBe(0.8);
    expect(result.top_p).toBe(0.95);
    expect(result.top_k).toBe(40);
    expect(result.stop).toEqual(["END"]);
  });

  /* ── metadata.user_id → chat.user_id ────────────── */
  it("maps metadata.user_id to chat.user_id", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hi" }],
      metadata: { user_id: "abc" },
    });
    expect(result.user_id).toBe("abc");
  });

  /* ── stream defaults to true (Anthropic always streams) ── */
  it("defaults stream to true", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.stream).toBe(true);
  });

  /* ── thinking config → thinking object ──────────── */
  it("converts thinking config to object", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Think hard" }],
      thinking: { type: "enabled", budget_tokens: 16000 },
    });
    expect(result.thinking).toEqual({
      type: "enabled",
      budget_tokens: 16000,
    });
  });

  /* ── tool_choice mapping ────────────────────────── */
  it("passes tool_choice when tools are defined", () => {
    const result = translateAnthropicToChat({
      messages: [{ role: "user", content: "Hi" }],
      tool_choice: { type: "tool", name: "get_weather" },
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
    });
    expect(result.tool_choice).toBeDefined();
  });

  /* ── system message in first message ────────────── */
  it("converts system role message to system content", () => {
    const result = translateAnthropicToChat({
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hi" },
      ],
    });
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("Be concise");
  });

  /* ── Empty messages array ───────────────────────── */
  it("handles empty messages", () => {
    const result = translateAnthropicToChat({ messages: [] });
    expect(result.messages).toEqual([]);
  });
});
