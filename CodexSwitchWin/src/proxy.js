const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const APPLY_PATCH_TOOL_NAME = "apply_patch";
const CUSTOM_TOOL_FUNCTION_PREFIX = "custom_tool__";
const NAMESPACE_TOOL_FUNCTION_PREFIX = "namespace__";
const TOOL_SEARCH_TOOL_NAME = "tool_search";
const REQUEST_TIMEOUT_MS = 600_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "x-goog-api-key"
]);
const MAX_LOG_PREVIEW_BYTES = 1024 * 1024;
const HTTP_AGENT = new http.Agent({ keepAlive: true });
const HTTPS_AGENT = new https.Agent({ keepAlive: true });

function jsonResponse(res, statusCode, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2));
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length
  });
  res.end(body);
}

function utcTimestamp() {
  return new Date().toISOString();
}

function safeFilePart(value) {
  return String(value || "root").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "root";
}

function redactHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return result;
}

function redactProvider(provider) {
  const result = { ...(provider || {}) };
  if (result.apiKey) result.apiKey = "[redacted]";
  return result;
}

function parseBodyPreview(buffer, contentType) {
  if (!buffer?.length) return null;
  const text = buffer.toString("utf8");
  if (!isJsonContentType(contentType)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function saveJsonLog(appDir, kind, entry) {
  if (!appDir) return;
  const dir = path.join(appDir, "logs", kind);
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = String(entry.receivedAt || utcTimestamp()).replace(/[:.]/g, "-");
  const file = `${timestamp}-${safeFilePart(entry.method)}-${safeFilePart(entry.path)}.json`;
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(appDir, "logs"), { recursive: true });
  fs.appendFileSync(path.join(appDir, "logs", `${kind}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
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

function isJsonContentType(contentType) {
  return String(contentType || "").toLowerCase().includes("application/json");
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

function sanitizeToolName(value, maxLength = 64) {
  return String(value || "tool").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength) || "tool";
}

function namespaceChatToolName(namespace, name) {
  return sanitizeToolName(`${NAMESPACE_TOOL_FUNCTION_PREFIX}${namespace}__${name}`);
}

function namespaceFromChatToolName(name) {
  const value = String(name || "");
  if (!value.startsWith(NAMESPACE_TOOL_FUNCTION_PREFIX)) return null;
  const rest = value.slice(NAMESPACE_TOOL_FUNCTION_PREFIX.length);
  const separator = rest.lastIndexOf("__");
  if (separator < 0) return null;
  return {
    namespace: rest.slice(0, separator),
    name: rest.slice(separator + 2)
  };
}

function responseFunctionCallToToolCall(item) {
  const id = String(item.call_id || item.id || `call_${cryptoRandom()}`);
  let args = item.arguments == null ? "{}" : item.arguments;
  if (typeof args !== "string") args = JSON.stringify(args);
  const name = item.namespace ? namespaceChatToolName(item.namespace, item.name) : String(item.name || "");
  return {
    id,
    type: "function",
    function: { name, arguments: args }
  };
}

function responseToolSearchCallToToolCall(item) {
  const id = String(item.call_id || item.id || `call_${cryptoRandom()}`);
  let args = item.arguments == null ? "{}" : item.arguments;
  if (typeof args !== "string") args = JSON.stringify(args);
  return {
    id,
    type: "function",
    function: { name: TOOL_SEARCH_TOOL_NAME, arguments: args }
  };
}

function responseApplyPatchCallToToolCall(item) {
  const id = String(item.call_id || item.id || `call_${cryptoRandom()}`);
  const operation = item.operation && typeof item.operation === "object" ? item.operation : {};
  return {
    id,
    type: "function",
    function: {
      name: APPLY_PATCH_TOOL_NAME,
      arguments: JSON.stringify({ input: operation.diff || JSON.stringify(operation) })
    }
  };
}

function responseCustomToolCallToToolCall(item) {
  const id = String(item.call_id || item.id || `call_${cryptoRandom()}`);
  const name = String(item.name || "custom_tool").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "custom_tool";
  return {
    id,
    type: "function",
    function: {
      name: `${CUSTOM_TOOL_FUNCTION_PREFIX}${name}`,
      arguments: JSON.stringify({
        input: "input" in item ? item.input : item.content,
        name: item.name || name
      })
    }
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
      if (type === "tool_search_call") {
        pending.push(responseToolSearchCallToToolCall(item));
        continue;
      }
      if (type === "apply_patch_call") {
        pending.push(responseApplyPatchCallToToolCall(item));
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
      if (type === "apply_patch_call_output") {
        flush();
        const callId = String(item.call_id || item.tool_call_id || item.id || "");
        const output = normalizeText("output" in item ? item.output : item.content);
        if (known.has(callId)) appendMessage(messages, { role: "tool", tool_call_id: callId, content: output });
        else appendMessage(messages, { role: "user", content: `Apply patch output for \`${callId || "unknown"}\`:\n${output}` });
        continue;
      }
      flush();
      if (type === "custom_tool_call") {
        pending.push(responseCustomToolCallToToolCall(item));
        continue;
      }
      if (type === "custom_tool_call_output") {
        flush();
        const callId = String(item.call_id || item.tool_call_id || item.id || "");
        const output = normalizeText("output" in item ? item.output : item.content);
        if (known.has(callId)) appendMessage(messages, { role: "tool", tool_call_id: callId, content: output });
        else appendMessage(messages, { role: "user", content: `Custom tool output for \`${callId || "unknown"}\`:\n${output}` });
        continue;
      }
      if (type === "tool_search_output") {
        flush();
        const callId = String(item.call_id || item.tool_call_id || item.id || "");
        const output = JSON.stringify(item);
        if (known.has(callId)) appendMessage(messages, { role: "tool", tool_call_id: callId, content: output });
        else appendMessage(messages, { role: "user", content: `Tool search output for \`${callId || "unknown"}\`:\n${output}` });
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

function buildCustomToolChatTool(tool) {
  const name = String(tool.name || "custom_tool");
  let description = "Original tool definition:" + "\n```json\n" + JSON.stringify(tool) + "\n```";
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description."
          }
        },
        required: ["input"]
      }
    }
  };
}

