"""Flask 路由 —— 页面渲染 + REST API"""

import os
import json
import hashlib
import logging
import tempfile
import uuid
from functools import wraps
from flask import Blueprint, request, jsonify, render_template, current_app, Response, send_file, session
from werkzeug.utils import secure_filename

logger = logging.getLogger(__name__)

page_bp = Blueprint("pages", __name__)
api_bp = Blueprint("api", __name__)


def _ctx():
    return current_app.config["app_context"]


# ── 认证辅助 ──
def _current_user():
    """从 session 获取当前用户信息, 返回 dict 或 None"""
    username = session.get("username")
    if not username:
        return None
    return _ctx()["db"].get_user(username)


def _require_login(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("username"):
            return jsonify({"error": "请先登录"}), 401
        return f(*args, **kwargs)
    return decorated


def _require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = _current_user()
        if not user:
            return jsonify({"error": "请先登录"}), 401
        if user["role"] != "admin":
            return jsonify({"error": "权限不足"}), 403
        return f(*args, **kwargs)
    return decorated


def _user_perms(user=None) -> dict:
    """获取用户权限字典, admin 默认全部 True"""
    if user is None:
        user = _current_user()
    if not user:
        return {}
    if user["role"] == "admin":
        return {"search": True, "download": True, "modify": True, "use_admin_ai": True,
                "todo": True, "files": True, "graph": True, "workflow": True, "patch_review": True, "plugins": True}
    try:
        return json.loads(user.get("permissions", "{}"))
    except (json.JSONDecodeError, TypeError):
        return {"search": True, "download": True, "modify": False, "use_admin_ai": False}


def _require_perm(perm_key):
    """检查当前用户是否拥有指定权限"""
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            user = _current_user()
            if not user:
                return jsonify({"error": "请先登录"}), 401
            perms = _user_perms(user)
            if not perms.get(perm_key, False):
                return jsonify({"error": f"无 {perm_key} 权限"}), 403
            return f(*args, **kwargs)
        return decorated
    return decorator


def _strip_md_suffix(name: str) -> str:
    if not name:
        return ""
    return name[:-3] if name.lower().endswith(".md") else name


# ═══════════════════════════════════════
#  页面
# ═══════════════════════════════════════
@page_bp.route("/")
def index():
    return render_template("index.html")


# ═══════════════════════════════════════
#  用户认证 API
# ═══════════════════════════════════════
@api_bp.route("/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400
    db = _ctx()["db"]
    user = db.get_user(username)
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    if not user or user["password"] != pw_hash:
        return jsonify({"error": "用户名或密码错误"}), 401
    session["username"] = username
    session["role"] = user["role"]
    logger.info("[Auth] 用户登录: %s (role=%s)", username, user["role"])
    return jsonify({"ok": True, "username": username, "role": user["role"]})


@api_bp.route("/auth/logout", methods=["POST"])
def auth_logout():
    username = session.get("username", "?")
    session.clear()
    logger.info("[Auth] 用户登出: %s", username)
    return jsonify({"ok": True})


@api_bp.route("/auth/register", methods=["POST"])
def auth_register():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    if not username or not password:
        return jsonify({"error": "用户名和密码不能为空"}), 400
    if len(username) < 2 or len(username) > 20:
        return jsonify({"error": "用户名长度 2-20 字符"}), 400
    if len(password) < 4:
        return jsonify({"error": "密码至少 4 位"}), 400
    db = _ctx()["db"]
    if db.get_user(username):
        return jsonify({"error": "用户名已存在"}), 409
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    db.create_user(username, pw_hash, role="user")
    session["username"] = username
    session["role"] = "user"
    logger.info("[Auth] 新用户注册: %s", username)
    return jsonify({"ok": True, "username": username, "role": "user"})


@api_bp.route("/auth/me", methods=["GET"])
def auth_me():
    user = _current_user()
    if not user:
        return jsonify({"logged_in": False}), 200
    perms = _user_perms(user)
    return jsonify({"logged_in": True, "username": user["username"], "role": user["role"], "permissions": perms})


# ═══════════════════════════════════════
#  用户管理 API (admin only)
# ═══════════════════════════════════════
@api_bp.route("/users", methods=["GET"])
@_require_admin
def list_users():
    users = _ctx()["db"].get_all_users()
    for u in users:
        try:
            u["permissions"] = json.loads(u.get("permissions", "{}"))
        except (json.JSONDecodeError, TypeError):
            u["permissions"] = {}
    return jsonify(users)


@api_bp.route("/users/<username>/permissions", methods=["PUT"])
@_require_admin
def update_user_perms(username):
    if username == "admin":
        return jsonify({"error": "不能修改 admin 权限"}), 400
    data = request.get_json() or {}
    perms = data.get("permissions", {})
    allowed_keys = {"search", "download", "modify", "use_admin_ai",
                     "todo", "files", "graph", "workflow", "patch_review", "plugins"}
    clean = {k: bool(v) for k, v in perms.items() if k in allowed_keys}
    db = _ctx()["db"]
    user = db.get_user(username)
    if not user:
        return jsonify({"error": "用户不存在"}), 404
    # 合并现有权限
    try:
        existing = json.loads(user.get("permissions", "{}"))
    except (json.JSONDecodeError, TypeError):
        existing = {}
    existing.update(clean)
    db.update_user_permissions(username, json.dumps(existing, ensure_ascii=False))
    logger.info("[API] 更新用户权限: %s -> %s", username, existing)
    return jsonify({"ok": True, "permissions": existing})


@api_bp.route("/users/<username>", methods=["DELETE"])
@_require_admin
def delete_user(username):
    if username == "admin":
        return jsonify({"error": "不能删除 admin 用户"}), 400
    db = _ctx()["db"]
    if not db.get_user(username):
        return jsonify({"error": "用户不存在"}), 404
    db.delete_user(username)
    return jsonify({"ok": True})


# ═══════════════════════════════════════
#  Todo API
# ═══════════════════════════════════════
@api_bp.route("/todos", methods=["GET"])
@_require_perm("todo")
def list_todos():
    include = request.args.get("include_completed", "false") == "true"
    logger.info("[API] GET /todos include_completed=%s", include)
    tasks = _ctx()["todo_service"].get_tasks(include_completed=include)
    logger.info("[API] GET /todos 返回 %d 条", len(tasks))
    return jsonify(tasks)


@api_bp.route("/todos", methods=["POST"])
@_require_perm("todo")
def add_todo():
    data = request.get_json()
    title = data.get("title", "").strip()
    priority = data.get("priority", 2)
    logger.info("[API] POST /todos title='%s', priority=%s", title[:50], priority)
    if not title:
        logger.warning("[API] POST /todos 缺少title")
        return jsonify({"error": "title is required"}), 400
    tid = _ctx()["todo_service"].add_task(title, priority)
    logger.info("[API] POST /todos 创建成功, id=%d", tid)
    return jsonify({"id": tid})


@api_bp.route("/todos/<int:tid>/complete", methods=["POST"])
@_require_perm("todo")
def complete_todo(tid):
    _ctx()["todo_service"].complete_task(tid)
    return jsonify({"ok": True})


@api_bp.route("/todos/<int:tid>/pin", methods=["POST"])
@_require_perm("todo")
def pin_todo(tid):
    _ctx()["todo_service"].toggle_pin(tid)
    return jsonify({"ok": True})


@api_bp.route("/todos/history", methods=["GET"])
def todo_history():
    date_str = request.args.get("date", "")
    if not date_str:
        return jsonify({"error": "date is required"}), 400
    tasks = _ctx()["todo_service"].get_tasks_by_date(date_str)
    return jsonify(tasks)


@api_bp.route("/todos/dates", methods=["GET"])
def todo_dates():
    dates = _ctx()["todo_service"].get_dates()
    return jsonify(dates)


@api_bp.route("/todos/<int:tid>", methods=["GET"])
def get_todo_detail(tid):
    task = _ctx()["todo_service"].get_task_detail(tid)
    if not task:
        return jsonify({"error": "not found"}), 404
    return jsonify(task)


@api_bp.route("/todos/<int:tid>", methods=["PUT"])
@_require_perm("todo")
def update_todo(tid):
    data = request.get_json() or {}
    title = data.get("title")
    detail = data.get("detail")
    priority = data.get("priority")
    _ctx()["todo_service"].update_task(tid, title=title, detail=detail, priority=priority)
    return jsonify({"ok": True})


@api_bp.route("/todos/<int:tid>", methods=["DELETE"])
@_require_perm("todo")
def delete_todo(tid):
    _ctx()["todo_service"].delete_task(tid)
    return jsonify({"ok": True})


@api_bp.route("/todos/ai-suggest", methods=["POST"])
@_require_perm("todo")
def ai_suggest():
    ctx = _ctx()
    ai = ctx["ai_client"]
    if not ai.is_configured():
        return jsonify({"error": "请先在 data/store/config.json 中配置 api_key"}), 400
    try:
        history = ctx["todo_service"].get_history(30)
        current = ctx["todo_service"].get_tasks()
        result = ai.generate_todo_suggestions(current + history)
        return jsonify({"result": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ═══════════════════════════════════════
#  Knowledge / RAG API
# ═══════════════════════════════════════
@api_bp.route("/documents", methods=["GET"])
def list_documents():
    logger.info("[API] GET /documents")
    docs = _ctx()["knowledge_service"].get_documents()
    # 排除 patch 分类的文档 (仅在 Patch Review 中可见)
    docs = [d for d in docs if not (d.get("category") or "").startswith("patch/")]
    logger.info("[API] GET /documents 返回 %d 篇", len(docs))
    return jsonify(docs)


@api_bp.route("/documents/browse", methods=["GET"])
def browse_documents():
    """按分类浏览文档列表 (query 为空时使用)"""
    category = request.args.get("category", "").strip()
    logger.info("[API] GET /documents/browse category='%s'", category)
    docs = _ctx()["knowledge_service"].get_documents()
    docs = [d for d in docs if not (d.get("category") or "").startswith("patch/")]
    if category:
        docs = [d for d in docs if (d.get("category") or "").startswith(category)]
    result = []
    for d in docs:
        content = d.get("content", "")
        preview = content[:200] + "..." if len(content) > 200 else content
        result.append({
            "doc_id": d["id"],
            "filename": d.get("filename", ""),
            "category": d.get("category", ""),
            "preview": preview,
            "content": content,
        })
    logger.info("[API] GET /documents/browse 返回 %d 篇", len(result))
    return jsonify(result)


@api_bp.route("/categories", methods=["GET"])
def list_categories():
    """获取所有已使用的分类 (树形结构)"""
    logger.info("[API] GET /categories")
    cats = _ctx()["knowledge_service"].get_categories()
    # 排除 patch 分类 (仅在 Patch Review 中可见)
    cats = [c for c in cats if not c.startswith("patch/")]
    return jsonify(cats)


@api_bp.route("/documents/upload", methods=["POST"])
@_require_perm("files")
def upload_document():
    import gzip
    logger.info("[API] POST /documents/upload")
    if "file" not in request.files:
        logger.warning("[API] 上传无文件")
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    if not f.filename:
        logger.warning("[API] 文件名为空")
        return jsonify({"error": "empty filename"}), 400

    logger.info("[API] 上传文件: %s", f.filename)
    # 保存到临时文件
    ext = os.path.splitext(f.filename)[1]
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    f.save(tmp.name)
    tmp.close()

    category = request.form.get("category", "").strip()
    try:
        ctx = _ctx()
        doc_id = ctx["knowledge_service"].add_document(tmp.name, ctx["ai_client"], category=category, original_filename=f.filename)
        if doc_id > 0:
            # 保存原始文件 (gzip 压缩存入 DB)
            with open(tmp.name, "rb") as rf:
                raw_bytes = rf.read()
            compressed = gzip.compress(raw_bytes, compresslevel=6)
            ctx["knowledge_service"].db.save_raw_blob(doc_id, compressed)
            logger.info("[API] 文档上传成功: doc_id=%d, filename=%s, raw=%d, gz=%d",
                        doc_id, f.filename, len(raw_bytes), len(compressed))
            return jsonify({"id": doc_id, "filename": f.filename, "category": category})
        logger.warning("[API] 文档上传失败: 解析失败或内容为空")
        return jsonify({"error": "文件解析失败或内容为空"}), 400
    finally:
        os.unlink(tmp.name)


@api_bp.route("/documents/text", methods=["POST"])
@_require_perm("files")
def add_text_document():
    """通过文本输入创建文档 (非文件上传)"""
    data = request.get_json()
    if not data:
        return jsonify({"error": "no data"}), 400
    title = data.get("title", "").strip()
    content = data.get("content", "").strip()
    category = data.get("category", "").strip()
    if not content:
        return jsonify({"error": "内容不能为空"}), 400
    logger.info("[API] POST /documents/text title='%s', category='%s', len=%d", title[:50], category, len(content))
    ctx = _ctx()
    doc_id = ctx["knowledge_service"].add_text_document(title, content, ctx["ai_client"], category=category)
    if doc_id > 0:
        return jsonify({"id": doc_id, "title": title, "category": category})
    return jsonify({"error": "保存失败"}), 400


@api_bp.route("/editor/notes", methods=["GET"])
@_require_perm("files")
def list_editor_notes():
    user = _current_user()
    username = user["username"]
    rows = _ctx()["db"].get_editor_notes(username)
    result = []
    for r in rows:
        content = r.get("content") or ""
        title = (r.get("title") or "").strip() or _strip_md_suffix(r.get("filename", "")) or "未命名文档"
        result.append({
            "id": r["id"],
            "doc_id": r["doc_id"],
            "title": title,
            "category": r.get("category", ""),
            "created_at": r.get("created_at", ""),
            "updated_at": r.get("updated_at", ""),
            "preview": content[:160],
        })
    return jsonify(result)


@api_bp.route("/editor/notes", methods=["POST"])
@_require_perm("files")
def create_editor_note():
    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    category = (data.get("category") or "").strip()
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "内容不能为空"}), 400

    user = _current_user()
    username = user["username"]
    ctx = _ctx()
    doc_id = ctx["knowledge_service"].add_text_document(title, content, ai_client=ctx["ai_client"], category=category)
    if doc_id <= 0:
        return jsonify({"error": "保存失败"}), 400

    note_id = ctx["db"].add_editor_note(doc_id, username, title, category)
    return jsonify({"id": note_id, "doc_id": doc_id, "title": title or "未命名文档", "category": category})


@api_bp.route("/editor/notes/<int:note_id>", methods=["GET"])
@_require_perm("files")
def get_editor_note(note_id):
    user = _current_user()
    username = user["username"]
    row = _ctx()["db"].get_editor_note_by_id(note_id, username)
    if not row:
        return jsonify({"error": "编辑内容不存在"}), 404

    title = (row.get("title") or "").strip() or _strip_md_suffix(row.get("filename", "")) or "未命名文档"
    return jsonify({
        "id": row["id"],
        "doc_id": row["doc_id"],
        "title": title,
        "category": row.get("category", ""),
        "content": row.get("content", ""),
        "created_at": row.get("created_at", ""),
        "updated_at": row.get("updated_at", ""),
    })


@api_bp.route("/editor/notes/<int:note_id>", methods=["PUT"])
@_require_perm("files")
def update_editor_note(note_id):
    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    category = (data.get("category") or "").strip()
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "内容不能为空"}), 400

    user = _current_user()
    username = user["username"]
    ctx = _ctx()
    row = ctx["db"].get_editor_note_by_id(note_id, username)
    if not row:
        return jsonify({"error": "编辑内容不存在"}), 404

    ok = ctx["knowledge_service"].update_text_document(
        row["doc_id"], title, content, category=category, ai_client=ctx["ai_client"]
    )
    if not ok:
        return jsonify({"error": "更新失败"}), 400

    ctx["db"].update_editor_note(note_id, username, title, category)
    return jsonify({"ok": True, "id": note_id, "title": title or "未命名文档", "category": category})


