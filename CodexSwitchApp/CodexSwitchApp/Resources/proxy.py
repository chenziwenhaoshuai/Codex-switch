from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import ssl
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qs, urlsplit


SCRIPT_DIR = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8787
LOG_DIR = Path("logs")
ROUTER_CONFIG_PATH = SCRIPT_DIR / "providers.json"
MAX_CAPTURE_BYTES = 25 * 1024 * 1024
NO_FORWARD = False
LOG_ENABLED = False
LOG_SENSITIVE = False
REQUEST_TIMEOUT_SECONDS = 600.0
MAX_RESPONSE_LOG_BYTES = 1024 * 1024
PROXY_VERSION = "2026-06-29-provider-router-v6-log-toggle"

HOP_BY_HOP_HEADERS = {
    "connection",
    "expect",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-goog-api-key",
}


def load_dotenv(path: Path = SCRIPT_DIR / ".env") -> None:
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def load_config() -> None:
    global HOST
    global PORT
    global LOG_DIR
    global ROUTER_CONFIG_PATH
    global MAX_CAPTURE_BYTES
    global NO_FORWARD
    global LOG_ENABLED
    global LOG_SENSITIVE
    global REQUEST_TIMEOUT_SECONDS

    HOST = os.environ.get("HOST", "127.0.0.1")
    PORT = int(os.environ.get("PORT", "8787"))
    LOG_DIR = Path(os.environ.get("LOG_DIR", str(SCRIPT_DIR / "logs")))
    if not LOG_DIR.is_absolute():
        LOG_DIR = SCRIPT_DIR / LOG_DIR
    ROUTER_CONFIG_PATH = Path(os.environ.get("ROUTER_CONFIG_PATH", str(SCRIPT_DIR / "providers.json")))
    if not ROUTER_CONFIG_PATH.is_absolute():
        ROUTER_CONFIG_PATH = SCRIPT_DIR / ROUTER_CONFIG_PATH
    MAX_CAPTURE_BYTES = int(os.environ.get("MAX_CAPTURE_BYTES", str(25 * 1024 * 1024)))
    NO_FORWARD = os.environ.get("NO_FORWARD") == "1"
    LOG_ENABLED = os.environ.get("LOG_ENABLED") == "1"
    LOG_SENSITIVE = os.environ.get("LOG_SENSITIVE") == "1"
    REQUEST_TIMEOUT_SECONDS = float(os.environ.get("REQUEST_TIMEOUT_SECONDS", "600"))


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_file_part(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-")
    return value[:80] or "root"


def redact_headers(headers: Dict[str, str]) -> Dict[str, str]:
    redacted = {}
    for name, value in headers.items():
        if not LOG_SENSITIVE and name.lower() in SENSITIVE_HEADERS:
            redacted[name] = "[redacted]"
        else:
            redacted[name] = value
    return redacted


def redact_provider(provider: Dict[str, object]) -> Dict[str, object]:
    redacted = dict(provider)
    if redacted.get("apiKey"):
        redacted["apiKey"] = "[redacted]"
    return redacted


def parse_body(body: bytes, content_type: str) -> object:
    if not body:
        return None

    text = body.decode("utf-8", errors="replace")
    if "application/json" not in content_type.lower():
        return text

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def parse_response_preview(body: bytes, content_type: str) -> object:
    if not body:
        return None

    text = body.decode("utf-8", errors="replace")
    if "application/json" in content_type.lower():
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    return text


def flatten_query(query: str) -> Dict[str, object]:
    parsed = parse_qs(query, keep_blank_values=True)
    result: Dict[str, object] = {}
    for key, values in parsed.items():
        result[key] = values[0] if len(values) == 1 else values
    return result


def default_router_config() -> Dict[str, object]:
    return {
        "activeProviderId": "openai",
        "providers": [
            {
                "id": "openai",
                "name": "OpenAI",
                "baseURL": "https://api.openai.com/v1",
                "apiKey": "",
                "headers": {},
                "defaultModel": "",
                "modelMapping": {
                    "enabled": False,
                    "targetModel": "",
                },
                "chatCompletionsBridgeEnabled": False,
            }
        ],
    }


def ensure_router_config_exists() -> None:
    if ROUTER_CONFIG_PATH.exists():
        return
    ROUTER_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    ROUTER_CONFIG_PATH.write_text(
        json.dumps(default_router_config(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_router_config() -> Tuple[Dict[str, object], Dict[str, object]]:
    ensure_router_config_exists()
    try:
        config = json.loads(ROUTER_CONFIG_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid router config JSON at {ROUTER_CONFIG_PATH}: {error}") from error

    providers = config.get("providers")
    if not isinstance(providers, list) or not providers:
        raise ValueError("Router config must contain at least one provider")

    active_provider_id = str(config.get("activeProviderId") or "")
    valid_providers = [provider for provider in providers if isinstance(provider, dict)]
    if not valid_providers:
        raise ValueError("Router config has no valid providers")

    active_provider = next(
        (
            provider
            for provider in valid_providers
            if str(provider.get("id") or "") == active_provider_id
        ),
        valid_providers[0],
    )
    validate_provider(active_provider)
    return config, active_provider


def rewrite_request_body(body: bytes, content_type: str, provider: Dict[str, object]) -> bytes:
    if not body or "application/json" not in content_type.lower():
        return body

    default_model = str(provider.get("defaultModel") or "").strip()
    model_mapping = provider.get("modelMapping")
    mapping_enabled = isinstance(model_mapping, dict) and bool(model_mapping.get("enabled"))
    if mapping_enabled:
        target_model = default_model or str(model_mapping.get("targetModel") or "").strip()
    else:
        target_model = default_model
    if not target_model:
        return body

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return body

    if not isinstance(data, dict) or "model" not in data:
        return body

    data["model"] = target_model
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def json_bytes(data: Dict[str, object]) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def provider_uses_chat_bridge(provider: Dict[str, object], path_and_query: str, content_type: str) -> bool:
    if not bool(provider.get("chatCompletionsBridgeEnabled", False)):
        return False
    if "application/json" not in content_type.lower():
        return False
    return urlsplit(path_and_query).path == "/v1/responses"


def normalize_text_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("output_text") or item.get("input_text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    if isinstance(content, dict):
        text = content.get("text") or content.get("output_text") or content.get("input_text")
        if isinstance(text, str):
            return text
    return str(content)


def response_content_to_chat_content(content: Any, role: str) -> Any:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return normalize_text_content(content)

    chat_parts: List[Dict[str, object]] = []
    text_buffer: List[str] = []

    def flush_text() -> None:
        if text_buffer:
            chat_parts.append({"type": "text", "text": "".join(text_buffer)})
            text_buffer.clear()

    for part in content:
        if isinstance(part, str):
            text_buffer.append(part)
            continue
        if not isinstance(part, dict):
            continue

        part_type = str(part.get("type") or "")
        if part_type in {"input_text", "output_text", "text"}:
            text = part.get("text")
            if isinstance(text, str):
                text_buffer.append(text)
            continue

        if part_type in {"input_image", "image_url"} and role == "user":
            image_url = part.get("image_url") or part.get("url")
            if isinstance(image_url, dict):
                image_url = image_url.get("url")
            if isinstance(image_url, str) and image_url:
                flush_text()
                chat_parts.append({"type": "image_url", "image_url": {"url": image_url}})

    if not chat_parts:
        return "".join(text_buffer)

    flush_text()
    return chat_parts


def response_item_to_chat_messages(item: Any) -> List[Dict[str, object]]:
    if isinstance(item, str):
        return [{"role": "user", "content": item}]
    if not isinstance(item, dict):
        return []

    item_type = str(item.get("type") or "")
    if item_type in {
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
        "reasoning",
    }:
        return []

    if item_type in {"input_text", "text"}:
        return [{"role": "user", "content": normalize_text_content(item)}]
    if item_type == "output_text":
        return [{"role": "assistant", "content": normalize_text_content(item)}]

    role = str(item.get("role") or "user")
    if role == "developer":
        role = "system"
    if role not in {"system", "user", "assistant", "tool"}:
        role = "user"

    content = item.get("content")
    if content is None and "text" in item:
        content = item.get("text")

    message = {
        "role": role,
        "content": response_content_to_chat_content(content, role),
    }
    if role == "tool":
        call_id = item.get("tool_call_id") or item.get("call_id")
        if call_id:
            message["tool_call_id"] = str(call_id)
    return [message]


def append_chat_message(messages: List[Dict[str, object]], message: Dict[str, object]) -> None:
    role = message.get("role")
    if role == "assistant" and message.get("tool_calls"):
        messages.append(message)
        return
    if role == "tool":
        if str(message.get("tool_call_id") or "").strip():
            messages.append(message)
        return
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        messages.append(message)
    elif isinstance(content, list) and content:
        messages.append(message)


def response_function_call_to_chat_tool_call(item: Dict[str, object]) -> Dict[str, object]:
    call_id = str(item.get("call_id") or item.get("id") or f"call_{uuid.uuid4().hex}")
    name = str(item.get("name") or "")
    arguments = item.get("arguments", "{}")
    if not isinstance(arguments, str):
        arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": arguments},
    }


def function_call_output_to_tool_message(item: Dict[str, object]) -> Dict[str, object]:
    call_id = str(item.get("call_id") or item.get("tool_call_id") or item.get("id") or "")
    output = normalize_text_content(item.get("output") if "output" in item else item.get("content"))
    message: Dict[str, object] = {"role": "tool", "content": output}
    if call_id:
        message["tool_call_id"] = call_id
    return message


def custom_tool_call_to_text(item: Dict[str, object]) -> str:
    name = str(item.get("name") or "custom_tool")
    call_input = item.get("input")
    if not isinstance(call_input, str):
        call_input = json.dumps(call_input, ensure_ascii=False, separators=(",", ":"))
    return f"Custom tool call `{name}`:\n{call_input}"


def custom_tool_output_to_text(item: Dict[str, object]) -> str:
    call_id = str(item.get("call_id") or item.get("id") or "unknown")
    output = normalize_text_content(item.get("output") if "output" in item else item.get("content"))
    return f"Custom tool output for `{call_id}`:\n{output}"


def responses_input_to_chat_messages(data: Dict[str, object]) -> List[Dict[str, object]]:
    messages: List[Dict[str, object]] = []
    instructions = data.get("instructions")
    if isinstance(instructions, str) and instructions.strip():
        messages.append({"role": "system", "content": instructions})

    pending_tool_calls: List[Dict[str, object]] = []
    known_tool_call_ids = set()

    def flush_pending_tool_calls() -> None:
        if not pending_tool_calls:
            return
        messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": list(pending_tool_calls),
            }
        )
        for tool_call in pending_tool_calls:
            tool_call_id = tool_call.get("id")
            if isinstance(tool_call_id, str):
                known_tool_call_ids.add(tool_call_id)
        pending_tool_calls.clear()

    response_input = data.get("input")
    if isinstance(response_input, str):
        messages.append({"role": "user", "content": response_input})
    elif isinstance(response_input, list):
        for item in response_input:
            if not isinstance(item, dict):
                flush_pending_tool_calls()
                append_chat_message(messages, {"role": "user", "content": str(item)})
                continue

            item_type = str(item.get("type") or "")
            if item_type == "function_call":
                pending_tool_calls.append(response_function_call_to_chat_tool_call(item))
                continue

            if item_type == "function_call_output":
                flush_pending_tool_calls()
                tool_message = function_call_output_to_tool_message(item)
                tool_call_id = str(tool_message.get("tool_call_id") or "")
                if tool_call_id in known_tool_call_ids:
                    append_chat_message(messages, tool_message)
                else:
                    output = normalize_text_content(item.get("output") if "output" in item else item.get("content"))
                    append_chat_message(
                        messages,
                        {
                            "role": "user",
                            "content": f"Tool output for `{tool_call_id or 'unknown'}`:\n{output}",
                        },
                    )
                continue

            flush_pending_tool_calls()
            if item_type == "custom_tool_call":
                append_chat_message(messages, {"role": "assistant", "content": custom_tool_call_to_text(item)})
                continue
            if item_type == "custom_tool_call_output":
                append_chat_message(messages, {"role": "user", "content": custom_tool_output_to_text(item)})
                continue
            if item_type == "reasoning":
                continue

            for message in response_item_to_chat_messages(item):
                append_chat_message(messages, message)

    flush_pending_tool_calls()

    if not messages:
        messages.append({"role": "user", "content": ""})
    return messages


def responses_tools_to_chat_tools(tools: Any) -> Optional[List[Dict[str, object]]]:
    if not isinstance(tools, list):
        return None

    chat_tools: List[Dict[str, object]] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        if tool.get("type") != "function":
            continue
        if isinstance(tool.get("function"), dict):
            chat_tools.append(tool)
            continue

        function: Dict[str, object] = {"name": str(tool.get("name") or "")}
        if not function["name"]:
            continue
        if isinstance(tool.get("description"), str):
            function["description"] = tool["description"]
        if isinstance(tool.get("parameters"), dict):
            function["parameters"] = tool["parameters"]
        if isinstance(tool.get("strict"), bool):
            function["strict"] = tool["strict"]
        chat_tools.append({"type": "function", "function": function})

    return chat_tools or None


def responses_tool_choice_to_chat_tool_choice(tool_choice: Any) -> Any:
    if not isinstance(tool_choice, dict):
        return tool_choice
    if tool_choice.get("type") != "function":
        return tool_choice
    name = tool_choice.get("name")
    if isinstance(name, str) and name:
        return {"type": "function", "function": {"name": name}}
    return tool_choice


def responses_text_format_to_chat_response_format(text_config: Any) -> Optional[Dict[str, object]]:
    if not isinstance(text_config, dict):
        return None
    fmt = text_config.get("format")
    if not isinstance(fmt, dict):
        return None
    fmt_type = fmt.get("type")
    if fmt_type == "json_schema":
        response_format = {"type": "json_schema"}
        json_schema = {key: value for key, value in fmt.items() if key != "type"}
        if json_schema:
            response_format["json_schema"] = json_schema
        return response_format
    if fmt_type == "json_object":
        return {"type": "json_object"}
    return None


def responses_body_to_chat_body(body: bytes, content_type: str) -> bytes:
    if not body or "application/json" not in content_type.lower():
        return body

    data = json.loads(body)
    if not isinstance(data, dict):
        return body

    chat_request: Dict[str, object] = {
        "model": data.get("model", ""),
        "messages": responses_input_to_chat_messages(data),
    }

    if "stream" in data:
        chat_request["stream"] = bool(data.get("stream"))

    copy_fields = [
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "seed",
        "stop",
        "user",
        "parallel_tool_calls",
        "stream_options",
    ]
    for field in copy_fields:
        if field in data and data[field] is not None:
            chat_request[field] = data[field]

    if data.get("max_output_tokens") is not None:
        chat_request["max_tokens"] = data["max_output_tokens"]
    if data.get("max_completion_tokens") is not None:
        chat_request["max_completion_tokens"] = data["max_completion_tokens"]

    tools = responses_tools_to_chat_tools(data.get("tools"))
    if tools:
        chat_request["tools"] = tools

    if "tool_choice" in data:
        chat_request["tool_choice"] = responses_tool_choice_to_chat_tool_choice(data.get("tool_choice"))

    response_format = responses_text_format_to_chat_response_format(data.get("text"))
    if response_format:
        chat_request["response_format"] = response_format

    return json_bytes(chat_request)


def chat_usage_to_responses_usage(usage: Any) -> Optional[Dict[str, object]]:
    if not isinstance(usage, dict):
        return None
    prompt_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
    completion_tokens = usage.get("completion_tokens", usage.get("output_tokens", 0))
    total_tokens = usage.get("total_tokens")
    if total_tokens is None and isinstance(prompt_tokens, int) and isinstance(completion_tokens, int):
        total_tokens = prompt_tokens + completion_tokens
    return {
        "input_tokens": prompt_tokens,
        "output_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }


def chat_message_text(message: Dict[str, object]) -> str:
    return normalize_text_content(message.get("content"))


def chat_tool_calls_to_response_items(tool_calls: Any) -> List[Dict[str, object]]:
    if not isinstance(tool_calls, list):
        return []
    items: List[Dict[str, object]] = []
    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        function = tool_call.get("function")
        if not isinstance(function, dict):
            continue
        call_id = str(tool_call.get("id") or f"call_{uuid.uuid4().hex}")
        arguments = function.get("arguments", "{}")
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
        items.append(
            {
                "id": f"fc_{call_id}",
                "type": "function_call",
                "status": "completed",
                "call_id": call_id,
                "name": str(function.get("name") or ""),
                "arguments": arguments,
            }
        )
    return items


def chat_response_to_responses(chat_json: Dict[str, object], request_model: str) -> Dict[str, object]:
    choices = chat_json.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else {}
    if not isinstance(choice, dict):
        choice = {}
    message = choice.get("message")
    if not isinstance(message, dict):
        message = {}

    text = chat_message_text(message)
    output: List[Dict[str, object]] = []
    if text:
        output.append(
            {
                "id": f"msg_{uuid.uuid4().hex}",
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": text,
                        "annotations": [],
                    }
                ],
            }
        )
    output.extend(chat_tool_calls_to_response_items(message.get("tool_calls")))

    response_id = str(chat_json.get("id") or f"resp_{uuid.uuid4().hex}")
    created = chat_json.get("created")
    if not isinstance(created, int):
        created = int(time.time())
    model = str(chat_json.get("model") or request_model or "unknown")
    response: Dict[str, object] = {
        "id": response_id,
        "object": "response",
        "created_at": created,
        "status": "completed",
        "model": model,
        "output": output,
        "output_text": text,
        "parallel_tool_calls": True,
        "error": None,
        "incomplete_details": None,
    }
    usage = chat_usage_to_responses_usage(chat_json.get("usage"))
    if usage:
        response["usage"] = usage
    return response


def iter_sse_events(upstream_response: http.client.HTTPResponse) -> Iterable[Tuple[str, str]]:
    event = ""
    data_lines: List[str] = []

    def flush() -> Optional[Tuple[str, str]]:
        nonlocal event
        nonlocal data_lines
        if not event and not data_lines:
            return None
        item = (event or "message", "\n".join(data_lines))
        event = ""
        data_lines = []
        return item

    while True:
        raw_line = upstream_response.readline()
        if not raw_line:
            item = flush()
            if item:
                yield item
            break

        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "":
            item = flush()
            if item:
                yield item
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())


def write_sse_event(handler: BaseHTTPRequestHandler, event: str, data: Dict[str, object]) -> None:
    payload = (
        f"event: {event}\n"
        f"data: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"
    ).encode("utf-8")
    handler.wfile.write(payload)
    handler.wfile.flush()


def minimal_response_shell(response_id: str, created_at: int, model: str, status: str) -> Dict[str, object]:
    return {
        "id": response_id,
        "object": "response",
        "created_at": created_at,
        "status": status,
        "model": model,
        "output": [],
        "parallel_tool_calls": True,
        "error": None,
        "incomplete_details": None,
    }


def emit_response_as_sse(handler: BaseHTTPRequestHandler, response: Dict[str, object]) -> None:
    created_response = dict(response)
    created_response["status"] = "in_progress"
    created_response["output"] = []
    write_sse_event(handler, "response.created", {"type": "response.created", "response": created_response})

    output = response.get("output")
    if isinstance(output, list):
        for output_index, item in enumerate(output):
            if not isinstance(item, dict):
                continue
            write_sse_event(
                handler,
                "response.output_item.added",
                {
                    "type": "response.output_item.added",
                    "output_index": output_index,
                    "item": item,
                },
            )
            if item.get("type") == "message":
                content = item.get("content")
                if isinstance(content, list):
                    for content_index, part in enumerate(content):
                        if not isinstance(part, dict):
                            continue
                        text = str(part.get("text") or "")
                        write_sse_event(
                            handler,
                            "response.content_part.added",
                            {
                                "type": "response.content_part.added",
                                "item_id": item.get("id"),
                                "output_index": output_index,
                                "content_index": content_index,
                                "part": {"type": "output_text", "text": "", "annotations": []},
                            },
                        )
                        if text:
                            write_sse_event(
                                handler,
                                "response.output_text.delta",
                                {
                                    "type": "response.output_text.delta",
                                    "item_id": item.get("id"),
                                    "output_index": output_index,
                                    "content_index": content_index,
                                    "delta": text,
                                },
                            )
                        write_sse_event(
                            handler,
                            "response.output_text.done",
                            {
                                "type": "response.output_text.done",
                                "item_id": item.get("id"),
                                "output_index": output_index,
                                "content_index": content_index,
                                "text": text,
                            },
                        )
                        write_sse_event(
                            handler,
                            "response.content_part.done",
                            {
                                "type": "response.content_part.done",
                                "item_id": item.get("id"),
                                "output_index": output_index,
                                "content_index": content_index,
                                "part": {"type": "output_text", "text": text, "annotations": []},
                            },
                        )
            elif item.get("type") == "function_call":
                arguments = str(item.get("arguments") or "")
                if arguments:
                    write_sse_event(
                        handler,
                        "response.function_call_arguments.delta",
                        {
                            "type": "response.function_call_arguments.delta",
                            "item_id": item.get("id"),
                            "output_index": output_index,
                            "delta": arguments,
                        },
                    )
                write_sse_event(
                    handler,
                    "response.function_call_arguments.done",
                    {
                        "type": "response.function_call_arguments.done",
                        "item_id": item.get("id"),
                        "output_index": output_index,
                        "arguments": arguments,
                    },
                )
            write_sse_event(
                handler,
                "response.output_item.done",
                {
                    "type": "response.output_item.done",
                    "output_index": output_index,
                    "item": item,
                },
            )

    write_sse_event(handler, "response.completed", {"type": "response.completed", "response": response})


def validate_provider(provider: Dict[str, object]) -> None:
    provider_id = str(provider.get("id") or "").strip()
    base_url = str(provider.get("baseURL") or "").strip()
    if not provider_id:
        raise ValueError("Active provider is missing an id")
    if not base_url:
        raise ValueError(f"Provider {provider_id} is missing baseURL")

    parts = urlsplit(base_url)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ValueError(f"Provider {provider_id} has an invalid baseURL: {base_url}")

    if not provider_api_key(provider):
        raise ValueError(f"Provider {provider_id} needs an apiKey")


def provider_api_key(provider: Dict[str, object]) -> Optional[str]:
    api_key = str(provider.get("apiKey") or "").strip()
    if api_key:
        return api_key

    return None


def provider_name(provider: Dict[str, object]) -> str:
    return str(provider.get("name") or provider.get("id") or "provider")


def save_capture(capture: Dict[str, object]) -> Path:
    if not LOG_ENABLED:
        return LOG_DIR / "disabled"

    request_dir = LOG_DIR / "requests"
    request_dir.mkdir(parents=True, exist_ok=True)

    timestamp_part = str(capture["receivedAt"]).replace(":", "-").replace(".", "-")
    method_part = str(capture["method"])
    path_part = safe_file_part(str(capture["path"]))
    capture_path = request_dir / f"{timestamp_part}-{method_part}-{path_part}.json"

    capture_json = json.dumps(capture, ensure_ascii=False, indent=2)
    capture_path.write_text(capture_json + "\n", encoding="utf-8")

    with (LOG_DIR / "requests.jsonl").open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(capture, ensure_ascii=False) + "\n")

    return capture_path


