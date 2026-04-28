"""示例插件 —— 展示如何访问 AI 接口、知识库、知识图谱"""

import sys
import os

# 确保项目根目录在 sys.path 中，以便导入 PluginBase
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from plugins.plugin_base import PluginBase


class ExamplePlugin(PluginBase):
    def __init__(self):
        self.ctx = None

    def init(self, app_context: dict):
        self.ctx = app_context

    def get_name(self) -> str:
        return "示例插件"

    def get_ui_component(self):
        return None

    def execute(self):
        lines = ["✅ 插件系统运行正常!", "", "可用的 app_context 键:"]
        for key in self.ctx:
            lines.append(f"  - {key}")

        if "todo_service" in self.ctx:
            tasks = self.ctx["todo_service"].get_tasks()
            lines.append(f"\n📋 当前待办事项数: {len(tasks)}")

        if "knowledge_service" in self.ctx:
            docs = self.ctx["knowledge_service"].get_documents()
            lines.append(f"📚 知识库文档数: {len(docs)}")

        if "graph_service" in self.ctx:
            triples = self.ctx["graph_service"].get_all_triples()
            lines.append(f"🔗 知识图谱三元组数: {len(triples)}")

        return "\n".join(lines)
