const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");

function jsonResponse(res, statusCode, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buffer) {
  if (!buffer.length) return null;
  return JSON.parse(buffer.toString("utf8"));
}

function providerApiKey(provider) {
  return String(provider.apiKey || "").trim();
}

function activeProvider(config) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  return providers.find((provider) => provider.id === config.activeProviderId) || providers[0];
}

function rewriteModel(data, provider) {
  if (!data || typeof data !== "object" || !("model" in data)) return data;
  const defaultModel = String(provider.defaultModel || "").trim();
  const mapping = provider.modelMapping && typeof provider.modelMapping === "object" ? provider.modelMapping : {};
  const targetModel = mapping.enabled ? defaultModel || String(mapping.targetModel || "").trim() : defaultModel;
  if (targetModel) data.model = targetModel;
  return data;
}

function normalizeText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") return part.text || part.output_text || part.input_text || "";
      return "";
    }).join("");
  }
  if (typeof content === "object") return content.text || content.output_text || content.input_text || "";
  return String(content);
}

function contentToChat(content, role) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return normalizeText(content);
  const parts = [];
  let text = "";
  const flush = () => {
    if (text) {
      parts.push({ type: "text", text });
      text = "";
    }
  };
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text"].includes(part.type)) {
      text += part.text || "";
    } else if (["input_image", "image_url"].includes(part.type) && role === "user") {
      const imageUrl = typeof part.image_url === "object" ? part.image_url.url : part.image_url || part.url;
      if (imageUrl) {
        flush();
        parts.push({ type: "image_url", image_url: { url: imageUrl } });
      }
    }
  }
  if (!parts.length) return text;
  flush();
  return parts;
}

function appendMessage(messages, message) {
  if (message.role === "assistant" && message.tool_calls) {
    messages.push(message);
    return;
  }
  if (message.role === "tool") {
    if (message.tool_call_id) messages.push(message);
    return;
  }
  const content = message.content;
  if (typeof content === "string" && content.trim()) messages.push(message);
  else if (Array.isArray(content) && content.length) messages.push(message);
}

function responseFunctionCallToToolCall(item) {
  const id = String(item.call_id || item.id || `call_${cryptoRandom()}`);
  let args = item.arguments == null ? "{}" : item.arguments;
  if (typeof args !== "string") args = JSON.stringify(args);
  return {
    id,
    type: "function",
    function: { name: String(item.name || ""), arguments: args }
  };
}

function cryptoRandom() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function responsesInputToMessages(data) {
  const messages = [];
  if (typeof data.instructions === "string" && data.instructions.trim()) {
    messages.push({ role: "system", content: data.instructions });
  }

  const pending = [];
  const known = new Set();
  const flush = () => {
    if (!pending.length) return;
    messages.push({ role: "assistant", content: "", tool_calls: pending.splice(0) });
    for (const call of messages[messages.length - 1].tool_calls) known.add(call.id);
  };

  const input = data.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") {
        flush();
        appendMessage(messages, { role: "user", content: String(item || "") });
        continue;
      }
      const type = String(item.type || "");
      if (type === "function_call") {
        pending.push(responseFunctionCallToToolCall(item));
        continue;
      }
      if (type === "function_call_output") {
        flush();
        const callId = String(item.call_id || item.tool_call_id || item.id || "");
        const output = normalizeText("output" in item ? item.output : item.content);
        if (known.has(callId)) appendMessage(messages, { role: "tool", tool_call_id: callId, content: output });
        else appendMessage(messages, { role: "user", content: `Tool output for \`${callId || "unknown"}\`:\n${output}` });
        continue;
      }
      flush();
      if (type === "custom_tool_call") {
        appendMessage(messages, { role: "assistant", content: `Custom tool call \`${item.name || "custom_tool"}\`:\n${normalizeText(item.input)}` });
        continue;
      }
      if (type === "custom_tool_call_output") {
        appendMessage(messages, { role: "user", content: `Custom tool output for \`${item.call_id || item.id || "unknown"}\`:\n${normalizeText(item.output || item.content)}` });
        continue;
      }
      if (type === "reasoning") continue;
      let role = String(item.role || "user");
      if (role === "developer") role = "system";
      if (!["system", "user", "assistant", "tool"].includes(role)) role = "user";
      appendMessage(messages, { role, content: contentToChat(item.content ?? item.text, role) });
    }
  }
  flush();
  if (!messages.length) messages.push({ role: "user", content: "" });
  return messages;
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const result = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || tool.type !== "function") continue;
    if (tool.function && typeof tool.function === "object") {
      result.push(tool);
      continue;
    }
    if (!tool.name) continue;
    const fn = { name: tool.name };
    if (tool.description) fn.description = tool.description;
    if (tool.parameters) fn.parameters = tool.parameters;
    if (typeof tool.strict === "boolean") fn.strict = tool.strict;
    result.push({ type: "function", function: fn });
  }
  return result.length ? result : undefined;
}

function responsesToolChoiceToChatToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object" || toolChoice.type !== "function") return toolChoice;
  if (typeof toolChoice.name === "string" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return toolChoice;
}

function responsesTextFormatToChatResponseFormat(textConfig) {
  if (!textConfig || typeof textConfig !== "object") return undefined;
  const format = textConfig.format;
  if (!format || typeof format !== "object") return undefined;
  if (format.type === "json_schema") {
    const { type, ...json_schema } = format;
    return Object.keys(json_schema).length ? { type: "json_schema", json_schema } : { type: "json_schema" };
  }
  if (format.type === "json_object") return { type: "json_object" };
  return undefined;
}

function responseToChatBody(data) {
  const body = {
    model: data.model || "",
    messages: responsesInputToMessages(data)
  };
  if ("stream" in data) body.stream = Boolean(data.stream);
  for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty", "seed", "stop", "user", "parallel_tool_calls", "stream_options"]) {
    if (data[key] != null) body[key] = data[key];
  }
  if (data.max_output_tokens != null) body.max_tokens = data.max_output_tokens;
  if (data.max_completion_tokens != null) body.max_completion_tokens = data.max_completion_tokens;
  const tools = responsesToolsToChatTools(data.tools);
  if (tools) body.tools = tools;
  if (data.tool_choice != null) body.tool_choice = responsesToolChoiceToChatToolChoice(data.tool_choice);
  const responseFormat = responsesTextFormatToChatResponseFormat(data.text);
  if (responseFormat) body.response_format = responseFormat;
  return body;
}

function chatUsageToResponseUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  let totalTokens = usage.total_tokens;
  if (totalTokens == null && Number.isInteger(inputTokens) && Number.isInteger(outputTokens)) {
    totalTokens = inputTokens + outputTokens;
  }
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };
}

function chatToolCallsToResponseItems(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const items = [];
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const fn = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : {};
    const callId = String(toolCall.id || `call_${cryptoRandom()}`);
    let args = fn.arguments == null ? "{}" : fn.arguments;
    if (typeof args !== "string") args = JSON.stringify(args);
    items.push({
      id: `fc_${callId}`,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: String(fn.name || ""),
      arguments: args
    });
  }
  return items;
}