def save_upstream_response(response_log: Dict[str, object]) -> Path:
    if not LOG_ENABLED:
        return LOG_DIR / "disabled"

    response_dir = LOG_DIR / "responses"
    response_dir.mkdir(parents=True, exist_ok=True)

    timestamp_part = str(response_log["receivedAt"]).replace(":", "-").replace(".", "-")
    method_part = str(response_log["method"])
    path_part = safe_file_part(str(response_log["path"]))
    response_path = response_dir / f"{timestamp_part}-{method_part}-{path_part}.json"

    response_json = json.dumps(response_log, ensure_ascii=False, indent=2)
    response_path.write_text(response_json + "\n", encoding="utf-8")

    with (LOG_DIR / "responses.jsonl").open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(response_log, ensure_ascii=False) + "\n")

    return response_path


def save_proxy_error(error: Exception) -> None:
    if not LOG_ENABLED:
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    error_path = LOG_DIR / "proxy-errors.log"
    entry = {
        "receivedAt": utc_timestamp(),
        "error": str(error),
        "traceback": traceback.format_exc(),
    }
    with error_path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(entry, ensure_ascii=False) + "\n")


def append_jsonl(path: Path, entry: Dict[str, object]) -> None:
    if not LOG_ENABLED:
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(entry, ensure_ascii=False) + "\n")