function responsesFunctionToolToChatTool(tool, nameOverride) {
  const name = nameOverride || String(tool.name || tool.function?.name || "");
  if (!name) return null;
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  const fn = { name };
  if (source.description) fn.description = source.description;
  if (source.parameters) fn.parameters = source.parameters;
  if (typeof source.strict === "boolean") fn.strict = source.strict;
  return { type: "function", function: fn };
}

function chatToolToResponseTool(chatTool) {
  return {
    type: "function",
    name: chatTool.function.name,
    description: chatTool.function.description,
    parameters: chatTool.function.parameters
  };
}

function isOpenRouterProvider(provider) {
  const text = `${provider?.id || ""} ${provider?.name || ""} ${provider?.baseURL || ""}`;
  return /openrouter/i.test(text);
}

function shouldUseResponsesToolCompat(provider, requestPath, bridge) {
  return !bridge && requestPath === "/v1/responses" && isOpenRouterProvider(provider);
}

function parseToolInput(argumentsText) {
  const raw = typeof argumentsText === "string" ? argumentsText : JSON.stringify(argumentsText ?? {});
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if ("input" in parsed) return parsed.input == null ? "" : String(parsed.input);
      if (parsed.operation && typeof parsed.operation === "object" && "diff" in parsed.operation) {
        return parsed.operation.diff == null ? "" : String(parsed.operation.diff);
      }
      return JSON.stringify(parsed);
    }
    return parsed == null ? "" : String(parsed);
  } catch {
    return raw;
  }
}