function chatToResponse(data, requestModel) {
  const choice = Array.isArray(data.choices) ? data.choices[0] || {} : {};
  const message = choice.message || {};
  const text = normalizeText(message.content);
  const output = [];
  if (text) {
    output.push({
      id: `msg_${cryptoRandom()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  output.push(...chatToolCallsToResponseItems(message.tool_calls));
  const response = {
    id: data.id || `resp_${cryptoRandom()}`,
    object: "response",
    created_at: data.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: data.model || requestModel || "unknown",
    output,
    output_text: text,
    error: null,
    incomplete_details: null,
    parallel_tool_calls: true
  };
  const usage = chatUsageToResponseUsage(data.usage);
  if (usage) response.usage = usage;
  return response;
}

function buildTarget(baseURL, incomingPath) {
  const base = new URL(baseURL.replace(/\/+$/, ""));
  let path = incomingPath;
  if (base.pathname.endsWith("/v1") && path.startsWith("/v1/")) path = path.slice(3);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  return base;
}

function requestUpstream(target, method, headers, body) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode || 500, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body?.length) req.write(body);
    req.end();
  });
}

function streamUpstream(target, method, headers, body, onResponse) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, { method, headers }, async (upstreamRes) => {
      try {
        await onResponse(upstreamRes);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
    if (body?.length) req.write(body);
    req.end();
  });
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === target) return Array.isArray(value) ? value.join(", ") : String(value || "");
  }
  return "";
}

function filteredResponseHeaders(headers) {
  const result = {};
  const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  for (const [key, value] of Object.entries(headers || {})) {
    if (hopByHop.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function minimalResponseShell(id, createdAt, model, status) {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output: [],
    parallel_tool_calls: true,
    error: null,
    incomplete_details: null
  };
}

function emitResponseAsSse(res, response) {
  const created = { ...response, status: "in_progress", output: [] };
  writeSseEvent(res, "response.created", { type: "response.created", response: created });

  const output = Array.isArray(response.output) ? response.output : [];
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const item = output[outputIndex];
    if (!item || typeof item !== "object") continue;
    writeSseEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item
    });

    if (item.type === "message" && Array.isArray(item.content)) {
      for (let contentIndex = 0; contentIndex < item.content.length; contentIndex += 1) {
        const part = item.content[contentIndex];
        if (!part || typeof part !== "object") continue;
        const text = String(part.text || "");
        writeSseEvent(res, "response.content_part.added", {
          type: "response.content_part.added",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: { type: "output_text", text: "", annotations: [] }
        });
        if (text) {
          writeSseEvent(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: text
          });
        }
        writeSseEvent(res, "response.output_text.done", {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          text
        });
        writeSseEvent(res, "response.content_part.done", {
          type: "response.content_part.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: { type: "output_text", text, annotations: [] }
        });
      }
    } else if (item.type === "function_call") {
      const args = String(item.arguments || "");
      if (args) {
        writeSseEvent(res, "response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: outputIndex,
          delta: args
        });
      }
      writeSseEvent(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: args
      });
    }

    writeSseEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item
    });
  }

  writeSseEvent(res, "response.completed", { type: "response.completed", response });
}

async function* iterSseEvents(readable) {
  let buffer = "";
  let event = "";
  let dataLines = [];

  const flush = async function* () {
    if (!event && !dataLines.length) return;
    yield { event: event || "message", data: dataLines.join("\n") };
    event = "";
    dataLines = [];
  };

  for await (const chunk of readable) {
    buffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = buffer.search(/\r?\n/);
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n" ? newlineIndex + 2 : newlineIndex + 1);

      if (line === "") {
        yield* flush();
      } else if (line.startsWith(":")) {
        continue;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  if (buffer) {
    const line = buffer.replace(/\r$/, "");
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  yield* flush();
}

async function streamChatSseAsResponses(upstreamRes, res, requestModel) {
  const responseId = `resp_${cryptoRandom()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let model = requestModel || "unknown";
  let textItemId = null;
  let textOutputIndex = null;
  let text = "";
  let nextOutputIndex = 0;
  let usage;
  const toolItems = new Map();

  writeSseEvent(res, "response.created", {
    type: "response.created",
    response: minimalResponseShell(responseId, createdAt, model, "in_progress")
  });

  const ensureTextItem = () => {
    if (textItemId != null && textOutputIndex != null) return [textItemId, textOutputIndex];
    textItemId = `msg_${cryptoRandom()}`;
    textOutputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    const item = {
      id: textItemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    };
    writeSseEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: textOutputIndex,
      item
    });
    writeSseEvent(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });
    return [textItemId, textOutputIndex];
  };

  const ensureToolItem = (toolIndex, delta) => {
    if (toolItems.has(toolIndex)) return toolItems.get(toolIndex);
    const fn = delta.function && typeof delta.function === "object" ? delta.function : {};
    const callId = String(delta.id || `call_${cryptoRandom()}`);
    const item = {
      id: `fc_${callId}`,
      type: "function_call",
      status: "in_progress",
      call_id: callId,
      name: String(fn.name || ""),
      arguments: "",
      output_index: nextOutputIndex
    };
    nextOutputIndex += 1;
    toolItems.set(toolIndex, item);
    const { output_index, ...sendItem } = item;
    writeSseEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index,
      item: sendItem
    });
    return item;
  };

  for await (const { data } of iterSseEvents(upstreamRes)) {
    if (data.trim() === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (!chunk || typeof chunk !== "object") continue;
    if (typeof chunk.model === "string") model = chunk.model;
    usage = chatUsageToResponseUsage(chunk.usage) || usage;

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] || {} : {};
    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};

    if (typeof delta.content === "string" && delta.content) {
      const [itemId, outputIndex] = ensureTextItem();
      text += delta.content;
      writeSseEvent(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        delta: delta.content
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        if (!toolCallDelta || typeof toolCallDelta !== "object") continue;
        const toolIndex = Number.isInteger(toolCallDelta.index) ? toolCallDelta.index : 0;
        const item = ensureToolItem(toolIndex, toolCallDelta);
        const fn = toolCallDelta.function && typeof toolCallDelta.function === "object" ? toolCallDelta.function : {};
        if (!item.name && typeof fn.name === "string") item.name = fn.name;
        if (typeof fn.arguments === "string" && fn.arguments) {
          item.arguments += fn.arguments;
          writeSseEvent(res, "response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: item.output_index,
            delta: fn.arguments
          });
        }
      }
    }
  }

  const output = [];
  if (textItemId != null && textOutputIndex != null) {
    const messageItem = {
      id: textItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    };
    output.push(messageItem);
    writeSseEvent(res, "response.output_text.done", {
      type: "response.output_text.done",
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      text
    });
    writeSseEvent(res, "response.content_part.done", {
      type: "response.content_part.done",
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] }
    });
    writeSseEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: textOutputIndex,
      item: messageItem
    });
  }

  const sortedToolItems = [...toolItems.values()].sort((a, b) => a.output_index - b.output_index);
  for (const item of sortedToolItems) {
    const { output_index, ...sendItem } = item;
    sendItem.status = "completed";
    output.push(sendItem);
    writeSseEvent(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index,
      arguments: String(item.arguments || "")
    });
    writeSseEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index,
      item: sendItem
    });
  }

  const completedResponse = minimalResponseShell(responseId, createdAt, model, "completed");
  completedResponse.output = output;
  completedResponse.output_text = text;
  if (usage) completedResponse.usage = usage;
  writeSseEvent(res, "response.completed", {
    type: "response.completed",
    response: completedResponse
  });
}

