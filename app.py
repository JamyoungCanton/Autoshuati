from __future__ import annotations

import argparse
import configparser
import json
import os
import subprocess
import sys
import threading
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any

from celery import Celery, Task
from flask import Flask, abort, g, jsonify, request, send_from_directory


ROOT = Path(__file__).parent.resolve()
CONFIG_FILE = ROOT / "config.ini"
ACCOUNTS_FILE = ROOT / "accounts.json"
DATA_ROOT = ROOT / "data" / "users"
FRONTEND_DIST = ROOT / "frontend" / "dist"

MODEL_CATALOG = [
    {
        "match": "siliconflow",
        "models": [
            "Qwen/Qwen2.5-7B-Instruct",
            "Qwen/Qwen2.5-14B-Instruct",
            "deepseek-ai/DeepSeek-V3",
            "THUDM/glm-4-9b-chat",
        ],
    },
    {"match": "deepseek", "models": ["deepseek-chat", "deepseek-reasoner"]},
    {"match": "dashscope", "models": ["qwen-plus", "qwen-turbo", "qwen-max"]},
    {"match": "openai", "models": ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"]},
    {"match": "freemodel", "models": ["gpt-4o-mini", "gpt-4.1-mini", "deepseek-chat", "qwen-plus"]},
]

AI_PROVIDER_ALIASES = {
    "ai",
    "claude",
    "freemodel",
    "free model",
    "openai",
    "openai-compatible",
    "openai compatible",
    "deepseek",
    "chatgpt",
}


class ProcessState:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None
        self.task_id: str | None = None
        self.logs: deque[dict[str, str]] = deque(maxlen=500)
        self.lock = threading.Lock()

    def add_log(self, level: str, message: str) -> None:
        from datetime import datetime

        self.logs.append(
            {
                "id": str(len(self.logs) + 1),
                "time": datetime.now().strftime("%H:%M:%S"),
                "level": level,
                "message": message.rstrip(),
            }
        )

    def state(self) -> str:
        with self.lock:
            if self.process is None:
                return "idle"
            if self.process.poll() is None:
                return "running"
            return "done" if self.process.returncode == 0 else "error"


PROCESS_STATES: dict[str, ProcessState] = {}


def _sanitize_device_id(value: str) -> str:
    cleaned = "".join(char for char in value if char.isalnum() or char in {"-", "_"})
    return cleaned[:80] or "anonymous"


def _current_device_id() -> str:
    if hasattr(g, "device_id"):
        return g.device_id
    try:
        return _sanitize_device_id(request.headers.get("X-Device-Id", "anonymous"))
    except RuntimeError:
        return "local"


def _device_root() -> Path:
    path = DATA_ROOT / _current_device_id()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _config_file() -> Path:
    return _device_root() / "config.ini"


def _accounts_file() -> Path:
    return _device_root() / "accounts.json"


def _state() -> ProcessState:
    device_id = _current_device_id()
    if device_id not in PROCESS_STATES:
        PROCESS_STATES[device_id] = ProcessState()
    return PROCESS_STATES[device_id]


class ProcessStateProxy:
    def __getattr__(self, name: str) -> Any:
        return getattr(_state(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(_state(), name, value)


process_state = ProcessStateProxy()


def _load_accounts() -> list[dict[str, Any]]:
    accounts_file = _accounts_file()
    if not accounts_file.exists():
        return []
    try:
        data = json.loads(accounts_file.read_text(encoding="utf8"))
    except (json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def _write_accounts(accounts: list[dict[str, Any]]) -> None:
    _accounts_file().write_text(json.dumps(accounts, ensure_ascii=False, indent=2), encoding="utf8")


def _mask_username(username: str) -> str:
    if len(username) <= 4:
        return username
    return f"{username[:3]}****{username[-2:]}"


def _get_chaoxing_client() -> Any:
    config = _load_config()
    username = config["runtime"].get("username", "").strip()
    password = config["runtime"].get("password", "").strip()
    if not username or not password:
        raise ValueError("请先在任务配置中填写账号和密码并保存")

    from api.base import Account, Chaoxing

    chaoxing = Chaoxing(account=Account(username, password), tiku=None)
    login_result = chaoxing.login(login_with_cookies=False)
    if not login_result.get("status"):
        raise RuntimeError(login_result.get("msg") or "超星登录失败")
    return chaoxing


def _normalize_course(course: dict[str, Any]) -> dict[str, Any]:
    course_id = str(course.get("courseId") or course.get("course_id") or course.get("id") or "")
    return {
        **course,
        "id": course_id,
        "courseId": course_id,
        "name": course.get("name") or course.get("courseName") or course.get("title") or f"课程 {course_id}",
        "clazzId": str(course.get("clazzId") or course.get("classId") or ""),
        "cpi": str(course.get("cpi") or ""),
        "teacher": course.get("teacher") or course.get("teacherName") or "",
    }


def _decode_process_line(raw_line: bytes) -> str:
    for encoding in ("utf-8", "gbk", sys.getdefaultencoding(), "mbcs"):
        try:
            return raw_line.decode(encoding).rstrip()
        except (LookupError, UnicodeDecodeError):
            continue
    return raw_line.decode("utf-8", errors="replace").rstrip()


def _log_level_from_line(line: str) -> str:
    lowered = line.lower()
    if any(keyword in lowered for keyword in ("error", "exception", "traceback", "failed", "失败", "错误", "异常")):
        return "error"
    if any(keyword in lowered for keyword in ("warn", "warning", "警告", "重试")):
        return "warn"
    return "info"


def celery_init_app(app: Flask) -> Celery:
    class FlaskTask(Task):
        def __call__(self, *args: object, **kwargs: object) -> object:
            with app.app_context():
                return self.run(*args, **kwargs)

    celery_app = Celery(app.name, task_cls=FlaskTask)
    celery_app.config_from_object(app.config["CELERY"])
    celery_app.set_default()
    app.extensions["celery"] = celery_app
    return celery_app


def _default_payload() -> dict[str, Any]:
    return {
        "runtime": {
            "username": "",
            "password": "",
            "courseList": "",
            "notopenAction": "retry",
            "speed": 1,
            "jobs": 4,
        },
        "tiku": {
            "provider": "SiliconFlow",
            "officialUrl": "https://cloud.siliconflow.cn/",
            "apiUrl": "https://api.siliconflow.cn/v1/chat/completions",
            "model": "Qwen/Qwen2.5-7B-Instruct",
            "token": "",
            "coverRate": 80,
            "submit": False,
        },
        "notification": {"provider": "ServerChan", "url": ""},
    }


def _normalize_tiku_provider(provider: Any, api_url: str = "") -> str:
    provider_text = str(provider or "").strip()
    if not provider_text:
        return "AI" if api_url else "TikuYanxi"
    if provider_text.lower() in AI_PROVIDER_ALIASES:
        return "AI"
    return provider_text


def _normalize_openai_base_url(api_url: str) -> str:
    normalized_url = str(api_url or "").strip().rstrip("/")
    if not normalized_url:
        return ""
    if "/chat/completions" in normalized_url:
        return normalized_url.split("/chat/completions")[0].rstrip("/")
    if normalized_url.endswith("/v1"):
        return normalized_url
    return f"{normalized_url}/v1"


def _normalize_chat_completions_url(api_url: str) -> str:
    base_url = _normalize_openai_base_url(api_url)
    if not base_url:
        return ""
    return f"{base_url}/chat/completions"


def _str_to_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _load_config() -> dict[str, Any]:
    payload = _default_payload()
    config_file = _config_file()
    if not config_file.exists():
        return payload

    config = configparser.ConfigParser()
    config.read(config_file, encoding="utf8")

    if config.has_section("common"):
        common = config["common"]
        payload["runtime"].update(
            {
                "username": common.get("username", ""),
                "password": common.get("password", ""),
                "courseList": common.get("course_list", ""),
                "notopenAction": common.get("notopen_action", "retry"),
                "speed": float(common.get("speed", "1")),
                "jobs": int(common.get("jobs", "4")),
            }
        )

    if config.has_section("tiku"):
        tiku = config["tiku"]
        provider = _normalize_tiku_provider(tiku.get("provider", "SiliconFlow"))
        if provider == "SiliconFlow":
            api_url = tiku.get("siliconflow_endpoint", "")
            model = tiku.get("siliconflow_model", "")
            token = tiku.get("siliconflow_key", "")
            official_url = "https://cloud.siliconflow.cn/"
        else:
            api_url = tiku.get("endpoint", "") or tiku.get("url", "")
            model = tiku.get("model", "") or tiku.get("likeapi_model", "")
            token = tiku.get("key", "") or tiku.get("tokens", "")
            official_url = ""

        cover_rate = float(tiku.get("cover_rate", "0.8"))
        payload["tiku"].update(
            {
                "provider": provider,
                "officialUrl": official_url,
                "apiUrl": api_url,
                "model": model,
                "token": token,
                "coverRate": round(cover_rate * 100 if cover_rate <= 1 else cover_rate),
                "submit": _str_to_bool(tiku.get("submit", False)),
            }
        )

    if config.has_section("notification"):
        notification = config["notification"]
        payload["notification"].update(
            {
                "provider": notification.get("provider", "ServerChan"),
                "url": notification.get("url", ""),
            }
        )

    return payload


def _write_config(payload: dict[str, Any]) -> None:
    runtime = payload.get("runtime", {})
    tiku = payload.get("tiku", {})
    notification = payload.get("notification", {})

    raw_api_url = str(tiku.get("apiUrl", ""))
    provider = _normalize_tiku_provider(tiku.get("provider"), raw_api_url)
    cover_rate = float(tiku.get("coverRate", 80)) / 100
    openai_base_url = _normalize_openai_base_url(raw_api_url)
    chat_completions_url = _normalize_chat_completions_url(raw_api_url)

    config = configparser.ConfigParser()
    config["common"] = {
        "use_cookies": "false",
        "username": str(runtime.get("username", "")),
        "password": str(runtime.get("password", "")),
        "course_list": str(runtime.get("courseList", "")),
        "speed": str(runtime.get("speed", 1)),
        "jobs": str(runtime.get("jobs", 4)),
        "notopen_action": str(runtime.get("notopenAction", "retry")),
    }

    config["tiku"] = {
        "provider": provider,
        "check_llm_connection": "true",
        "submit": str(bool(tiku.get("submit", False))).lower(),
        "cover_rate": str(cover_rate),
        "delay": "1.0",
        "tokens": str(tiku.get("token", "")),
        "url": "",
        "endpoint": openai_base_url,
        "key": str(tiku.get("token", "")),
        "model": str(tiku.get("model", "")),
        "min_interval_seconds": "3",
        "http_proxy": "",
        "siliconflow_key": str(tiku.get("token", "")),
        "siliconflow_model": str(tiku.get("model", "")),
        "siliconflow_endpoint": chat_completions_url,
        "likeapi_search": "false",
        "likeapi_vision": "true",
        "likeapi_model": str(tiku.get("model", "")),
        "likeapi_retry": "true",
        "likeapi_retry_times": "3",
        "true_list": "正确,对,√,是",
        "false_list": "错误,错,×,否,不对,不正确",
    }

    config["notification"] = {
        "provider": str(notification.get("provider", "ServerChan")),
        "url": str(notification.get("url", "")),
        "tg_chat_id": "",
    }

    config_file = _config_file()
    with config_file.open("w", encoding="utf8") as file:
        config.write(file)


def _catalog_models(api_url: str) -> list[str]:
    normalized_url = api_url.strip().lower()
    if not normalized_url:
        return []
    for entry in MODEL_CATALOG:
        if entry["match"] in normalized_url:
            return entry["models"]
    if "/v1/chat/completions" in normalized_url or normalized_url.startswith(("http://", "https://")):
        return ["qwen-plus", "deepseek-chat", "gpt-4.1-mini"]
    return []


def _models_url_from_api_url(api_url: str) -> str:
    normalized_url = api_url.strip().rstrip("/")
    if not normalized_url:
        return ""
    if normalized_url.endswith("/models"):
        return normalized_url
    if "/chat/completions" in normalized_url:
        return normalized_url.split("/chat/completions")[0].rstrip("/") + "/models"
    if normalized_url.endswith("/v1"):
        return normalized_url + "/models"
    return normalized_url + "/v1/models"


def _try_remote_models(api_url: str, api_key: str) -> list[str]:
    if not api_url:
        return []
    try:
        import json
        from urllib.request import Request, urlopen

        models_url = _models_url_from_api_url(api_url)
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        request_obj = Request(
            models_url,
            headers=headers,
        )
        with urlopen(request_obj, timeout=8) as response:
            data = json.loads(response.read().decode("utf8"))
        raw_models = data.get("data", [])
        return [item["id"] for item in raw_models if isinstance(item, dict) and item.get("id")]
    except Exception:
        return []


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(
        CELERY=dict(
            broker_url="db+sqlite:///celeryresults.sqlite3",
            result_backend="sqlite:///celeryresults.sqlite3",
            task_ignore_result=True,
        ),
    )
    celery_init_app(app)

    @app.before_request
    def bind_device_id():
        if request.path.startswith("/api/"):
            g.device_id = _sanitize_device_id(request.headers.get("X-Device-Id", "anonymous"))
        return None

    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Device-Id"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        response.headers["Vary"] = "Origin"
        return response

    @app.route("/api/<path:_path>", methods=["OPTIONS"])
    def options(_path: str):
        return ("", 204)

    @app.get("/api/health")
    def health():
        return jsonify(
            {
                "success": True,
                "service": "chaoxing-console",
                "state": process_state.state(),
                "device_id": _current_device_id(),
            }
        )

    @app.get("/api/connection")
    def connection():
        return jsonify(
            {
                "success": True,
                "related_project": r"C:\Users\Jamyoung\Desktop\Chaoxing\lin\chaoxing",
                "relationship": [
                    "Both projects share the same Chaoxing api package and main.py command workflow.",
                    "lin/chaoxing adds Flask routes, Socket.IO progress, Vue frontend, auth, accounts, courses, tasks, and config APIs.",
                    "This project now exposes a lighter local Flask API compatible with the React control panel.",
                ],
                "mapped_endpoints": {
                    "lin:/api/auth/login": "current:/api/auth/login",
                    "lin:/api/courses": "current:/api/courses",
                    "lin:/api/config": "current:/api/config",
                    "lin:/api/config/tiku/providers": "current:/api/config/tiku/providers",
                    "lin:/api/tasks/start": "current:/api/tasks/start",
                    "lin:/api/tasks/pause": "current:/api/tasks/pause",
                    "lin:/api/tasks/resume": "current:/api/tasks/resume",
                    "lin:/api/tasks/stop": "current:/api/tasks/stop",
                    "lin:/api/tasks/status": "current:/api/tasks/status",
                    "lin:/api/accounts": "current:/api/accounts",
                    "lin:/api/admin/stats": "current:/api/admin/stats",
                },
            }
        )

    @app.post("/api/auth/login")
    def auth_login():
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", "")).strip()
        login_type = str(payload.get("type", "chaoxing")).strip() or "chaoxing"
        if not username or not password:
            return jsonify({"success": False, "error": "username and password are required"}), 400

        config = _load_config()
        if login_type == "chaoxing":
            config["runtime"]["username"] = username
            config["runtime"]["password"] = password
            _write_config(config)
            account = {
                "id": "local",
                "account_name": _mask_username(username),
                "username": username,
                "loginType": "chaoxing",
            }
            process_state.add_log("info", f"Chaoxing credentials saved for {_mask_username(username)}")
            return jsonify(
                {
                    "success": True,
                    "access_token": "local-dev-token",
                    "refresh_token": "local-dev-refresh-token",
                    "account": account,
                }
            )

        user = {"id": "admin", "username": username, "role": "admin", "loginType": "admin"}
        process_state.add_log("info", f"Admin console login: {username}")
        return jsonify(
            {
                "success": True,
                "access_token": "local-admin-token",
                "refresh_token": "local-admin-refresh-token",
                "user": user,
            }
        )

    @app.post("/api/auth/logout")
    def auth_logout():
        process_state.add_log("info", "Console logout requested")
        return jsonify({"success": True})

    @app.get("/api/auth/me")
    def auth_me():
        config = _load_config()
        username = config["runtime"].get("username", "")
        return jsonify(
            {
                "success": True,
                "user": {
                    "id": "local",
                    "username": username,
                    "account_name": _mask_username(username) if username else "未登录",
                    "loginType": "chaoxing" if username else "guest",
                },
            }
        )

    @app.get("/api/config")
    def get_config():
        config_file = _config_file()
        return jsonify({"success": True, "config": _load_config(), "source": "file" if config_file.exists() else "default"})

    @app.post("/api/config")
    def save_config():
        payload = request.get_json(silent=True) or {}
        _write_config(payload)
        process_state.add_log("info", "Configuration saved to config.ini")
        return jsonify({"success": True, "message": "Configuration saved"})

    @app.get("/api/ai/providers")
    def ai_providers():
        return jsonify(
            {
                "success": True,
                "providers": {
                    "AI": {
                        "name": "OpenAI-compatible API",
                        "config_fields": ["endpoint", "key", "model", "cover_rate", "submit"],
                    },
                    "SiliconFlow": {
                        "name": "SiliconFlow AI",
                        "homepage": "https://cloud.siliconflow.cn/",
                        "config_fields": ["siliconflow_endpoint", "siliconflow_key", "siliconflow_model", "cover_rate", "submit"],
                    },
                },
            }
        )

    @app.get("/api/config/tiku/providers")
    def tiku_providers():
        return jsonify(
            {
                "success": True,
                "providers": {
                    "AI": {
                        "name": "OpenAI-compatible API",
                        "description": "通过 API 地址、Key 与模型名称连接 AI 答题服务",
                        "fields": ["endpoint", "key", "model", "min_interval_seconds"],
                    },
                    "SiliconFlow": {
                        "name": "SiliconFlow",
                        "homepage": "https://cloud.siliconflow.cn/",
                        "fields": ["siliconflow_endpoint", "siliconflow_key", "siliconflow_model"],
                    },
                    "TikuLike": {
                        "name": "TikuLike legacy provider",
                        "fields": ["tokens", "likeapi_search", "likeapi_vision", "likeapi_model"],
                    },
                    "TikuYanxi": {
                        "name": "TikuYanxi legacy provider",
                        "fields": ["tokens"],
                    },
                },
            }
        )

    @app.get("/api/config/notification/providers")
    def notification_providers():
        return jsonify(
            {
                "success": True,
                "providers": {
                    "ServerChan": {"name": "ServerChan", "fields": ["url"]},
                    "PushPlus": {"name": "PushPlus", "fields": ["url"]},
                    "Bark": {"name": "Bark", "fields": ["url"]},
                    "Telegram": {"name": "Telegram", "fields": ["url", "tg_chat_id"]},
                    "Custom": {"name": "Custom Webhook", "fields": ["url"]},
                },
            }
        )

    @app.get("/api/ai/models")
    def ai_models():
        api_url = request.args.get("api_url", "")
        api_key = request.args.get("api_key", "")
        remote_models = _try_remote_models(api_url, api_key)
        models = remote_models or _catalog_models(api_url)
        return jsonify({"success": True, "models": models, "source": "remote" if remote_models else "catalog"})

    @app.get("/api/tasks/status")
    def task_status():
        state = process_state.state()
        logs = list(process_state.logs)
        error_count = len([log for log in logs if log["level"] == "error"])
        return jsonify(
            {
                "success": True,
                "status": {
                    "state": state,
                    "task_id": process_state.task_id,
                    "progress": 65 if state == "running" else (100 if state == "done" else 0),
                    "current": logs[-1]["message"] if logs else "",
                    "errors": error_count,
                },
            }
        )

    @app.post("/api/tasks/start")
    def start_task():
        payload = request.get_json(silent=True) or {}
        if "course_ids" in payload:
            config_payload = _load_config()
            config_payload["runtime"]["courseList"] = ",".join(str(item) for item in payload.get("course_ids", []))
            task_config = payload.get("config", {}) or {}
            if "speed" in task_config:
                config_payload["runtime"]["speed"] = task_config["speed"]
            if "jobs" in task_config:
                config_payload["runtime"]["jobs"] = task_config["jobs"]
            if "notopen_action" in task_config:
                config_payload["runtime"]["notopenAction"] = task_config["notopen_action"]
        else:
            config_payload = payload

        _write_config(config_payload)
        config_file = _config_file()
        course_list = config_payload.get("runtime", {}).get("courseList", "")
        if not course_list:
            return jsonify({"success": False, "error": "courseList is required"}), 400

        state = _state()
        with state.lock:
            if state.process and state.process.poll() is None:
                return jsonify({"success": False, "error": "task is already running"}), 409

            import uuid

            state.task_id = str(uuid.uuid4())
            task_id = state.task_id
            state.add_log("info", f"Starting task {task_id}")
            child_env = {
                **os.environ,
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
            }
            state.process = subprocess.Popen(
                [sys.executable, str(ROOT / "main.py"), "-c", str(config_file)],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=child_env,
            )
            process = state.process

            def pump_logs() -> None:
                assert process is not None
                assert process.stdout is not None
                for raw_line in process.stdout:
                    line = _decode_process_line(raw_line)
                    level = _log_level_from_line(line)
                    state.add_log(level, line)
                code = process.wait()
                state.add_log("info" if code == 0 else "error", f"Process exited with code {code}")

            threading.Thread(target=pump_logs, daemon=True).start()

        return jsonify({"success": True, "task_id": task_id, "message": "Task started"})

    @app.post("/api/tasks/pause")
    def pause_task():
        process_state.add_log("warn", "Pause requested from console. The local subprocess backend records the request but cannot suspend main.py safely.")
        return jsonify({"success": True, "message": "Pause request recorded"})

    @app.post("/api/tasks/resume")
    def resume_task():
        process_state.add_log("info", "Resume requested from console")
        return jsonify({"success": True, "message": "Resume request recorded"})

    @app.post("/api/tasks/stop")
    def stop_task():
        with process_state.lock:
            if process_state.process and process_state.process.poll() is None:
                process_state.process.terminate()
                process_state.add_log("warn", "Stop requested from console")
                return jsonify({"success": True, "message": "Task stop requested"})
        return jsonify({"success": True, "message": "No running task"})

    @app.get("/api/logs")
    def logs():
        return jsonify({"success": True, "logs": list(process_state.logs)})

    @app.get("/api/tasks/history")
    def task_history():
        return jsonify(
            {
                "success": True,
                "tasks": [
                    {
                        "id": process_state.task_id or "local",
                        "state": process_state.state(),
                        "started_at": datetime.now().isoformat(timespec="seconds"),
                        "log_count": len(process_state.logs),
                    }
                ]
                if process_state.task_id
                else [],
            }
        )

    @app.get("/api/accounts")
    def list_accounts():
        return jsonify({"success": True, "accounts": _load_accounts()})

    @app.post("/api/accounts")
    def create_account():
        payload = request.get_json(silent=True) or {}
        account_name = str(payload.get("account_name") or payload.get("name") or "").strip()
        username = str(payload.get("username", "")).strip()
        if not account_name or not username:
            return jsonify({"success": False, "error": "account_name and username are required"}), 400
        accounts = _load_accounts()
        account = {
            "id": max([int(item.get("id", 0)) for item in accounts] or [0]) + 1,
            "account_name": account_name,
            "username": username,
            "is_active": not accounts,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }
        accounts.append(account)
        _write_accounts(accounts)
        process_state.add_log("info", f"Account added: {account_name}")
        return jsonify({"success": True, "account": account})

    @app.put("/api/accounts/<int:account_id>")
    def update_account(account_id: int):
        payload = request.get_json(silent=True) or {}
        accounts = _load_accounts()
        for account in accounts:
            if int(account.get("id", 0)) == account_id:
                account["account_name"] = str(payload.get("account_name", account.get("account_name", "")))
                account["username"] = str(payload.get("username", account.get("username", "")))
                _write_accounts(accounts)
                return jsonify({"success": True, "account": account})
        return jsonify({"success": False, "error": "account not found"}), 404

    @app.delete("/api/accounts/<int:account_id>")
    def delete_account(account_id: int):
        accounts = _load_accounts()
        next_accounts = [account for account in accounts if int(account.get("id", 0)) != account_id]
        if len(next_accounts) == len(accounts):
            return jsonify({"success": False, "error": "account not found"}), 404
        _write_accounts(next_accounts)
        process_state.add_log("warn", f"Account deleted: {account_id}")
        return jsonify({"success": True})

    @app.get("/api/accounts/<int:account_id>/status")
    def account_status(account_id: int):
        account = next((item for item in _load_accounts() if int(item.get("id", 0)) == account_id), None)
        if not account:
            return jsonify({"success": False, "error": "account not found"}), 404
        config = _load_config()
        logged_in = account.get("username") == config["runtime"].get("username") and bool(config["runtime"].get("password"))
        return jsonify({"success": True, "logged_in": logged_in, "message": "当前账号已写入任务配置" if logged_in else "尚未写入任务配置"})

    @app.get("/api/courses")
    def list_courses():
        try:
            chaoxing = _get_chaoxing_client()
            courses = [_normalize_course(course) for course in chaoxing.get_course_list()]
            return jsonify({"success": True, "courses": courses})
        except Exception as exc:
            process_state.add_log("error", f"Failed to load courses: {exc}")
            return jsonify({"success": False, "error": str(exc), "courses": []}), 400

    @app.get("/api/courses/<course_id>")
    def get_course(course_id: str):
        try:
            chaoxing = _get_chaoxing_client()
            courses = [_normalize_course(course) for course in chaoxing.get_course_list()]
            course = next((item for item in courses if str(item["courseId"]) == str(course_id)), None)
            if not course:
                return jsonify({"success": False, "error": "course not found"}), 404
            return jsonify({"success": True, "course": course})
        except Exception as exc:
            return jsonify({"success": False, "error": str(exc)}), 400

    @app.get("/api/courses/<course_id>/points")
    def get_course_points(course_id: str):
        try:
            chaoxing = _get_chaoxing_client()
            courses = [_normalize_course(course) for course in chaoxing.get_course_list()]
            course = next((item for item in courses if str(item["courseId"]) == str(course_id)), None)
            if not course:
                return jsonify({"success": False, "error": "course not found", "points": []}), 404
            points = chaoxing.get_course_point(course["courseId"], course["clazzId"], course["cpi"])
            return jsonify({"success": True, "points": points})
        except Exception as exc:
            process_state.add_log("error", f"Failed to load course points: {exc}")
            return jsonify({"success": False, "error": str(exc), "points": []}), 400

    @app.get("/api/admin/stats")
    def admin_stats():
        config = _load_config()
        accounts = _load_accounts()
        return jsonify(
            {
                "success": True,
                "stats": {
                    "accounts": len(accounts),
                    "configured_courses": len([item for item in config["runtime"].get("courseList", "").split(",") if item.strip()]),
                    "task_state": process_state.state(),
                    "logs": len(process_state.logs),
                    "ai_provider": config["tiku"].get("provider", ""),
                    "notification_provider": config["notification"].get("provider", ""),
                },
            }
        )

    @app.get("/")
    def serve_index():
        index_file = FRONTEND_DIST / "index.html"
        if not index_file.exists():
            return jsonify({"success": False, "error": "frontend dist not found. Run npm run build in frontend first."}), 503
        return send_from_directory(FRONTEND_DIST, "index.html")

    @app.get("/<path:path>")
    def serve_frontend(path: str):
        if path.startswith("api/"):
            abort(404)

        target = FRONTEND_DIST / path
        if target.exists() and target.is_file():
            return send_from_directory(FRONTEND_DIST, path)

        index_file = FRONTEND_DIST / "index.html"
        if not index_file.exists():
            return jsonify({"success": False, "error": "frontend dist not found. Run npm run build in frontend first."}), 503
        return send_from_directory(FRONTEND_DIST, "index.html")

    return app


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chaoxing local console backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=5000, type=int)
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    create_app().run(host=args.host, port=args.port, debug=args.debug, threaded=True)