@api_bp.route("/editor/notes/<int:note_id>", methods=["DELETE"])
@_require_perm("files")
def delete_editor_note(note_id):
    user = _current_user()
    username = user["username"]
    ctx = _ctx()
    row = ctx["db"].get_editor_note_by_id(note_id, username)
    if not row:
        return jsonify({"error": "编辑内容不存在"}), 404

    ctx["knowledge_service"].delete_document(row["doc_id"])
    return jsonify({"ok": True})


@api_bp.route("/editor/images/upload", methods=["POST"])
@_require_perm("files")
def upload_editor_image():
    if "file" not in request.files:
        return jsonify({"error": "未找到图片文件"}), 400
    f = request.files["file"]
    if not f or not f.filename:
        return jsonify({"error": "图片文件名为空"}), 400

    ext = os.path.splitext(f.filename)[1].lower()
    allowed = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}
    if ext not in allowed:
        return jsonify({"error": "仅支持图片格式: png/jpg/jpeg/gif/webp/bmp/svg"}), 400

    username = session.get("username", "user")
    safe_base = secure_filename(os.path.splitext(f.filename)[0]) or "image"
    filename = f"{username}_{uuid.uuid4().hex[:10]}_{safe_base}{ext}"
    upload_dir = os.path.join(current_app.root_path, "static", "editor_uploads")
    os.makedirs(upload_dir, exist_ok=True)
    abs_path = os.path.join(upload_dir, filename)
    f.save(abs_path)

    return jsonify({
        "ok": True,
        "filename": filename,
        "url": f"/api/editor/images/{filename}",
    })


@api_bp.route("/editor/images/<path:filename>", methods=["GET"])
@_require_login
def get_editor_image(filename):
    upload_dir = os.path.normpath(os.path.join(current_app.root_path, "static", "editor_uploads"))
    target = os.path.normpath(os.path.join(upload_dir, filename))
    if not target.startswith(upload_dir):
        return jsonify({"error": "非法路径"}), 400
    if not os.path.isfile(target):
        return jsonify({"error": "图片不存在"}), 404
    return send_file(target)


@api_bp.route("/documents/<int:doc_id>/content", methods=["GET"])
def get_document_content(doc_id):
    """获取文档的完整内容(MD格式)"""
    logger.info("[API] GET /documents/%d/content", doc_id)
    ctx = _ctx()
    row = ctx["knowledge_service"].db.conn.execute(
        "SELECT id, filename, content, category, doc_type FROM documents WHERE id=?", (doc_id,)
    ).fetchone()
    if not row:
        return jsonify({"error": "文档不存在"}), 404
    doc = dict(row)
    has_raw = bool(ctx["knowledge_service"].db.conn.execute(
        "SELECT 1 FROM documents WHERE id=? AND raw_blob IS NOT NULL", (doc_id,)
    ).fetchone())
    return jsonify({
        "id": doc_id,
        "filename": doc.get("filename", ""),
        "category": doc.get("category", ""),
        "content": doc.get("content", ""),
        "doc_type": doc.get("doc_type", ""),
        "has_raw_file": has_raw,
    })


