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
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Iterable, Optional, Tuple
from urllib.parse import parse_qs, urlsplit


SCRIPT_DIR = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = 8787
LOG_DIR = Path("logs")
ROUTER_CONFIG_PATH = SCRIPT_DIR / "providers.json"
MAX_CAPTURE_BYTES = 25 * 1024 * 1024
NO_FORWARD = False
LOG_SENSITIVE = False
REQUEST_TIMEOUT_SECONDS = 600.0
MAX_RESPONSE_LOG_BYTES = 1024 * 1024
PROXY_VERSION = "2026-06-29-provider-router-v1"

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
                "enabled": True,
                "headers": {},
                "defaultModel": "",
                "modelMapping": {
                    "enabled": False,
                    "targetModel": "",
                },
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
    enabled_providers = [
        provider
        for provider in providers
        if isinstance(provider, dict) and provider.get("enabled", True)
    ]
    if not enabled_providers:
        raise ValueError("Router config has no enabled providers")

    active_provider = next(
        (
            provider
            for provider in enabled_providers
            if str(provider.get("id") or "") == active_provider_id
        ),
        enabled_providers[0],
    )
    validate_provider(active_provider)
    return config, active_provider


def rewrite_request_body(body: bytes, content_type: str, provider: Dict[str, object]) -> bytes:
    if not body or "application/json" not in content_type.lower():
        return body

    model_mapping = provider.get("modelMapping")
    if not isinstance(model_mapping, dict) or not model_mapping.get("enabled"):
        return body

    target_model = str(model_mapping.get("targetModel") or "").strip()
    if not target_model:
        target_model = str(provider.get("defaultModel") or "").strip()
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
            upstream_body = rewrite_request_body(body, self.headers.get("Content-Type", ""), active_provider)
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
                },
            }

            saved_to = save_capture(capture)
            print(
                f"[{received_at}] captured {self.command} {incoming.path} "
                f"for {provider_name(active_provider)} -> {saved_to}"
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

            self.forward_to_upstream(upstream_body, active_provider)
            elapsed_ms = int((time.time() - started) * 1000)
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
            print(f"saved upstream response {upstream_response.status} -> {response_path}")

        finally:
            connection.close()


def main() -> None:
    load_dotenv()
    load_config()
    ensure_router_config_exists()
    save_boot_log()
    server = ThreadingHTTPServer((HOST, PORT), CaptureProxyHandler)
    print(f"Codex provider router listening on http://{HOST}:{PORT}")
    print(f"Reading providers from {ROUTER_CONFIG_PATH}")
    print(f"Writing captures to {LOG_DIR / 'requests'} and {LOG_DIR / 'requests.jsonl'}")
    print("Set NO_FORWARD=1 to capture without calling the active provider.")
    server.serve_forever()


if __name__ == "__main__":
    main()
