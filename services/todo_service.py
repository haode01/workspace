"""待办事项业务逻辑层"""

import logging
from data.database import Database

logger = logging.getLogger(__name__)


class TodoService:
    def __init__(self, db: Database):
        self.db = db

    def add_task(self, title: str, priority: int = 2) -> int:
        logger.info("[Todo] 新增任务: title='%s', priority=%d", title[:50], priority)
        tid = self.db.add_todo(title, priority)
        logger.info("[Todo] 任务创建成功: id=%d", tid)
        return tid

    def get_tasks(self, include_completed: bool = False) -> list[dict]:
        tasks = self.db.get_todos(include_completed)
        logger.info("[Todo] 获取任务列表: %d条 (include_completed=%s)", len(tasks), include_completed)
        return tasks

    def complete_task(self, task_id: int):
        logger.info("[Todo] 完成任务: id=%d", task_id)
        self.db.complete_todo(task_id)

    def delete_task(self, task_id: int):
        logger.info("[Todo] 删除任务: id=%d", task_id)
        self.db.delete_todo(task_id)

    def toggle_pin(self, task_id: int):
        logger.info("[Todo] 切换置顶: id=%d", task_id)
        self.db.toggle_pin(task_id)

    def get_history(self, limit: int = 50) -> list[dict]:
        history = self.db.get_completed_todos(limit)
        logger.info("[Todo] 获取历史: %d条 (limit=%d)", len(history), limit)
        return history

    def get_task_detail(self, task_id: int) -> dict | None:
        task = self.db.get_todo_by_id(task_id)
        if task:
            logger.info("[Todo] 获取任务详情: id=%d", task_id)
        return task

    def update_task(self, task_id: int, title: str = None, detail: str = None, priority: int = None):
        logger.info("[Todo] 更新任务: id=%d", task_id)
        self.db.update_todo(task_id, title=title, detail=detail, priority=priority)

    def get_tasks_by_date(self, date_str: str) -> list[dict]:
        tasks = self.db.get_todos_by_date(date_str)
        logger.info("[Todo] 按日期查询: date=%s, %d条", date_str, len(tasks))
        return tasks

    def get_dates(self) -> list[str]:
        dates = self.db.get_todo_dates()
        logger.info("[Todo] 获取日期列表: %d天", len(dates))
        return dates
