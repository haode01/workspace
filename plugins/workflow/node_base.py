"""工作流节点基类 —— 所有节点插件必须继承此类"""

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional


class WorkflowNode(ABC):
    """统一节点接口"""

    # 节点元信息 (子类必须覆盖)
    name: str = ""
    node_type: str = ""          # input / output / processor / trigger
    description: str = ""
    default_config: Dict = {}

    def __init__(self, node_id: str, config: Optional[Dict] = None):
        self.node_id = node_id
        self.config = dict(self.default_config)
        if config:
            self.config.update(config)
        self.last_output: Any = None

    @abstractmethod
    def run(self, input_data: Any = None) -> Any:
        """执行节点逻辑, 返回输出"""
        pass

    def to_dict(self) -> Dict:
        return {
            "node_id": self.node_id,
            "name": self.name,
            "type": self.node_type,
            "config": self.config,
            "description": self.description,
        }


class NodeRegistry:
    """节点类型注册中心 —— 管理所有可用节点类型"""

    _registry: Dict[str, type] = {}

    @classmethod
    def register(cls, node_class: type):
        """注册一个节点类型"""
        cls._registry[node_class.name] = node_class
        return node_class

    @classmethod
    def unregister(cls, name: str):
        """卸载一个节点类型"""
        cls._registry.pop(name, None)

    @classmethod
    def get(cls, name: str) -> Optional[type]:
        return cls._registry.get(name)

    @classmethod
    def get_all(cls) -> Dict[str, type]:
        return dict(cls._registry)

    @classmethod
    def create_node(cls, name: str, node_id: str, config: dict = None) -> WorkflowNode:
        node_class = cls._registry.get(name)
        if not node_class:
            raise ValueError(f"Unknown node type: {name}")
        return node_class(node_id, config)

    @classmethod
    def list_types(cls):
        """返回所有已注册节点的元信息"""
        result = []
        for name, nc in cls._registry.items():
            result.append({
                "name": nc.name,
                "type": nc.node_type,
                "description": nc.description,
                "default_config": nc.default_config,
            })
        return result