def save_access_log(handler: BaseHTTPRequestHandler, stage: str) -> None:
    append_jsonl(
        LOG_DIR / "access.log",
        {
            "receivedAt": utc_timestamp(),
            "stage": stage,
            "client": handler.client_address[0] if handler.client_address else None,
            "method": handler.command,
            "path": handler.path,
            "headers": redact_headers(dict(handler.headers.items())),
        },
    )


def save_boot_log() -> None:
    append_jsonl(
        LOG_DIR / "boot.log",
        {
            "startedAt": utc_timestamp(),
            "script": str(Path(__file__).resolve()),
            "cwd": str(Path.cwd()),
            "host": HOST,
            "port": PORT,
            "logDir": str(LOG_DIR),
            "routerConfig": str(ROUTER_CONFIG_PATH),
            "logSensitive": LOG_SENSITIVE,
            "logEnabled": LOG_ENABLED,
            "noForward": NO_FORWARD,
            "version": PROXY_VERSION,
        },
    )


def build_upstream_headers(incoming_headers: Dict[str, str], provider: Dict[str, object], body_length: int) -> Dict[str, str]:
    preserve_auth = bool(provider.get("preserveIncomingAuth", False))
    headers: Dict[str, str] = {}

    for name, value in incoming_headers.items():
        lower_name = name.lower()
        if lower_name in HOP_BY_HOP_HEADERS or lower_name in {"host", "content-length"}:
            continue
        if not preserve_auth and lower_name in SENSITIVE_HEADERS:
            continue
        headers[name] = value

    headers["Accept-Encoding"] = "identity"

    provider_headers = provider.get("headers")
    if isinstance(provider_headers, dict):
        for name, value in provider_headers.items():
            if name and value is not None:
                headers[str(name)] = str(value)

    api_key = provider_api_key(provider)
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    if body_length:
        headers["Content-Length"] = str(body_length)

    return headers