function parseToolArgumentsObject(argumentsText) {
  if (argumentsText && typeof argumentsText === "object" && !Array.isArray(argumentsText)) return argumentsText;
  if (argumentsText == null) return {};
  const raw = typeof argumentsText === "string" ? argumentsText : JSON.stringify(argumentsText);
  if (!String(raw).trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return { query: parsed == null ? "" : String(parsed) };
  } catch {
    return { query: String(raw) };
  }
}

function customToolNameFromFunctionName(name) {
  const value = String(name || "");
  if (value.startsWith(CUSTOM_TOOL_FUNCTION_PREFIX)) return value.slice(CUSTOM_TOOL_FUNCTION_PREFIX.length) || "custom_tool";
  return value || "custom_tool";
}

function isCustomCompatFunctionName(name) {
  const value = String(name || "");
  return value === APPLY_PATCH_TOOL_NAME || value.startsWith(CUSTOM_TOOL_FUNCTION_PREFIX);
}

function isToolSearchFunctionName(name) {
  return String(name || "") === TOOL_SEARCH_TOOL_NAME;
}

function customToolFunctionToResponseItem(toolCall, fn, args) {
  const callId = String(toolCall.id || toolCall.call_id || `call_${cryptoRandom()}`);
  const name = customToolNameFromFunctionName(fn.name);
  return {
    id: `ctc_${callId}`,
    type: "custom_tool_call",
    status: "completed",
    call_id: callId,
    name,
    input: parseToolInput(args)
  };
}

