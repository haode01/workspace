"""内置工作流节点 —— Input / Output / Button / Timer / Script / AI"""

import os
import re
import logging
from typing import Any, Dict, Optional
from plugins.workflow.node_base import WorkflowNode, NodeRegistry
from plugins.workflow.tools import ToolRegistry

logger = logging.getLogger(__name__)

# 每个执行节点的输出文件存放目录
WORKFLOW_OUTPUT_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "store", "workflows", "node_output")
os.makedirs(WORKFLOW_OUTPUT_DIR, exist_ok=True)


def _get_node_output_path(node_id: str) -> str:
    """返回节点专属输出文件路径"""
    safe_id = re.sub(r'[^\w\-]', '_', node_id)
    return os.path.join(WORKFLOW_OUTPUT_DIR, f"{safe_id}.txt")


def _resolve_placeholders(params: dict, input_data: Any, extra_mapping: dict = None) -> dict:
    """将工具参数中的 {1}, {2} ... 以及 {out} 占位符替换为实际值。
    input_data 为 dict {idx: value} 或单个值 (视为 {1: value})。
    extra_mapping: 额外的命名占位符, 如 {"out": "/path/to/file"}
    """
    extra_mapping = extra_mapping or {}

    # 统一数字占位符为 {int: str} 映射
    num_mapping: Dict[int, str] = {}
    if input_data is not None:
        if isinstance(input_data, dict):
            num_mapping = {int(k): str(v) if v is not None else '' for k, v in input_data.items()}
        else:
            num_mapping = {1: str(input_data)}

    resolved = {}
    placeholder_re = re.compile(r'\{(\w+)\}')
    for key, val in params.items():
        if isinstance(val, str) and placeholder_re.search(val):
            def _replacer(m):
                token = m.group(1)
                # 命名占位符: {out} 等
                if token in extra_mapping:
                    return extra_mapping[token]
                # 数字占位符: {1}, {2} ...
                if token.isdigit():
                    return num_mapping.get(int(token), m.group(0))
                return m.group(0)
            resolved[key] = placeholder_re.sub(_replacer, val)
        else:
            resolved[key] = val
    return resolved


def _run_tool_with_output_file(node_id: str, tool_name: str, raw_params: dict,
                                input_data: Any, config: dict) -> str:
    """执行工具的通用逻辑:
    1) 清空节点输出文件  2) 替换占位符  3) 执行  4) 合并 stdout + 文件输出
    """
    out_path = _get_node_output_path(node_id)
    # 1. 清空输出文件
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('')

    # 2. 占位符替换 (  {1}{2}... + {out}  )
    params = _resolve_placeholders(raw_params, input_data,
                                   extra_mapping={"out": out_path})

    # 3. 无占位符时的兼容逻辑: 单个字符串输入填入第一个参数
    if input_data is not None and not isinstance(input_data, dict):
        has_placeholder = any('{' in str(v) for v in config.get("tool_params", {}).values())
        if not has_placeholder and isinstance(input_data, str) and input_data:
            schema = ToolRegistry.get(tool_name)
            if schema and schema.get("params_schema"):
                first_key = schema["params_schema"][0]["name"]
                if tool_name == "shell":
                    cmd = params.get("command", "")
                    params["command"] = f"{cmd} {input_data}".strip()
                else:
                    params[first_key] = input_data

    # 4. 执行工具 (shell 工具注入 _output_file 实现实时输出)
    if tool_name == 'shell':
        params['_output_file'] = out_path
    try:
        stdout_result = ToolRegistry.execute(tool_name, params)
    except Exception as e:
        return f"[ToolError] {e}"

    # 5. 读取输出文件 (非 shell 工具, 或用户命令中显式写了 {out})
    stdout_str = (stdout_result or '').strip() if stdout_result else ''

    # shell 工具已经通过 _output_file 实时写入了, 直接用 stdout 即可
    # 但如果用户的命令里用了 > {out} 重定向, stdout 可能为空, 此时从文件读取
    file_output = ''
    try:
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            with open(out_path, 'r', encoding='utf-8', errors='replace') as f:
                file_output = f.read().strip()
    except Exception:
        pass

    # 6. 合并输出
    if tool_name == 'shell' and file_output and not stdout_str:
        # 用户用了 > {out} 重定向, stdout 为空, 用文件内容
        return file_output
    elif stdout_str:
        return stdout_str
    elif file_output:
        return file_output
    else:
        return '(无输出)'


