"""插件抽象基类 —— 所有第三方插件必须继承此类"""

from abc import ABC, abstractmethod


class PluginBase(ABC):
    """插件基类，定义插件生命周期接口"""

    @abstractmethod
    def init(self, app_context: dict):
        """初始化插件，app_context 包含所有 Service / AI 客户端 / 配置"""
        pass

    @abstractmethod
    def get_name(self) -> str:
        """返回插件显示名称"""
        pass

    @abstractmethod
    def get_ui_component(self):
        """返回一个 QWidget，嵌入主界面内容区"""
        pass

    @abstractmethod
    def execute(self):
        """主执行入口，可被插件管理器或 UI 触发"""
        pass
