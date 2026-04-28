"""知识图谱页面 —— 三元组录入 / 查询 / 展示"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QTextEdit, QListWidget, QListWidgetItem,
    QFrame, QGridLayout,
)
from PySide6.QtCore import Qt


class GraphWidget(QWidget):
    def __init__(self, ctx: dict):
        super().__init__()
        self.ctx = ctx
        self.graph_service = ctx["graph_service"]
        self._init_ui()
        self._refresh()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 24, 32, 24)
        layout.setSpacing(16)

        title = QLabel("🔗 知识图谱")
        title.setProperty("heading", True)
        layout.addWidget(title)

        # ── 添加三元组 ──
        add_frame = QFrame()
        add_frame.setStyleSheet(
            "QFrame{background-color:rgba(49,50,68,0.5);border-radius:10px;padding:8px;}"
        )
        g = QGridLayout(add_frame)
        g.setSpacing(8)
        g.addWidget(QLabel("实体1:"), 0, 0)
        self.e1_input = QLineEdit()
        self.e1_input.setPlaceholderText("例: Python")
        g.addWidget(self.e1_input, 0, 1)
        g.addWidget(QLabel("关系:"), 0, 2)
        self.rel_input = QLineEdit()
        self.rel_input.setPlaceholderText("例: 是一种")
        g.addWidget(self.rel_input, 0, 3)
        g.addWidget(QLabel("实体2:"), 0, 4)
        self.e2_input = QLineEdit()
        self.e2_input.setPlaceholderText("例: 编程语言")
        g.addWidget(self.e2_input, 0, 5)
        add_btn = QPushButton("+ 添加三元组")
        add_btn.clicked.connect(self._add_triple)
        g.addWidget(add_btn, 0, 6)
        layout.addWidget(add_frame)

        # ── 查询 ──
        qbar = QHBoxLayout()
        self.query_input = QLineEdit()
        self.query_input.setPlaceholderText("输入实体名称查询关联关系...")
        self.query_input.returnPressed.connect(self._query)
        qbar.addWidget(self.query_input, 1)
        qbtn = QPushButton("🔍 查询")
        qbtn.clicked.connect(self._query)
        qbar.addWidget(qbtn)
        layout.addLayout(qbar)

        self.result_area = QTextEdit()
        self.result_area.setReadOnly(True)
        self.result_area.setPlaceholderText("查询结果将显示在此...")
        self.result_area.setMaximumHeight(160)
        layout.addWidget(self.result_area)

        # ── 三元组列表 ──
        list_header = QHBoxLayout()
        list_header.addWidget(QLabel("所有三元组"))
        list_header.addStretch()
        del_btn = QPushButton("🗑 删除选中")
        del_btn.setProperty("danger", True)
        del_btn.clicked.connect(self._delete_triple)
        list_header.addWidget(del_btn)
        layout.addLayout(list_header)

        self.triple_list = QListWidget()
        layout.addWidget(self.triple_list, 1)

    # ────────── 操作方法 ──────────
    def _refresh(self):
        self.triple_list.clear()
        for t in self.graph_service.get_all_triples():
            text = f"{t['entity1']}  —[ {t['relation']} ]→  {t['entity2']}"
            item = QListWidgetItem(text)
            item.setData(Qt.ItemDataRole.UserRole, t["id"])
            self.triple_list.addItem(item)

    def _add_triple(self):
        e1, rel, e2 = (
            self.e1_input.text().strip(),
            self.rel_input.text().strip(),
            self.e2_input.text().strip(),
        )
        if e1 and rel and e2:
            self.graph_service.add_triple(e1, rel, e2)
            self.e1_input.clear()
            self.rel_input.clear()
            self.e2_input.clear()
            self._refresh()

    def _query(self):
        name = self.query_input.text().strip()
        if not name:
            return
        results = self.graph_service.query_entity(name)
        if not results:
            self.result_area.setText(f"未找到与 '{name}' 相关的三元组")
            return
        lines = [f"🔍 与 '{name}' 相关的关系:\n"]
        for r in results:
            lines.append(f"  {r['entity1']}  —[ {r['relation']} ]→  {r['entity2']}")
        self.result_area.setText("\n".join(lines))

    def _delete_triple(self):
        item = self.triple_list.currentItem()
        if item:
            self.graph_service.delete_triple(item.data(Qt.ItemDataRole.UserRole))
            self._refresh()