function upstreamHeaders(req, provider, bodyLength) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (["host", "content-length", "connection", "transfer-encoding"].includes(lower)) continue;
    if (["authorization", "cookie", "x-api-key"].includes(lower)) continue;
    headers[key] = value;
  }
  headers["accept-encoding"] = "identity";
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  if (bodyLength) headers["content-length"] = String(bodyLength);
  return headers;
}

function createProxyServer({ host, port, getConfig, log }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      if (url.pathname === "/_health") {
        jsonResponse(res, 200, { ok: true });
        return;
      }
      if (!url.pathname.startsWith("/v1/")) {
        jsonResponse(res, 404, { ok: false, error: "Use /v1/..." });
        return;
      }
      const config = getConfig();
      const provider = activeProvider(config);
      if (!provider) throw new Error("No provider configured");
      if (!providerApiKey(provider)) throw new Error(`${provider.name} needs an API key`);

      const originalBody = await readBody(req);
      let requestJson = parseJson(originalBody);
      requestJson = rewriteModel(requestJson, provider);
      const bridge = Boolean(provider.chatCompletionsBridgeEnabled && url.pathname === "/v1/responses");
      const upstreamJson = bridge ? responseToChatBody(requestJson) : requestJson;
      const upstreamBody = Buffer.from(JSON.stringify(upstreamJson));
      const target = buildTarget(provider.baseURL, bridge ? "/v1/chat/completions" : url.pathname);
      target.search = url.search;
      log(`${bridge ? "bridged" : "forwarded"} ${req.method} ${url.pathname}${bridge ? " -> /v1/chat/completions" : ""} via ${provider.name}`);

      if (bridge && upstreamJson.stream) {
        await streamUpstream(target, req.method || "POST", upstreamHeaders(req, provider, upstreamBody.length), upstreamBody, async (upstreamRes) => {
          if ((upstreamRes.statusCode || 500) >= 400) {
            res.writeHead(upstreamRes.statusCode || 500, filteredResponseHeaders(upstreamRes.headers));
            upstreamRes.pipe(res);
            await new Promise((resolve, reject) => {
              upstreamRes.on("end", resolve);
              upstreamRes.on("error", reject);
            });
            return;
          }

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "close"
          });

          const contentType = headerValue(upstreamRes.headers, "content-type");
          if (contentType.toLowerCase().includes("text/event-stream")) {
            await streamChatSseAsResponses(upstreamRes, res, upstreamJson.model);
          } else {
            const chunks = [];
            for await (const chunk of upstreamRes) chunks.push(chunk);
            const rawBody = Buffer.concat(chunks);
            const chatJson = JSON.parse(rawBody.toString("utf8"));
            const responseJson = chatToResponse(chatJson, upstreamJson.model);
            emitResponseAsSse(res, responseJson);
          }
          res.end();
        });
        return;
      }

      const upstream = await requestUpstream(target, req.method || "POST", upstreamHeaders(req, provider, upstreamBody.length), upstreamBody);
      if (bridge && upstream.statusCode < 400) {
        const contentType = headerValue(upstream.headers, "content-type");
        if (contentType.toLowerCase().includes("text/event-stream")) {
          res.writeHead(upstream.statusCode, filteredResponseHeaders(upstream.headers));
          res.end(upstream.body);
          return;
        }
        let chatJson;
        try {
          chatJson = JSON.parse(upstream.body.toString("utf8"));
        } catch {
          res.writeHead(upstream.statusCode, filteredResponseHeaders(upstream.headers));
          res.end(upstream.body);
          return;
        }
        const responseJson = chatToResponse(chatJson, upstreamJson.model);
        jsonResponse(res, 200, responseJson);
        return;
      }
      res.writeHead(upstream.statusCode, filteredResponseHeaders(upstream.headers));
      res.end(upstream.body);
    } catch (error) {
      log(`proxy error: ${error.message}`);
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
      } else {
        jsonResponse(res, 502, { ok: false, error: error.message });
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { createProxyServer };
