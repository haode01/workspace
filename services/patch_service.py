"""Patch 收集与审查服务 —— 定时扫描目录, 导入知识库, 文件浏览与 diff 查看"""

import os
import json
import logging
import threading
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
PATCH_META_FILE = os.path.join(DATA_DIR, "store", "patch_meta.json")


class PatchService:
    """扫描 patch 目录, 管理已导入状态, 提供文件浏览和搜索"""

    def __init__(self, knowledge_service=None, ai_client=None):
        self.knowledge_service = knowledge_service
        self.ai_client = ai_client
        # 配置
        self.scan_dir = ""          # 扫描根目录
        self.interval = 300         # 定时间隔 (秒), 默认 5 分钟
        # 已导入记录  {collection_path: {imported_at, doc_ids: [...]}}
        self._imported: Dict[str, dict] = {}
        # 定时器
        self._timer_stop = threading.Event()
        self._timer_thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        # 加载持久化元数据
        self._load_meta()

    # ═══════════════════════════════════
    #  持久化
    # ═══════════════════════════════════
    def _load_meta(self):
        try:
            if os.path.exists(PATCH_META_FILE):
                with open(PATCH_META_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.scan_dir = data.get("scan_dir", "")
                self.interval = data.get("interval", 300)
                self._imported = data.get("imported", {})
                logger.info("[PatchService] 已加载元数据: scan_dir=%s, imported=%d",
                            self.scan_dir, len(self._imported))
        except Exception as e:
            logger.warning("[PatchService] 加载元数据失败: %s", e)

    def _save_meta(self):
        os.makedirs(os.path.dirname(PATCH_META_FILE), exist_ok=True)
        with open(PATCH_META_FILE, "w", encoding="utf-8") as f:
            json.dump({
                "scan_dir": self.scan_dir,
                "interval": self.interval,
                "imported": self._imported,
            }, f, ensure_ascii=False, indent=2)

    # ═══════════════════════════════════
    #  配置
    # ═══════════════════════════════════
    def get_config(self) -> dict:
        return {
            "scan_dir": self.scan_dir,
            "interval": self.interval,
            "timer_running": self._timer_thread is not None and self._timer_thread.is_alive(),
            "imported_count": len(self._imported),
        }

    def set_config(self, scan_dir: str = None, interval: int = None):
        if scan_dir is not None:
            self.scan_dir = scan_dir.strip()
        if interval is not None:
            self.interval = max(10, int(interval))
        self._save_meta()

    # ═══════════════════════════════════
    #  目录扫描
    # ═══════════════════════════════════
    def scan_collections(self, scan_dir: str = None) -> List[dict]:
        """扫描目录, 返回所有 patch_collect 集合的结构化信息"""
        root = scan_dir or self.scan_dir
        if not root or not os.path.isdir(root):
            return []
        collections = []
        # 遍历日期目录
        for date_dir_name in sorted(os.listdir(root)):
            date_path = os.path.join(root, date_dir_name)
            if not os.path.isdir(date_path):
                continue
            # 遍历子目录 (不限制 patch_collect_ 前缀)
            for coll_name in sorted(os.listdir(date_path)):
                coll_path = os.path.join(date_path, coll_name)
                if not os.path.isdir(coll_path):
                    continue
                coll_key = f"{date_dir_name}/{coll_name}"
                files = self._list_files_recursive(coll_path, coll_path)
                patch_files = self._count_patches_recursive(files)
                all_files = self._count_files_recursive(files)
                imported = coll_key in self._imported
                collections.append({
                    "key": coll_key,
                    "date": date_dir_name,
                    "name": coll_name,
                    "path": coll_path,
                    "file_count": all_files,
                    "patch_count": patch_files,
                    "files": files,
                    "imported": imported,
                    "imported_at": self._imported.get(coll_key, {}).get("imported_at", ""),
                })
        return collections

    @staticmethod
    def _count_patches_recursive(items: list) -> int:
        count = 0
        for item in items:
            if item["type"] == "file" and item["name"].endswith(".patch"):
                count += 1
            elif item["type"] == "dir" and item.get("children"):
                count += PatchService._count_patches_recursive(item["children"])
        return count

    @staticmethod
    def _count_files_recursive(items: list) -> int:
        count = 0
        for item in items:
            if item["type"] == "file":
                count += 1
            elif item["type"] == "dir" and item.get("children"):
                count += PatchService._count_files_recursive(item["children"])
        return count

    def _list_files_recursive(self, base_path: str, root_path: str) -> List[dict]:
        """递归列出目录下所有文件"""
        result = []
        try:
            for item in sorted(os.listdir(base_path)):
                full = os.path.join(base_path, item)
                rel = os.path.relpath(full, root_path).replace("\\", "/")
                if os.path.isdir(full):
                    children = self._list_files_recursive(full, root_path)
                    result.append({"name": rel, "type": "dir", "children": children})
                else:
                    size = os.path.getsize(full)
                    result.append({"name": rel, "type": "file", "size": size})
        except Exception as e:
            logger.warning("[PatchService] 列目录失败 %s: %s", base_path, e)
        return result

    # ═══════════════════════════════════
    #  文件读取
    # ═══════════════════════════════════
    def read_file(self, collection_key: str, file_path: str) -> dict:
        """读取集合中的某个文件内容"""
        root = self.scan_dir
        if not root:
            return {"error": "未配置扫描目录"}
        full_path = os.path.join(root, collection_key, file_path)
        full_path = os.path.normpath(full_path)
        # 安全检查
        if not full_path.startswith(os.path.normpath(root)):
            return {"error": "路径越界"}
        if not os.path.isfile(full_path):
            return {"error": "文件不存在"}
        is_patch = file_path.endswith(".patch")
        try:
            content = self._read_text(full_path)
            return {
                "path": file_path,
                "content": content,
                "is_patch": is_patch,
                "size": os.path.getsize(full_path),
            }
        except Exception as e:
            return {"error": str(e)}

    @staticmethod
    def _read_text(filepath: str) -> str:
        """智能编码读取"""
        raw = open(filepath, "rb").read()
        for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk", "latin-1"):
            try:
                return raw.decode(enc)
            except (UnicodeDecodeError, ValueError):
                pass
        return raw.decode("utf-8", errors="replace")

    # ═══════════════════════════════════
    #  导入知识库
    # ═══════════════════════════════════
    def import_collection(self, collection_key: str, force: bool = False) -> dict:
        """将集合中的 .patch 文件导入知识库 (仅 patch 文件, 用于搜索)"""
        if not force and collection_key in self._imported:
            return {"ok": False, "msg": "已导入, 使用 force=true 强制重新导入"}
        root = self.scan_dir
        if not root:
            return {"ok": False, "msg": "未配置扫描目录"}
        coll_path = os.path.join(root, collection_key)
        if not os.path.isdir(coll_path):
            return {"ok": False, "msg": "集合目录不存在"}

        # 分类: patch/日期/集合名
        category = f"patch/{collection_key}"
        doc_ids = []
        imported_files = 0

        # 仅遍历 .patch 文件
        for dirpath, _, filenames in os.walk(coll_path):
            for fn in filenames:
                if not fn.endswith(".patch"):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, coll_path).replace("\\", "/")
                try:
                    if self.knowledge_service:
                        content = self._read_text(full)
                        if not content.strip():
                            continue
                        title = f"{collection_key}/{rel}"
                        doc_id = self.knowledge_service.add_text_document(
                            title, content, ai_client=self.ai_client, category=category
                        )
                        if doc_id > 0:
                            doc_ids.append(doc_id)
                            imported_files += 1
                except Exception as e:
                    logger.warning("[PatchService] 导入文件失败 %s: %s", rel, e)

        self._imported[collection_key] = {
            "imported_at": datetime.now().isoformat(),
            "doc_ids": doc_ids,
        }
        self._save_meta()
        logger.info("[PatchService] 导入集合 %s: %d 个patch文件", collection_key, imported_files)
        return {"ok": True, "msg": f"已导入 {imported_files} 个 patch 文件", "doc_ids": doc_ids}

    def import_all_new(self, force: bool = False) -> dict:
        """扫描并导入所有未导入的集合"""
        collections = self.scan_collections()
        results = []
        for coll in collections:
            if not force and coll["imported"]:
                continue
            r = self.import_collection(coll["key"], force=force)
            results.append({"key": coll["key"], **r})
        return {"ok": True, "results": results, "total": len(results)}

    # ═══════════════════════════════════
    #  数据库管理
    # ═══════════════════════════════════
    def get_imported_docs(self) -> List[dict]:
        """返回所有已导入 patch 的文档列表 (从 DB 中按 patch 分类查询)"""
        if not self.knowledge_service:
            return []
        all_docs = self.knowledge_service.get_documents()
        return [d for d in all_docs if (d.get("category") or "").startswith("patch/")]

    def get_imported_summary(self) -> List[dict]:
        """返回每个已导入集合的摘要信息 (集合key, 导入时间, 文档数)"""
        summary = []
        for key, meta in self._imported.items():
            summary.append({
                "key": key,
                "imported_at": meta.get("imported_at", ""),
                "doc_count": len(meta.get("doc_ids", [])),
                "doc_ids": meta.get("doc_ids", []),
            })
        summary.sort(key=lambda x: x["imported_at"], reverse=True)
        return summary

    def delete_collection_docs(self, collection_key: str) -> dict:
        """删除某个集合在数据库中的所有 patch 文档"""
        if not self.knowledge_service:
            return {"ok": False, "msg": "knowledge_service not available"}
        meta = self._imported.get(collection_key)
        if not meta:
            return {"ok": False, "msg": "该集合未导入过"}
        doc_ids = meta.get("doc_ids", [])
        deleted = 0
        for doc_id in doc_ids:
            try:
                self.knowledge_service.delete_document(doc_id)
                deleted += 1
            except Exception as e:
                logger.warning("[PatchService] 删除文档失败 doc_id=%d: %s", doc_id, e)
        del self._imported[collection_key]
        self._save_meta()
        logger.info("[PatchService] 删除集合 %s 的 %d 个文档", collection_key, deleted)
        return {"ok": True, "msg": f"已删除 {deleted} 个文档", "deleted": deleted}

    def delete_single_doc(self, doc_id: int) -> dict:
        """删除单个 patch 文档"""
        if not self.knowledge_service:
            return {"ok": False, "msg": "knowledge_service not available"}
        try:
            self.knowledge_service.delete_document(doc_id)
        except Exception as e:
            return {"ok": False, "msg": str(e)}
        # 从 _imported 元数据中也移除该 doc_id
        for key, meta in self._imported.items():
            ids = meta.get("doc_ids", [])
            if doc_id in ids:
                ids.remove(doc_id)
                if not ids:
                    del self._imported[key]
                break
        self._save_meta()
        logger.info("[PatchService] 删除单个文档 doc_id=%d", doc_id)
        return {"ok": True, "msg": f"已删除文档 {doc_id}"}

    def delete_all_patch_docs(self) -> dict:
        """删除数据库中所有 patch 文档"""
        if not self.knowledge_service:
            return {"ok": False, "msg": "knowledge_service not available"}
        docs = self.get_imported_docs()
        deleted = 0
        for d in docs:
            try:
                self.knowledge_service.delete_document(d["id"])
                deleted += 1
            except Exception as e:
                logger.warning("[PatchService] 删除文档失败 id=%d: %s", d["id"], e)
        self._imported.clear()
        self._save_meta()
        logger.info("[PatchService] 清空所有patch文档, 共 %d 个", deleted)
        return {"ok": True, "msg": f"已清空 {deleted} 个 patch 文档", "deleted": deleted}

    # ═══════════════════════════════════
    #  AI 修复 patch 并回写
    # ═══════════════════════════════════
    def apply_fix(self, collection_key: str, file_path: str, fixed_content: str) -> dict:
        """将修复后的内容写回源文件 + 同步更新知识库 DB"""
        root = self.scan_dir
        if not root:
            return {"ok": False, "msg": "未配置扫描目录"}
        full_path = os.path.join(root, collection_key, file_path)
        full_path = os.path.normpath(full_path)
        if not full_path.startswith(os.path.normpath(root)):
            return {"ok": False, "msg": "路径越界"}
        if not os.path.isfile(full_path):
            return {"ok": False, "msg": "源文件不存在"}

        # ── 1. 备份原文件 ──
        backup_path = full_path + ".bak"
        try:
            import shutil
            shutil.copy2(full_path, backup_path)
        except Exception as e:
            logger.warning("[PatchService] 备份失败: %s", e)

        # ── 2. 写入修复后的内容到磁盘 ──
        try:
            with open(full_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(fixed_content)
            logger.info("[PatchService] 已写回修复内容: %s (%d bytes)", full_path, len(fixed_content))
        except Exception as e:
            logger.error("[PatchService] 写回失败: %s", e)
            return {"ok": False, "msg": f"写入文件失败: {e}"}

        # ── 3. 同步更新知识库 DB (如果已导入) ──
        updated_db = False
        if self.knowledge_service:
            category = f"patch/{collection_key}"
            # 找到对应的 DB 文档
            title_prefix = f"{collection_key}/"
            all_docs = self.knowledge_service.get_documents()
            for doc in all_docs:
                fname = doc.get("filename", "")
                # 文档 filename 格式: "coll_key/rel_path.md"
                expected = f"{collection_key}/{file_path}.md"
                if fname == expected or fname == f"{collection_key}/{file_path}":
                    try:
                        doc_id = doc["id"]
                        self.knowledge_service.db.update_document_content(doc_id, fixed_content)
                        # 重建索引
                        self.knowledge_service.db.delete_chunks_by_doc(doc_id)
                        self.knowledge_service.rag.remove_doc_chunks(doc_id)
                        self.knowledge_service._index_document(
                            doc_id, fixed_content, fname,
                            doc.get("category", category), self.ai_client
                        )
                        updated_db = True
                        logger.info("[PatchService] DB文档已更新: doc_id=%d", doc_id)
                    except Exception as e:
                        logger.warning("[PatchService] 更新DB文档失败: %s", e)
                    break

        return {
            "ok": True,
            "msg": f"已修复并写回文件" + (" (数据库已同步)" if updated_db else " (数据库未找到对应文档)"),
            "backup": os.path.basename(backup_path),
        }

    def generate_fix(self, collection_key: str, file_path: str, issue_description: str) -> dict:
        """让 AI 根据问题描述生成修复后的完整 patch 内容"""
        if not self.ai_client or not self.ai_client.is_configured():
            return {"ok": False, "msg": "AI 未配置"}
        # 读取当前文件
        file_data = self.read_file(collection_key, file_path)
        if "error" in file_data:
            return {"ok": False, "msg": file_data["error"]}

        original = file_data["content"]
        prompt = (
            "你是一个 patch 文件修复专家。下面是一个 git patch 文件内容，以及用户描述的问题。\n"
            "请修复 patch 中的问题，输出修复后的 **完整 patch 文件内容**。\n\n"
            "【关键要求】\n"
            "- 只输出修复后的完整 patch 文本，不要任何解释、markdown代码块标记\n"
            "- 保持 patch 格式完全正确（diff header、hunk header 的行号必须正确）\n"
            "- 确保修复后的 patch 能被 git apply 正确应用\n"
            "- 如果问题涉及 hunk 行号不匹配，需要重新计算正确的 @@ 行号\n"
            "- 保留原始的提交信息头部（From、Subject、Date 等）\n\n"
            f"【问题描述】\n{issue_description}\n\n"
            f"【原始 patch 内容】\n{original}"
        )
        try:
            fixed = self.ai_client.generate_text(
                prompt,
                system="你是 patch/diff 格式专家。只输出修复后的完整 patch 文件内容，不附加任何解释。"
            )
            # 去掉可能的 markdown 代码块包裹
            fixed = fixed.strip()
            if fixed.startswith("```"):
                first_nl = fixed.index("\n")
                fixed = fixed[first_nl + 1:]
            if fixed.endswith("```"):
                fixed = fixed[:-3].rstrip()
            return {"ok": True, "fixed_content": fixed}
        except Exception as e:
            logger.error("[PatchService] AI生成修复失败: %s", e)
            return {"ok": False, "msg": f"AI 生成修复失败: {e}"}

    # ═══════════════════════════════════
    #  搜索 (复用知识库)
    # ═══════════════════════════════════
    def search(self, query: str, top_k: int = 10) -> list:
        """在 patch 分类下搜索知识库"""
        if not self.knowledge_service:
            return []
        results = self.knowledge_service.search(
            query, ai_client=self.ai_client, top_k=top_k, category="patch"
        )
        return [{"chunk": r[0], "score": r[1]} for r in results]

    # ═══════════════════════════════════
    #  定时扫描
    # ═══════════════════════════════════
    def start_timer(self):
        if self._timer_thread and self._timer_thread.is_alive():
            raise RuntimeError("定时器已在运行")
        self._timer_stop.clear()
        self._timer_thread = threading.Thread(target=self._timer_loop, daemon=True)
        self._timer_thread.start()
        logger.info("[PatchService] 定时扫描已启动, 间隔=%d秒", self.interval)

    def stop_timer(self):
        self._timer_stop.set()
        if self._timer_thread:
            self._timer_thread.join(timeout=5)
            self._timer_thread = None
        logger.info("[PatchService] 定时扫描已停止")

    def _timer_loop(self):
        while not self._timer_stop.is_set():
            try:
                self.import_all_new(force=False)
            except Exception as e:
                logger.error("[PatchService] 定时导入异常: %s", e)
            self._timer_stop.wait(self.interval)
