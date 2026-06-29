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
  const tools = responsesToolsToChatTools(data.tools);
  if (tools) body.tools = tools;
  if (data.tool_choice != null) body.tool_choice = data.tool_choice;
  return body;
}

function chatToResponse(data, requestModel) {
  const choice = Array.isArray(data.choices) ? data.choices[0] || {} : {};
  const message = choice.message || {};
  const text = normalizeText(message.content);
  return {
    id: data.id || `resp_${cryptoRandom()}`,
    object: "response",
    created_at: data.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: data.model || requestModel || "unknown",
    output: text ? [{
      id: `msg_${cryptoRandom()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    }] : [],
    output_text: text,
    error: null,
    incomplete_details: null,
    parallel_tool_calls: true
  };
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

      const upstream = await requestUpstream(target, req.method || "POST", upstreamHeaders(req, provider, upstreamBody.length), upstreamBody);
      if (bridge && upstream.statusCode < 400) {
        const chatJson = JSON.parse(upstream.body.toString("utf8"));
        const responseJson = chatToResponse(chatJson, upstreamJson.model);
        jsonResponse(res, 200, responseJson);
        return;
      }
      res.writeHead(upstream.statusCode, upstream.headers);
      res.end(upstream.body);
    } catch (error) {
      log(`proxy error: ${error.message}`);
      jsonResponse(res, 502, { ok: false, error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { createProxyServer };
