"""待办事项主页面 —— 卡片式任务列表 + 优先级 + AI智能规划"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QComboBox, QScrollArea, QCheckBox, QFrame, QTextEdit,
)
from PySide6.QtCore import Qt


class TodoCard(QFrame):
    """单条任务卡片"""

    PRIORITY_COLORS = {1: "#f38ba8", 2: "#fab387", 3: "#a6e3a1"}
    PRIORITY_LABELS = {1: "高", 2: "中", 3: "低"}

    def __init__(self, task: dict, on_complete, on_delete, on_pin):
        super().__init__()
        self.setStyleSheet(
            "TodoCard { background-color: rgba(49,50,68,0.6); border-radius: 10px; }"
        )
        layout = QHBoxLayout(self)
        layout.setContentsMargins(14, 10, 14, 10)

        # 完成复选框
        cb = QCheckBox()
        cb.setChecked(bool(task.get("completed")))
        cb.stateChanged.connect(lambda: on_complete(task["id"]))
        layout.addWidget(cb)

        # 优先级徽章
        p = task.get("priority", 2)
        badge = QLabel(self.PRIORITY_LABELS.get(p, "中"))
        badge.setFixedWidth(28)
        badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
        badge.setStyleSheet(
            f"background-color:{self.PRIORITY_COLORS.get(p,'#fab387')};"
            "color:#1e1e2e;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:bold;"
        )
        layout.addWidget(badge)

        # 标题
        title = QLabel(task["title"])
        title.setWordWrap(True)
        if task.get("completed"):
            title.setStyleSheet("text-decoration:line-through;color:#6c7086;")
        layout.addWidget(title, 1)

        # 置顶
        pin_btn = QPushButton("📌" if not task.get("pinned") else "📍")
        pin_btn.setFixedSize(30, 30)
        pin_btn.setToolTip("置顶/取消置顶")
        pin_btn.setStyleSheet("background:transparent;border:none;font-size:14px;")
        pin_btn.clicked.connect(lambda: on_pin(task["id"]))
        layout.addWidget(pin_btn)

        # 删除
        del_btn = QPushButton("🗑")
        del_btn.setFixedSize(30, 30)
        del_btn.setToolTip("删除")
        del_btn.setStyleSheet("background:transparent;border:none;font-size:14px;")
        del_btn.clicked.connect(lambda: on_delete(task["id"]))
        layout.addWidget(del_btn)


class TodoWidget(QWidget):
    """待办事项页面"""

    def __init__(self, ctx: dict):
        super().__init__()
        self.ctx = ctx
        self.todo_service = ctx["todo_service"]
        self.ai_client = ctx["ai_client"]
        self._init_ui()
        self._refresh()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 24, 32, 24)
        layout.setSpacing(16)

        # 标题栏
        header = QHBoxLayout()
        title = QLabel("📋 待办事项")
        title.setProperty("heading", True)
        header.addWidget(title)
        header.addStretch()
        ai_btn = QPushButton("✨ 智能规划")
        ai_btn.clicked.connect(self._ai_suggest)
        header.addWidget(ai_btn)
        layout.addLayout(header)

        # 添加任务栏
        add_bar = QHBoxLayout()
        self.task_input = QLineEdit()
        self.task_input.setPlaceholderText("输入新任务...")
        self.task_input.returnPressed.connect(self._add_task)
        add_bar.addWidget(self.task_input, 1)

        self.priority_combo = QComboBox()
        self.priority_combo.addItems(["🔴 高优先", "🟡 中优先", "🟢 低优先"])
        self.priority_combo.setCurrentIndex(1)
        self.priority_combo.setFixedWidth(110)
        add_bar.addWidget(self.priority_combo)

        add_btn = QPushButton("+ 添加")
        add_btn.clicked.connect(self._add_task)
        add_bar.addWidget(add_btn)
        layout.addLayout(add_bar)

        # 可滚动任务列表
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setStyleSheet("QScrollArea{border:none;background:transparent;}")
        self.task_container = QWidget()
        self.task_layout = QVBoxLayout(self.task_container)
        self.task_layout.setContentsMargins(0, 0, 0, 0)
        self.task_layout.setSpacing(8)
        self.task_layout.addStretch()
        scroll.setWidget(self.task_container)
        layout.addWidget(scroll, 1)

        # AI 输出区
        self.ai_output = QTextEdit()
        self.ai_output.setPlaceholderText("AI 建议将显示在此处...")
        self.ai_output.setMaximumHeight(140)
        self.ai_output.setReadOnly(True)
        layout.addWidget(self.ai_output)

    # ────────── 刷新列表 ──────────
    def _refresh(self):
        while self.task_layout.count() > 1:
            item = self.task_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for task in self.todo_service.get_tasks():
            card = TodoCard(task, self._complete, self._delete, self._pin)
            self.task_layout.insertWidget(self.task_layout.count() - 1, card)

    def _add_task(self):
        title = self.task_input.text().strip()
        if not title:
            return
        priority = self.priority_combo.currentIndex() + 1
        self.todo_service.add_task(title, priority)
        self.task_input.clear()
        self._refresh()

    def _complete(self, tid):
        self.todo_service.complete_task(tid)
        self._refresh()

    def _delete(self, tid):
        self.todo_service.delete_task(tid)
        self._refresh()

    def _pin(self, tid):
        self.todo_service.toggle_pin(tid)
        self._refresh()

    def _ai_suggest(self):
        if not self.ai_client.is_configured():
            self.ai_output.setText("⚠️ 请先在 data/store/config.json 中配置 api_key")
            return
        try:
            history = self.todo_service.get_history(30)
            current = self.todo_service.get_tasks()
            result = self.ai_client.generate_todo_suggestions(current + history)
            self.ai_output.setText(result)
        except Exception as e:
            self.ai_output.setText(f"❌ AI 调用失败: {e}")