def build_upstream_target(path_and_query: str, provider: Dict[str, object]) -> Tuple[urlsplit, str]:
    base = str(provider.get("baseURL") or "").strip().rstrip("/")
    base_parts = urlsplit(base)
    if base_parts.scheme not in {"http", "https"} or not base_parts.netloc:
        raise ValueError(f"Invalid provider baseURL: {base}")

    incoming = urlsplit(path_and_query)
    base_path = base_parts.path.rstrip("/")
    incoming_path = incoming.path

    if base_path.endswith("/v1") and incoming_path == "/v1":
        incoming_path = ""
    elif base_path.endswith("/v1") and incoming_path.startswith("/v1/"):
        incoming_path = incoming_path[3:]

    target_path = f"{base_path}{incoming_path}"
    if not target_path.startswith("/"):
        target_path = "/" + target_path
    if incoming.query:
        target_path = f"{target_path}?{incoming.query}"

    return base_parts, target_path


def response_headers_for_client(headers: Iterable[Tuple[str, str]]) -> Dict[str, str]:
    forwarded = {}
    for name, value in headers:
        if name.lower() in HOP_BY_HOP_HEADERS or name.lower() == "connection":
            continue
        forwarded[name] = value
    return forwarded


def header_value(headers: Dict[str, str], target_name: str) -> str:
    target_name = target_name.lower()
    for name, value in headers.items():
        if name.lower() == target_name:
            return value
    return ""


