"""知识图谱业务逻辑层 —— SQLite 存储，可选 Neo4j"""

import logging
from data.database import Database

logger = logging.getLogger(__name__)


class GraphService:
    def __init__(self, db: Database, config: dict | None = None):
        self.db = db
        self._neo4j_driver = None
        if config and config.get("neo4j_uri"):
            try:
                from neo4j import GraphDatabase
                self._neo4j_driver = GraphDatabase.driver(
                    config["neo4j_uri"],
                    auth=(config.get("neo4j_user", ""), config.get("neo4j_password", "")),
                )
                logger.info("[图谱] Neo4j连接成功: %s", config["neo4j_uri"])
            except (ImportError, Exception) as e:
                self._neo4j_driver = None
                logger.warning("[图谱] Neo4j连接失败, 仅使用SQLite: %s", e)
        logger.info("[图谱] GraphService初始化: neo4j=%s", bool(self._neo4j_driver))

    def add_triple(self, entity1: str, relation: str, entity2: str):
        logger.info("[图谱存储] 新增三元组: (%s)-[%s]->(%s)", entity1, relation, entity2)
        self.db.add_triple(entity1, relation, entity2)
        if self._neo4j_driver:
            try:
                with self._neo4j_driver.session() as session:
                    session.run(
                        "MERGE (a:Entity {name: $e1}) "
                        "MERGE (b:Entity {name: $e2}) "
                        "MERGE (a)-[:REL {type: $rel}]->(b)",
                        e1=entity1, e2=entity2, rel=relation,
                    )
                logger.info("[图谱存储] Neo4j同步完成")
            except Exception as e:
                logger.warning("[图谱存储] Neo4j同步失败: %s", e)

    def query_entity(self, name: str) -> list[dict]:
        logger.info("[图谱查询] 查询实体: name='%s'", name)
        results = self.db.query_entity(name)
        logger.info("[图谱查询] 查询完成, 返回 %d 条", len(results))
        return results

    def get_all_triples(self) -> list[dict]:
        results = self.db.get_all_triples()
        logger.info("[图谱查询] 获取所有三元组: 共 %d 条", len(results))
        return results

    def delete_triple(self, triple_id: int):
        logger.info("[图谱存储] 删除三元组: id=%d", triple_id)
        self.db.delete_triple(triple_id)

    def close(self):
        if self._neo4j_driver:
            self._neo4j_driver.close()
