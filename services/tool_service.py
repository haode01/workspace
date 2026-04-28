"""工具管理服务 —— 工具上传、分类、检索、执行与使用记录"""

import os
import shutil
import logging
import zipfile
import tarfile
from datetime import datetime

logger = logging.getLogger(__name__)

# 工具文件统一存储根目录
TOOLS_STORE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "data", "store", "tools_store")


class ToolService:
    def __init__(self, db):
        self.db = db
        os.makedirs(TOOLS_STORE_DIR, exist_ok=True)
        self._ensure_default_category()

    def _ensure_default_category(self):
        """确保默认分类 misc 存在"""
        cat = self.db.get_tool_category_by_name("misc")
        if not cat:
            self.db.add_tool_category("misc", "未分类工具")
            logger.info("[ToolService] 创建默认分类: misc")

    # ────────────────── 分类管理 ──────────────────
    def list_categories(self) -> list[dict]:
        return self.db.get_tool_categories()

    def add_category(self, name: str, description: str = "") -> dict:
        name = name.strip()
        if not name:
            raise ValueError("分类名称不能为空")
        existing = self.db.get_tool_category_by_name(name)
        if existing:
            raise ValueError(f"分类 '{name}' 已存在")
        cat_id = self.db.add_tool_category(name, description)
        return {"id": cat_id, "name": name, "description": description}

    def delete_category(self, cat_id: int):
        cat = self.db.get_tool_category_by_id(cat_id)
        if not cat:
            raise ValueError("分类不存在")
        if cat["name"] == "misc":
            raise ValueError("不能删除默认分类")
        # 将该分类下的工具移到 misc
        misc = self.db.get_tool_category_by_name("misc")
        tools = self.db.get_tools(category_id=cat_id)
        for t in tools:
            self.db.conn.execute("UPDATE tools SET category_id=? WHERE id=?", (misc["id"], t["id"]))
        self.db.conn.commit()
        self.db.delete_tool_category(cat_id)

    # ────────────────── 工具上传 ──────────────────
    def upload_file(self, file_obj, name: str, description: str, category_id: int) -> dict:
        """上传单个二进制文件"""
        name = name.strip()
        description = description.strip()
        if not name or not description:
            raise ValueError("工具名称和描述不能为空")
        if not category_id:
            misc = self.db.get_tool_category_by_name("misc")
            category_id = misc["id"]

        # 存储路径: tools_store/<tool_name>_<timestamp>/
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        tool_dir = os.path.join(TOOLS_STORE_DIR, f"{name}_{ts}")
        os.makedirs(tool_dir, exist_ok=True)

        filename = file_obj.filename
        dest = os.path.join(tool_dir, filename)
        file_obj.save(dest)
        file_size = os.path.getsize(dest)

        # 设置可执行权限(Unix)
        try:
            os.chmod(dest, os.stat(dest).st_mode | stat.S_IEXEC)
        except Exception:
            pass

        tool_id = self.db.add_tool(name, description, category_id, "file", tool_dir, file_size)
        logger.info("[ToolService] 上传单文件工具: id=%d, name='%s', path='%s'", tool_id, name, dest)
        return {"id": tool_id, "name": name, "file_path": tool_dir}

    # ── 支持的压缩格式 ──
    _ARCHIVE_EXTS = ('.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2',
                     '.tar.xz', '.txz', '.7z', '.rar')

    @staticmethod
    def _extract_archive(archive_path: str, extract_dir: str):
        """根据文件后缀自动解压，支持 zip / tar 系列 / 7z / rar"""
        lower = archive_path.lower()

        # ── ZIP ──
        if lower.endswith('.zip'):
            try:
                with zipfile.ZipFile(archive_path, 'r') as zf:
                    zf.extractall(extract_dir)
                return
            except zipfile.BadZipFile:
                raise ValueError("上传的文件不是有效的 ZIP 压缩包")

        # ── TAR / TAR.GZ / TAR.BZ2 / TAR.XZ ──
        tar_exts = ('.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz')
        if any(lower.endswith(e) for e in tar_exts):
            try:
                with tarfile.open(archive_path, 'r:*') as tf:
                    try:
                        tf.extractall(extract_dir, filter='data')
                    except TypeError:
                        tf.extractall(extract_dir)
                return
            except tarfile.TarError as e:
                raise ValueError(f"解压 TAR 失败: {e}")

        # ── 7Z ──
        if lower.endswith('.7z'):
            try:
                import py7zr
                with py7zr.SevenZipFile(archive_path, 'r') as sz:
                    sz.extractall(extract_dir)
                return
            except ImportError:
                raise ValueError("服务器未安装 py7zr，无法解压 .7z 文件。请执行: pip install py7zr")
            except Exception as e:
                raise ValueError(f"解压 7z 失败: {e}")

        # ── RAR ──
        if lower.endswith('.rar'):
            try:
                import rarfile
                with rarfile.RarFile(archive_path, 'r') as rf:
                    rf.extractall(extract_dir)
                return
            except ImportError:
                raise ValueError("服务器未安装 rarfile，无法解压 .rar 文件。请执行: pip install rarfile")
            except Exception as e:
                raise ValueError(f"解压 RAR 失败: {e}")

        raise ValueError(f"不支持的压缩格式: {os.path.basename(archive_path)}")

    def upload_folder(self, file_obj, name: str, description: str, category_id: int) -> dict:
        """上传文件夹(压缩包), 支持 zip/tar/tar.gz/tar.bz2/tar.xz/7z/rar"""
        name = name.strip()
        description = description.strip()
        if not name or not description:
            raise ValueError("工具名称和描述不能为空")
        if not category_id:
            misc = self.db.get_tool_category_by_name("misc")
            category_id = misc["id"]

        filename = file_obj.filename or ''
        if not any(filename.lower().endswith(e) for e in self._ARCHIVE_EXTS):
            supported = ', '.join(self._ARCHIVE_EXTS)
            raise ValueError(f"不支持的压缩格式，支持: {supported}")

        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        tool_dir = os.path.join(TOOLS_STORE_DIR, f"{name}_{ts}")
        os.makedirs(tool_dir, exist_ok=True)

        # 保存压缩包
        archive_path = os.path.join(tool_dir, filename)
        file_obj.save(archive_path)

        # 解压
        extract_dir = os.path.join(tool_dir, "contents")
        os.makedirs(extract_dir, exist_ok=True)
        try:
            self._extract_archive(archive_path, extract_dir)
        except ValueError:
            shutil.rmtree(tool_dir, ignore_errors=True)
            raise

        folder_size = sum(
            os.path.getsize(os.path.join(dp, f))
            for dp, _, fns in os.walk(extract_dir)
            for f in fns
        )

        tool_id = self.db.add_tool(name, description, category_id, "folder", tool_dir, folder_size)
        logger.info("[ToolService] 上传文件夹工具: id=%d, name='%s', path='%s'", tool_id, name, tool_dir)
        return {"id": tool_id, "name": name, "file_path": tool_dir}

    # ────────────────── 工具检索 ──────────────────
    def search_tools(self, category_id: int = None, keyword: str = "") -> list[dict]:
        return self.db.get_tools(category_id=category_id, keyword=keyword)

    def get_tool(self, tool_id: int) -> dict | None:
        return self.db.get_tool_by_id(tool_id)

    def delete_tool(self, tool_id: int):
        tool = self.db.get_tool_by_id(tool_id)
        if not tool:
            raise ValueError("工具不存在")
        # 删除文件
        fp = tool["file_path"]
        if fp and os.path.exists(fp):
            shutil.rmtree(fp, ignore_errors=True)
        self.db.delete_tool(tool_id)
        logger.info("[ToolService] 删除工具: id=%d", tool_id)

    # ────────────────── 工具下载 ──────────────────
    def get_download_zip(self, tool_id: int) -> str | None:
        """将工具目录打包为 zip, 返回 zip 文件路径"""
        tool = self.db.get_tool_by_id(tool_id)
        if not tool:
            return None
        base = tool["file_path"]
        if not os.path.exists(base):
            return None
        zip_path = os.path.join(TOOLS_STORE_DIR, f"_download_{tool['name']}_{tool_id}.zip")
        # 如果已存在且较新, 直接复用
        if os.path.exists(zip_path):
            os.remove(zip_path)
        src_dir = os.path.join(base, "contents") if tool["upload_type"] == "folder" else base
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for dp, _, fns in os.walk(src_dir):
                for fn in fns:
                    full = os.path.join(dp, fn)
                    arcname = os.path.relpath(full, src_dir)
                    zf.write(full, arcname)
        return zip_path

    def get_file_abs_path(self, tool_id: int, sub_path: str) -> str | None:
        """返回工具内某个文件的绝对路径 (用于下载)"""
        tool = self.db.get_tool_by_id(tool_id)
        if not tool:
            return None
        base = tool["file_path"]
        if tool["upload_type"] == "folder":
            base = os.path.join(base, "contents")
        target = os.path.normpath(os.path.join(base, sub_path))
        if not target.startswith(os.path.normpath(base)):
            return None
        if not os.path.isfile(target):
            return None
        return target

    # ────────────────── 浏览目录 ──────────────────
    def browse_tool_dir(self, tool_id: int, sub_path: str = "") -> list[dict]:
        """浏览工具目录结构; 对 folder 类型返回 contents 下的文件树"""
        tool = self.db.get_tool_by_id(tool_id)
        if not tool:
            raise ValueError("工具不存在")
        base = tool["file_path"]
        if tool["upload_type"] == "folder":
            base = os.path.join(base, "contents")

        target = os.path.normpath(os.path.join(base, sub_path)) if sub_path else base
        if not target.startswith(os.path.normpath(base)):
            raise ValueError("路径越界")
        if not os.path.exists(target):
            return []

        entries = []
        for item in sorted(os.listdir(target)):
            full = os.path.join(target, item)
            rel = os.path.relpath(full, base)
            is_dir = os.path.isdir(full)
            entry = {
                "name": item,
                "path": rel.replace("\\", "/"),
                "is_dir": is_dir,
                "size": 0 if is_dir else os.path.getsize(full),
            }
            entries.append(entry)
        return entries

    def read_tool_file(self, tool_id: int, sub_path: str) -> str | None:
        """读取工具目录中的文本文件内容"""
        tool = self.db.get_tool_by_id(tool_id)
        if not tool:
            return None
        base = tool["file_path"]
        if tool["upload_type"] == "folder":
            base = os.path.join(base, "contents")

        target = os.path.normpath(os.path.join(base, sub_path))
        if not target.startswith(os.path.normpath(base)):
            return None
        if not os.path.isfile(target):
            return None
        try:
            with open(target, "r", encoding="utf-8", errors="replace") as f:
                return f.read(500_000)  # 限制 500KB
        except Exception:
            return None

    # ────────────────── 使用经验 ──────────────────
    def add_experience(self, tool_id: int, title: str, content: str) -> dict:
        title = title.strip()
        content = content.strip()
        if not title:
            raise ValueError("经验主题不能为空")
        exp_id = self.db.add_tool_experience(tool_id, title, content)
        return self.db.get_tool_experience_by_id(exp_id)

    def get_experiences(self, tool_id: int) -> list[dict]:
        return self.db.get_tool_experiences(tool_id)

    def update_experience(self, exp_id: int, title: str, content: str) -> dict:
        title = title.strip()
        if not title:
            raise ValueError("经验主题不能为空")
        exp = self.db.get_tool_experience_by_id(exp_id)
        if not exp:
            raise ValueError("经验记录不存在")
        self.db.update_tool_experience(exp_id, title, content.strip())
        return self.db.get_tool_experience_by_id(exp_id)

    def delete_experience(self, exp_id: int):
        exp = self.db.get_tool_experience_by_id(exp_id)
        if not exp:
            raise ValueError("经验记录不存在")
        self.db.delete_tool_experience(exp_id)
