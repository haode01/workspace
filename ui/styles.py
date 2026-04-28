"""QSS 主题样式 —— Catppuccin 风格暗黑/明亮双主题"""

# ═══════════════════════════════════════════════════
#  暗黑模式 (Catppuccin Mocha)
# ═══════════════════════════════════════════════════
DARK_STYLE = """
/* ── 全局 ── */
QMainWindow, QWidget {
    background-color: #1e1e2e;
    color: #cdd6f4;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 13px;
}

/* ── 侧边栏 ── */
#sidebar {
    background-color: #181825;
    border-right: 1px solid #313244;
}
#sidebar QPushButton {
    background-color: transparent;
    color: #cdd6f4;
    border: none;
    border-radius: 8px;
    padding: 12px 16px;
    text-align: left;
    font-size: 14px;
}
#sidebar QPushButton:hover {
    background-color: #313244;
}
#sidebar QPushButton:checked,
#sidebar QPushButton[active="true"] {
    background-color: #45475a;
    color: #89b4fa;
    font-weight: bold;
}

/* ── 输入框 ── */
QLineEdit, QTextEdit, QPlainTextEdit {
    background-color: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 8px 12px;
    selection-background-color: #89b4fa;
}
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {
    border: 2px solid #89b4fa;
}

/* ── 按钮 ── */
QPushButton {
    background-color: #89b4fa;
    color: #1e1e2e;
    border: none;
    border-radius: 8px;
    padding: 8px 20px;
    font-weight: bold;
    font-size: 13px;
}
QPushButton:hover { background-color: #b4d0fb; }
QPushButton:pressed { background-color: #74c7ec; }
QPushButton:disabled { background-color: #45475a; color: #6c7086; }

QPushButton[danger="true"] { background-color: #f38ba8; }
QPushButton[danger="true"]:hover { background-color: #f5a0ba; }

QPushButton[ghost="true"] {
    background-color: transparent;
    color: #89b4fa;
    border: 1px solid #89b4fa;
}
QPushButton[ghost="true"]:hover {
    background-color: rgba(137, 180, 250, 0.1);
}

/* ── 下拉框 ── */
QComboBox {
    background-color: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 8px;
    padding: 6px 12px;
}
QComboBox::drop-down { border: none; }
QComboBox QAbstractItemView {
    background-color: #313244;
    color: #cdd6f4;
    selection-background-color: #45475a;
    border: 1px solid #45475a;
}

/* ── 滚动条 ── */
QScrollBar:vertical {
    background-color: #1e1e2e;
    width: 8px;
    border-radius: 4px;
}
QScrollBar::handle:vertical {
    background-color: #45475a;
    border-radius: 4px;
    min-height: 30px;
}
QScrollBar::handle:vertical:hover { background-color: #585b70; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar:horizontal {
    background-color: #1e1e2e;
    height: 8px;
}
QScrollBar::handle:horizontal {
    background-color: #45475a;
    border-radius: 4px;
}

/* ── 标签 ── */
QLabel { color: #cdd6f4; }
QLabel[heading="true"] { font-size: 22px; font-weight: bold; }
QLabel[subheading="true"] { font-size: 14px; color: #a6adc8; }

/* ── 列表 ── */
QListWidget {
    background-color: #1e1e2e;
    border: 1px solid #313244;
    border-radius: 8px;
    padding: 4px;
}
QListWidget::item { padding: 8px; border-radius: 6px; }
QListWidget::item:hover { background-color: #313244; }
QListWidget::item:selected { background-color: #45475a; color: #cdd6f4; }

/* ── 复选框 ── */
QCheckBox { spacing: 8px; color: #cdd6f4; }
QCheckBox::indicator {
    width: 18px; height: 18px;
    border: 2px solid #585b70;
    border-radius: 4px;
    background-color: transparent;
}
QCheckBox::indicator:checked {
    background-color: #89b4fa;
    border-color: #89b4fa;
}

/* ── 悬浮窗 ── */
#floatingTodo {
    background-color: #1e1e2e;
    border: 1px solid #313244;
    border-radius: 16px;
}

/* ── Splitter ── */
QSplitter::handle { background-color: #313244; width: 2px; }

/* ── Tooltip ── */
QToolTip {
    background-color: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 6px;
    padding: 4px 8px;
}
"""

