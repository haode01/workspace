"""SQLite 数据持久化层 —— 统一管理 Todo、文档、Chunk、图谱三元组"""

import sqlite3
import os
import json
import logging
import threading
from datetime import datetime

logger = logging.getLogger(__name__)


class Database:
    def __init__(self, db_path: str):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._init_tables()
        logger.info("[DB] 数据库初始化完成: %s", db_path)

    # ────────────────────── 建表 ──────────────────────
    def _init_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS todos (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT    NOT NULL,
                detail      TEXT    DEFAULT '',
                priority    INTEGER DEFAULT 2,
                completed   INTEGER DEFAULT 0,
                pinned      INTEGER DEFAULT 0,
                created_at  TEXT,
                completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS documents (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                filename    TEXT NOT NULL,
                content     TEXT,
                doc_type    TEXT,
                category    TEXT DEFAULT '',
                raw_blob    BLOB,
                created_at  TEXT
            );
            CREATE TABLE IF NOT EXISTS editor_notes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id      INTEGER NOT NULL,
                username    TEXT NOT NULL,
                title       TEXT DEFAULT '',
                category    TEXT DEFAULT '',
                created_at  TEXT,
                updated_at  TEXT,
                FOREIGN KEY (doc_id) REFERENCES documents(id),
                FOREIGN KEY (username) REFERENCES users(username)
            );
            CREATE TABLE IF NOT EXISTS chunks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id      INTEGER,
                content     TEXT,
                chunk_index INTEGER,
                FOREIGN KEY (doc_id) REFERENCES documents(id)
            );
            CREATE TABLE IF NOT EXISTS graph_triples (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                entity1     TEXT NOT NULL,
                relation    TEXT NOT NULL,
                entity2     TEXT NOT NULL,
                created_at  TEXT
            );
            CREATE TABLE IF NOT EXISTS patch_annotations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                collection  TEXT NOT NULL,
                file_path   TEXT NOT NULL,
                line_num    INTEGER NOT NULL,
                content     TEXT NOT NULL,
                color       TEXT DEFAULT 'yellow',
                created_at  TEXT
            );
            CREATE TABLE IF NOT EXISTS users (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                username    TEXT NOT NULL UNIQUE,
                password    TEXT NOT NULL,
                role        TEXT NOT NULL DEFAULT 'user',
                permissions TEXT NOT NULL DEFAULT '{"search":true,"download":true,"modify":false,"use_admin_ai":false,"todo":false,"files":false,"graph":false,"workflow":false,"patch_review":false,"plugins":false}',
                created_at  TEXT
            );
            CREATE TABLE IF NOT EXISTS user_configs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                username    TEXT NOT NULL UNIQUE,
                config_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (username) REFERENCES users(username)
            );
            CREATE TABLE IF NOT EXISTS tool_categories (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                created_at  TEXT
            );
            CREATE TABLE IF NOT EXISTS tools (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                description TEXT NOT NULL,
                category_id INTEGER NOT NULL,
                upload_type TEXT NOT NULL DEFAULT 'file',
                file_path   TEXT NOT NULL,
                file_size   INTEGER DEFAULT 0,
                created_at  TEXT,
                FOREIGN KEY (category_id) REFERENCES tool_categories(id)
            );
            CREATE TABLE IF NOT EXISTS tool_experiences (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                tool_id     INTEGER NOT NULL,
                title       TEXT NOT NULL DEFAULT '',
                content     TEXT NOT NULL DEFAULT '',
                created_at  TEXT,
                updated_at  TEXT,
                FOREIGN KEY (tool_id) REFERENCES tools(id)
            );
            CREATE TABLE IF NOT EXISTS file_ops (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                username    TEXT NOT NULL,
                op_type     TEXT NOT NULL,
                file_path   TEXT NOT NULL,
                old_content TEXT,
                new_content TEXT,
                extra       TEXT DEFAULT '',
                created_at  TEXT
            );
        """)
        self.conn.commit()
        self._migrate()

    def _migrate(self):
        """自动迁移: 为已有表添加新列"""
        try:
            self.conn.execute("SELECT category FROM documents LIMIT 1")
        except sqlite3.OperationalError:
            self.conn.execute("ALTER TABLE documents ADD COLUMN category TEXT DEFAULT ''")
            self.conn.commit()
            logger.info("[DB] 迁移: documents 表已添加 category 列")
        try:
            self.conn.execute("SELECT raw_blob FROM documents LIMIT 1")
        except sqlite3.OperationalError:
            self.conn.execute("ALTER TABLE documents ADD COLUMN raw_blob BLOB")
            self.conn.commit()
            logger.info("[DB] 迁移: documents 表已添加 raw_blob 列")
        try:
            self.conn.execute("SELECT detail FROM todos LIMIT 1")
        except sqlite3.OperationalError:
            self.conn.execute("ALTER TABLE todos ADD COLUMN detail TEXT DEFAULT ''")
            self.conn.commit()
            logger.info("[DB] 迁移: todos 表已添加 detail 列")
        # 迁移: users 表添加 permissions 列
        try:
            self.conn.execute("SELECT permissions FROM users LIMIT 1")
        except sqlite3.OperationalError:
            self.conn.execute(
                """ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT
                '{"search":true,"download":true,"modify":false,"use_admin_ai":false,"todo":false,"files":false,"graph":false,"workflow":false,"patch_review":false,"plugins":false}'"""
            )
            self.conn.commit()
            logger.info("[DB] 迁移: users 表已添加 permissions 列")
        # 迁移: 为已有用户补齐新增的权限 key
        _FULL_DEFAULTS = {"search":True,"download":True,"modify":False,"use_admin_ai":False,
                          "todo":False,"files":False,"graph":False,"workflow":False,"patch_review":False,"plugins":False}
        for row in self.conn.execute("SELECT username, permissions FROM users WHERE role != 'admin'").fetchall():
            try:
                p = json.loads(row["permissions"]) if row["permissions"] else {}
            except Exception:
                p = {}
            if set(p.keys()) != set(_FULL_DEFAULTS.keys()):
                merged = {**_FULL_DEFAULTS, **p}
                self.conn.execute("UPDATE users SET permissions=? WHERE username=?",
                                  (json.dumps(merged, ensure_ascii=False), row["username"]))
        self.conn.commit()
        # 种子: 确保 admin 用户存在
        row = self.conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()
        if not row:
            import hashlib
            pw_hash = hashlib.sha256("720818".encode()).hexdigest()
            self.conn.execute(
                "INSERT INTO users (username, password, role, created_at) VALUES (?, ?, 'admin', ?)",
                ("admin", pw_hash, datetime.now().isoformat()),
            )
            self.conn.commit()
            logger.info("[DB] 种子: admin 用户已创建")

    # ────────────────────── User ──────────────────────
    def get_user(self, username: str) -> dict | None:
        row = self.conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(row) if row else None

    def create_user(self, username: str, password_hash: str, role: str = "user") -> int:
        default_perms = '{"search":true,"download":true,"modify":false,"use_admin_ai":false,"todo":false,"files":false,"graph":false,"workflow":false,"patch_review":false,"plugins":false}'
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO users (username, password, role, permissions, created_at) VALUES (?, ?, ?, ?, ?)",
                (username, password_hash, role, default_perms, datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增用户: %s, role=%s", username, role)
        return cur.lastrowid

    def get_all_users(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT id, username, role, permissions, created_at FROM users ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]

    def update_user_permissions(self, username: str, permissions_json: str):
        with self._lock:
            self.conn.execute(
                "UPDATE users SET permissions=? WHERE username=?",
                (permissions_json, username),
            )
            self.conn.commit()
        logger.info("[DB存储] 更新用户权限: %s -> %s", username, permissions_json)

    def delete_user(self, username: str):
        with self._lock:
            self.conn.execute("DELETE FROM user_configs WHERE username=?", (username,))
            self.conn.execute("DELETE FROM users WHERE username=?", (username,))
            self.conn.commit()
        logger.info("[DB存储] 删除用户: %s", username)

    def get_user_config(self, username: str) -> str:
        row = self.conn.execute(
            "SELECT config_json FROM user_configs WHERE username=?", (username,)
        ).fetchone()
        return row["config_json"] if row else "{}"

    def save_user_config(self, username: str, config_json: str):
        with self._lock:
            existing = self.conn.execute(
                "SELECT id FROM user_configs WHERE username=?", (username,)
            ).fetchone()
            if existing:
                self.conn.execute(
                    "UPDATE user_configs SET config_json=? WHERE username=?",
                    (config_json, username),
                )
            else:
                self.conn.execute(
                    "INSERT INTO user_configs (username, config_json) VALUES (?, ?)",
                    (username, config_json),
                )
            self.conn.commit()
        logger.info("[DB存储] 保存用户配置: %s", username)

    # ────────────────────── Todo CRUD ──────────────────────
    def add_todo(self, title: str, priority: int = 2) -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO todos (title, priority, created_at) VALUES (?, ?, ?)",
                (title, priority, datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增Todo: id=%d, title='%s', priority=%d", cur.lastrowid, title[:50], priority)
        return cur.lastrowid

    def get_todos(self, include_completed: bool = False) -> list[dict]:
        if include_completed:
            sql = "SELECT * FROM todos ORDER BY pinned DESC, priority ASC, created_at DESC"
        else:
            sql = "SELECT * FROM todos WHERE completed=0 ORDER BY pinned DESC, priority ASC, created_at DESC"
        rows = [dict(r) for r in self.conn.execute(sql).fetchall()]
        logger.info("[DB查询] 获取Todo列表: 共%d条 (include_completed=%s)", len(rows), include_completed)
        return rows

    def complete_todo(self, todo_id: int):
        with self._lock:
            self.conn.execute(
                "UPDATE todos SET completed=1, completed_at=? WHERE id=?",
                (datetime.now().isoformat(), todo_id),
            )
            self.conn.commit()
        logger.info("[DB存储] 完成Todo: id=%d", todo_id)

    def delete_todo(self, todo_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM todos WHERE id=?", (todo_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除Todo: id=%d", todo_id)

    def toggle_pin(self, todo_id: int):
        with self._lock:
            row = self.conn.execute("SELECT pinned FROM todos WHERE id=?", (todo_id,)).fetchone()
            if row:
                new_val = 1 - row["pinned"]
                self.conn.execute("UPDATE todos SET pinned=? WHERE id=?", (new_val, todo_id))
                self.conn.commit()
            logger.info("[DB存储] 切换Todo置顶: id=%d, pinned=%d", todo_id, new_val)

    def get_completed_todos(self, limit: int = 50) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            "SELECT * FROM todos WHERE completed=1 ORDER BY completed_at DESC LIMIT ?",
            (limit,),
        ).fetchall()]
        logger.info("[DB查询] 获取已完成Todo: 共%d条 (limit=%d)", len(rows), limit)
        return rows

    def get_todo_by_id(self, todo_id: int) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM todos WHERE id=?", (todo_id,)
        ).fetchone()
        return dict(row) if row else None

    def update_todo(self, todo_id: int, title: str = None, detail: str = None, priority: int = None):
        with self._lock:
            if title is not None:
                self.conn.execute("UPDATE todos SET title=? WHERE id=?", (title, todo_id))
            if detail is not None:
                self.conn.execute("UPDATE todos SET detail=? WHERE id=?", (detail, todo_id))
            if priority is not None:
                self.conn.execute("UPDATE todos SET priority=? WHERE id=?", (priority, todo_id))
            self.conn.commit()
        logger.info("[DB存储] 更新Todo: id=%d", todo_id)

    def get_todos_by_date(self, date_str: str) -> list[dict]:
        """获取指定日期的 Todo (date_str 格式: YYYY-MM-DD)"""
        rows = [dict(r) for r in self.conn.execute(
            "SELECT * FROM todos WHERE created_at LIKE ? ORDER BY pinned DESC, priority ASC, created_at DESC",
            (date_str + '%',),
        ).fetchall()]
        logger.info("[DB查询] 获取%s的Todo: 共%d条", date_str, len(rows))
        return rows

    def get_todo_dates(self) -> list[str]:
        """获取所有有 Todo 的日期列表"""
        rows = self.conn.execute(
            "SELECT DISTINCT substr(created_at, 1, 10) as d FROM todos ORDER BY d DESC"
        ).fetchall()
        return [r["d"] for r in rows if r["d"]]

    # ────────────────────── Document CRUD ──────────────────────
    def add_document(self, filename: str, content: str, doc_type: str, category: str = "") -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO documents (filename, content, doc_type, category, created_at) VALUES (?, ?, ?, ?, ?)",
                (filename, content, doc_type, category, datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增文档: id=%d, filename='%s', type=%s, category='%s', 内容长度=%d",
                    cur.lastrowid, filename, doc_type, category, len(content))
        return cur.lastrowid

    def update_document_content(self, doc_id: int, content: str):
        """更新文档内容 (AI 排版后回写)"""
        with self._lock:
            self.conn.execute("UPDATE documents SET content=? WHERE id=?", (content, doc_id))
            self.conn.commit()
        logger.info("[DB存储] 更新文档内容: doc_id=%d, 新长度=%d", doc_id, len(content))

    def update_document(self, doc_id: int, filename: str, content: str, category: str = ""):
        """更新文档名称/内容/分类"""
        with self._lock:
            self.conn.execute(
                "UPDATE documents SET filename=?, content=?, category=? WHERE id=?",
                (filename, content, category, doc_id),
            )
            self.conn.commit()
        logger.info("[DB存储] 更新文档: doc_id=%d, filename='%s', category='%s', 新长度=%d",
                    doc_id, filename, category, len(content))

    def get_documents(self) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            "SELECT id, filename, doc_type, category, created_at FROM documents ORDER BY created_at DESC"
        ).fetchall()]
        logger.info("[DB查询] 获取文档列表: 共%d篇", len(rows))
        return rows

    def get_document_by_id(self, doc_id: int) -> dict | None:
        row = self.conn.execute(
            "SELECT id, filename, doc_type, category FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        return dict(row) if row else None

    def save_raw_blob(self, doc_id: int, blob: bytes):
        """保存文件原始内容 (gzip压缩后的二进制)"""
        with self._lock:
            self.conn.execute("UPDATE documents SET raw_blob=? WHERE id=?", (sqlite3.Binary(blob), doc_id))
            self.conn.commit()
        logger.info("[DB存储] 保存原始文件: doc_id=%d, blob_size=%d", doc_id, len(blob))

    def get_raw_blob(self, doc_id: int) -> tuple:
        """获取文件原始内容, 返回 (filename, blob) 或 (None, None)"""
        row = self.conn.execute(
            "SELECT filename, raw_blob FROM documents WHERE id=?", (doc_id,)
        ).fetchone()
        if row and row["raw_blob"]:
            return row["filename"], row["raw_blob"]
        return None, None

    def get_categories(self) -> list[str]:
        """获取所有已使用的分类 (去重)"""
        rows = self.conn.execute(
            "SELECT DISTINCT category FROM documents WHERE category != '' ORDER BY category"
        ).fetchall()
        cats = [r["category"] for r in rows]
        logger.info("[DB查询] 获取分类列表: %d 种", len(cats))
        return cats

    def update_document_category(self, doc_id: int, category: str):
        with self._lock:
            self.conn.execute("UPDATE documents SET category=? WHERE id=?", (category, doc_id))
            self.conn.commit()
        logger.info("[DB存储] 更新文档分类: doc_id=%d, category='%s'", doc_id, category)

    def delete_document(self, doc_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
            self.conn.execute("DELETE FROM editor_notes WHERE doc_id=?", (doc_id,))
            self.conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除文档及其chunks: doc_id=%d", doc_id)

    # ────────────────────── Editor Notes ──────────────────────
    def add_editor_note(self, doc_id: int, username: str, title: str, category: str = "") -> int:
        now = datetime.now().isoformat()
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO editor_notes (doc_id, username, title, category, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (doc_id, username, title, category, now, now),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增编辑记录: note_id=%d, doc_id=%d, username=%s",
                    cur.lastrowid, doc_id, username)
        return cur.lastrowid

    def get_editor_notes(self, username: str) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            """
            SELECT n.id, n.doc_id, n.username, n.title, n.category, n.created_at, n.updated_at,
                   d.filename, d.content, d.doc_type
            FROM editor_notes n
            JOIN documents d ON d.id = n.doc_id
            WHERE n.username=?
            ORDER BY n.updated_at DESC, n.id DESC
            """,
            (username,),
        ).fetchall()]
        logger.info("[DB查询] 获取编辑记录: username=%s, 共%d条", username, len(rows))
        return rows

    def get_editor_note_by_id(self, note_id: int, username: str) -> dict | None:
        row = self.conn.execute(
            """
            SELECT n.id, n.doc_id, n.username, n.title, n.category, n.created_at, n.updated_at,
                   d.filename, d.content, d.doc_type
            FROM editor_notes n
            JOIN documents d ON d.id = n.doc_id
            WHERE n.id=? AND n.username=?
            """,
            (note_id, username),
        ).fetchone()
        return dict(row) if row else None

    def update_editor_note(self, note_id: int, username: str, title: str, category: str = ""):
        now = datetime.now().isoformat()
        with self._lock:
            self.conn.execute(
                "UPDATE editor_notes SET title=?, category=?, updated_at=? WHERE id=? AND username=?",
                (title, category, now, note_id, username),
            )
            self.conn.commit()
        logger.info("[DB存储] 更新编辑记录: note_id=%d, username=%s", note_id, username)

    def delete_editor_note(self, note_id: int, username: str):
        with self._lock:
            self.conn.execute("DELETE FROM editor_notes WHERE id=? AND username=?", (note_id, username))
            self.conn.commit()
        logger.info("[DB存储] 删除编辑记录: note_id=%d, username=%s", note_id, username)

    # ────────────────────── Chunk ──────────────────────
    def add_chunk(self, doc_id: int, content: str, chunk_index: int):
        with self._lock:
            self.conn.execute(
                "INSERT INTO chunks (doc_id, content, chunk_index) VALUES (?, ?, ?)",
                (doc_id, content, chunk_index),
            )
            self.conn.commit()

        logger.debug("[DB存储] 新增Chunk: doc_id=%d, index=%d, 长度=%d", doc_id, chunk_index, len(content))

    def delete_chunks_by_doc(self, doc_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM chunks WHERE doc_id=?", (doc_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除文档chunks: doc_id=%d", doc_id)

    # ────────────────────── Graph Triple ──────────────────────
    def add_triple(self, e1: str, rel: str, e2: str):
        with self._lock:
            self.conn.execute(
                "INSERT INTO graph_triples (entity1, relation, entity2, created_at) VALUES (?, ?, ?, ?)",
                (e1, rel, e2, datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增三元组: (%s)-[%s]->(%s)", e1, rel, e2)

    def query_entity(self, name: str) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            "SELECT * FROM graph_triples WHERE entity1=? OR entity2=?", (name, name)
        ).fetchall()]
        logger.info("[DB查询] 查询实体: name='%s', 结果%d条", name, len(rows))
        return rows

    def get_all_triples(self) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            "SELECT * FROM graph_triples ORDER BY created_at DESC"
        ).fetchall()]
        logger.info("[DB查询] 获取所有三元组: 共%d条", len(rows))
        return rows

    def delete_triple(self, triple_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM graph_triples WHERE id=?", (triple_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除三元组: id=%d", triple_id)

    # ────────────────────── Patch 标注 ──────────────────────
    def add_annotation(self, collection: str, file_path: str, line_num: int,
                       content: str, color: str = "yellow") -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO patch_annotations (collection, file_path, line_num, content, color, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (collection, file_path, line_num, content, color, datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增标注: id=%d, %s/%s line %d", cur.lastrowid, collection, file_path, line_num)
        return cur.lastrowid

    def get_annotations(self, collection: str, file_path: str) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            "SELECT * FROM patch_annotations WHERE collection=? AND file_path=? ORDER BY line_num, id",
            (collection, file_path),
        ).fetchall()]
        return rows

    def update_annotation(self, ann_id: int, content: str, color: str = None):
        with self._lock:
            if color:
                self.conn.execute(
                    "UPDATE patch_annotations SET content=?, color=? WHERE id=?",
                    (content, color, ann_id),
                )
            else:
                self.conn.execute(
                    "UPDATE patch_annotations SET content=? WHERE id=?",
                    (content, ann_id),
                )
            self.conn.commit()
        logger.info("[DB存储] 更新标注: id=%d", ann_id)

    def delete_annotation(self, ann_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM patch_annotations WHERE id=?", (ann_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除标注: id=%d", ann_id)

    # ────────────────────── Tool Category ──────────────────────
    def add_tool_category(self, name: str, description: str = "") -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO tool_categories (name, description, created_at) VALUES (?, ?, ?)",
                (name, description, datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增工具分类: id=%d, name='%s'", cur.lastrowid, name)
        return cur.lastrowid

    def get_tool_categories(self) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            "SELECT * FROM tool_categories ORDER BY name"
        ).fetchall()]
        return rows

    def get_tool_category_by_id(self, cat_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM tool_categories WHERE id=?", (cat_id,)).fetchone()
        return dict(row) if row else None

    def get_tool_category_by_name(self, name: str) -> dict | None:
        row = self.conn.execute("SELECT * FROM tool_categories WHERE name=?", (name,)).fetchone()
        return dict(row) if row else None

    def delete_tool_category(self, cat_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM tool_categories WHERE id=?", (cat_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除工具分类: id=%d", cat_id)

    # ────────────────────── Tool CRUD ──────────────────────
    def add_tool(self, name: str, description: str, category_id: int,
                 upload_type: str, file_path: str, file_size: int = 0) -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO tools (name, description, category_id, upload_type, file_path, file_size, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (name, description, category_id, upload_type, file_path, file_size,
                 datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增工具: id=%d, name='%s', type=%s", cur.lastrowid, name, upload_type)
        return cur.lastrowid

    def get_tools(self, category_id: int = None, keyword: str = "") -> list[dict]:
        sql = """SELECT t.*, tc.name as category_name
                 FROM tools t LEFT JOIN tool_categories tc ON t.category_id = tc.id
                 WHERE 1=1"""
        params = []
        if category_id:
            sql += " AND t.category_id = ?"
            params.append(category_id)
        if keyword:
            sql += " AND (t.description LIKE ? OR t.name LIKE ?)"
            params.extend([f"%{keyword}%", f"%{keyword}%"])
        sql += " ORDER BY t.created_at DESC"
        rows = [dict(r) for r in self.conn.execute(sql, params).fetchall()]
        return rows

    def get_tool_by_id(self, tool_id: int) -> dict | None:
        row = self.conn.execute(
            """SELECT t.*, tc.name as category_name
               FROM tools t LEFT JOIN tool_categories tc ON t.category_id = tc.id
               WHERE t.id=?""", (tool_id,)
        ).fetchone()
        return dict(row) if row else None

    def delete_tool(self, tool_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM tool_experiences WHERE tool_id=?", (tool_id,))
            self.conn.execute("DELETE FROM tools WHERE id=?", (tool_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除工具及其记录: id=%d", tool_id)

    # ────────────────────── Tool Experience ──────────────────────
    def add_tool_experience(self, tool_id: int, title: str, content: str) -> int:
        now = datetime.now().isoformat()
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO tool_experiences (tool_id, title, content, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (tool_id, title, content, now, now),
            )
            self.conn.commit()
        logger.info("[DB存储] 新增工具经验: id=%d, tool_id=%d", cur.lastrowid, tool_id)
        return cur.lastrowid

    def get_tool_experiences(self, tool_id: int) -> list[dict]:
        rows = [dict(r) for r in self.conn.execute(
            "SELECT * FROM tool_experiences WHERE tool_id=? ORDER BY created_at DESC",
            (tool_id,),
        ).fetchall()]
        return rows

    def get_tool_experience_by_id(self, exp_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM tool_experiences WHERE id=?", (exp_id,)).fetchone()
        return dict(row) if row else None

    def update_tool_experience(self, exp_id: int, title: str, content: str):
        with self._lock:
            self.conn.execute(
                "UPDATE tool_experiences SET title=?, content=?, updated_at=? WHERE id=?",
                (title, content, datetime.now().isoformat(), exp_id),
            )
            self.conn.commit()
        logger.info("[DB存储] 更新工具经验: id=%d", exp_id)

    def delete_tool_experience(self, exp_id: int):
        with self._lock:
            self.conn.execute("DELETE FROM tool_experiences WHERE id=?", (exp_id,))
            self.conn.commit()
        logger.info("[DB存储] 删除工具经验: id=%d", exp_id)

    # ────────────────────── File Ops (服务器文件操作记录) ──────────────────────
    def add_file_op(self, username: str, op_type: str, file_path: str,
                    old_content: str = None, new_content: str = None, extra: str = "") -> int:
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO file_ops (username, op_type, file_path, old_content, new_content, extra, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (username, op_type, file_path, old_content, new_content, extra, datetime.now().isoformat()),
            )
            self.conn.commit()
        logger.info("[DB存储] 文件操作记录: op=%s, path=%s, user=%s", op_type, file_path, username)
        return cur.lastrowid

    def get_file_ops(self, file_path: str = None, limit: int = 100) -> list[dict]:
        if file_path:
            rows = [dict(r) for r in self.conn.execute(
                "SELECT id, username, op_type, file_path, extra, created_at FROM file_ops WHERE file_path=? ORDER BY id DESC LIMIT ?",
                (file_path, limit),
            ).fetchall()]
        else:
            rows = [dict(r) for r in self.conn.execute(
                "SELECT id, username, op_type, file_path, extra, created_at FROM file_ops ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()]
        return rows

    def get_file_op_by_id(self, op_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM file_ops WHERE id=?", (op_id,)).fetchone()
        return dict(row) if row else None

    # ────────────────────── 清理 ──────────────────────
    def close(self):
        self.conn.close()
