"""应用全局配置管理"""

import os
import json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data", "store")
PLUGINS_DIR = os.path.join(BASE_DIR, "plugins")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")

DEFAULT_CONFIG = {
    # 问答模型配置 (默认/主模型)
    "api_key": "sk-9d0ff23a2faf42f8b32481f7402439cc",
    "api_base": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    # 模型列表 (可在设置页面动态添加)
    "models": [
        {"name": "DeepSeek", "api_base": "https://api.deepseek.com/v1",
         "api_key": "sk-9d0ff23a2faf42f8b32481f7402439cc", "model": "deepseek-chat"},
        {"name": "Claude", "api_base": "https://lanyiapi.com/v1",
         "api_key": "sk-G1IFyxQq5cnRZfuEtgQoAibLXueP28mHQVwW0MyX18JLtEeM", "model": "claude-sonnet-4-6"},
    ],
    # Embedding 模型配置 (留空则复用问答模型的 api_key/api_base)
    "embedding_model": "text-embedding-v3",
    "embedding_api_key": "sk-6cfc3e3009b8446b9e2f4f8f416cfe6d",
    "embedding_api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "dark_mode": True,
    "neo4j_uri": "",
    "neo4j_user": "",
    "neo4j_password": "",
}


def load_config() -> dict:
    """加载配置文件，不存在则使用默认配置"""
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        return cfg
    return DEFAULT_CONFIG.copy()


def save_config(cfg: dict):
    """持久化配置到文件"""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
