"""工作流工具注册中心 —— 可绑定到按钮/定时器节点的服务器端工具"""

import os
import time
import subprocess
import logging

logger = logging.getLogger(__name__)


class ToolRegistry:
    """工具注册中心: 管理所有可被节点绑定的服务器端工具"""

    _tools = {}

    @classmethod
    def register(cls, name, func, description="", params_schema=None):
        cls._tools[name] = {
            "func": func,
            "description": description,
            "params_schema": params_schema or [],
        }

    @classmethod
    def unregister(cls, name):
        cls._tools.pop(name, None)

    @classmethod
    def execute(cls, name, params=None):
        tool = cls._tools.get(name)
        if not tool:
            raise ValueError(f"Unknown tool: {name}")
        return tool["func"](params or {})

    @classmethod
    def list_tools(cls):
        return [
            {"name": k, "description": v["description"], "params": v["params_schema"]}
            for k, v in cls._tools.items()
        ]

    @classmethod
    def get(cls, name):
        return cls._tools.get(name)


# ═══════════════════════════════════
#  内置工具
# ═══════════════════════════════════

def _ping(params):
    """Ping 指定主机"""
    host = params.get("host", "127.0.0.1")
    count = int(params.get("count", 4))
    flag = "-n" if os.name == "nt" else "-c"
    try:
        result = subprocess.run(
            ["ping", flag, str(count), host],
            capture_output=True, text=True, timeout=30,
            encoding="gbk" if os.name == "nt" else "utf-8",
            errors="replace",
        )
        return result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return "[Timeout] ping 超时"
    except Exception as e:
        return f"[Error] {e}"


ToolRegistry.register("ping", _ping, "Ping 主机", [
    {"name": "host", "type": "string", "default": "127.0.0.1", "label": "主机地址"},
    {"name": "count", "type": "number", "default": 4, "label": "次数"},
])


def _shell(params):
    """执行 Shell/CMD 命令, 支持实时输出到文件"""
    cmd = params.get("command", "echo hello")
    timeout = int(params.get("timeout", 30))
    output_file = params.get("_output_file")  # 内部参数: 实时写入的文件路径
    proc = None
    try:
        enc = "gbk" if os.name == "nt" else "utf-8"
        proc = subprocess.Popen(
            cmd, shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            bufsize=1,               # 行缓冲
            encoding=enc, errors="replace",
        )
        lines = []
        deadline = time.time() + timeout
        for line in iter(proc.stdout.readline, ''):
            if not line:
                break
            lines.append(line)
            # 实时写入输出文件
            if output_file:
                try:
                    with open(output_file, 'a', encoding='utf-8') as f:
                        f.write(line)
                        f.flush()
                except Exception:
                    pass
            # 超时检查
            if time.time() > deadline:
                proc.kill()
                lines.append(f"\n[Timeout] 命令执行超过 {timeout}s\n")
                break
        proc.stdout.close()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        return ''.join(lines)
    except Exception as e:
        if proc:
            try:
                proc.kill()
            except Exception:
                pass
        return f"[Error] {e}"


ToolRegistry.register("shell", _shell, "执行 Shell 命令", [
    {"name": "command", "type": "string", "default": "echo hello", "label": "命令"},
    {"name": "timeout", "type": "number", "default": 30, "label": "超时(秒)"},
])


def _http_request(params):
    """发送 HTTP 请求"""
    import urllib.request
    import urllib.error
    url = params.get("url", "")
    method = params.get("method", "GET").upper()
    if not url:
        return "[Error] URL 不能为空"
    try:
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return f"Status: {resp.status}\n{body[:5000]}"
    except Exception as e:
        return f"[Error] {e}"


ToolRegistry.register("http_request", _http_request, "HTTP 请求", [
    {"name": "url", "type": "string", "default": "", "label": "URL"},
    {"name": "method", "type": "string", "default": "GET", "label": "方法 (GET/POST)"},
])


def _read_file(params):
    """读取文件内容"""
    path = params.get("path", "")
    if not path:
        return "[Error] 路径不能为空"
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()[:10000]
    except Exception as e:
        return f"[Error] {e}"


ToolRegistry.register("read_file", _read_file, "读取文件", [
    {"name": "path", "type": "string", "default": "", "label": "文件路径"},
])


def _list_dir(params):
    """列出目录内容"""
    path = params.get("path", ".")
    try:
        items = os.listdir(path)
        return "\n".join(items[:200])
    except Exception as e:
        return f"[Error] {e}"


ToolRegistry.register("list_dir", _list_dir, "列出目录", [
    {"name": "path", "type": "string", "default": ".", "label": "目录路径"},
])
