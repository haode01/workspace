"""
AI Desktop Assistant —— 应用入口 (Flask Web GUI)
启动流程: 加载配置 → 初始化数据层 → 初始化 AI → 初始化 Service → 加载插件 → 启动 Web 服务
"""

import sys
import os
import logging
import webbrowser
import threading

# Windows 控制台 UTF-8
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 确保项目根目录在 sys.path 中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import load_config, DATA_DIR, PLUGINS_DIR


def _setup_logging():
    """配置全局日志: 同时输出到控制台和文件, 方便分析功能调用链路"""
    log_dir = os.path.join(DATA_DIR, "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "app.log")

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 文件handler (DEBUG级别, 记录全部)
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(fmt)

    # 控制台handler (INFO级别)
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)

    root = logging.getLogger()
    root.setLevel(logging.DEBUG)
    root.addHandler(fh)
    root.addHandler(ch)

    # 抑制第三方库的噪音
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    logging.getLogger(__name__).info("日志系统初始化完成, 日志文件: %s", log_file)

from data.database import Database
from ai.ai_client import AIClient
from ai.rag_engine import RAGEngine
from services.todo_service import TodoService
from services.knowledge_service import KnowledgeService
from services.graph_service import GraphService
from services.tool_service import ToolService
from plugins.plugin_manager import PluginManager
from web.app import create_app

HOST = "0.0.0.0"
PORT = 8888


def main():
    # ── 0. 日志 ──
    _setup_logging()

    # ── 1. 配置 ──
    config = load_config()

    # ── 2. 数据层 ──
    db = Database(os.path.join(DATA_DIR, "app.db"))

    # ── 3. AI 层 ──
    ai_client = AIClient(config)
    rag_engine = RAGEngine(os.path.join(DATA_DIR, "rag_store"))

    # ── 4. Service 层 ──
    todo_service = TodoService(db)
    knowledge_service = KnowledgeService(db, rag_engine)
    graph_service = GraphService(db, config)

    # ── 4.5 工具管理 ──
    tool_service = ToolService(db)

    # ── 5. 插件 ──
    plugin_manager = PluginManager(PLUGINS_DIR)

    # ── 5.5 工作流引擎 ──
    import plugins.workflow.builtin_nodes  # 注册内置节点
    from plugins.workflow.engine import WorkflowEngine
    workflow_engine = WorkflowEngine()

    # ── 5.6 Patch 服务 ──
    from services.patch_service import PatchService
    patch_service = PatchService(knowledge_service=knowledge_service, ai_client=ai_client)

    # 构建全局上下文
    app_context = {
        "config": config,
        "db": db,
        "ai_client": ai_client,
        "rag_engine": rag_engine,
        "todo_service": todo_service,
        "knowledge_service": knowledge_service,
        "graph_service": graph_service,
        "tool_service": tool_service,
        "plugin_manager": plugin_manager,
        "workflow_engine": workflow_engine,
        "patch_service": patch_service,
    }
    workflow_engine.app_context = app_context

    plugin_manager.load_plugins(app_context)

    # ── 6. Web 服务 ──
    app = create_app(app_context)

    # 自动打开浏览器
    threading.Timer(1.5, lambda: webbrowser.open(f"http://{HOST}:{PORT}")).start()

    print(f"\n  🤖 AI Desktop Assistant 已启动")
    print(f"  🌐 http://{HOST}:{PORT}\n")

    try:
        app.run(host=HOST, port=PORT, debug=False)
    finally:
        db.close()
        graph_service.close()


if __name__ == "__main__":
    main()