# ═══════════════════════════════════
#  1. 输入框节点
# ═══════════════════════════════════
@NodeRegistry.register
class InputNode(WorkflowNode):
    name = "input"
    node_type = "input"
    description = "用户输入文本，作为数据流起点"
    default_config = {"value": "", "label": "输入"}

    def run(self, input_data: Any = None) -> Any:
        self.last_output = self.config.get("value", "")
        return self.last_output


# ═══════════════════════════════════
#  2. 输出框节点
# ═══════════════════════════════════
@NodeRegistry.register
class OutputNode(WorkflowNode):
    name = "output"
    node_type = "output"
    description = "展示处理结果"
    default_config = {"label": "输出"}

    def run(self, input_data: Any = None) -> Any:
        self.last_output = input_data
        return self.last_output


# ═══════════════════════════════════
#  3. 按钮节点 — 绑定服务器工具
# ═══════════════════════════════════
@NodeRegistry.register
class ButtonNode(WorkflowNode):
    name = "button"
    node_type = "trigger"
    description = "绑定服务器工具，点击执行。参数可用 {1}{2}… 引用输入，{out} 引用输出文件"
    default_config = {"label": "执行", "tool": "", "tool_params": {}}

    def run(self, input_data: Any = None) -> Any:
        tool_name = self.config.get("tool", "")
        if not tool_name:
            self.last_output = input_data if input_data is not None else "(未绑定工具)"
            return self.last_output
        raw_params = dict(self.config.get("tool_params", {}))
        self.last_output = _run_tool_with_output_file(
            self.node_id, tool_name, raw_params, input_data, self.config)
        return self.last_output


# ═══════════════════════════════════
#  4. 定时器节点 — 服务器端周期运行绑定工具
# ═══════════════════════════════════
@NodeRegistry.register
class TimerNode(WorkflowNode):
    name = "timer"
    node_type = "trigger"
    description = "定时执行服务器工具。参数可用 {1}{2}… 引用输入，{out} 引用输出文件"
    default_config = {"interval": 5, "label": "定时器", "tool": "", "tool_params": {}}

    def run(self, input_data: Any = None) -> Any:
        tool_name = self.config.get("tool", "")
        if not tool_name:
            self.last_output = "tick"
            return self.last_output
        raw_params = dict(self.config.get("tool_params", {}))
        self.last_output = _run_tool_with_output_file(
            self.node_id, tool_name, raw_params, input_data, self.config)
        return self.last_output


# ═══════════════════════════════════
#  5. 脚本节点 — JavaScript, 在浏览器端执行
#     服务器端直接透传数据
# ═══════════════════════════════════
@NodeRegistry.register
class ScriptNode(WorkflowNode):
    name = "script"
    node_type = "processor"
    description = "JavaScript 条件检测 (浏览器端执行)"
    default_config = {
        "code": '// input 为上游输出\n// 返回 true 则触发下游\nreturn input && input.includes("error");',
        "label": "脚本",
    }

    def run(self, input_data: Any = None) -> Any:
        # 服务器端透传: JS 脚本由前端在轮询时执行
        self.last_output = input_data
        return self.last_output


# ═══════════════════════════════════
#  6. AI 问答节点
# ═══════════════════════════════════
@NodeRegistry.register
class AiNode(WorkflowNode):
    name = "ai"
    node_type = "processor"
    description = "调用 AI 模型处理输入"
    default_config = {
        "system_prompt": "你是一个有用的助手，请用中文回答。",
        "label": "AI",
    }
    _app_context = None

    def run(self, input_data: Any = None) -> Any:
        logger.info("[AiNode] run called, input_data=%s, _app_context=%s",
                     str(input_data)[:200], bool(self._app_context))
        if not self._app_context:
            self.last_output = "[Error] AI 未初始化 (_app_context 为空)"
            return self.last_output
        ai = self._app_context.get("ai_client")
        if not ai:
            self.last_output = "[Error] AI 客户端不存在"
            return self.last_output
        if not ai.is_configured():
            self.last_output = "[Error] AI 未配置 (请先在设置中配置 API Key)"
            return self.last_output
        try:
            prompt = str(input_data or "")
            system = self.config.get("system_prompt", "")
            logger.info("[AiNode] calling generate_text, prompt=%s, system=%s",
                         prompt[:100], system[:100])
            resp = ai.generate_text(prompt, system=system)
            self.last_output = resp
            logger.info("[AiNode] response=%s", str(resp)[:200])
        except Exception as e:
            logger.error("[AiNode] error: %s", e, exc_info=True)
            self.last_output = f"[AIError] {e}"
        return self.last_output
