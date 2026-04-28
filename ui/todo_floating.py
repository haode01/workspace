"""悬浮待办小窗口 —— 无边框、置顶、可拖拽"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QCheckBox, QScrollArea,
)
from PySide6.QtCore import Qt


class TodoFloatingWindow(QWidget):
    def __init__(self, ctx: dict):
        super().__init__(None)
        self.ctx = ctx
        self.todo_service = ctx["todo_service"]
        self.setObjectName("floatingTodo")
        self.setWindowTitle("待办事项")
        self.setWindowFlags(
            Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.Tool
        )
        self.setFixedSize(320, 420)
        self._drag_pos = None
        self._init_ui()
        self._refresh()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(8)

        # 标题栏
        bar = QHBoxLayout()
        title = QLabel("📋 待办事项")
        title.setStyleSheet("font-size:15px;font-weight:bold;")
        bar.addWidget(title)
        bar.addStretch()
        close_btn = QPushButton("✕")
        close_btn.setFixedSize(28, 28)
        close_btn.setStyleSheet(
            "QPushButton{background:transparent;border:none;font-size:16px;color:#a6adc8;}"
            "QPushButton:hover{color:#f38ba8;}"
        )
        close_btn.clicked.connect(self.hide)
        bar.addWidget(close_btn)
        layout.addLayout(bar)

        # 添加栏
        input_bar = QHBoxLayout()
        self.input = QLineEdit()
        self.input.setPlaceholderText("添加任务...")
        self.input.returnPressed.connect(self._add_task)
        input_bar.addWidget(self.input, 1)
        add_btn = QPushButton("+")
        add_btn.setFixedSize(32, 32)
        add_btn.clicked.connect(self._add_task)
        input_bar.addWidget(add_btn)
        layout.addLayout(input_bar)

        # 列表
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setStyleSheet("QScrollArea{border:none;background:transparent;}")
        self.list_container = QWidget()
        self.list_layout = QVBoxLayout(self.list_container)
        self.list_layout.setContentsMargins(0, 0, 0, 0)
        self.list_layout.setSpacing(4)
        self.list_layout.addStretch()
        scroll.setWidget(self.list_container)
        layout.addWidget(scroll, 1)

    def _refresh(self):
        while self.list_layout.count() > 1:
            item = self.list_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for task in self.todo_service.get_tasks():
            row = QWidget()
            h = QHBoxLayout(row)
            h.setContentsMargins(4, 2, 4, 2)
            cb = QCheckBox(task["title"])
            tid = task["id"]
            cb.stateChanged.connect(lambda _s, t=tid: self._complete(t))
            h.addWidget(cb, 1)
            self.list_layout.insertWidget(self.list_layout.count() - 1, row)

    def _add_task(self):
        title = self.input.text().strip()
        if title:
            self.todo_service.add_task(title, 2)
            self.input.clear()
            self._refresh()

    def _complete(self, tid):
        self.todo_service.complete_task(tid)
        self._refresh()

    # ────────── 拖拽支持 ──────────
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()

    def mouseMoveEvent(self, event):
        if self._drag_pos and (event.buttons() & Qt.MouseButton.LeftButton):
            self.move(event.globalPosition().toPoint() - self._drag_pos)

    def mouseReleaseEvent(self, event):
        self._drag_pos = None
