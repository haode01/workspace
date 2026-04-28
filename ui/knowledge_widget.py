"""知识库页面 —— 文档管理 + 语义搜索 + RAG 问答"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QTextEdit, QFileDialog, QListWidget, QListWidgetItem,
    QSplitter,
)
from PySide6.QtCore import Qt


class KnowledgeWidget(QWidget):
    def __init__(self, ctx: dict):
        super().__init__()
        self.ctx = ctx
        self.knowledge_service = ctx["knowledge_service"]
        self.ai_client = ctx["ai_client"]
        self._init_ui()
        self._refresh_docs()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 24, 32, 24)
        layout.setSpacing(16)

        title = QLabel("📚 AI 知识库")
        title.setProperty("heading", True)
        layout.addWidget(title)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        # ── 左侧：文档列表 ──
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 8, 0)

        doc_header = QHBoxLayout()
        doc_header.addWidget(QLabel("文档列表"))
        doc_header.addStretch()
        upload_btn = QPushButton("📂 上传文件")
        upload_btn.clicked.connect(self._upload_file)
        doc_header.addWidget(upload_btn)
        ll.addLayout(doc_header)

        self.doc_list = QListWidget()
        self.doc_list.setMinimumWidth(250)
        ll.addWidget(self.doc_list)

        del_btn = QPushButton("🗑 删除选中")
        del_btn.setProperty("danger", True)
        del_btn.clicked.connect(self._delete_doc)
        ll.addWidget(del_btn)
        splitter.addWidget(left)

        # ── 右侧：搜索 + 问答 ──
        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(8, 0, 0, 0)

        rl.addWidget(QLabel("语义搜索 / RAG 问答"))

        search_bar = QHBoxLayout()
        self.query_input = QLineEdit()
        self.query_input.setPlaceholderText("输入问题进行语义搜索和问答...")
        self.query_input.returnPressed.connect(self._search)
        search_bar.addWidget(self.query_input, 1)
        search_btn = QPushButton("🔍 搜索")
        search_btn.clicked.connect(self._search)
        search_bar.addWidget(search_btn)
        qa_btn = QPushButton("💬 RAG问答")
        qa_btn.clicked.connect(self._rag_qa)
        search_bar.addWidget(qa_btn)
        rl.addLayout(search_bar)

        self.result_area = QTextEdit()
        self.result_area.setReadOnly(True)
        self.result_area.setPlaceholderText("搜索结果和 AI 回答将显示在此...")
        rl.addWidget(self.result_area, 1)

        splitter.addWidget(right)
        splitter.setSizes([300, 600])
        layout.addWidget(splitter, 1)

    # ────────── 操作方法 ──────────
    def _refresh_docs(self):
        self.doc_list.clear()
        for doc in self.knowledge_service.get_documents():
            item = QListWidgetItem(f"📄 {doc['filename']}  ({doc['doc_type']})")
            item.setData(Qt.ItemDataRole.UserRole, doc["id"])
            self.doc_list.addItem(item)

    def _upload_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择文件", "", "Supported Files (*.txt *.pdf *.md);;All Files (*)"
        )
        if not path:
            return
        doc_id = self.knowledge_service.add_document(path, self.ai_client)
        if doc_id > 0:
            self._refresh_docs()
            self.result_area.setText(f"✅ 文件已导入并建立索引 (ID: {doc_id})")
        else:
            self.result_area.setText("❌ 文件解析失败或内容为空")

    def _delete_doc(self):
        item = self.doc_list.currentItem()
        if item:
            self.knowledge_service.delete_document(item.data(Qt.ItemDataRole.UserRole))
            self._refresh_docs()

    def _search(self):
        query = self.query_input.text().strip()
        if not query:
            return
        results = self.knowledge_service.search(query, self.ai_client, top_k=5)
        if not results:
            self.result_area.setText("未找到相关内容")
            return
        lines = ["🔍 搜索结果:\n"]
        for i, (chunk, score) in enumerate(results, 1):
            lines.append(f"--- [{i}] 相关度: {score:.4f} ---")
            lines.append(chunk["content"][:300])
            lines.append("")
        self.result_area.setText("\n".join(lines))

    def _rag_qa(self):
        query = self.query_input.text().strip()
        if not query:
            return
        if not self.ai_client.is_configured():
            self.result_area.setText("⚠️ 请先配置 API Key")
            return
        results = self.knowledge_service.search(query, self.ai_client, top_k=5)
        if not results:
            self.result_area.setText("未找到相关上下文，无法进行 RAG 问答")
            return
        context_chunks = [c["content"] for c, _ in results]
        try:
            answer = self.ai_client.rag_answer(query, context_chunks)
            self.result_area.setText(
                f"💬 RAG 问答结果:\n\n{answer}\n\n---\n参考了 {len(context_chunks)} 个文档片段"
            )
        except Exception as e:
            self.result_area.setText(f"❌ RAG 问答失败: {e}")