@api_bp.route("/documents/<int:doc_id>/download", methods=["GET"])
@_require_perm("download")
def download_document(doc_id):
    """下载文档原始文件 (优先从 gzip blob, 旧文档回退到文本)"""
    import gzip
    import io
    import mimetypes
    from flask import send_file
    logger.info("[API] GET /documents/%d/download", doc_id)
    ctx = _ctx()
    db = ctx["knowledge_service"].db

    # 优先返回原始文件
    filename, blob = db.get_raw_blob(doc_id)
    if filename and blob:
        raw_bytes = gzip.decompress(bytes(blob))
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        logger.info("[API] 下载原始文件: %s, size=%d, mime=%s", filename, len(raw_bytes), mime)
        return send_file(
            io.BytesIO(raw_bytes),
            mimetype=mime,
            as_attachment=True,
            download_name=filename,
        )

    # 旧文档: 没有 raw_blob, 回退到文本内容
    row = db.conn.execute(
        "SELECT filename, content FROM documents WHERE id=?", (doc_id,)
    ).fetchone()
    if not row:
        return jsonify({"error": "文档不存在"}), 404
    doc = dict(row)
    filename = doc.get("filename", f"doc_{doc_id}.md")
    content = doc.get("content", "")
    buf = io.BytesIO(content.encode("utf-8"))
    return send_file(
        buf,
        mimetype="text/plain; charset=utf-8",
        as_attachment=True,
        download_name=filename,
    )


@api_bp.route("/documents/<int:doc_id>/category", methods=["PUT"])
@_require_perm("modify")
def update_document_category(doc_id):
    data = request.get_json() or {}
    category = data.get("category", "").strip()
    ctx = _ctx()
    ctx["knowledge_service"].db.update_document_category(doc_id, category)
    ctx["knowledge_service"].rag.update_doc_category(doc_id, category)
    logger.info("[API] PUT /documents/%d/category -> '%s'", doc_id, category)
    return jsonify({"ok": True, "category": category})


@api_bp.route("/documents/<int:doc_id>", methods=["DELETE"])
@_require_perm("modify")
def delete_document(doc_id):
    _ctx()["knowledge_service"].delete_document(doc_id)
    return jsonify({"ok": True})


@api_bp.route("/knowledge/search", methods=["POST"])
@_require_perm("search")
def knowledge_search():
    data = request.get_json()
    query = data.get("query", "").strip()
    logger.info("[API] POST /knowledge/search query='%s'", query[:100] if query else "")
    if not query:
        logger.warning("[API] 搜索缺少query")
        return jsonify({"error": "query required"}), 400
    category = data.get("category", "").strip()
    ctx = _ctx()
    results = ctx["knowledge_service"].search(query, ctx["ai_client"], top_k=5, category=category)
    # 排除 patch 分类结果 (仅通过 Patch Review 搜索)
    results = [(c, s) for c, s in results if not (c.get("category") or "").startswith("patch/")]
    logger.info("[API] POST /knowledge/search 返回 %d 条结果 (category='%s')", len(results), category)
    return jsonify([
        {
            "content": c["content"],
            "score": round(s, 4),
            "doc_id": c.get("doc_id"),
            "filename": c.get("filename", ""),
            "category": c.get("category", ""),
        }
        for c, s in results
    ])


@api_bp.route("/knowledge/rag", methods=["POST"])
def knowledge_rag():
    data = request.get_json()
    query = data.get("query", "").strip()
    logger.info("[API] POST /knowledge/rag query='%s'", query[:100] if query else "")
    if not query:
        return jsonify({"error": "query required"}), 400
    ctx = _ctx()
    ai = ctx["ai_client"]
    if not ai.is_configured():
        logger.warning("[API] RAG问答失败: API Key未配置")
        return jsonify({"error": "请先配置 API Key"}), 400
    results = ctx["knowledge_service"].search(query, ai, top_k=5)
    if not results:
        logger.warning("[API] RAG问答: 未找到相关上下文")
        return jsonify({"error": "未找到相关上下文"}), 404
    chunks = [c["content"] for c, _ in results]
    try:
        answer = ai.rag_answer(query, chunks)
        logger.info("[API] RAG问答成功, 答案长度=%d, 源=%d", len(answer) if answer else 0, len(chunks))
        return jsonify({"answer": answer, "sources": len(chunks)})
    except Exception as e:
        logger.error("[API] RAG问答异常: %s", e)
        return jsonify({"error": str(e)}), 500


def _get_ai_for_model(model_name: str = ""):
    """根据模型名称返回对应 AIClient, 空则返回默认客户端
    非 admin 且 use_admin_ai=false 时使用用户自己的配置"""
    ctx = _ctx()
    user = _current_user()
    perms = _user_perms(user) if user else {}
    # 普通用户 + 不使用 admin AI: 从用户自有配置创建客户端
    if user and user["role"] != "admin" and not perms.get("use_admin_ai"):
        raw = ctx["db"].get_user_config(user["username"])
        ucfg = json.loads(raw) if raw and raw != "{}" else {}
        user_models = ucfg.get("models", [])
        if model_name:
            for m in user_models:
                if m.get("name") == model_name:
                    from ai.ai_client import AIClient
                    return AIClient(m)
        if ucfg.get("api_key"):
            from ai.ai_client import AIClient
            return AIClient(ucfg)
        # 用户没有配置, 回退全局
    if not model_name:
        return ctx["ai_client"]
    models = ctx["config"].get("models", [])
    for m in models:
        if m.get("name") == model_name:
            from ai.ai_client import AIClient
            return AIClient(m)
    return ctx["ai_client"]


@api_bp.route("/knowledge/ask-context", methods=["POST"])
def ask_with_context():
    """基于给定上下文进行 AI 问答 — SSE 流式输出, 支持选择模型"""
    import json as _json
    data = request.get_json()
    query = data.get("query", "").strip()
    context = data.get("context", "").strip()
    model_name = data.get("model_name", "").strip()
    logger.info("[API] POST /knowledge/ask-context query='%s', model='%s', context_len=%d",
                query[:100] if query else "", model_name, len(context))
    if not query:
        return jsonify({"error": "query required"}), 400

    ai = _get_ai_for_model(model_name)
    if not ai.is_configured():
        return jsonify({"error": "请先配置 API Key"}), 400

    # 剥离 base64 图片 (浪费大量 tokens)
    import re
    if context:
        context = re.sub(r'!\[[^\]]*\]\(data:[^)]+\)', '[图片]', context)
    # 限制上下文长度: 200k字符 ≈ 100k tokens, 预留 system+output 空间
    if len(context) > 200000:
        context = context[:200000] + "\n\n...(文档过长, 后续内容已省略)"

    def generate():
        try:
            if context:
                # 全文模式: 整篇文档作为上下文
                for token in ai.rag_answer_stream(query, [context]):
                    yield f"data: {_json.dumps({'t': token})}\n\n"
            else:
                # 无上下文模式: AI 用自身知识回答
                for token in ai.generate_text_stream(query,
                        system="You are a knowledgeable assistant. Answer in Chinese."):
                    yield f"data: {_json.dumps({'t': token})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("[API] 流式问答异常: %s", e)
            yield f"data: {_json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ═══════════════════════════════════════
#  Graph API
# ═══════════════════════════════════════
@api_bp.route("/graph/triples", methods=["GET"])
@_require_perm("graph")
def list_triples():
    return jsonify(_ctx()["graph_service"].get_all_triples())


@api_bp.route("/graph/triples", methods=["POST"])
@_require_perm("graph")
def add_triple():
    data = request.get_json()
    e1 = data.get("entity1", "").strip()
    rel = data.get("relation", "").strip()
    e2 = data.get("entity2", "").strip()
    logger.info("[API] POST /graph/triples (%s)-[%s]->(%s)", e1, rel, e2)
    if not (e1 and rel and e2):
        logger.warning("[API] 新增三元组缺少字段")
        return jsonify({"error": "all fields required"}), 400
    _ctx()["graph_service"].add_triple(e1, rel, e2)
    return jsonify({"ok": True})


@api_bp.route("/graph/triples/<int:tid>", methods=["DELETE"])
@_require_perm("graph")
def delete_triple(tid):
    _ctx()["graph_service"].delete_triple(tid)
    return jsonify({"ok": True})


@api_bp.route("/graph/query", methods=["POST"])
@_require_perm("graph")
def query_entity():
    data = request.get_json()
    name = data.get("name", "").strip()
    logger.info("[API] POST /graph/query name='%s'", name)
    if not name:
        logger.warning("[API] 查询实体缺少name")
        return jsonify({"error": "name required"}), 400
    results = _ctx()["graph_service"].query_entity(name)
    logger.info("[API] POST /graph/query 返回 %d 条", len(results))
    return jsonify(results)


# ═══════════════════════════════════════
#  Config API (界面配置)
# ═══════════════════════════════════════
def _mask_key(key: str) -> str:
    """API Key 脱敏: 仅显示前4位和后4位"""
    if not key or len(key) < 12:
        return key
    return key[:4] + "****" + key[-4:]


