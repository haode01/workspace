"""工作流执行引擎 —— 解析 JSON 工作流, 支持工具绑定 / 服务端定时器 / 状态轮询"""

import os
import json
import logging
import time
import threading
from datetime import datetime
from typing import Any, Dict, List, Optional
from collections import defaultdict

from plugins.workflow.node_base import NodeRegistry, WorkflowNode

logger = logging.getLogger(__name__)

WORKFLOW_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "data", "store", "workflows")


class WorkflowEngine:
    """工作流引擎"""

    def __init__(self, app_context: dict = None):
        self.app_context = app_context or {}
        os.makedirs(WORKFLOW_DIR, exist_ok=True)

        # 运行状态: wf_id -> {outputs, running, tick_count, last_tick}
        self._state: Dict[str, dict] = {}
        self._timers: Dict[str, threading.Event] = {}   # stop events
        self._threads: Dict[str, threading.Thread] = {}
        self._lock = threading.Lock()

    # ────────────────── 持久化 ──────────────────

    def save_workflow(self, wf_id: str, data: dict):
        path = os.path.join(WORKFLOW_DIR, f"{wf_id}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def load_workflow(self, wf_id: str) -> Optional[dict]:
        path = os.path.join(WORKFLOW_DIR, f"{wf_id}.json")
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def delete_workflow(self, wf_id: str):
        self.stop_timer(wf_id)
        path = os.path.join(WORKFLOW_DIR, f"{wf_id}.json")
        if os.path.exists(path):
            os.remove(path)

    def list_workflows(self) -> List[dict]:
        result = []
        for fname in os.listdir(WORKFLOW_DIR):
            if fname.endswith(".json"):
                wf_id = fname[:-5]
                try:
                    data = self.load_workflow(wf_id)
                    result.append({
                        "id": wf_id,
                        "name": data.get("name", wf_id),
                        "node_count": len(data.get("nodes", [])),
                        "edge_count": len(data.get("edges", [])),
                        "timer_running": wf_id in self._timers,
                    })
                except Exception:
                    pass
        return result

    # ────────────────── 状态管理 ──────────────────

    def get_state(self, wf_id: str) -> dict:
        with self._lock:
            st = self._state.get(wf_id, {})
            return {
                "outputs": st.get("outputs", {}),
                "running": st.get("running", False),
                "current_node": st.get("current_node", ""),
                "tick_count": st.get("tick_count", 0),
                "last_tick": st.get("last_tick", ""),
                "timer_running": wf_id in self._timers,
            }

    def _update_state(self, wf_id: str, outputs: dict, running: bool = False):
        with self._lock:
            st = self._state.setdefault(wf_id, {})
            st["outputs"] = outputs
            st["running"] = running
            if not running:
                st["current_node"] = ""
            st["tick_count"] = st.get("tick_count", 0) + 1
            st["last_tick"] = datetime.now().strftime("%H:%M:%S")

    # ────────────────── 执行 ──────────────────

    def execute(self, workflow: dict, overrides: dict = None,
                wf_id: str = "") -> Dict[str, Any]:
        """
        执行工作流, 返回每个节点的输出。
        overrides: {node_id: config_override}
        """
        overrides = overrides or {}
        nodes_def = workflow.get("nodes", [])
        edges_def = workflow.get("edges", [])

        if wf_id:
            with self._lock:
                st = self._state.setdefault(wf_id, {})
                st["running"] = True

        # 1. 实例化所有节点
        nodes: Dict[str, WorkflowNode] = {}
        for nd in nodes_def:
            ntype = nd.get("node_type") or nd.get("type", "")
            nid = nd["id"]
            cfg = dict(nd.get("config", {}))
            if nid in overrides:
                cfg.update(overrides[nid])
            try:
                node = NodeRegistry.create_node(ntype, nid, cfg)
                if hasattr(node, '_app_context'):
                    node._app_context = self.app_context
                nodes[nid] = node
            except ValueError as e:
                logger.warning("[Workflow] Skip node %s: %s", nid, e)

        # 2. 构建邻接表, 记录边索引 (target_idx)
        adj: Dict[str, List[str]] = defaultdict(list)
        # in_edges[tgt] = [(src, idx), ...] 按 idx 排序
        in_edges: Dict[str, List[tuple]] = defaultdict(list)
        # 自动分配 target_idx 的计数器
        _auto_idx: Dict[str, int] = defaultdict(int)
        for edge in edges_def:
            src = edge.get("source")
            tgt = edge.get("target")
            if src in nodes and tgt in nodes:
                adj[src].append(tgt)
                idx = edge.get("target_idx")
                if idx is None:
                    _auto_idx[tgt] += 1
                    idx = _auto_idx[tgt]
                else:
                    idx = int(idx)
                    _auto_idx[tgt] = max(_auto_idx[tgt], idx)
                in_edges[tgt].append((src, idx))
        # 按 idx 排序
        for tgt in in_edges:
            in_edges[tgt].sort(key=lambda x: x[1])

        # 3. 拓扑排序 (Kahn)
        in_degree = {nid: 0 for nid in nodes}
        for tgt, srcs in in_edges.items():
            in_degree[tgt] = len(srcs)
        queue = [nid for nid, deg in in_degree.items() if deg == 0]
        order = []
        while queue:
            nid = queue.pop(0)
            order.append(nid)
            for child in adj.get(nid, []):
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    queue.append(child)

        # 4. 按拓扑序执行, 每个节点完成后立即更新状态
        outputs: Dict[str, Any] = {}
        for nid in order:
            node = nodes[nid]
            # 标记当前正在执行的节点
            if wf_id:
                with self._lock:
                    st = self._state.setdefault(wf_id, {})
                    st["current_node"] = nid

            sources = in_edges.get(nid, [])
            if len(sources) == 0:
                inp = None
            elif len(sources) == 1:
                inp = outputs.get(sources[0][0])
            else:
                # 多输入: 传递 {idx: value, ...} 字典, 方便占位符替换
                inp = {idx: outputs.get(src) for src, idx in sources}

            try:
                result = node.run(inp)
                outputs[nid] = result
                logger.debug("[Workflow] Node %s (%s) -> %s",
                             nid, node.name, str(result)[:200])
            except Exception as e:
                outputs[nid] = f"[Error] {e}"
                logger.error("[Workflow] Node %s error: %s", nid, e)

            # 每完成一个节点就更新状态, 前端可轮询看到渐进结果
            if wf_id:
                self._update_state(wf_id, outputs, running=True)

        # 最终: 标记完成
        if wf_id:
            self._update_state(wf_id, outputs, running=False)

        return outputs

    # ────────────────── 服务端定时器 ──────────────────

    def start_timer(self, wf_id: str, workflow: dict = None, overrides: dict = None):
        """启动工作流的服务端定时器"""
        self.stop_timer(wf_id)

        if not workflow:
            workflow = self.load_workflow(wf_id)
        if not workflow:
            raise ValueError(f"Workflow {wf_id} not found")

        # 找定时器节点获取 interval
        nodes = workflow.get("nodes", [])
        timer_nodes = [n for n in nodes
                       if (n.get("node_type") or n.get("type")) == "timer"]
        if not timer_nodes:
            raise ValueError("工作流中没有定时器节点")

        interval = int(timer_nodes[0].get("config", {}).get("interval", 5))
        if interval < 1:
            interval = 1

        stop_event = threading.Event()
        self._timers[wf_id] = stop_event

        def loop():
            logger.info("[Workflow] Timer started: %s, interval=%ds", wf_id, interval)
            while not stop_event.is_set():
                try:
                    self.execute(workflow, overrides, wf_id=wf_id)
                except Exception as e:
                    logger.error("[Workflow] Timer tick error for %s: %s", wf_id, e)
                stop_event.wait(interval)
            logger.info("[Workflow] Timer stopped: %s", wf_id)

        t = threading.Thread(target=loop, daemon=True, name=f"wf-timer-{wf_id}")
        self._threads[wf_id] = t
        t.start()

    def stop_timer(self, wf_id: str):
        ev = self._timers.pop(wf_id, None)
        if ev:
            ev.set()
        self._threads.pop(wf_id, None)

    def stop_all_timers(self):
        for wf_id in list(self._timers.keys()):
            self.stop_timer(wf_id)