def send_json(handler: BaseHTTPRequestHandler, status_code: int, data: Dict[str, object]) -> None:
    payload = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status_code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class CaptureProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:
        save_access_log(self, "do_GET")
        self.handle_proxy()

    def do_POST(self) -> None:
        save_access_log(self, "do_POST")
        self.handle_proxy()

    def do_PUT(self) -> None:
        save_access_log(self, "do_PUT")
        self.handle_proxy()

    def do_PATCH(self) -> None:
        save_access_log(self, "do_PATCH")
        self.handle_proxy()

    def do_DELETE(self) -> None:
        save_access_log(self, "do_DELETE")
        self.handle_proxy()

    def do_OPTIONS(self) -> None:
        save_access_log(self, "do_OPTIONS")
        self.handle_proxy()

    def do_HEAD(self) -> None:
        save_access_log(self, "do_HEAD")
        self.handle_proxy()

    def read_body(self) -> bytes:
        transfer_encoding = self.headers.get("Transfer-Encoding", "").lower()
        if "chunked" in transfer_encoding:
            return self.read_chunked_body()

        content_length = self.headers.get("Content-Length")
        if not content_length:
            return b""

        body_length = int(content_length)
        if body_length > MAX_CAPTURE_BYTES:
            raise ValueError(f"Request body is larger than {MAX_CAPTURE_BYTES} bytes")

        return self.rfile.read(body_length)

    def read_chunked_body(self) -> bytes:
        chunks = []
        total = 0

        while True:
            size_line = self.rfile.readline().split(b";", 1)[0].strip()
            if not size_line:
                continue

            chunk_size = int(size_line, 16)
            if chunk_size == 0:
                while True:
                    trailer = self.rfile.readline()
                    if trailer in {b"\r\n", b"\n", b""}:
                        break
                break

            total += chunk_size
            if total > MAX_CAPTURE_BYTES:
                raise ValueError(f"Request body is larger than {MAX_CAPTURE_BYTES} bytes")

            chunks.append(self.rfile.read(chunk_size))
            self.rfile.read(2)

        return b"".join(chunks)

    def handle_proxy(self) -> None:
        started = time.time()

        try:
            save_access_log(self, "received")

            if self.path == "/_health":
                _, active_provider = load_router_config()
                send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        "version": PROXY_VERSION,
                        "activeProvider": redact_provider(active_provider),
                        "logDir": str(LOG_DIR),
                        "routerConfig": str(ROUTER_CONFIG_PATH),
                    },
                )
                return

            if self.path == "/_providers":
                config, active_provider = load_router_config()
                providers = config.get("providers") if isinstance(config.get("providers"), list) else []
                send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        "activeProviderId": active_provider.get("id"),
                        "providers": [
                            redact_provider(provider)
                            for provider in providers
                            if isinstance(provider, dict)
                        ],
                    },
                )
                return

            incoming = urlsplit(self.path)
            if not incoming.path.startswith("/v1/"):
                send_json(
                    self,
                    404,
                    {
                        "ok": False,
                        "error": "This router only forwards /v1/... API requests.",
                        "hint": "Use OPENAI_BASE_URL=http://127.0.0.1:8787/v1 for Codex.",
                    },
                )
                return

            router_config, active_provider = load_router_config()
            body = self.read_body()
            content_type = self.headers.get("Content-Type", "")
            rewritten_body = rewrite_request_body(body, content_type, active_provider)
            bridge_enabled = provider_uses_chat_bridge(active_provider, self.path, content_type)
            upstream_body = responses_body_to_chat_body(rewritten_body, content_type) if bridge_enabled else rewritten_body
            received_at = utc_timestamp()
            incoming_headers = dict(self.headers.items())

            capture = {
                "receivedAt": received_at,
                "method": self.command,
                "path": incoming.path,
                "query": flatten_query(incoming.query),
                "headers": redact_headers(incoming_headers),
                "bodyBytes": len(body),
                "bodySha256": hashlib.sha256(body).hexdigest(),
                "body": parse_body(body, self.headers.get("Content-Type", "")),
                "upstreamBodyBytes": len(upstream_body),
                "upstreamBodySha256": hashlib.sha256(upstream_body).hexdigest(),
                "upstreamBody": parse_body(upstream_body, self.headers.get("Content-Type", "")),
                "provider": redact_provider(active_provider),
                "upstream": {
                    "baseUrl": active_provider.get("baseURL"),
                    "forwarding": not NO_FORWARD,
                    "protocolBridge": "responses-to-chat-completions" if bridge_enabled else "none",
                },
            }

            saved_to = save_capture(capture)
            if LOG_ENABLED:
                print(
                    f"[{received_at}] captured {self.command} {incoming.path} "
                    f"for {provider_name(active_provider)} -> {saved_to}"
                )
            else:
                print(
                    f"[{received_at}] received {self.command} {incoming.path} "
                    f"for {provider_name(active_provider)}"
                )

            if NO_FORWARD:
                send_json(
                    self,
                    200,
                    {
                        "ok": True,
                        "captured": True,
                        "savedTo": str(saved_to),
                        "provider": redact_provider(active_provider),
                        "forwarding": False,
                    },
                )
                return

            if bridge_enabled:
                self.forward_to_chat_completions_bridge(upstream_body, active_provider, rewritten_body)
            else:
                self.forward_to_upstream(upstream_body, active_provider)
            elapsed_ms = int((time.time() - started) * 1000)
            if bridge_enabled:
                print(
                    f"[{received_at}] bridged {self.command} {incoming.path} "
                    f"-> /v1/chat/completions via {provider_name(active_provider)} in {elapsed_ms}ms"
                )
            else:
                print(
                    f"[{received_at}] forwarded {self.command} {incoming.path} "
                    f"via {provider_name(active_provider)} in {elapsed_ms}ms"
                )

        except Exception as error:
            save_proxy_error(error)
            print(f"proxy error: {error}", file=sys.stderr)
            if not self.wfile.closed:
                send_json(self, 502, {"ok": False, "error": str(error)})

    def forward_to_upstream(self, body: bytes, provider: Dict[str, object]) -> None:
        base_parts, target_path = build_upstream_target(self.path, provider)
        port = base_parts.port
        host = base_parts.hostname
        if host is None:
            raise ValueError("Upstream host is missing")

        connection_cls = http.client.HTTPSConnection if base_parts.scheme == "https" else http.client.HTTPConnection
        context = ssl.create_default_context() if base_parts.scheme == "https" else None

        if context is not None:
            connection = connection_cls(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS, context=context)
        else:
            connection = connection_cls(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS)

        try:
            connection.request(
                self.command,
                target_path,
                body=body if body else None,
                headers=build_upstream_headers(dict(self.headers.items()), provider, len(body)),
            )
            upstream_response = connection.getresponse()
            upstream_headers_list = upstream_response.getheaders()
            response_headers = response_headers_for_client(upstream_headers_list)
            has_content_length = any(name.lower() == "content-length" for name in response_headers)
            preview = bytearray()
            preview_truncated = False

            self.send_response(upstream_response.status, upstream_response.reason)
            for name, value in response_headers.items():
                self.send_header(name, value)
            if not has_content_length:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()

            if self.command == "HEAD":
                return

            while True:
                chunk = upstream_response.read(8192)
                if not chunk:
                    break
                remaining_preview_bytes = MAX_RESPONSE_LOG_BYTES - len(preview)
                if remaining_preview_bytes > 0:
                    preview.extend(chunk[:remaining_preview_bytes])
                    if len(chunk) > remaining_preview_bytes:
                        preview_truncated = True
                else:
                    preview_truncated = True
                self.wfile.write(chunk)
                self.wfile.flush()

            response_log = {
                "receivedAt": utc_timestamp(),
                "method": self.command,
                "path": urlsplit(self.path).path,
                "query": flatten_query(urlsplit(self.path).query),
                "provider": redact_provider(provider),
                "upstream": {
                    "baseUrl": provider.get("baseURL"),
                    "targetPath": target_path,
                    "status": upstream_response.status,
                    "reason": upstream_response.reason,
                },
                "headers": redact_headers(dict(upstream_headers_list)),
                "bodyPreviewBytes": len(preview),
                "bodyPreviewTruncated": preview_truncated,
                "bodyPreview": parse_response_preview(bytes(preview), header_value(response_headers, "content-type")),
            }
            response_path = save_upstream_response(response_log)
            if LOG_ENABLED:
                print(f"saved upstream response {upstream_response.status} -> {response_path}")

        finally:
            connection.close()

    def forward_to_chat_completions_bridge(
        self,
        body: bytes,
        provider: Dict[str, object],
        responses_body: bytes,
    ) -> None:
        incoming = urlsplit(self.path)
        chat_path = "/v1/chat/completions"
        if incoming.query:
            chat_path = f"{chat_path}?{incoming.query}"
        base_parts, target_path = build_upstream_target(chat_path, provider)
        port = base_parts.port
        host = base_parts.hostname
        if host is None:
            raise ValueError("Upstream host is missing")

        request_model = ""
        wants_stream = False
        try:
            responses_json = json.loads(responses_body)
            if isinstance(responses_json, dict):
                request_model = str(responses_json.get("model") or "")
                wants_stream = bool(responses_json.get("stream", False))
        except json.JSONDecodeError:
            pass

        connection_cls = http.client.HTTPSConnection if base_parts.scheme == "https" else http.client.HTTPConnection
        context = ssl.create_default_context() if base_parts.scheme == "https" else None

        if context is not None:
            connection = connection_cls(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS, context=context)
        else:
            connection = connection_cls(host, port=port, timeout=REQUEST_TIMEOUT_SECONDS)

        try:
            connection.request(
                "POST",
                target_path,
                body=body if body else None,
                headers=build_upstream_headers(dict(self.headers.items()), provider, len(body)),
            )
            upstream_response = connection.getresponse()
            upstream_headers_list = upstream_response.getheaders()
            upstream_content_type = header_value(dict(upstream_headers_list), "content-type")

            if upstream_response.status >= 400:
                self.relay_raw_bridge_response(upstream_response, upstream_headers_list, provider, target_path)
                return

            if wants_stream:
                self.send_response(200, "OK")
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

                if "text/event-stream" in upstream_content_type.lower():
                    response_log = self.stream_chat_sse_as_responses(
                        upstream_response,
                        provider,
                        target_path,
                        request_model,
                    )
                    save_upstream_response(response_log)
                else:
                    raw_body = upstream_response.read()
                    chat_json = json.loads(raw_body.decode("utf-8", errors="replace"))
                    if not isinstance(chat_json, dict):
                        raise ValueError("Chat bridge upstream response was not a JSON object")
                    response = chat_response_to_responses(chat_json, request_model)
                    emit_response_as_sse(self, response)
                    save_upstream_response(
                        self.bridge_response_log(
                            provider,
                            target_path,
                            upstream_response.status,
                            upstream_response.reason,
                            upstream_headers_list,
                            raw_body,
                            response,
                        )
                    )
                return

            raw_body = upstream_response.read()
            chat_json = json.loads(raw_body.decode("utf-8", errors="replace"))
            if not isinstance(chat_json, dict):
                raise ValueError("Chat bridge upstream response was not a JSON object")
            response = chat_response_to_responses(chat_json, request_model)
            payload = json.dumps(response, ensure_ascii=False, indent=2).encode("utf-8")

            self.send_response(200, "OK")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)

            save_upstream_response(
                self.bridge_response_log(
                    provider,
                    target_path,
                    upstream_response.status,
                    upstream_response.reason,
                    upstream_headers_list,
                    raw_body,
                    response,
                )
            )

        finally:
            connection.close()

    def relay_raw_bridge_response(
        self,
        upstream_response: http.client.HTTPResponse,
        upstream_headers_list: List[Tuple[str, str]],
        provider: Dict[str, object],
        target_path: str,
    ) -> None:
        response_headers = response_headers_for_client(upstream_headers_list)
        raw_body = upstream_response.read()
        self.send_response(upstream_response.status, upstream_response.reason)
        for name, value in response_headers.items():
            if name.lower() == "content-length":
                continue
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(raw_body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw_body)

        save_upstream_response(
            self.bridge_response_log(
                provider,
                target_path,
                upstream_response.status,
                upstream_response.reason,
                upstream_headers_list,
                raw_body,
                None,
            )
        )

    def bridge_response_log(
        self,
        provider: Dict[str, object],
        target_path: str,
        status: int,
        reason: str,
        headers: List[Tuple[str, str]],
        raw_body: bytes,
        converted_response: Optional[Dict[str, object]],
    ) -> Dict[str, object]:
        preview = raw_body[:MAX_RESPONSE_LOG_BYTES]
        return {
            "receivedAt": utc_timestamp(),
            "method": self.command,
            "path": urlsplit(self.path).path,
            "query": flatten_query(urlsplit(self.path).query),
            "provider": redact_provider(provider),
            "upstream": {
                "baseUrl": provider.get("baseURL"),
                "targetPath": target_path,
                "status": status,
                "reason": reason,
                "protocolBridge": "responses-to-chat-completions",
            },
            "headers": redact_headers(dict(headers)),
            "bodyPreviewBytes": len(preview),
            "bodyPreviewTruncated": len(raw_body) > len(preview),
            "bodyPreview": parse_response_preview(bytes(preview), header_value(dict(headers), "content-type")),
            "convertedPreview": converted_response,
        }

    def stream_chat_sse_as_responses(
        self,
        upstream_response: http.client.HTTPResponse,
        provider: Dict[str, object],
        target_path: str,
        request_model: str,
    ) -> Dict[str, object]:
        response_id = f"resp_{uuid.uuid4().hex}"
        created_at = int(time.time())
        model = request_model or "unknown"
        write_sse_event(
            self,
            "response.created",
            {
                "type": "response.created",
                "response": minimal_response_shell(response_id, created_at, model, "in_progress"),
            },
        )

        text_item_id: Optional[str] = None
        text_output_index: Optional[int] = None
        text = ""
        next_output_index = 0
        tool_items: Dict[int, Dict[str, object]] = {}
        usage: Optional[Dict[str, object]] = None

        def ensure_text_item() -> Tuple[str, int]:
            nonlocal text_item_id
            nonlocal text_output_index
            nonlocal next_output_index
            if text_item_id is not None and text_output_index is not None:
                return text_item_id, text_output_index

            text_item_id = f"msg_{uuid.uuid4().hex}"
            text_output_index = next_output_index
            next_output_index += 1
            item = {
                "id": text_item_id,
                "type": "message",
                "status": "in_progress",
                "role": "assistant",
                "content": [],
            }
            write_sse_event(
                self,
                "response.output_item.added",
                {
                    "type": "response.output_item.added",
                    "output_index": text_output_index,
                    "item": item,
                },
            )
            write_sse_event(
                self,
                "response.content_part.added",
                {
                    "type": "response.content_part.added",
                    "item_id": text_item_id,
                    "output_index": text_output_index,
                    "content_index": 0,
                    "part": {"type": "output_text", "text": "", "annotations": []},
                },
            )
            return text_item_id, text_output_index

        def ensure_tool_item(tool_index: int, delta: Dict[str, object]) -> Dict[str, object]:
            nonlocal next_output_index
            if tool_index in tool_items:
                return tool_items[tool_index]

            function = delta.get("function")
            if not isinstance(function, dict):
                function = {}
            call_id = str(delta.get("id") or f"call_{uuid.uuid4().hex}")
            item = {
                "id": f"fc_{call_id}",
                "type": "function_call",
                "status": "in_progress",
                "call_id": call_id,
                "name": str(function.get("name") or ""),
                "arguments": "",
                "output_index": next_output_index,
            }
            next_output_index += 1
            tool_items[tool_index] = item
            send_item = {key: value for key, value in item.items() if key != "output_index"}
            write_sse_event(
                self,
                "response.output_item.added",
                {
                    "type": "response.output_item.added",
                    "output_index": item["output_index"],
                    "item": send_item,
                },
            )
            return item

        for _, data_text in iter_sse_events(upstream_response):
            if data_text.strip() == "[DONE]":
                break
            try:
                chunk = json.loads(data_text)
            except json.JSONDecodeError:
                continue
            if not isinstance(chunk, dict):
                continue
            if isinstance(chunk.get("model"), str):
                model = str(chunk["model"])
            mapped_usage = chat_usage_to_responses_usage(chunk.get("usage"))
            if mapped_usage:
                usage = mapped_usage

            choices = chunk.get("choices")
            choice = choices[0] if isinstance(choices, list) and choices else {}
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                delta = {}

            content_delta = delta.get("content")
            if isinstance(content_delta, str) and content_delta:
                item_id, output_index = ensure_text_item()
                text += content_delta
                write_sse_event(
                    self,
                    "response.output_text.delta",
                    {
                        "type": "response.output_text.delta",
                        "item_id": item_id,
                        "output_index": output_index,
                        "content_index": 0,
                        "delta": content_delta,
                    },
                )

            tool_calls = delta.get("tool_calls")
            if isinstance(tool_calls, list):
                for tool_call_delta in tool_calls:
                    if not isinstance(tool_call_delta, dict):
                        continue
                    tool_index = int(tool_call_delta.get("index", 0))
                    item = ensure_tool_item(tool_index, tool_call_delta)
                    function_delta = tool_call_delta.get("function")
                    if not isinstance(function_delta, dict):
                        function_delta = {}
                    if not item.get("name") and isinstance(function_delta.get("name"), str):
                        item["name"] = function_delta["name"]
                    arguments_delta = function_delta.get("arguments")
                    if isinstance(arguments_delta, str) and arguments_delta:
                        item["arguments"] = str(item.get("arguments") or "") + arguments_delta
                        write_sse_event(
                            self,
                            "response.function_call_arguments.delta",
                            {
                                "type": "response.function_call_arguments.delta",
                                "item_id": item["id"],
                                "output_index": item["output_index"],
                                "delta": arguments_delta,
                            },
                        )

        output: List[Dict[str, object]] = []
        if text_item_id is not None and text_output_index is not None:
            message_item = {
                "id": text_item_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": text,
                        "annotations": [],
                    }
                ],
            }
            output.append(message_item)
            write_sse_event(
                self,
                "response.output_text.done",
                {
                    "type": "response.output_text.done",
                    "item_id": text_item_id,
                    "output_index": text_output_index,
                    "content_index": 0,
                    "text": text,
                },
            )
            write_sse_event(
                self,
                "response.content_part.done",
                {
                    "type": "response.content_part.done",
                    "item_id": text_item_id,
                    "output_index": text_output_index,
                    "content_index": 0,
                    "part": {"type": "output_text", "text": text, "annotations": []},
                },
            )
            write_sse_event(
                self,
                "response.output_item.done",
                {
                    "type": "response.output_item.done",
                    "output_index": text_output_index,
                    "item": message_item,
                },
            )

        for item in sorted(tool_items.values(), key=lambda value: int(value["output_index"])):
            send_item = {key: value for key, value in item.items() if key != "output_index"}
            send_item["status"] = "completed"
            output.append(send_item)
            write_sse_event(
                self,
                "response.function_call_arguments.done",
                {
                    "type": "response.function_call_arguments.done",
                    "item_id": item["id"],
                    "output_index": item["output_index"],
                    "arguments": str(item.get("arguments") or ""),
                },
            )
            write_sse_event(
                self,
                "response.output_item.done",
                {
                    "type": "response.output_item.done",
                    "output_index": item["output_index"],
                    "item": send_item,
                },
            )

        completed_response = minimal_response_shell(response_id, created_at, model, "completed")
        completed_response["output"] = output
        completed_response["output_text"] = text
        if usage:
            completed_response["usage"] = usage
        write_sse_event(
            self,
            "response.completed",
            {
                "type": "response.completed",
                "response": completed_response,
            },
        )

        return {
            "receivedAt": utc_timestamp(),
            "method": self.command,
            "path": urlsplit(self.path).path,
            "query": flatten_query(urlsplit(self.path).query),
            "provider": redact_provider(provider),
            "upstream": {
                "baseUrl": provider.get("baseURL"),
                "targetPath": target_path,
                "status": upstream_response.status,
                "reason": upstream_response.reason,
                "protocolBridge": "responses-to-chat-completions",
            },
            "headers": redact_headers(dict(upstream_response.getheaders())),
            "bodyPreviewBytes": 0,
            "bodyPreviewTruncated": True,
            "bodyPreview": "[stream converted from chat.completions to responses]",
            "convertedPreview": completed_response,
        }


def main() -> None:
    load_dotenv()
    load_config()
    ensure_router_config_exists()
    save_boot_log()
    server = ThreadingHTTPServer((HOST, PORT), CaptureProxyHandler)
    print(f"Codex provider router listening on http://{HOST}:{PORT}")
    print(f"Reading providers from {ROUTER_CONFIG_PATH}")
    if LOG_ENABLED:
        print(f"Writing captures to {LOG_DIR / 'requests'} and {LOG_DIR / 'requests.jsonl'}")
    else:
        print("Persistent request/response logs are disabled.")
    print("Set NO_FORWARD=1 to capture without calling the active provider.")
    server.serve_forever()


if __name__ == "__main__":
    main()
