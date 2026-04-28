"""主窗口 —— 左侧导航栏 + 右侧 StackedWidget 内容区"""

from PySide6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QStackedWidget, QLabel,
)
from PySide6.QtCore import Qt

from ui.styles import DARK_STYLE, LIGHT_STYLE
from ui.todo_widget import TodoWidget
from ui.knowledge_widget import KnowledgeWidget
from ui.graph_widget import GraphWidget
from ui.plugin_widget import PluginWidget
from ui.todo_floating import TodoFloatingWindow


class MainWindow(QMainWindow):
    def __init__(self, app_context: dict):
        super().__init__()
        self.ctx = app_context
        self.dark_mode = app_context["config"].get("dark_mode", True)
        self.setWindowTitle("AI Desktop Assistant")
        self.setMinimumSize(1100, 700)
        self.resize(1200, 800)

        self._floating_todo = None
        self._nav_buttons: list[tuple[QPushButton, str]] = []
        self._init_ui()
        self._apply_style()

    # ────────────────── 界面构建 ──────────────────
    def _init_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # ── 侧边栏 ──
        sidebar = QWidget()
        sidebar.setObjectName("sidebar")
        sidebar.setFixedWidth(220)
        sb = QVBoxLayout(sidebar)
        sb.setContentsMargins(12, 20, 12, 20)
        sb.setSpacing(4)

        app_title = QLabel("🤖 AI Assistant")
        app_title.setProperty("heading", True)
        app_title.setStyleSheet("font-size:18px;padding:8px 0 20px 4px;")
        sb.addWidget(app_title)

        # 页面栈
        self.stack = QStackedWidget()
        self.todo_page = TodoWidget(self.ctx)
        self.knowledge_page = KnowledgeWidget(self.ctx)
        self.graph_page = GraphWidget(self.ctx)
        self.plugin_page = PluginWidget(self.ctx)
        self.stack.addWidget(self.todo_page)       # 0
        self.stack.addWidget(self.knowledge_page)  # 1
        self.stack.addWidget(self.graph_page)      # 2
        self.stack.addWidget(self.plugin_page)     # 3

        # 内置导航项
        nav_items: list[tuple[str, str]] = [
            ("📋  待办事项", "todo"),
            ("📚  知识库", "knowledge"),
            ("🔗  知识图谱", "graph"),
            ("🧩  插件", "plugins"),
        ]

        # 动态添加插件自带的 UI 页面
        for plugin in self.ctx["plugin_manager"].get_plugins():
            try:
                w = plugin.get_ui_component()
                if w:
                    self.stack.addWidget(w)
                    nav_items.append((f"🔌  {plugin.get_name()}", f"_plugin_{id(plugin)}"))
            except Exception:
                pass

        # 生成导航按钮
        for idx, (text, key) in enumerate(nav_items):
            btn = QPushButton(text)
            btn.setCheckable(True)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.clicked.connect(lambda _checked, i=idx: self._navigate(i))
            self._nav_buttons.append((btn, key))
            sb.addWidget(btn)

        sb.addStretch()

        # 主题切换
        self.theme_btn = QPushButton("🌙 暗黑模式" if self.dark_mode else "☀️ 明亮模式")
        self.theme_btn.setProperty("ghost", True)
        self.theme_btn.clicked.connect(self._toggle_theme)
        sb.addWidget(self.theme_btn)

        # 悬浮待办
        float_btn = QPushButton("📌 悬浮待办")
        float_btn.setProperty("ghost", True)
        float_btn.clicked.connect(self._show_floating_todo)
        sb.addWidget(float_btn)

        root.addWidget(sidebar)
        root.addWidget(self.stack, 1)

        # 默认选中第一个
        if self._nav_buttons:
            self._nav_buttons[0][0].setChecked(True)
            self._nav_buttons[0][0].setProperty("active", True)

    # ────────────────── 导航切换 ──────────────────
    def _navigate(self, index: int):
        self.stack.setCurrentIndex(index)
        for i, (btn, _) in enumerate(self._nav_buttons):
            active = i == index
            btn.setChecked(active)
            btn.setProperty("active", active)
            btn.style().unpolish(btn)
            btn.style().polish(btn)

    # ────────────────── 主题切换 ──────────────────
    def _toggle_theme(self):
        self.dark_mode = not self.dark_mode
        self.ctx["config"]["dark_mode"] = self.dark_mode
        self.theme_btn.setText("🌙 暗黑模式" if self.dark_mode else "☀️ 明亮模式")
        self._apply_style()

    def _apply_style(self):
        style = DARK_STYLE if self.dark_mode else LIGHT_STYLE
        self.setStyleSheet(style)
        if self._floating_todo:
            self._floating_todo.setStyleSheet(style)

    # ────────────────── 悬浮窗 ──────────────────
    def _show_floating_todo(self):
        if self._floating_todo is None:
            self._floating_todo = TodoFloatingWindow(self.ctx)
            self._floating_todo.setStyleSheet(
                DARK_STYLE if self.dark_mode else LIGHT_STYLE
            )
        self._floating_todo.show()
        self._floating_todo.raise_()
        self._floating_todo.activateWindow()

    # ────────────────── 关闭事件 ──────────────────
    def closeEvent(self, event):
        if self._floating_todo:
            self._floating_todo.close()
        from config import save_config
        save_config(self.ctx["config"])
        event.accept()