# ═══════════════════════════════════════════════════
#  明亮模式 (Catppuccin Latte)
# ═══════════════════════════════════════════════════
LIGHT_STYLE = """
QMainWindow, QWidget {
    background-color: #eff1f5;
    color: #4c4f69;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 13px;
}

#sidebar {
    background-color: #e6e9ef;
    border-right: 1px solid #ccd0da;
}
#sidebar QPushButton {
    background-color: transparent;
    color: #4c4f69;
    border: none;
    border-radius: 8px;
    padding: 12px 16px;
    text-align: left;
    font-size: 14px;
}
#sidebar QPushButton:hover { background-color: #ccd0da; }
#sidebar QPushButton:checked,
#sidebar QPushButton[active="true"] {
    background-color: #bcc0cc;
    color: #1e66f5;
    font-weight: bold;
}

QLineEdit, QTextEdit, QPlainTextEdit {
    background-color: #ffffff;
    color: #4c4f69;
    border: 1px solid #ccd0da;
    border-radius: 8px;
    padding: 8px 12px;
}
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus { border: 2px solid #1e66f5; }

QPushButton {
    background-color: #1e66f5;
    color: #ffffff;
    border: none;
    border-radius: 8px;
    padding: 8px 20px;
    font-weight: bold;
}
QPushButton:hover { background-color: #4880f7; }
QPushButton:pressed { background-color: #1657d4; }
QPushButton:disabled { background-color: #ccd0da; color: #9ca0b0; }

QPushButton[danger="true"] { background-color: #d20f39; color: #fff; }
QPushButton[danger="true"]:hover { background-color: #e34068; }
QPushButton[ghost="true"] {
    background-color: transparent;
    color: #1e66f5;
    border: 1px solid #1e66f5;
}
QPushButton[ghost="true"]:hover { background-color: rgba(30, 102, 245, 0.08); }

QComboBox {
    background-color: #ffffff;
    color: #4c4f69;
    border: 1px solid #ccd0da;
    border-radius: 8px;
    padding: 6px 12px;
}
QComboBox::drop-down { border: none; }
QComboBox QAbstractItemView {
    background-color: #ffffff;
    color: #4c4f69;
    selection-background-color: #e6e9ef;
}

QScrollBar:vertical { background-color: #eff1f5; width: 8px; }
QScrollBar::handle:vertical { background-color: #ccd0da; border-radius: 4px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background-color: #bcc0cc; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }

QLabel { color: #4c4f69; }
QLabel[heading="true"] { font-size: 22px; font-weight: bold; }
QLabel[subheading="true"] { font-size: 14px; color: #6c6f85; }

QListWidget {
    background-color: #ffffff;
    border: 1px solid #ccd0da;
    border-radius: 8px;
}
QListWidget::item { padding: 8px; border-radius: 6px; }
QListWidget::item:hover { background-color: #e6e9ef; }
QListWidget::item:selected { background-color: #ccd0da; }

QCheckBox { color: #4c4f69; }
QCheckBox::indicator { width: 18px; height: 18px; border: 2px solid #9ca0b0; border-radius: 4px; }
QCheckBox::indicator:checked { background-color: #1e66f5; border-color: #1e66f5; }

#floatingTodo {
    background-color: #eff1f5;
    border: 1px solid #ccd0da;
    border-radius: 16px;
}

QSplitter::handle { background-color: #ccd0da; width: 2px; }

QToolTip {
    background-color: #ffffff;
    color: #4c4f69;
    border: 1px solid #ccd0da;
    border-radius: 6px;
    padding: 4px 8px;
}
"""