@api_bp.route("/config", methods=["GET"])
def get_config():
    """获取当前配置 (API Key 已脱敏) — admin 用全局配置, 普通用户用自己的配置"""
    ctx = _ctx()
    user = _current_user()
    # 普通用户
    if user and user["role"] != "admin":
        perms = _user_perms(user)
        # use_admin_ai: 使用全局配置 (脱敏)
        if perms.get("use_admin_ai"):
            cfg = dict(ctx["config"])
            cfg["_use_admin_ai"] = True
        else:
            raw = ctx["db"].get_user_config(user["username"])
            cfg = json.loads(raw) if raw and raw != "{}" else {}
            cfg["_use_admin_ai"] = False
        safe = dict(cfg)
        for k in ("api_key", "embedding_api_key", "neo4j_password"):
            if k in safe and safe[k]:
                safe[k] = _mask_key(safe[k])
        if "models" in safe:
            safe["models"] = [
                {**m, "api_key": _mask_key(m.get("api_key", ""))} for m in safe["models"]
            ]
        return jsonify(safe)
    # admin: 返回全局配置
    cfg = ctx["config"]
    safe = dict(cfg)
    for k in ("api_key", "embedding_api_key", "neo4j_password"):
        if k in safe and safe[k]:
            safe[k] = _mask_key(safe[k])
    if "models" in safe:
        safe["models"] = [
            {**m, "api_key": _mask_key(m.get("api_key", ""))} for m in safe["models"]
        ]
    return jsonify(safe)


@api_bp.route("/user-config", methods=["PUT"])
@_require_login
def save_user_config():
    """普通用户保存自己的 AI 配置"""
    user = _current_user()
    if not user:
        return jsonify({"error": "请先登录"}), 401
    if user["role"] == "admin":
        return jsonify({"error": "admin 请使用全局配置"}), 400
    data = request.get_json()
    if not data:
        return jsonify({"error": "no data"}), 400
    # 读取已有配置
    raw = _ctx()["db"].get_user_config(user["username"])
    cfg = json.loads(raw) if raw and raw != "{}" else {}
    ALLOWED = {
        "api_key", "api_base", "model",
        "embedding_model", "embedding_api_key", "embedding_api_base",
        "dark_mode", "models",
    }
    changed = []
    for k, v in data.items():
        if k not in ALLOWED:
            continue
        if isinstance(v, str) and "****" in v:
            continue
        if k == "models" and isinstance(v, list):
            old_models = {m.get("name"): m for m in cfg.get("models", [])}
            for m in v:
                if isinstance(m.get("api_key"), str) and "****" in m["api_key"]:
                    orig = old_models.get(m.get("name"), {})
                    m["api_key"] = orig.get("api_key", "")
        if cfg.get(k) != v:
            cfg[k] = v
            changed.append(k)
    if not changed:
        return jsonify({"ok": True, "changed": []})
    _ctx()["db"].save_user_config(user["username"], json.dumps(cfg, ensure_ascii=False))
    logger.info("[API] 用户 %s 配置已更新: %s", user["username"], changed)
    return jsonify({"ok": True, "changed": changed})


@api_bp.route("/config", methods=["PUT"])
@_require_admin
def update_config():
    """更新配置并热重载 AI 客户端"""
    from config import save_config
    data = request.get_json()
    if not data:
        return jsonify({"error": "no data"}), 400

    ctx = _ctx()
    cfg = ctx["config"]

    # 可更新的字段白名单
    ALLOWED = {
        "api_key", "api_base", "model",
        "embedding_model", "embedding_api_key", "embedding_api_base",
        "neo4j_uri", "neo4j_user", "neo4j_password",
        "dark_mode", "models",
    }

    changed = []
    for k, v in data.items():
        if k not in ALLOWED:
            continue
        # 跳过脱敏占位值 (包含 ****)
        if isinstance(v, str) and "****" in v:
            continue
        # models 列表特殊处理: 保留已脱敏的 api_key
        if k == "models" and isinstance(v, list):
            old_models = {m.get("name"): m for m in cfg.get("models", [])}
            for m in v:
                if isinstance(m.get("api_key"), str) and "****" in m["api_key"]:
                    orig = old_models.get(m.get("name"), {})
                    m["api_key"] = orig.get("api_key", "")
        if cfg.get(k) != v:
            cfg[k] = v
            changed.append(k)

    if not changed:
        return jsonify({"ok": True, "changed": []})

    # 持久化
    save_config(cfg)
    logger.info("[API] 配置已更新: %s", changed)

    # 热重载 AI 客户端 (无需重启)
    from ai.ai_client import AIClient
    new_ai = AIClient(cfg)
    ctx["ai_client"] = new_ai
    logger.info("[API] AI 客户端已热重载")

    return jsonify({"ok": True, "changed": changed})


# ═══════════════════════════════════════
#  Workflow API (可视化工作流)
# ═══════════════════════════════════════

@page_bp.route("/workflow")
def workflow_page():
    return render_template("workflow.html")


@api_bp.route("/workflow/node-types", methods=["GET"])
@_require_perm("workflow")
def workflow_node_types():
    """返回所有已注册的节点类型"""
    from plugins.workflow.node_base import NodeRegistry
    return jsonify(NodeRegistry.list_types())


@api_bp.route("/workflow/tools", methods=["GET"])
@_require_perm("workflow")
def workflow_tools():
    """返回所有已注册的服务器工具"""
    from plugins.workflow.tools import ToolRegistry
    return jsonify(ToolRegistry.list_tools())


@api_bp.route("/workflow/list", methods=["GET"])
@_require_perm("workflow")
def workflow_list():
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify([])
    return jsonify(engine.list_workflows())


@api_bp.route("/workflow/<wf_id>", methods=["GET"])
@_require_perm("workflow")
def workflow_get(wf_id):
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    data = engine.load_workflow(wf_id)
    if not data:
        return jsonify({"error": "not found"}), 404
    return jsonify(data)


@api_bp.route("/workflow/<wf_id>", methods=["PUT"])
@_require_perm("workflow")
def workflow_save(wf_id):
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    data = request.get_json()
    if not data:
        return jsonify({"error": "no data"}), 400
    engine.save_workflow(wf_id, data)
    return jsonify({"ok": True})


@api_bp.route("/workflow/<wf_id>", methods=["DELETE"])
@_require_perm("workflow")
def workflow_delete(wf_id):
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    engine.delete_workflow(wf_id)
    return jsonify({"ok": True})


def _safe_outputs(outputs):
    """将输出转换为 JSON 可序列化"""
    return {k: str(v) if not isinstance(v, (str, int, float, bool, list, dict, type(None))) else v
            for k, v in outputs.items()}


