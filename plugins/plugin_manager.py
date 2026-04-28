"""插件管理器 —— 启动时自动扫描 plugins/ 目录，动态加载符合规范的插件"""

import os
import sys
import json
import importlib.util
from plugins.plugin_base import PluginBase


class PluginManager:
    def __init__(self, plugins_dir: str):
        self.plugins_dir = plugins_dir
        self.plugins: list[PluginBase] = []
        self.plugin_info: list[dict] = []

    # ────────────────── 扫描发现 ──────────────────
    def discover_plugins(self) -> list[dict]:
        infos = []
        if not os.path.isdir(self.plugins_dir):
            return infos
        for name in os.listdir(self.plugins_dir):
            plugin_dir = os.path.join(self.plugins_dir, name)
            if not os.path.isdir(plugin_dir):
                continue
            json_path = os.path.join(plugin_dir, "plugin.json")
            if not os.path.exists(json_path):
                continue
            with open(json_path, "r", encoding="utf-8") as f:
                info = json.load(f)
            info["_dir"] = plugin_dir
            infos.append(info)
        return infos

    # ────────────────── 动态加载 ──────────────────
    def load_plugins(self, app_context: dict):
        for info in self.discover_plugins():
            try:
                plugin_dir = info["_dir"]
                entry = info.get("entry", "main.py")
                module_path = os.path.join(plugin_dir, entry)
                if not os.path.exists(module_path):
                    continue

                spec = importlib.util.spec_from_file_location(
                    f"plugin_{info['name']}", module_path,
                )
                module = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = module
                spec.loader.exec_module(module)

                # 查找 PluginBase 子类
                plugin_class = None
                for attr_name in dir(module):
                    attr = getattr(module, attr_name)
                    if isinstance(attr, type) and issubclass(attr, PluginBase) and attr is not PluginBase:
                        plugin_class = attr
                        break

                if plugin_class:
                    instance = plugin_class()
                    instance.init(app_context)
                    self.plugins.append(instance)
                    self.plugin_info.append(info)
                    print(f"[PluginManager] Loaded: {info.get('name')}")
            except Exception as e:
                print(f"[PluginManager] Failed to load {info.get('name', '?')}: {e}")

    def get_plugins(self) -> list[PluginBase]:
        return self.plugins

    def get_plugin_info(self) -> list[dict]:
        return self.plugin_info