function functionToolCallToResponseItem(toolCall, fn, args) {
  const callId = String(toolCall.id || toolCall.call_id || `call_${cryptoRandom()}`);
  const namespaceInfo = namespaceFromChatToolName(fn.name);
  const item = {
    id: `fc_${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: namespaceInfo ? namespaceInfo.name : String(fn.name || ""),
    arguments: args
  };
  if (namespaceInfo?.namespace) item.namespace = namespaceInfo.namespace;
  return item;
}

function toolSearchFunctionToResponseItem(toolCall, fn, args) {
  const callId = String(toolCall.id || toolCall.call_id || `call_${cryptoRandom()}`);
  return {
    id: `tsc_${callId}`,
    type: "tool_search_call",
    status: "completed",
    call_id: callId,
    name: TOOL_SEARCH_TOOL_NAME,
    execution: "client",
    arguments: parseToolArgumentsObject(args)
  };
}

function customToolToChatTool(tool) {
  const rawName = sanitizeToolName(tool.name || "custom_tool", 48);
  return buildCustomToolChatTool({ ...tool, type: "custom", name: rawName });
}

function openRouterWebSearchTool(tool) {
  const converted = { type: "openrouter:web_search" };
  const parameters = {};
  if (typeof tool.search_context_size === "string" && tool.search_context_size) {
    parameters.search_context_size = tool.search_context_size;
  }
  if (Object.keys(parameters).length) converted.parameters = parameters;
  return converted;
}

function responsesToolsToChatTools(tools, options = {}) {
  if (!Array.isArray(tools)) return undefined;
  const result = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "web_search") {
      if (options.openRouterWebSearchEnabled) result.push(openRouterWebSearchTool(tool));
      continue;
    }
    if (tool.type === "custom" || tool.type === "custom_tool") {
      result.push(customToolToChatTool(tool));
      continue;
    }
    if (tool.type === "namespace") {
      const namespace = sanitizeToolName(tool.name || "namespace", 32);
      if (!Array.isArray(tool.tools)) continue;
      for (const nested of tool.tools) {
        if (!nested || typeof nested !== "object") continue;
        if (nested.type !== "function") continue;
        const nestedName = nested.name || nested.function?.name;
        const chatTool = responsesFunctionToolToChatTool(nested, namespaceChatToolName(namespace, nestedName));
        if (chatTool) result.push(chatTool);
      }
      continue;
    }
    if (tool.type === TOOL_SEARCH_TOOL_NAME) {
      const chatTool = responsesFunctionToolToChatTool({ ...tool, type: "function", name: TOOL_SEARCH_TOOL_NAME });
      if (chatTool) result.push(chatTool);
      continue;
    }
    if (tool.type !== "function") continue;
    if (tool.function && typeof tool.function === "object") {
      result.push(tool);
      continue;
    }
    const chatTool = responsesFunctionToolToChatTool(tool);
    if (chatTool) result.push(chatTool);
  }
  const deduped = dedupeChatTools(result);
  return deduped.length ? deduped : undefined;
}

function dedupeChatTools(tools) {
  const seen = new Set();
  const deduped = [];
  for (const tool of tools) {
    const name = tool?.function?.name;
    const key = name ? String(name) : JSON.stringify(tool);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(tool);
  }
  return deduped;
}

function collectToolSearchOutputTools(value) {
  const collected = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (node.type === "tool_search_output" && Array.isArray(node.tools)) {
      for (const tool of node.tools) {
        if (tool && typeof tool === "object") collected.push(tool);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "tools") walk(child);
    }
  };
  walk(value);
  return collected;
}

function responsesToolToProviderTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  if ((tool.type === "custom" || tool.type === "custom_tool") && tool.name === APPLY_PATCH_TOOL_NAME) {
    return chatToolToResponseTool(customToolToChatTool(tool));
  }
  return tool;
}

function responsesToolChoiceToProviderToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  if ((toolChoice.type === "custom" || toolChoice.type === "custom_tool") && toolChoice.name === APPLY_PATCH_TOOL_NAME) {
    return { type: "function", name: APPLY_PATCH_TOOL_NAME };
  }
  return toolChoice;
}

function applyResponsesToolCompat(data) {
  if (!data || typeof data !== "object") return data;
  let changed = false;
  const next = { ...data };
  if (Array.isArray(data.tools)) {
    const tools = data.tools.map((tool) => {
      const converted = responsesToolToProviderTool(tool);
      if (converted !== tool) changed = true;
      return converted;
    });
    if (changed) next.tools = tools;
  }
  if (data.tool_choice != null) {
    const toolChoice = responsesToolChoiceToProviderToolChoice(data.tool_choice);
    if (toolChoice !== data.tool_choice) {
      next.tool_choice = toolChoice;
      changed = true;
    }
  }
  return changed ? next : data;
}

function transformResponseItemForToolCompat(item, options = {}) {
  if (!item || typeof item !== "object") return item;
  if (item.type !== "function_call" || !isCustomCompatFunctionName(item.name)) return item;
  const name = customToolNameFromFunctionName(item.name);
  const next = {
    ...item,
    id: item.id || `ctc_${item.call_id || cryptoRandom()}`,
    type: "custom_tool_call",
    name
  };
  if ("arguments" in next) {
    next.input = parseToolInput(next.arguments);
    delete next.arguments;
  } else if (!("input" in next) && options.includeEmptyInput) {
    next.input = "";
  }
  return next;
}

function transformResponsesJsonForToolCompat(data) {
  if (!data || typeof data !== "object") return data;
  let changed = false;
  const next = Array.isArray(data) ? [...data] : { ...data };

  if (Array.isArray(data.output)) {
    next.output = data.output.map((item) => {
      const converted = transformResponseItemForToolCompat(item);
      if (converted !== item) changed = true;
      return converted;
    });
  }
  if (data.item && typeof data.item === "object") {
    next.item = transformResponseItemForToolCompat(data.item, { keepId: true, includeEmptyInput: true });
    if (next.item !== data.item) changed = true;
  }
  if (data.response && typeof data.response === "object") {
    const response = transformResponsesJsonForToolCompat(data.response);
    if (response !== data.response) {
      next.response = response;
      changed = true;
    }
  }
  return changed ? next : data;
}

function shouldDropResponsesToolCompatEvent(eventName, payload, customToolItemIds) {
  const type = String(payload?.type || eventName || "");
  if (!type.startsWith("response.function_call_arguments.")) return false;
  return customToolItemIds.has(String(payload?.item_id || ""));
}

async function streamResponsesSseWithToolCompat(upstreamRes, res) {
  const customToolItemIds = new Set();
  for await (const { event, data } of iterSseEvents(upstreamRes)) {
    if (data.trim() === "[DONE]") {
      res.write(`data: [DONE]\n\n`);
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      if (event && event !== "message") res.write(`event: ${event}\n`);
      res.write(`data: ${data}\n\n`);
      continue;
    }
    const item = payload?.item;
    if (item && typeof item === "object" && item.type === "function_call" && isCustomCompatFunctionName(item.name)) {
      customToolItemIds.add(String(item.id || ""));
      payload.item = transformResponseItemForToolCompat(item, { keepId: true, includeEmptyInput: true });
    }
    if (shouldDropResponsesToolCompatEvent(event, payload, customToolItemIds)) continue;
    payload = transformResponsesJsonForToolCompat(payload);
    writeSseEvent(res, String(payload?.type || event || "message"), payload);
  }
}

function responsesToolChoiceToChatToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  if (toolChoice.type === "apply_patch" || toolChoice.type === "openrouter:apply_patch") {
    return { type: "function", function: { name: APPLY_PATCH_TOOL_NAME } };
  }
  if (toolChoice.type !== "function") return toolChoice;
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

function responseToChatBody(data, provider) {
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
  const requestTools = Array.isArray(data.tools) ? data.tools.filter((tool) => tool && typeof tool === "object") : [];
  requestTools.push(...collectToolSearchOutputTools(data.input));
  const tools = responsesToolsToChatTools(requestTools, {
    openRouterWebSearchEnabled: Boolean(provider?.openRouterWebSearchEnabled && isOpenRouterProvider(provider))
  });
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
    if (isCustomCompatFunctionName(fn.name)) {
      items.push(customToolFunctionToResponseItem({ id: callId }, fn, args));
      continue;
    }
    if (isToolSearchFunctionName(fn.name)) {
      items.push(toolSearchFunctionToResponseItem({ id: callId }, fn, args));
      continue;
    }
    items.push(functionToolCallToResponseItem({ id: callId }, fn, args));
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
  if (base.pathname.endsWith("/v1") && path === "/v1") path = "";
  if (base.pathname.endsWith("/v1") && path.startsWith("/v1/")) path = path.slice(3);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  return base;
}

function requestUpstream(target, method, headers, body) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const agent = target.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT;
    const req = client.request(target, { method, headers, agent }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode || 500, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Upstream request timed out")));
    req.on("error", reject);
    if (body?.length) req.write(body);
    req.end();
  });
}

function streamUpstream(target, method, headers, body, onResponse) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const agent = target.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT;
    const req = client.request(target, { method, headers, agent }, async (upstreamRes) => {
      try {
        await onResponse(upstreamRes);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Upstream request timed out")));
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
  for (const [key, value] of Object.entries(headers || {})) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
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
    } else if (item.type === "apply_patch_call") {
      writeSseEvent(res, "response.apply_patch_call.done", {
        type: "response.apply_patch_call.done",
        item_id: item.id,
        output_index: outputIndex,
        operation: item.operation && typeof item.operation === "object" ? item.operation : {}
      });
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

async function streamChatSseAsResponses(upstreamRes, res, requestModel, options = {}) {
  const includePreview = Boolean(options.includePreview);
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
    const name = String(fn.name || "");
    const item = {
      id: `fc_${callId}`,
      type: "function_call",
      status: "in_progress",
      call_id: callId,
      name,
      arguments: "",
      output_index: nextOutputIndex,
      added: false
    };
    nextOutputIndex += 1;
    toolItems.set(toolIndex, item);
    if (name) sendToolItemAdded(item);
    return item;
  };

  const normalizeToolItemType = (item) => {
    if (item.type !== "function_call") return;
    if (isCustomCompatFunctionName(item.name)) {
      item.id = `ctc_${item.call_id}`;
      item.type = "custom_tool_call";
    } else if (isToolSearchFunctionName(item.name)) {
      item.id = `tsc_${item.call_id}`;
      item.type = "tool_search_call";
      item.execution = "client";
    }
  };

  const sendToolItemAdded = (item) => {
    if (item.added) return;
    normalizeToolItemType(item);
    const { output_index, ...sendItem } = item;
    delete sendItem.added;
    if (sendItem.type === "custom_tool_call" || sendItem.type === "tool_search_call") delete sendItem.arguments;
    if (sendItem.type === "function_call") {
      const namespaceInfo = namespaceFromChatToolName(sendItem.name);
      if (namespaceInfo) {
        sendItem.name = namespaceInfo.name;
        sendItem.namespace = namespaceInfo.namespace;
      }
    }
    writeSseEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index,
      item: sendItem
    });
    item.added = true;
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
        if (item.name) sendToolItemAdded(item);
        if (typeof fn.arguments === "string" && fn.arguments) {
          item.arguments += fn.arguments;
          if (item.type === "custom_tool_call" || item.type === "tool_search_call") {
            continue;
          } else {
            if (!item.added) sendToolItemAdded(item);
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
    if (!item.added) sendToolItemAdded(item);
    const { output_index, ...sendItem } = item;
    delete sendItem.added;
    sendItem.status = "completed";
    if (sendItem.type === "custom_tool_call") {
      sendItem.name = customToolNameFromFunctionName(sendItem.name);
      sendItem.input = parseToolInput(sendItem.arguments);
      delete sendItem.arguments;
    } else if (sendItem.type === "tool_search_call") {
      sendItem.name = TOOL_SEARCH_TOOL_NAME;
      sendItem.execution = "client";
      sendItem.arguments = parseToolArgumentsObject(sendItem.arguments);
    } else if (sendItem.type === "function_call") {
      const namespaceInfo = namespaceFromChatToolName(sendItem.name);
      if (namespaceInfo) {
        sendItem.name = namespaceInfo.name;
        sendItem.namespace = namespaceInfo.namespace;
      }
    }
    output.push(sendItem);
    if (sendItem.type === "custom_tool_call") {
      writeSseEvent(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index,
        item: sendItem
      });
      continue;
    } else if (sendItem.type === "tool_search_call") {
      writeSseEvent(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index,
        item: sendItem
      });
      continue;
    } else {
      writeSseEvent(res, "response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index,
        arguments: String(item.arguments || "")
      });
    }
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
  return includePreview ? completedResponse : null;
}

function upstreamHeaders(req, provider, bodyLength) {
  const headers = {};
  const preserveAuth = Boolean(provider.preserveIncomingAuth);
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "host" || lower === "content-length") continue;
    if (!preserveAuth && SENSITIVE_HEADERS.has(lower)) continue;
    headers[key] = value;
  }
  headers["accept-encoding"] = "identity";
  if (provider.headers && typeof provider.headers === "object") {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (key && value != null) headers[key] = String(value);
    }
  }
  const apiKey = providerApiKey(provider);
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (bodyLength) headers["content-length"] = String(bodyLength);
  return headers;
}

function createProxyServer({ host, port, getConfig, getSettings = () => ({}), appDir, log }) {
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
      const contentType = req.headers["content-type"] || "";
      const bridge = Boolean(provider.chatCompletionsBridgeEnabled && url.pathname === "/v1/responses" && isJsonContentType(contentType));
      const responsesToolCompat = shouldUseResponsesToolCompat(provider, url.pathname, bridge);
      let upstreamJson = null;
      let upstreamBody = originalBody;

      if (isJsonContentType(contentType) && originalBody.length) {
        let requestJson = parseJson(originalBody);
        requestJson = rewriteModel(requestJson, provider);
        upstreamJson = bridge ? responseToChatBody(requestJson, provider) : (responsesToolCompat ? applyResponsesToolCompat(requestJson) : requestJson);
        upstreamBody = Buffer.from(JSON.stringify(upstreamJson));
      }

      const logEnabled = Boolean(getSettings()?.logEnabled);
      const target = buildTarget(provider.baseURL, bridge ? "/v1/chat/completions" : url.pathname);
      target.search = url.search;
      log(`${bridge ? "bridged" : "forwarded"} ${req.method} ${url.pathname}${bridge ? " -> /v1/chat/completions" : ""} via ${provider.name}`);
      if (logEnabled) {
        saveJsonLog(appDir, "requests", {
          receivedAt: utcTimestamp(),
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          headers: redactHeaders(req.headers),
          bodyBytes: originalBody.length,
          body: parseBodyPreview(originalBody.slice(0, MAX_LOG_PREVIEW_BYTES), contentType),
          upstreamBodyBytes: upstreamBody.length,
          upstreamBody: parseBodyPreview(upstreamBody.slice(0, MAX_LOG_PREVIEW_BYTES), contentType),
          provider: redactProvider(provider),
          upstream: {
            baseUrl: provider.baseURL,
            targetPath: `${target.pathname}${target.search}`,
            protocolBridge: bridge ? "responses-to-chat-completions" : "none"
          }
        });
      }

      if (bridge && upstreamJson?.stream) {
        await streamUpstream(target, "POST", upstreamHeaders(req, provider, upstreamBody.length), upstreamBody, async (upstreamRes) => {
          if ((upstreamRes.statusCode || 500) >= 400) {
            const chunks = [];
            for await (const chunk of upstreamRes) chunks.push(chunk);
            const rawBody = Buffer.concat(chunks);
            if (logEnabled) {
              saveJsonLog(appDir, "responses", {
                receivedAt: utcTimestamp(),
                method: req.method,
                path: url.pathname,
                provider: redactProvider(provider),
                upstream: { baseUrl: provider.baseURL, targetPath: `${target.pathname}${target.search}`, status: upstreamRes.statusCode || 500 },
                headers: redactHeaders(upstreamRes.headers),
                bodyBytes: rawBody.length,
                body: parseBodyPreview(rawBody.slice(0, MAX_LOG_PREVIEW_BYTES), headerValue(upstreamRes.headers, "content-type"))
              });
            }
            res.writeHead(upstreamRes.statusCode || 500, filteredResponseHeaders(upstreamRes.headers));
            res.end(rawBody);
            return;
          }

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "close"
          });

          const contentType = headerValue(upstreamRes.headers, "content-type");
          if (contentType.toLowerCase().includes("text/event-stream")) {
            const converted = await streamChatSseAsResponses(upstreamRes, res, upstreamJson.model, { includePreview: logEnabled });
            if (logEnabled) {
              saveJsonLog(appDir, "responses", {
                receivedAt: utcTimestamp(),
                method: req.method,
                path: url.pathname,
                provider: redactProvider(provider),
                upstream: { baseUrl: provider.baseURL, targetPath: `${target.pathname}${target.search}`, status: upstreamRes.statusCode || 500 },
                headers: redactHeaders(upstreamRes.headers),
                body: "[stream converted from chat.completions to responses]",
                convertedPreview: converted
              });
            }
          } else {
            const chunks = [];
            for await (const chunk of upstreamRes) chunks.push(chunk);
            const rawBody = Buffer.concat(chunks);
            const chatJson = JSON.parse(rawBody.toString("utf8"));
            const responseJson = chatToResponse(chatJson, upstreamJson.model);
            emitResponseAsSse(res, responseJson);
            if (logEnabled) {
              saveJsonLog(appDir, "responses", {
                receivedAt: utcTimestamp(),
                method: req.method,
                path: url.pathname,
                provider: redactProvider(provider),
                upstream: { baseUrl: provider.baseURL, targetPath: `${target.pathname}${target.search}`, status: upstreamRes.statusCode || 500 },
                headers: redactHeaders(upstreamRes.headers),
                bodyBytes: rawBody.length,
                body: parseBodyPreview(rawBody.slice(0, MAX_LOG_PREVIEW_BYTES), headerValue(upstreamRes.headers, "content-type")),
                convertedPreview: responseJson
              });
            }
          }
          res.end();
        });
        return;
      }

      if (!bridge && String(upstreamJson?.stream) === "true") {
        await streamUpstream(target, req.method || "POST", upstreamHeaders(req, provider, upstreamBody.length), upstreamBody, async (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 500, filteredResponseHeaders(upstreamRes.headers));
          if (req.method === "HEAD") {
            upstreamRes.resume();
            await new Promise((resolve, reject) => {
              upstreamRes.on("end", resolve);
              upstreamRes.on("error", reject);
            });
            res.end();
            return;
          }
          if ((upstreamRes.statusCode || 500) < 400 && responsesToolCompat && headerValue(upstreamRes.headers, "content-type").toLowerCase().includes("text/event-stream")) {
            await streamResponsesSseWithToolCompat(upstreamRes, res);
            res.end();
          } else {
            upstreamRes.pipe(res);
            await new Promise((resolve, reject) => {
              upstreamRes.on("end", resolve);
              upstreamRes.on("error", reject);
              res.on("error", reject);
            });
          }
        });
        return;
      }

      const upstream = await requestUpstream(target, bridge ? "POST" : req.method || "POST", upstreamHeaders(req, provider, upstreamBody.length), upstreamBody);
      if (bridge && upstream.statusCode < 400) {
        const contentType = headerValue(upstream.headers, "content-type");
        if (contentType.toLowerCase().includes("text/event-stream")) {
          res.writeHead(upstream.statusCode, filteredResponseHeaders(upstream.headers));
        res.end(req.method === "HEAD" ? undefined : upstream.body);
        return;
      }
        let chatJson;
        try {
          chatJson = JSON.parse(upstream.body.toString("utf8"));
        } catch {
          res.writeHead(upstream.statusCode, filteredResponseHeaders(upstream.headers));
          res.end(req.method === "HEAD" ? undefined : upstream.body);
          return;
        }
        const responseJson = chatToResponse(chatJson, upstreamJson.model);
        if (logEnabled) {
          saveJsonLog(appDir, "responses", {
            receivedAt: utcTimestamp(),
            method: req.method,
            path: url.pathname,
            provider: redactProvider(provider),
            upstream: { baseUrl: provider.baseURL, targetPath: `${target.pathname}${target.search}`, status: upstream.statusCode },
            headers: redactHeaders(upstream.headers),
            bodyBytes: upstream.body.length,
            body: parseBodyPreview(upstream.body.slice(0, MAX_LOG_PREVIEW_BYTES), headerValue(upstream.headers, "content-type")),
            convertedPreview: responseJson
          });
        }
        jsonResponse(res, 200, responseJson);
        return;
      }
      if (logEnabled) {
        saveJsonLog(appDir, "responses", {
          receivedAt: utcTimestamp(),
          method: req.method,
          path: url.pathname,
          provider: redactProvider(provider),
          upstream: { baseUrl: provider.baseURL, targetPath: `${target.pathname}${target.search}`, status: upstream.statusCode },
          headers: redactHeaders(upstream.headers),
          bodyBytes: upstream.body.length,
          body: parseBodyPreview(upstream.body.slice(0, MAX_LOG_PREVIEW_BYTES), headerValue(upstream.headers, "content-type"))
        });
      }
      if (!bridge && responsesToolCompat && upstream.statusCode < 400 && isJsonContentType(headerValue(upstream.headers, "content-type"))) {
        let responseJson;
        try {
          responseJson = JSON.parse(upstream.body.toString("utf8"));
        } catch {
          responseJson = null;
        }
        const converted = transformResponsesJsonForToolCompat(responseJson);
        if (converted !== responseJson) {
          jsonResponse(res, upstream.statusCode, converted);
          return;
        }
      }
      res.writeHead(upstream.statusCode, filteredResponseHeaders(upstream.headers));
      res.end(req.method === "HEAD" ? undefined : upstream.body);
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