@api_bp.route("/workflow/<wf_id>/execute", methods=["POST"])
@_require_perm("workflow")
def workflow_execute(wf_id):
    """执行已保存的工作流"""
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    workflow = engine.load_workflow(wf_id)
    if not workflow:
        return jsonify({"error": "not found"}), 404
    overrides = (request.get_json() or {}).get("overrides", {})
    try:
        outputs = engine.execute(workflow, overrides, wf_id=wf_id)
        return jsonify({"ok": True, "outputs": _safe_outputs(outputs)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/workflow/run-inline", methods=["POST"])
@_require_perm("workflow")
def workflow_run_inline():
    """传入完整工作流 JSON 并异步执行, 前端通过轮询 state 获取渐进输出"""
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    data = request.get_json()
    if not data or "nodes" not in data:
        return jsonify({"error": "invalid workflow"}), 400
    overrides = data.get("overrides", {})
    wf_id = data.get("wf_id", "")
    if not wf_id:
        wf_id = "tmp_" + str(int(__import__('time').time() * 1000))
        data["wf_id"] = wf_id

    import threading
    def _bg():
        try:
            engine.execute(data, overrides, wf_id=wf_id)
        except Exception as e:
            import logging
            logging.getLogger(__name__).error("[Workflow] bg exec error: %s", e)
            # 确保 running 置为 False, 前端不会永远轮询
            engine._update_state(wf_id, {"_error": f"[Error] {e}"}, running=False)

    threading.Thread(target=_bg, daemon=True).start()
    return jsonify({"ok": True, "async": True, "wf_id": wf_id})


@api_bp.route("/workflow/node-output/<node_id>", methods=["GET"])
@_require_perm("workflow")
def workflow_node_output(node_id):
    """读取节点的实时输出文件内容"""
    from plugins.workflow.builtin_nodes import _get_node_output_path
    import os
    path = _get_node_output_path(node_id)
    content = ""
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except Exception:
            pass
    return jsonify({"content": content})


@api_bp.route("/workflow/<wf_id>/state", methods=["GET"])
@_require_perm("workflow")
def workflow_state(wf_id):
    """轮询: 获取工作流最新运行状态和各节点输出"""
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    st = engine.get_state(wf_id)
    st["outputs"] = _safe_outputs(st.get("outputs", {}))
    return jsonify(st)


@api_bp.route("/workflow/<wf_id>/timer/start", methods=["POST"])
@_require_perm("workflow")
def workflow_timer_start(wf_id):
    """启动工作流的服务端定时器"""
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    try:
        engine.start_timer(wf_id)
        return jsonify({"ok": True, "msg": "定时器已启动"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/workflow/<wf_id>/timer/stop", methods=["POST"])
@_require_perm("workflow")
def workflow_timer_stop(wf_id):
    """停止工作流的服务端定时器"""
    engine = _ctx().get("workflow_engine")
    if not engine:
        return jsonify({"error": "engine not init"}), 500
    engine.stop_timer(wf_id)
    return jsonify({"ok": True, "msg": "定时器已停止"})


# ═══════════════════════════════════════
#  Plugin API
# ═══════════════════════════════════════
@api_bp.route("/plugins", methods=["GET"])
@_require_perm("plugins")
def list_plugins():
    pm = _ctx()["plugin_manager"]
    infos = pm.get_plugin_info()
    return jsonify([
        {"name": i.get("name"), "version": i.get("version"), "description": i.get("description")}
        for i in infos
    ])


@api_bp.route("/plugins/<int:idx>/execute", methods=["POST"])
@_require_perm("plugins")
def execute_plugin(idx):
    plugins = _ctx()["plugin_manager"].get_plugins()
    if 0 <= idx < len(plugins):
        try:
            result = plugins[idx].execute()
            return jsonify({"result": result or "执行完成"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "plugin not found"}), 404


# ═══════════════════════════════════════
#  Patch Review API
# ═══════════════════════════════════════
@page_bp.route("/patch-review")
def patch_review_page():
    return render_template("patch_review.html")


@page_bp.route("/server-files")
def server_files_page():
    return render_template("server_files.html")


def _patch_svc():
    return _ctx().get("patch_service")


@api_bp.route("/patch/config", methods=["GET"])
@_require_perm("patch_review")
def patch_config_get():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    return jsonify(svc.get_config())


@api_bp.route("/patch/config", methods=["PUT"])
@_require_perm("patch_review")
def patch_config_set():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    data = request.get_json() or {}
    svc.set_config(scan_dir=data.get("scan_dir"), interval=data.get("interval"))
    return jsonify({"ok": True, **svc.get_config()})


@api_bp.route("/patch/collections", methods=["GET"])
@_require_perm("patch_review")
def patch_collections():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    colls = svc.scan_collections()
    # 轻量化: 去掉 files 子节点, 列表页不需要
    for c in colls:
        c.pop("files", None)
    return jsonify(colls)


@api_bp.route("/patch/collection/<path:coll_key>/files", methods=["GET"])
@_require_perm("patch_review")
def patch_collection_files(coll_key):
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    colls = svc.scan_collections()
    for c in colls:
        if c["key"] == coll_key:
            return jsonify(c["files"])
    return jsonify({"error": "not found"}), 404


@api_bp.route("/patch/file", methods=["GET"])
@_require_perm("patch_review")
def patch_read_file():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    coll_key = request.args.get("collection", "")
    file_path = request.args.get("path", "")
    if not coll_key or not file_path:
        return jsonify({"error": "missing params"}), 400
    result = svc.read_file(coll_key, file_path)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@api_bp.route("/patch/import", methods=["POST"])
@_require_perm("patch_review")
def patch_import():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    data = request.get_json() or {}
    coll_key = data.get("collection")
    force = data.get("force", False)
    if coll_key:
        return jsonify(svc.import_collection(coll_key, force=force))
    else:
        return jsonify(svc.import_all_new(force=force))


@api_bp.route("/patch/search", methods=["GET"])
@_require_perm("patch_review")
def patch_search():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    q = request.args.get("q", "")
    if not q:
        return jsonify([])
    return jsonify(svc.search(q))


@api_bp.route("/patch/db/summary", methods=["GET"])
@_require_perm("patch_review")
def patch_db_summary():
    """已导入集合的摘要列表"""
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    return jsonify(svc.get_imported_summary())


@api_bp.route("/patch/db/docs", methods=["GET"])
@_require_perm("patch_review")
def patch_db_docs():
    """所有 patch 文档列表 (从 DB 查询)"""
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    return jsonify(svc.get_imported_docs())


@api_bp.route("/patch/db/delete-collection", methods=["POST"])
@_require_perm("patch_review")
def patch_db_delete_collection():
    """删除某个集合的所有 patch 文档"""
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    data = request.get_json() or {}
    coll_key = data.get("collection", "")
    if not coll_key:
        return jsonify({"error": "missing collection"}), 400
    return jsonify(svc.delete_collection_docs(coll_key))


@api_bp.route("/patch/db/delete-doc", methods=["POST"])
@_require_perm("patch_review")
def patch_db_delete_doc():
    """删除单个 patch 文档"""
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    data = request.get_json() or {}
    doc_id = data.get("doc_id")
    if not doc_id:
        return jsonify({"error": "missing doc_id"}), 400
    return jsonify(svc.delete_single_doc(int(doc_id)))


@api_bp.route("/patch/db/delete-all", methods=["POST"])
@_require_perm("patch_review")
def patch_db_delete_all():
    """清空所有 patch 文档"""
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    return jsonify(svc.delete_all_patch_docs())


@api_bp.route("/patch/timer/start", methods=["POST"])
@_require_perm("patch_review")
def patch_timer_start():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    try:
        svc.start_timer()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/patch/timer/stop", methods=["POST"])
@_require_perm("patch_review")
def patch_timer_stop():
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    svc.stop_timer()
    return jsonify({"ok": True})


@api_bp.route("/patch/download", methods=["GET"])
@_require_perm("patch_review")
def patch_download():
    """下载目录为 zip, 支持 collection 级别和子目录级别"""
    import zipfile, io
    svc = _patch_svc()
    if not svc or not svc.scan_dir:
        return jsonify({"error": "patch_service not configured"}), 500
    coll_key = request.args.get("collection", "")
    sub_path = request.args.get("path", "")
    if not coll_key:
        return jsonify({"error": "missing collection"}), 400
    target = os.path.join(svc.scan_dir, coll_key)
    if sub_path:
        target = os.path.join(target, sub_path)
    target = os.path.normpath(target)
    if not target.startswith(os.path.normpath(svc.scan_dir)):
        return jsonify({"error": "path out of scope"}), 400
    if os.path.isfile(target):
        return send_file(target, as_attachment=True)
    if not os.path.isdir(target):
        return jsonify({"error": "not found"}), 404
    buf = io.BytesIO()
    zip_name = os.path.basename(target)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, _, filenames in os.walk(target):
            for fn in filenames:
                full = os.path.join(dirpath, fn)
                arcname = os.path.join(zip_name, os.path.relpath(full, target))
                zf.write(full, arcname)
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                     download_name=f"{zip_name}.zip")


@api_bp.route("/patch/generate-fix", methods=["POST"])
@_require_perm("patch_review")
def patch_generate_fix():
    """AI 根据问题描述生成修复后的完整 patch"""
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    data = request.get_json() or {}
    coll_key = data.get("collection", "")
    file_path = data.get("path", "")
    issue = data.get("issue", "")
    if not coll_key or not file_path or not issue:
        return jsonify({"error": "missing params (collection, path, issue)"}), 400
    return jsonify(svc.generate_fix(coll_key, file_path, issue))


@api_bp.route("/patch/apply-fix", methods=["POST"])
@_require_perm("patch_review")
def patch_apply_fix():
    """将修复后的 patch 内容写回源文件并同步 DB"""
    svc = _patch_svc()
    if not svc:
        return jsonify({"error": "patch_service not init"}), 500
    data = request.get_json() or {}
    coll_key = data.get("collection", "")
    file_path = data.get("path", "")
    fixed_content = data.get("fixed_content", "")
    if not coll_key or not file_path or not fixed_content:
        return jsonify({"error": "missing params (collection, path, fixed_content)"}), 400
    return jsonify(svc.apply_fix(coll_key, file_path, fixed_content))


@api_bp.route("/patch/annotations", methods=["GET"])
@_require_perm("patch_review")
def patch_annotations_get():
    """获取指定文件的所有标注"""
    db = _ctx().get("db")
    if not db:
        return jsonify({"error": "db not init"}), 500
    coll = request.args.get("collection", "")
    path = request.args.get("path", "")
    if not coll or not path:
        return jsonify({"error": "missing params"}), 400
    return jsonify(db.get_annotations(coll, path))


@api_bp.route("/patch/annotations", methods=["POST"])
@_require_perm("patch_review")
def patch_annotations_add():
    """新增标注"""
    db = _ctx().get("db")
    if not db:
        return jsonify({"error": "db not init"}), 500
    data = request.get_json() or {}
    coll = data.get("collection", "")
    path = data.get("path", "")
    line_num = data.get("line_num")
    content = data.get("content", "").strip()
    color = data.get("color", "yellow")
    if not coll or not path or line_num is None or not content:
        return jsonify({"error": "missing params"}), 400
    ann_id = db.add_annotation(coll, path, int(line_num), content, color)
    return jsonify({"ok": True, "id": ann_id})


@api_bp.route("/patch/annotations/<int:ann_id>", methods=["PUT"])
@_require_perm("patch_review")
def patch_annotations_update(ann_id):
    """更新标注"""
    db = _ctx().get("db")
    if not db:
        return jsonify({"error": "db not init"}), 500
    data = request.get_json() or {}
    content = data.get("content", "").strip()
    color = data.get("color")
    if not content:
        return jsonify({"error": "content is empty"}), 400
    db.update_annotation(ann_id, content, color)
    return jsonify({"ok": True})


@api_bp.route("/patch/annotations/<int:ann_id>", methods=["DELETE"])
@_require_perm("patch_review")
def patch_annotations_delete(ann_id):
    """删除标注"""
    db = _ctx().get("db")
    if not db:
        return jsonify({"error": "db not init"}), 500
    db.delete_annotation(ann_id)
    return jsonify({"ok": True})


@api_bp.route("/patch/ask", methods=["POST"])
@_require_perm("patch_review")
def patch_ask():
    """基于当前 patch 文件内容的 AI 问答 — SSE 流式输出, 支持选择模型"""
    import json as _json
    import re as _re
    data = request.get_json() or {}
    question = data.get("question", "")
    context = data.get("context", "")
    model_name = data.get("model_name", "").strip()
    if not question:
        return jsonify({"error": "missing question"}), 400
    ai = _get_ai_for_model(model_name)
    if not ai.is_configured():
        return jsonify({"error": "AI 未配置, 请先在系统设置中配置 API Key"}), 400
    if context:
        context = _re.sub(r'!\[[^\]]*\]\(data:[^)]+\)', '[图片]', context)
    if len(context) > 200000:
        context = context[:200000] + "\n\n...(内容过长, 后续已省略)"

    def generate():
        try:
            system = "你是一个专业的代码审查助手，擅长分析 patch、代码变更和 diff。请用中文回答。"
            if context:
                prompt = (
                    "基于以下代码/patch 内容回答问题。如果内容不足以回答，请说明。\n\n"
                    f"内容:\n{context}\n\n问题: {question}"
                )
                for token in ai.generate_text_stream(prompt, system=system):
                    yield f"data: {_json.dumps({'t': token})}\n\n"
            else:
                for token in ai.generate_text_stream(question, system=system):
                    yield f"data: {_json.dumps({'t': token})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("[API] patch/ask 流式异常: %s", e)
            yield f"data: {_json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ═══════════════════════════════════════
#  Tool Management API (工具管理)
# ═══════════════════════════════════════
def _tool_svc():
    return _ctx().get("tool_service")


@page_bp.route("/tools")
def tools_page():
    return render_template("tools.html")


@page_bp.route("/tools/<int:tool_id>")
def tool_detail_page(tool_id):
    return render_template("tool_detail.html", tool_id=tool_id)


# ── 工具 AI 问答 ──
@api_bp.route("/tools/<int:tool_id>/chat", methods=["POST"])
@_require_login
def tool_chat(tool_id):
    """基于工具描述进行 AI 问答 — SSE 流式输出"""
    import json as _json
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    tool = svc.get_tool(tool_id)
    if not tool:
        return jsonify({"error": "工具不存在"}), 404

    data = request.get_json() or {}
    query = data.get("query", "").strip()
    history = data.get("history", [])
    model_name = data.get("model_name", "").strip()
    # 支持附带的文件内容作为额外上下文
    file_context = data.get("file_context", "").strip()

    if not query:
        return jsonify({"error": "query required"}), 400

    ai = _get_ai_for_model(model_name)
    if not ai.is_configured():
        return jsonify({"error": "请先配置 API Key"}), 400

    system = (
        f"你是一个工具使用助手。当前工具信息如下：\n"
        f"工具名称：{tool['name']}\n"
        f"工具描述：{tool['description']}\n"
        f"工具类型：{tool['upload_type']}\n"
        f"工具分类：{tool.get('category_name', 'misc')}\n\n"
        f"请根据以上工具信息回答用户的问题，提供使用建议、参数说明、"
        f"注意事项等。用中文回答。"
    )
    if file_context:
        system += f"\n\n以下是用户正在查看的文件内容，可供参考：\n{file_context[:50000]}"

    def generate():
        try:
            msgs = [{"role": "system", "content": system}]
            for h in history[-10:]:
                msgs.append({"role": h.get("role", "user"), "content": h.get("content", "")})
            msgs.append({"role": "user", "content": query})
            for token in ai.chat(msgs, stream=True):
                yield f"data: {_json.dumps({'t': token})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("[API] tool/chat 流式异常: %s", e)
            yield f"data: {_json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── 分类 ──
@api_bp.route("/tools/categories", methods=["GET"])
@_require_login
def tool_categories():
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    return jsonify(svc.list_categories())


@api_bp.route("/tools/categories", methods=["POST"])
@_require_login
def tool_category_add():
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    desc = data.get("description", "").strip()
    if not name:
        return jsonify({"error": "分类名称不能为空"}), 400
    try:
        cat = svc.add_category(name, desc)
        return jsonify(cat)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/tools/categories/<int:cat_id>", methods=["DELETE"])
@_require_login
def tool_category_delete(cat_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    try:
        svc.delete_category(cat_id)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ── 工具上传 ──
@api_bp.route("/tools/upload/file", methods=["POST"])
@_require_login
def tool_upload_file():
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    if "file" not in request.files:
        return jsonify({"error": "缺少文件"}), 400
    f = request.files["file"]
    name = request.form.get("name", "").strip()
    desc = request.form.get("description", "").strip()
    cat_id = int(request.form.get("category_id", 0))
    if not name or not desc:
        return jsonify({"error": "名称和描述不能为空"}), 400
    try:
        result = svc.upload_file(f, name, desc, cat_id)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/tools/upload/folder", methods=["POST"])
@_require_login
def tool_upload_folder():
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    if "file" not in request.files:
        return jsonify({"error": "缺少ZIP文件"}), 400
    f = request.files["file"]
    name = request.form.get("name", "").strip()
    desc = request.form.get("description", "").strip()
    cat_id = int(request.form.get("category_id", 0))
    if not name or not desc:
        return jsonify({"error": "名称和描述不能为空"}), 400
    try:
        result = svc.upload_folder(f, name, desc, cat_id)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ── 工具列表 / 检索 ──
@api_bp.route("/tools", methods=["GET"])
@_require_login
def tool_list():
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    cat_id = request.args.get("category_id", type=int)
    keyword = request.args.get("keyword", "").strip()
    return jsonify(svc.search_tools(category_id=cat_id, keyword=keyword))


@api_bp.route("/tools/<int:tool_id>", methods=["GET"])
@_require_login
def tool_detail(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    tool = svc.get_tool(tool_id)
    if not tool:
        return jsonify({"error": "工具不存在"}), 404
    return jsonify(tool)


@api_bp.route("/tools/<int:tool_id>", methods=["DELETE"])
@_require_login
def tool_delete(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    try:
        svc.delete_tool(tool_id)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ── 下载 ──
@api_bp.route("/tools/<int:tool_id>/download", methods=["GET"])
@_require_login
def tool_download(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    tool = svc.get_tool(tool_id)
    if not tool:
        return jsonify({"error": "工具不存在"}), 404
    zip_path = svc.get_download_zip(tool_id)
    if not zip_path:
        return jsonify({"error": "工具文件不存在"}), 404
    return send_file(zip_path, as_attachment=True,
                     download_name=f"{tool['name']}.zip")


@api_bp.route("/tools/<int:tool_id>/download-file", methods=["GET"])
@_require_login
def tool_download_file(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    sub = request.args.get("path", "")
    if not sub:
        return jsonify({"error": "缺少文件路径"}), 400
    abs_path = svc.get_file_abs_path(tool_id, sub)
    if not abs_path:
        return jsonify({"error": "文件不存在"}), 404
    return send_file(abs_path, as_attachment=True)


# ── 目录浏览 ──
@api_bp.route("/tools/<int:tool_id>/browse", methods=["GET"])
@_require_login
def tool_browse(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    sub = request.args.get("path", "")
    try:
        return jsonify(svc.browse_tool_dir(tool_id, sub))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/tools/<int:tool_id>/read", methods=["GET"])
@_require_login
def tool_read_file(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    sub = request.args.get("path", "")
    if not sub:
        return jsonify({"error": "缺少文件路径"}), 400
    content = svc.read_tool_file(tool_id, sub)
    if content is None:
        return jsonify({"error": "文件不存在或无法读取"}), 404
    return jsonify({"content": content, "path": sub})


# ── 使用经验 ──
@api_bp.route("/tools/<int:tool_id>/experiences", methods=["GET"])
@_require_login
def tool_experiences_list(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    return jsonify(svc.get_experiences(tool_id))


@api_bp.route("/tools/<int:tool_id>/experiences", methods=["POST"])
@_require_login
def tool_experience_add(tool_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    content = data.get("content", "").strip()
    if not title:
        return jsonify({"error": "主题不能为空"}), 400
    try:
        exp = svc.add_experience(tool_id, title, content)
        return jsonify(exp)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/tools/experiences/<int:exp_id>", methods=["PUT"])
@_require_login
def tool_experience_update(exp_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    data = request.get_json() or {}
    title = data.get("title", "").strip()
    content = data.get("content", "").strip()
    if not title:
        return jsonify({"error": "主题不能为空"}), 400
    try:
        exp = svc.update_experience(exp_id, title, content)
        return jsonify(exp)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@api_bp.route("/tools/experiences/<int:exp_id>", methods=["DELETE"])
@_require_login
def tool_experience_delete(exp_id):
    svc = _tool_svc()
    if not svc:
        return jsonify({"error": "tool_service not init"}), 500
    try:
        svc.delete_experience(exp_id)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════
#  Server File Manager API
# ═══════════════════════════════════════
def _safe_resolve(base: str, rel: str) -> str:
    """确保路径不会逃逸出 base 目录"""
    full = os.path.normpath(os.path.join(base, rel))
    if not full.startswith(os.path.normpath(base)):
        return None
    return full


@api_bp.route("/server-files/browse", methods=["POST"])
@_require_perm("files")
def sfm_browse():
    """浏览指定服务器路径的文件结构 (单层)"""
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    if not root:
        return jsonify({"error": "请输入服务器目录路径"}), 400
    root = os.path.normpath(root)
    if not os.path.isdir(root):
        return jsonify({"error": f"目录不存在: {root}"}), 400
    target = _safe_resolve(root, rel) if rel else root
    if not target or not os.path.isdir(target):
        return jsonify({"error": "目标路径不存在或不是目录"}), 400
    items = []
    try:
        for name in sorted(os.listdir(target), key=lambda n: (not os.path.isdir(os.path.join(target, n)), n.lower())):
            full = os.path.join(target, name)
            rel_path = os.path.relpath(full, root).replace("\\", "/")
            if os.path.isdir(full):
                items.append({"name": name, "path": rel_path, "type": "dir"})
            else:
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    sz = 0
                items.append({"name": name, "path": rel_path, "type": "file", "size": sz})
    except PermissionError:
        return jsonify({"error": "无权限读取此目录"}), 403
    return jsonify({"root": root, "rel": rel, "items": items})


@api_bp.route("/server-files/read", methods=["POST"])
@_require_perm("files")
def sfm_read():
    """读取文件内容"""
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    if not root or not rel:
        return jsonify({"error": "缺少参数"}), 400
    full = _safe_resolve(root, rel)
    if not full or not os.path.isfile(full):
        return jsonify({"error": "文件不存在"}), 404
    try:
        sz = os.path.getsize(full)
        if sz > 5 * 1024 * 1024:
            return jsonify({"error": "文件过大 (>5MB)，不支持在线编辑"}), 400
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        return jsonify({"path": rel, "content": content, "size": sz})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/write", methods=["POST"])
@_require_perm("files")
def sfm_write():
    """写入文件内容 (记录操作历史)"""
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    content = data.get("content", "")
    if not root or not rel:
        return jsonify({"error": "缺少参数"}), 400
    full = _safe_resolve(root, rel)
    if not full:
        return jsonify({"error": "路径非法"}), 400
    user = _current_user()
    db = _ctx()["db"]
    # 读取旧内容用于回滚
    old_content = None
    if os.path.isfile(full):
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                old_content = f.read()
        except Exception:
            pass
    try:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        db.add_file_op(user["username"], "write", full, old_content, content)
        return jsonify({"ok": True, "msg": "保存成功"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/sync", methods=["POST"])
@_require_perm("files")
def sfm_sync():
    """将文件同步写入到指定的同步目标目录"""
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    sync_root = (data.get("sync_root") or "").strip()
    content = data.get("content", "")
    if not root or not rel or not sync_root:
        return jsonify({"error": "缺少参数 (root, path, sync_root)"}), 400
    # 目标路径 = sync_root + 相对路径
    target = os.path.normpath(os.path.join(sync_root, rel))
    # 安全检查: 目标必须在 sync_root 下
    if not target.startswith(os.path.normpath(sync_root)):
        return jsonify({"error": "同步目标路径非法"}), 400
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
        # 返回简短路径供前端提示
        short = rel.replace("\\", "/")
        if len(short) > 50:
            short = "..." + short[-47:]
        logger.info("[SFM同步] %s -> %s", rel, target)
        return jsonify({"ok": True, "target": target, "target_short": short})
    except Exception as e:
        logger.error("[SFM同步] 失败: %s -> %s, err=%s", rel, target, e)
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/rename", methods=["POST"])
@_require_perm("files")
def sfm_rename():
    """重命名文件或目录"""
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    new_name = (data.get("new_name") or "").strip()
    if not root or not rel or not new_name:
        return jsonify({"error": "缺少参数"}), 400
    full = _safe_resolve(root, rel)
    if not full or not os.path.exists(full):
        return jsonify({"error": "路径不存在"}), 404
    new_full = os.path.join(os.path.dirname(full), new_name)
    new_full = os.path.normpath(new_full)
    if not new_full.startswith(os.path.normpath(root)):
        return jsonify({"error": "路径非法"}), 400
    if os.path.exists(new_full):
        return jsonify({"error": "目标已存在"}), 400
    user = _current_user()
    db = _ctx()["db"]
    try:
        os.rename(full, new_full)
        db.add_file_op(user["username"], "rename", full, extra=new_full)
        return jsonify({"ok": True, "msg": "重命名成功"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/delete", methods=["POST"])
@_require_perm("files")
def sfm_delete():
    """删除文件"""
    import shutil
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    if not root or not rel:
        return jsonify({"error": "缺少参数"}), 400
    full = _safe_resolve(root, rel)
    if not full or not os.path.exists(full):
        return jsonify({"error": "路径不存在"}), 404
    user = _current_user()
    db = _ctx()["db"]
    try:
        old_content = None
        if os.path.isfile(full):
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    old_content = f.read()
            except Exception:
                pass
            os.remove(full)
            db.add_file_op(user["username"], "delete", full, old_content=old_content)
        elif os.path.isdir(full):
            shutil.rmtree(full)
            db.add_file_op(user["username"], "delete_dir", full)
        return jsonify({"ok": True, "msg": "删除成功"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/mkdir", methods=["POST"])
@_require_perm("files")
def sfm_mkdir():
    """创建目录"""
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    name = (data.get("name") or "").strip()
    if not root or not name:
        return jsonify({"error": "缺少参数"}), 400
    base = _safe_resolve(root, rel) if rel else root
    if not base:
        return jsonify({"error": "路径非法"}), 400
    new_dir = os.path.join(base, name)
    new_dir = os.path.normpath(new_dir)
    if not new_dir.startswith(os.path.normpath(root)):
        return jsonify({"error": "路径非法"}), 400
    if os.path.exists(new_dir):
        return jsonify({"error": "目录已存在"}), 400
    user = _current_user()
    db = _ctx()["db"]
    try:
        os.makedirs(new_dir, exist_ok=True)
        db.add_file_op(user["username"], "mkdir", new_dir)
        return jsonify({"ok": True, "msg": "创建成功"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/create-file", methods=["POST"])
@_require_perm("files")
def sfm_create_file():
    """创建新文件"""
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    rel = (data.get("path") or "").strip()
    name = (data.get("name") or "").strip()
    if not root or not name:
        return jsonify({"error": "缺少参数"}), 400
    base = _safe_resolve(root, rel) if rel else root
    if not base:
        return jsonify({"error": "路径非法"}), 400
    new_file = os.path.join(base, name)
    new_file = os.path.normpath(new_file)
    if not new_file.startswith(os.path.normpath(root)):
        return jsonify({"error": "路径非法"}), 400
    if os.path.exists(new_file):
        return jsonify({"error": "文件已存在"}), 400
    user = _current_user()
    db = _ctx()["db"]
    try:
        os.makedirs(os.path.dirname(new_file), exist_ok=True)
        with open(new_file, "w", encoding="utf-8") as f:
            f.write("")
        db.add_file_op(user["username"], "create", new_file)
        return jsonify({"ok": True, "msg": "创建成功"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/history", methods=["POST"])
@_require_perm("files")
def sfm_history():
    """获取文件操作记录"""
    data = request.get_json() or {}
    file_path = (data.get("file_path") or "").strip()
    limit = data.get("limit", 50)
    db = _ctx()["db"]
    # 规范化路径以确保匹配
    if file_path:
        file_path = os.path.normpath(file_path)
    ops = db.get_file_ops(file_path=file_path or None, limit=limit)
    return jsonify(ops)


@api_bp.route("/server-files/history-detail", methods=["POST"])
@_require_perm("files")
def sfm_history_detail():
    """获取单条操作的详细内容(含 diff)"""
    import difflib
    data = request.get_json() or {}
    op_id = data.get("op_id")
    if not op_id:
        return jsonify({"error": "缺少 op_id"}), 400
    db = _ctx()["db"]
    op = db.get_file_op_by_id(int(op_id))
    if not op:
        return jsonify({"error": "操作记录不存在"}), 404
    old = op.get("old_content") or ""
    new = op.get("new_content") or ""
    diff_lines = []
    if op["op_type"] == "write" and (old or new):
        diff_lines = list(difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile="修改前",
            tofile="修改后",
            lineterm="",
        ))
    elif op["op_type"] == "delete":
        if old:
            diff_lines = [f"- {l}" for l in old.splitlines()]
    elif op["op_type"] == "create":
        if new:
            diff_lines = [f"+ {l}" for l in new.splitlines()]
    # 限制 diff 长度
    if len(diff_lines) > 2000:
        diff_lines = diff_lines[:2000] + ["... (diff 过长, 已截断)"]
    return jsonify({
        "id": op["id"],
        "op_type": op["op_type"],
        "file_path": op["file_path"],
        "username": op.get("username", ""),
        "extra": op.get("extra", ""),
        "created_at": op.get("created_at", ""),
        "has_old": old != "",
        "has_new": new != "",
        "old_lines": len(old.splitlines()) if old else 0,
        "new_lines": len(new.splitlines()) if new else 0,
        "diff": "\n".join(diff_lines),
    })


@api_bp.route("/server-files/find", methods=["POST"])
@_require_perm("files")
def sfm_find():
    """在目录中搜索文件名 (使用 find / dir)"""
    import subprocess, platform
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    pattern = (data.get("pattern") or "").strip()
    if not root or not pattern:
        return jsonify({"error": "缺少 root 或 pattern"}), 400
    if not os.path.isdir(root):
        return jsonify({"error": "目录不存在"}), 400
    try:
        if platform.system() == "Windows":
            cmd = ["cmd", "/c", "dir", "/s", "/b", os.path.join(root, f"*{pattern}*")]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15, cwd=root)
            raw = result.stdout.strip()
        else:
            cmd = ["find", root, "-maxdepth", "8", "-iname", f"*{pattern}*", "-not", "-path", "*/.*"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            raw = result.stdout.strip()
        lines = [l.strip() for l in raw.split('\n') if l.strip()] if raw else []
        # 转换为相对路径 + 类型
        norm_root = os.path.normpath(root)
        items = []
        for full in lines[:500]:
            full_n = os.path.normpath(full)
            if full_n.startswith(norm_root):
                rel = full_n[len(norm_root):].lstrip(os.sep).replace(os.sep, '/')
            else:
                rel = full_n.replace(os.sep, '/')
            is_dir = os.path.isdir(full_n)
            sz = 0
            if not is_dir:
                try: sz = os.path.getsize(full_n)
                except: pass
            items.append({"path": rel, "name": os.path.basename(full_n), "type": "dir" if is_dir else "file", "size": sz})
        return jsonify({"items": items, "total": len(lines)})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "搜索超时"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/grep", methods=["POST"])
@_require_perm("files")
def sfm_grep():
    """在目录中搜索文件内容 (使用 grep / findstr)"""
    import subprocess, platform
    data = request.get_json() or {}
    root = (data.get("root") or "").strip()
    query = (data.get("query") or "").strip()
    if not root or not query:
        return jsonify({"error": "缺少 root 或 query"}), 400
    if not os.path.isdir(root):
        return jsonify({"error": "目录不存在"}), 400
    try:
        if platform.system() == "Windows":
            cmd = ["findstr", "/s", "/i", "/n", "/p", query, os.path.join(root, "*")]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=20, cwd=root)
        else:
            cmd = ["grep", "-r", "-i", "-n", "--include=*", "-m", "5", query, root]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        raw = result.stdout.strip()
        lines = [l for l in raw.split('\n') if l.strip()] if raw else []
        norm_root = os.path.normpath(root)
        matches = []
        seen_files = {}
        for line in lines[:300]:
            # 格式: filepath:linenum:content
            parts = line.split(':', 2)
            if len(parts) < 3:
                parts = line.split(':', 1)
                if len(parts) < 2:
                    continue
                fpath, content = parts[0], parts[1]
                linenum = 0
            else:
                fpath, linenum_s, content = parts[0], parts[1], parts[2]
                try: linenum = int(linenum_s)
                except: linenum = 0
            full_n = os.path.normpath(fpath)
            if full_n.startswith(norm_root):
                rel = full_n[len(norm_root):].lstrip(os.sep).replace(os.sep, '/')
            else:
                rel = full_n.replace(os.sep, '/')
            if rel not in seen_files:
                seen_files[rel] = []
            seen_files[rel].append({"line": linenum, "content": content.strip()[:200]})
        # 组织为按文件分组
        results = []
        for fpath, hits in seen_files.items():
            results.append({"path": fpath, "name": os.path.basename(fpath), "hits": hits})
        return jsonify({"results": results, "total_hits": len(lines)})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "搜索超时"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/exec", methods=["POST"])
@_require_perm("files")
def sfm_exec():
    """在指定目录执行终端命令"""
    import subprocess, platform
    data = request.get_json() or {}
    cwd = (data.get("cwd") or "").strip()
    cmd = (data.get("cmd") or "").strip()
    if not cwd or not cmd:
        return jsonify({"error": "缺少 cwd 或 cmd"}), 400
    if not os.path.isdir(cwd):
        return jsonify({"error": "目录不存在"}), 400
    logger.info("[SFM终端] cwd=%s, cmd=%s, user=%s", cwd, cmd, _current_user().get("username"))
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True,
                timeout=30, cwd=cwd, encoding="utf-8", errors="replace",
            )
        else:
            result = subprocess.run(
                ["bash", "-c", cmd], capture_output=True, text=True,
                timeout=30, cwd=cwd,
            )
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        # 限制输出长度
        if len(stdout) > 50000:
            stdout = stdout[:50000] + "\n...(输出过长, 已截断)"
        if len(stderr) > 10000:
            stderr = stderr[:10000] + "\n...(错误输出过长, 已截断)"
        return jsonify({
            "stdout": stdout,
            "stderr": stderr,
            "code": result.returncode,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"error": "命令执行超时 (30s)"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/format", methods=["POST"])
@_require_perm("files")
def sfm_format():
    """使用 AI 格式化/标准化代码"""
    import re as _re
    data = request.get_json() or {}
    content = data.get("content", "")
    lang = data.get("lang", "").strip()
    filename = data.get("filename", "").strip()
    model_name = data.get("model_name", "").strip()
    if not content.strip():
        return jsonify({"error": "内容为空"}), 400
    if len(content) > 200000:
        return jsonify({"error": "文件过大, 不支持格式化"}), 400
    ai = _get_ai_for_model(model_name)
    if not ai.is_configured():
        return jsonify({"error": "AI 未配置, 请先在系统设置中配置 API Key"}), 400
    system = (
        "你是一个专业的代码格式化工具。你的任务是将用户提供的代码按照该编程语言的官方编码规范和最佳实践进行格式化和标准化。\n"
        "规则:\n"
        "1. 只输出格式化后的代码，不要输出任何解释、注释或 markdown 代码块标记\n"
        "2. 保持代码逻辑完全不变，只调整格式\n"
        "3. 统一缩进风格(Python用4空格, JS/TS用2空格, Java/C/C++用4空格等)\n"
        "4. 规范空行、空格、括号位置\n"
        "5. 保留所有原始注释，但规范注释格式\n"
        "6. 如果无法识别语言，按通用编码规范处理\n"
        "7. 不要添加或删除任何代码逻辑"
    )
    prompt = f"请格式化以下 {lang} 代码 (文件: {filename}):\n\n{content}"
    try:
        result = ""
        for token in ai.generate_text_stream(prompt, system=system):
            result += token
        # 去除可能的 markdown 代码块包裹
        result = result.strip()
        if result.startswith("```"):
            lines = result.split("\n")
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            result = "\n".join(lines)
        # 确保末尾有换行符(如果原文有)
        if content.endswith("\n") and not result.endswith("\n"):
            result += "\n"
        return jsonify({"formatted": result, "lang": lang})
    except Exception as e:
        logger.error("[SFM格式化] 异常: %s", e)
        return jsonify({"error": str(e)}), 500


@api_bp.route("/server-files/ask", methods=["POST"])
@_require_perm("files")
def sfm_ask():
    """基于当前文件内容的 AI 问答 — SSE 流式输出"""
    import json as _json
    import re as _re
    data = request.get_json() or {}
    question = data.get("question", "")
    context = data.get("context", "")
    model_name = data.get("model_name", "").strip()
    if not question:
        return jsonify({"error": "missing question"}), 400
    ai = _get_ai_for_model(model_name)
    if not ai.is_configured():
        return jsonify({"error": "AI 未配置, 请先在系统设置中配置 API Key"}), 400
    if context:
        context = _re.sub(r'!\[[^\]]*\]\(data:[^)]+\)', '[图片]', context)
    if len(context) > 200000:
        context = context[:200000] + "\n\n...(内容过长, 后续已省略)"

    def generate():
        try:
            system = "你是一个专业的编程助手，擅长分析代码、解释逻辑、发现 bug 和建议优化。请用中文回答。"
            if context:
                prompt = (
                    "基于以下文件内容回答问题。如果内容不足以回答，请说明。\n\n"
                    f"文件内容:\n{context}\n\n问题: {question}"
                )
                for token in ai.generate_text_stream(prompt, system=system):
                    yield f"data: {_json.dumps({'t': token})}\n\n"
            else:
                for token in ai.generate_text_stream(question, system=system):
                    yield f"data: {_json.dumps({'t': token})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            logger.error("[API] server-files/ask 流式异常: %s", e)
            yield f"data: {_json.dumps({'error': str(e)})}\n\n"

    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@api_bp.route("/server-files/rollback", methods=["POST"])
@_require_perm("files")
def sfm_rollback():
    """回滚指定操作"""
    data = request.get_json() or {}
    op_id = data.get("op_id")
    if not op_id:
        return jsonify({"error": "缺少 op_id"}), 400
    db = _ctx()["db"]
    op = db.get_file_op_by_id(int(op_id))
    if not op:
        return jsonify({"error": "操作记录不存在"}), 404
    user = _current_user()
    fp = op["file_path"]
    logger.info("[SFM回滚] op_id=%s, type=%s, path=%s, has_old=%s",
                op_id, op["op_type"], fp, op.get("old_content") is not None)
    try:
        if op["op_type"] == "write" and op["old_content"] is not None:
            with open(fp, "w", encoding="utf-8", newline="\n") as f:
                f.write(op["old_content"])
            db.add_file_op(user["username"], "rollback_write", fp, extra=f"rollback op#{op_id}")
            return jsonify({"ok": True, "msg": f"已回滚文件写入 (op#{op_id})"})
        elif op["op_type"] == "delete" and op["old_content"] is not None:
            os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "w", encoding="utf-8", newline="\n") as f:
                f.write(op["old_content"])
            db.add_file_op(user["username"], "rollback_delete", fp, extra=f"rollback op#{op_id}")
            return jsonify({"ok": True, "msg": f"已恢复已删除的文件 (op#{op_id})"})
        elif op["op_type"] == "rename":
            old_path = fp
            new_path = op.get("extra", "")
            if new_path and os.path.exists(new_path):
                os.rename(new_path, old_path)
                db.add_file_op(user["username"], "rollback_rename", old_path, extra=f"rollback op#{op_id}")
                return jsonify({"ok": True, "msg": f"已回滚重命名 (op#{op_id})"})
            return jsonify({"error": "无法回滚: 目标文件不存在"}), 400
        elif op["op_type"] == "create":
            if os.path.isfile(fp):
                os.remove(fp)
                db.add_file_op(user["username"], "rollback_create", fp, extra=f"rollback op#{op_id}")
                return jsonify({"ok": True, "msg": f"已回滚文件创建 (op#{op_id})"})
            return jsonify({"error": "文件已不存在"}), 400
        else:
            return jsonify({"error": f"不支持回滚此操作类型: {op['op_type']}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
