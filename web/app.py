"""Flask 应用工厂 —— 创建并配置 Flask 实例"""

import os
from flask import Flask


def create_app(app_context: dict) -> Flask:
    template_dir = os.path.join(os.path.dirname(__file__), "templates")
    static_dir = os.path.join(os.path.dirname(__file__), "static")

    app = Flask(
        __name__,
        template_folder=template_dir,
        static_folder=static_dir,
    )
    app.secret_key = "ai-desktop-assistant-secret"
    app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # 禁止静态文件缓存
    app.config["app_context"] = app_context

    from web.routes import api_bp, page_bp
    app.register_blueprint(page_bp)
    app.register_blueprint(api_bp, url_prefix="/api")

    return app
