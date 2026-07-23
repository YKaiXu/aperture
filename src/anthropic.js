// ─── Anthropic Messages API → OpenCode Chat Completions ───

import { uid, now, extractText } from "./utils.js";
import { sendChatRequest, extractUsage, getFinishReason } from "./upstream.js";

/**
 * Translate an Anthropic Messages API request body to OpenCode Chat Completions format.
 *
 * Supports:
 * - messages[] with role: user/assistant
 * - system prompt (as top-level field or first system message)
 * - content blocks (text, image, tool_use, tool_result, thinking)
 * - tools[] definitions → OpenAI function calling
 * - streaming via stream: true
 * - thinking config
 * - Anthropic-style image blocks → OpenAI image URL format
 */
export function translateAnthropicToChat(body) {
  const messages = [];
  let systemContent = null;

  // Extract system prompt (Anthropic puts it at top level)
  if (body.system) {
    systemContent = typeof body.system === "string" 
      ? body.system 
      : Array.isArray(body.system) 
        ? body.system.map((b) => extractText(b)).join("\n")
        : "";
  }

  // Process messages
  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      systemContent = (systemContent || "") + "\n" + extractText(msg.content);
      continue;
    }

    if (msg.role === "user") {
      const translated = translateAnthropicContent(msg.content);
      messages.push({ role: "user", content: translated.text, ...(translated.images.length > 0 ? { images: translated.images } : {}) });
      continue;
    }

    if (msg.role === "assistant") {
      const translated = translateAnthropicContent(msg.content);
      const assistantMsg = { role: "assistant", content: translated.text };

      // Handle tool_use content blocks → tool_calls
      const toolCalls = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id || uid("call"),
              type: "function",
              function: {
                name: block.name || "",
                arguments: typeof block.input === "object" ? JSON.stringify(block.input) : String(block.input || ""),
              },
            });
          }
        }
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }

      messages.push(assistantMsg);
      continue;
    }

    if (msg.role === "tool_result" || msg.role === "tool") {
      // Anthropic tool_result → OpenAI tool message
      const content = typeof msg.content === "string" 
        ? msg.content 
        : Array.isArray(msg.content) 
          ? msg.content.map((b) => extractText(b)).join("\n")
          : "";
      messages.push({
        role: "tool",
        tool_call_id: msg.tool_use_id || uid("call"),
        content,
      });
    }
  }

  // Prepend system message
  if (systemContent) {
    messages.unshift({ role: "system", content: systemContent.trim() });
  }

  // Build chat request
  const chat = {
    model: translateModel(body.model),
    messages,
    stream: body.stream !== false,
  };

  // Copy parameters
  const paramMap = {
    temperature: "temperature",
    top_p: "top_p",
    top_k: "top_k",
    stop_sequences: "stop",
    max_tokens: "max_tokens",
  };
  for (const [src, dst] of Object.entries(paramMap)) {
    if (body[src] !== undefined) chat[dst] = body[src];
  }
  if (body.max_tokens === undefined) chat.max_tokens = 8192;

  // Tools → function calling
  if (body.tools && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (t.type === "custom" || t.type === "function" || (!t.type && t.name)) {
        const fn = t.function || t;
        tools.push({
          type: "function",
          function: {
            name: fn.name || t.name,
            description: fn.description || t.description,
            input_schema: fn.input_schema || t.input_schema,
            parameters: fn.parameters || t.parameters || fn.input_schema || t.input_schema,
          },
        });
      }
    }
    if (tools.length > 0) {
      chat.tools = tools;
      chat.tool_choice = body.tool_choice ? mapAnthropicToolChoice(body.tool_choice) : "auto";
    }
  }

  // Thinking → reasoning effort
  if (body.thinking && body.thinking.type === "enabled") {
    chat.thinking = {
      type: "enabled",
      budget_tokens: body.thinking.budget_tokens || 2048,
    };
  }

  // Metadata
  if (body.metadata) {
    chat.user_id = body.metadata.user_id;
  }

  return chat;
}

/**
 * Translate Anthropic SSE stream events to Server-Sent Events format.
 * Since upstream returns Chat Completions format, we emit SSE events
 * that an Anthropic client can consume.
 */
