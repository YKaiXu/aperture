// ─── Anthropic Messages API → OpenCode Chat Completions ───

import { uid, now, extractText, resolveDefaultModel, parseChatSSE, MIN_MAX_TOKENS } from "./utils.js";
import { extractUsage } from "./upstream.js";

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
  let lastAssistantIdx = null;

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
      // A user message can contain text, image, and tool_result blocks.
      // tool_result blocks are converted to user text for upstream compatibility.
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        let text = "";
        const images = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            text += block.text || "";
          } else if (block.type === "image") {
            if (block.source?.data) {
              images.push({
                type: "image_url",
                image_url: {
                  url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
                },
              });
            }
          } else if (block.type === "tool_result") {
            // Convert tool result to user text (upstream Console Go
            // doesn't support role: "tool" in multi-turn conversations).
            const out = typeof block.content === "string"
              ? block.content
              : extractText(block.content);
            text += (text ? "\n" : "") + (out || "");
          }
        }
        if (text || images.length > 0) {
          messages.push({
            role: "user",
            content: text,
            ...(images.length > 0 ? { images } : {}),
          });
        }
      } else {
        messages.push({ role: "user", content: "" });
      }
      lastAssistantIdx = null;
      continue;
    }

    if (msg.role === "assistant") {
      const translated = translateAnthropicContent(msg.content);
      const assistantMsg = { role: "assistant", content: translated.text };

      // Convert tool_use blocks in assistant messages to tool_calls
      // so the upstream Chat Completions API sees a complete tool call cycle.
      if (Array.isArray(msg.content)) {
        const toolCalls = [];
        for (const block of msg.content) {
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id || `call_${uid("")}`,
              type: "function",
              function: {
                name: block.name,
                arguments:
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input || {}),
              },
            });
          }
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
      }

      messages.push(assistantMsg);
      continue;
    }

    if (msg.role === "tool_result" || msg.role === "tool") {
      // Convert tool results to user text (upstream Console Go
      // doesn't support role: "tool" in multi-turn conversations).
      const content = typeof msg.content === "string" 
        ? msg.content 
        : Array.isArray(msg.content) 
          ? msg.content.map((b) => extractText(b)).join("\n")
          : "";
      messages.push({ role: "user", content: content || "" });
    }
  }

  // Prepend system message
  if (systemContent) {
    messages.unshift({ role: "system", content: systemContent.trim() });
  }

  // Upstream (Console Go) doesn't support tool_calls in conversation history.
  // Since tool results have been converted to user text, we must also strip
  // tool_calls from assistant messages to avoid 400 errors on multi-turn
  // conversations that include tool interactions.
  for (const m of messages) {
    delete m.tool_calls;
  }

  // Build chat request
  // Note: stream defaults to false. The caller (handleAnthropicMessages)
  // should set stream: true if the client requested SSE via Accept header.
  const chat = {
    model: translateModel(body.model),
    messages,
    stream: body.stream === true,
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
  // Enforce a sensible minimum so reasoning models don't spend the whole budget
  // on chain-of-thought and leave the actual answer empty.
  chat.max_tokens = Math.max(chat.max_tokens, MIN_MAX_TOKENS);

  // Tools → function calling
  if (body.tools && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (t.type === "custom" || t.type === "function" || (!t.type && t.name)) {
        const fn = t.function || t;
        // OpenAI Chat Completions uses `parameters`; Anthropic uses `input_schema`.
        // Map Anthropic's `input_schema` to `parameters` and omit `input_schema`.
        const schema = fn.parameters || t.parameters || fn.input_schema || t.input_schema;
        if (!schema) continue;
        tools.push({
          type: "function",
          function: {
            name: fn.name || t.name,
            description: fn.description || t.description,
            parameters: schema,
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
  const model = resolveDefaultModel();

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
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  };

  let contentIndex = 0;
  let textBlockIndex = -1;        // -1 = no text block currently open
  let thinkingBlockIndex = -1;    // -1 = no thinking block currently open
  const toolUseMap = {};
  let lastFinishReason = null;
  const streamUsage = { input_tokens: 0, output_tokens: 0 };

  for await (const chunk of parseChatSSE(upstreamResponse)) {
    // Track usage from chunks (some providers emit usage in the final chunk)
    if (chunk.usage) {
      streamUsage.input_tokens = chunk.usage.prompt_tokens ?? chunk.usage.input_tokens ?? 0;
      streamUsage.output_tokens = chunk.usage.completion_tokens ?? chunk.usage.output_tokens ?? 0;
    }
    for (const choice of chunk.choices || []) {
      const delta = choice.delta || {};
      const content = delta.content;
      const reasoning = delta.reasoning_content;   // DeepSeek reasoning model output
      const toolCalls = delta.tool_calls;
      const finishReason = choice.finish_reason;
      if (finishReason) lastFinishReason = finishReason;

      // Thinking (reasoning) content: open ONCE, accumulate deltas, close ONCE.
      // Anthropic protocol requires thinking blocks to appear before text blocks,
      // so we close any open text block before opening a thinking block.
      if (reasoning) {
        if (textBlockIndex !== -1) {
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: textBlockIndex },
          };
          contentIndex++;
          textBlockIndex = -1;
        }
        if (thinkingBlockIndex === -1) {
          thinkingBlockIndex = contentIndex;
          yield {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: thinkingBlockIndex,
              content_block: { type: "thinking", thinking: "" },
            },
          };
        }
        yield {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: thinkingBlockIndex,
            delta: { type: "thinking_delta", thinking: reasoning },
          },
        };
      }

      // Text content: open the text block ONCE, accumulate deltas, close ONCE.
      // Bug fix: previously every delta was wrapped in its own start/delta/stop,
      // which made the Anthropic SDK render each token on its own line.
      if (content) {
        // Close any open thinking block first (Anthropic protocol order)
        if (thinkingBlockIndex !== -1) {
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: thinkingBlockIndex },
          };
          contentIndex++;
          thinkingBlockIndex = -1;
        }
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
        if (thinkingBlockIndex !== -1) {
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: thinkingBlockIndex },
          };
          contentIndex++;
          thinkingBlockIndex = -1;
        }

        for (const tc of toolCalls) {
          const fn = tc.function || {};
          const idx = tc.index;
          if (!toolUseMap[idx]) {
            // Some providers (e.g. Console Go / OpenCode) never set
            // function.name or id — the function name is embedded inside
            // the arguments JSON. We buffer and defer content_block_start
            // until we can extract the name from arguments.
            toolUseMap[idx] = {
              blockIndex: -1,   // not yet assigned
              id: tc.id || "",
              name: fn.name || "",
              input: "",
              started: false,   // content_block_start not yet emitted
            };
          }

          if (fn.arguments) {
            toolUseMap[idx].input += fn.arguments;

            // If we haven't emitted content_block_start yet and now have
            // enough data, try to extract the name from arguments JSON.
            if (!toolUseMap[idx].started) {
              // Extract id from arguments if not provided separately
              if (!toolUseMap[idx].id) {
                const idMatch = toolUseMap[idx].input.match(/"id"\s*:\s*"([^"]+)"/);
                if (idMatch) toolUseMap[idx].id = idMatch[1];
              }
              // Extract name from arguments JSON (e.g. {"name":"web_search",...})
              if (!toolUseMap[idx].name) {
                const nameMatch = toolUseMap[idx].input.match(/"name"\s*:\s*"([^"]+)"/);
                if (nameMatch) toolUseMap[idx].name = nameMatch[1];
              }
              // Only emit content_block_start once we have the name (or enough input)
              if (toolUseMap[idx].name || toolUseMap[idx].input.length > 50) {
                toolUseMap[idx].blockIndex = contentIndex;
                toolUseMap[idx].id = toolUseMap[idx].id || uid("toolu");
                toolUseMap[idx].started = true;
                yield {
                  event: "content_block_start",
                  data: {
                    type: "content_block_start",
                    index: toolUseMap[idx].blockIndex,
                    content_block: {
                      type: "tool_use",
                      id: toolUseMap[idx].id,
                      name: toolUseMap[idx].name || toolUseMap[idx].id,
                      input: {},
                    },
                  },
                };
                contentIndex++;
              }
            }

            // Emit delta only after content_block_start has been sent
            if (toolUseMap[idx].started) {
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
      }

      // Close any still-open tool_use blocks when the upstream signals finish.
      if (finishReason) {
        for (const key of Object.keys(toolUseMap)) {
          const tc = toolUseMap[key];
          // If content_block_start was never emitted, force-emit it now
          // with name extracted from arguments.
          if (!tc.started) {
            tc.id = tc.id || uid("toolu");
            if (!tc.name && tc.input) {
              try {
                const parsed = JSON.parse(tc.input);
                if (parsed.name) tc.name = parsed.name;
              } catch {}
            }
            tc.blockIndex = contentIndex;
            tc.started = true;
            yield {
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: tc.blockIndex,
                content_block: {
                  type: "tool_use",
                  id: tc.id,
                  name: tc.name || tc.id,
                  input: {},
                },
              },
            };
            contentIndex++;
          }
          yield {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: tc.blockIndex },
          };
        }
        Object.keys(toolUseMap).forEach((k) => delete toolUseMap[k]);
      }
    }
  }

  // Close any text or thinking block that was never followed by a tool call.
  // Close thinking first (Anthropic protocol: thinking before text).
  if (thinkingBlockIndex !== -1) {
    yield {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: thinkingBlockIndex },
    };
  }
  if (textBlockIndex !== -1) {
    yield {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: textBlockIndex },
    };
  }

  // Map finish reason from the tracked last finish reason
  const stopReason = lastFinishReason ? mapFinishReason(lastFinishReason) : "end_turn";

  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: streamUsage.output_tokens },
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

  // Thinking (reasoning) content — must come before text per Anthropic protocol
  if (message.reasoning_content) {
    content.push({
      type: "thinking",
      thinking: message.reasoning_content,
    });
  }

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
    model: resolveDefaultModel(),
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
  return resolveDefaultModel();
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
        text += extractText(block.content) || "";
      } else if (block.type === "tool_use") {
        // Handled at message level — converted to tool_calls on assistant message
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


