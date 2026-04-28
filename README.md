




以下是完整的项目描述，可以直接作为 commit message 或项目说明提交：

---

## AI Desktop Assistant（仓库）

一个基于 **Flask + SQLite** 的本地 AI 桌面助手 Web 应用，集成多种效率工具，运行在 `0.0.0.0:8888`。

### 核心架构

- **入口**: [main.py](cci:7://file:///f:/workspace/study/cangku/main.py:0:0-0:0) — 加载配置 → 数据库 → AI → Service → 插件 → Web 服务
- **后端**: Flask ([web/routes.py](cci:7://file:///f:/workspace/study/cangku/web/routes.py:0:0-0:0))，带权限控制和 RESTful API
- **数据**: SQLite ([data/database.py](cci:7://file:///f:/workspace/study/cangku/data/database.py:0:0-0:0))，含用户、TODO、知识库、文件操作历史等表
- **AI**: `ai/ai_client.py` + `ai/rag_engine.py`，支持多模型 LLM 对话与 RAG 检索

### 功能模块

| 模块 | 页面 | 说明 |
|------|------|------|
| **主面板** | [index.html](cci:7://file:///f:/workspace/study/cangku/web/templates/index.html:0:0-0:0) | AI 对话、TODO 管理、知识库管理、知识图谱 |
| **服务器文件管理** | [server_files.html](cci:7://file:///f:/workspace/study/cangku/web/templates/server_files.html:0:0-0:0) | 远程文件浏览/编辑/搜索，内置终端、AI 问答、代码格式化、操作历史(含 diff 和回滚)、文件同步 |
| **可视化工作流** | [workflow.html](cci:7://file:///f:/workspace/study/cangku/web/templates/workflow.html:0:0-0:0) | 拖拽式节点编排（输入/输出/按钮/定时器/脚本/AI 节点），支持 Shell 命令、HTTP 请求等服务器工具绑定 |
| **Patch 审查** | [patch_review.html](cci:7://file:///f:/workspace/study/cangku/web/templates/patch_review.html:0:0-0:0) | 补丁/代码变更审查 |
| **工具管理** | [tools.html](cci:7://file:///f:/workspace/study/cangku/web/templates/tools.html:0:0-0:0) | 服务器端工具注册与配置 |

### 服务层

- **TodoService** — 待办事项 CRUD
- **KnowledgeService** — 知识库管理 + RAG 向量检索
- **GraphService** — 知识图谱
- **ToolService** — 服务器工具注册/执行（Shell、HTTP、文件读写等）
- **PatchService** — 补丁生成与审查
- **WorkflowEngine** — 工作流执行引擎，支持服务端定时器

### 插件系统

[plugins/](cci:9://file:///f:/workspace/study/cangku/plugins:0:0-0:0) 目录，支持热加载自定义插件，内置工作流节点（输入、输出、按钮、定时器、脚本、AI）。

### 近期增强（文件管理模块）

- 文件操作历史按文件分组显示，支持查看逐行 diff 和一键回滚
- 编辑器顶栏增加当前文件历史按钮
- 新增文件同步功能：配置同步目标路径后，保存文件自动同步
- 全屏编辑器目录面板支持拖动调整宽度
- 目录树展开/收起时视图定位到操作的文件夹