export async function* translateAnthropicStream(upstreamResponse, requestId) {
  // Emit the start-of-stream event for Anthropic
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: requestId,
        type: "message",
        role: "assistant",
        content: [],
        model: "deepseek-v4-flash",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  };

  let contentIndex = 0;
  let textBlockIndex = -1;        // -1 = no text block currently open
  const toolUseMap = {};

  for await (const chunk of streamFromResponse(upstreamResponse)) {
    for (const choice of chunk.choices || []) {
      const delta = choice.delta || {};
      const content = delta.content;
      const toolCalls = delta.tool_calls;
      const finishReason = choice.finish_reason;

      // Text content: open the text block ONCE, accumulate deltas, close ONCE.
      // Bug fix: previously every delta was wrapped in its own start/delta/stop,
      // which made the Anthropic SDK render each token on its own line.
      if (content) {
        if (textBlockIndex === -1) {
          textBlockIndex = contentIndex;
          yield {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: textBlockIndex,
              content_block: { type: "text", text: "" },
            },
          };
        }
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: content },
          },
        };
      }

      // Tool calls: close the open text block first, then open the tool_use block
      // with a fresh index and accumulate its argument deltas on that index.
      if (toolCalls) {
        if (textBlockIndex !== -1) {
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: textBlockIndex },
          };
          contentIndex++;
          textBlockIndex = -1;
        }

        for (const tc of toolCalls) {
          const fn = tc.function || {};
          const idx = tc.index;
          if (!toolUseMap[idx]) {
            toolUseMap[idx] = {
              blockIndex: contentIndex,
              id: tc.id || uid("toolu"),
              name: fn.name || "",
              input: "",
            };
            yield {
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: toolUseMap[idx].blockIndex,
                content_block: {
                  type: "tool_use",
                  id: toolUseMap[idx].id,
                  name: toolUseMap[idx].name,
                  input: {},
                },
              },
            };
            contentIndex++;
          }
          if (fn.name && !toolUseMap[idx].name) {
            toolUseMap[idx].name = fn.name;
          }
          if (fn.arguments) {
            toolUseMap[idx].input += fn.arguments;
            yield {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index: toolUseMap[idx].blockIndex,
                delta: { type: "input_json_delta", partial_json: fn.arguments },
              },
            };
          }
        }
      }

      // Close any still-open tool_use blocks when the upstream signals finish.
      if (finishReason) {
        for (const key of Object.keys(toolUseMap)) {
          const tc = toolUseMap[key];
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: tc.blockIndex },
          };
        }
        Object.keys(toolUseMap).forEach((k) => delete toolUseMap[k]);
      }
    }
  }

  // Close any text block that was never followed by a tool call.
  if (textBlockIndex !== -1) {
    yield {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: textBlockIndex },
    };
  }

  // Map finish reason
  let stopReason = "end_turn";
  // Check last finish reason from chunks (simplified)
  const usage = { input_tokens: 0, output_tokens: 0 };

  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
  };

  yield {
    event: "message_stop",
    data: { type: "message_stop" },
  };
}

/**
 * Translate a complete upstream Chat Completion response to Anthropic Messages JSON format.
 */
export async function translateAnthropicJson(upstreamResponse, requestId) {
  const data = await upstreamResponse.json();
  const choice = data.choices?.[0];
  const message = choice?.message || {};
  const content = [];

  // Text content
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  // Tool calls → tool_use blocks
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Map finish reason
  const finishReason = choice?.finish_reason;
  const stopReason = mapFinishReason(finishReason);

  return {
    id: requestId,
    type: "message",
    role: "assistant",
    content,
    model: "deepseek-v4-flash",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: data.usage
      ? {
          input_tokens: data.usage.prompt_tokens ?? 0,
          output_tokens: data.usage.completion_tokens ?? 0,
        }
      : { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── Internal helpers ──────────────────────────────

function translateModel(model) {
  if (!model) return "deepseek-v4-flash";
  // Map common Anthropic model names to our model
  const modelMap = {
    "claude-sonnet-4-20250514": "deepseek-v4-flash",
    "claude-sonnet-4": "deepseek-v4-flash",
    "claude-3-5-sonnet-latest": "deepseek-v4-flash",
    "claude-3-haiku": "deepseek-v4-flash",
    "claude-3-opus": "deepseek-v4-flash",
  };
  return modelMap[model] || "deepseek-v4-flash";
}

function mapFinishReason(fr) {
  switch (fr) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}

function mapAnthropicToolChoice(choice) {
  if (!choice) return "auto";
  if (choice.type === "any" || choice.type === "auto") return "auto";
  if (choice.type === "tool") return { type: "function", function: { name: choice.name } };
  return "auto";
}

function translateAnthropicContent(content) {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (Array.isArray(content)) {
    let text = "";
    const images = [];
    for (const block of content) {
      if (block.type === "text") {
        text += block.text || "";
      } else if (block.type === "image") {
        // Anthropic image → OpenAI image URL (for multimodal models)
        if (block.source?.data) {
          images.push({
            type: "image_url",
            image_url: {
              url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
            },
          });
        }
      } else if (block.type === "tool_result") {
        // Already handled at message level
        text += extractText(block.content) || "";
      } else if (block.type === "tool_use") {
        // Already handled at message level
      } else if (block.type === "thinking") {
        text += `[Thinking: ${block.thinking || ""}]`;
      } else if (block.type === "redacted_thinking") {
        text += "[Redacted thinking]";
      }
    }
    return { text: text || "...", images };
  }
  return { text: "", images: [] };
}

async function* streamFromResponse(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // skip
      }
    }
  }
}
