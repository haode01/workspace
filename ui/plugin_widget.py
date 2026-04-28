"""插件管理页面 —— 展示已加载插件、执行插件"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QLabel, QListWidget, QListWidgetItem,
    QPushButton, QTextEdit,
)
from PySide6.QtCore import Qt


class PluginWidget(QWidget):
    def __init__(self, ctx: dict):
        super().__init__()
        self.ctx = ctx
        self.plugin_manager = ctx["plugin_manager"]
        self._init_ui()
        self._refresh()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(32, 24, 32, 24)
        layout.setSpacing(16)

        title = QLabel("🧩 插件管理")
        title.setProperty("heading", True)
        layout.addWidget(title)

        desc = QLabel("插件目录: plugins/  ·  应用启动时自动扫描加载")
        desc.setProperty("subheading", True)
        layout.addWidget(desc)

        self.plugin_list = QListWidget()
        layout.addWidget(self.plugin_list, 1)

        exec_btn = QPushButton("▶ 执行选中插件")
        exec_btn.clicked.connect(self._execute)
        layout.addWidget(exec_btn)

        self.output = QTextEdit()
        self.output.setReadOnly(True)
        self.output.setPlaceholderText("插件执行输出...")
        self.output.setMaximumHeight(180)
        layout.addWidget(self.output)

    def _refresh(self):
        self.plugin_list.clear()
        infos = self.plugin_manager.get_plugin_info()
        plugins = self.plugin_manager.get_plugins()
        for info, plugin in zip(infos, plugins):
            text = f"🔌 {info.get('name','?')}  v{info.get('version','?')}  —  {info.get('description','')}"
            item = QListWidgetItem(text)
            item.setData(Qt.ItemDataRole.UserRole, plugin)
            self.plugin_list.addItem(item)
        if not infos:
            self.plugin_list.addItem("暂无已加载的插件")

    def _execute(self):
        item = self.plugin_list.currentItem()
        if not item:
            return
        plugin = item.data(Qt.ItemDataRole.UserRole)
        if plugin:
            try:
                result = plugin.execute()
                self.output.setText(f"✅ 插件执行完成\n\n{result or ''}")
            except Exception as e:
                self.output.setText(f"❌ 执行失败: {e}")
