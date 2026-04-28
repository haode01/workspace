"""RAG 向量检索引擎 —— 优先 FAISS，退回 numpy 余弦相似度"""

import os
import pickle
import logging
import numpy as np
from typing import List, Tuple

logger = logging.getLogger(__name__)


class RAGEngine:
    def __init__(self, store_path: str):
        self.store_path = store_path
        os.makedirs(store_path, exist_ok=True)
        self._use_faiss = False
        try:
            import faiss  # noqa: F401
            self._use_faiss = True
        except ImportError:
            pass
        self.chunks: list[dict] = []
        self.embeddings: list[list[float]] = []
        self.dimension: int = 0
        self._index = None
        self._load()
        logger.info("[RAG] 引擎初始化: faiss=%s, chunks=%d, dim=%d", self._use_faiss, len(self.chunks), self.dimension)

    # ────────────────── 持久化 ──────────────────
    def _data_path(self) -> str:
        return os.path.join(self.store_path, "rag_store.pkl")

    def _load(self):
        path = self._data_path()
        if os.path.exists(path):
            with open(path, "rb") as f:
                data = pickle.load(f)
            self.chunks = data.get("chunks", [])
            self.embeddings = data.get("embeddings", [])
            self.dimension = data.get("dimension", 0)
            if self.embeddings:
                self._rebuild_index()
            logger.info("[RAG] 从磁盘加载: chunks=%d, dim=%d", len(self.chunks), self.dimension)
        else:
            logger.info("[RAG] 无已有数据, 空索引启动")

    def _save(self):
        with open(self._data_path(), "wb") as f:
            pickle.dump({
                "chunks": self.chunks,
                "embeddings": self.embeddings,
                "dimension": self.dimension,
            }, f)

    # ────────────────── 索引构建 ──────────────────
    def _rebuild_index(self):
        if not self.embeddings:
            self._index = None
            return
        # 过滤维度不一致的 embedding，防止 np.array 报错
        if self.dimension > 0:
            valid = [(c, e) for c, e in zip(self.chunks, self.embeddings)
                     if len(e) == self.dimension]
            if len(valid) < len(self.chunks):
                logger.warning("[RAG] 过滤维度不匹配的 chunks: %d -> %d (dim=%d)",
                               len(self.chunks), len(valid), self.dimension)
                self.chunks = [v[0] for v in valid]
                self.embeddings = [v[1] for v in valid]
        if not self.embeddings:
            self._index = None
            return
        emb = np.array(self.embeddings, dtype=np.float32)
        norms = np.linalg.norm(emb, axis=1, keepdims=True)
        norms[norms == 0] = 1
        emb_normed = emb / norms
        if self._use_faiss:
            import faiss
            self._index = faiss.IndexFlatIP(self.dimension)
            self._index.add(emb_normed)
        else:
            self._index = emb_normed  # numpy fallback

    # ────────────────── 添加文档块 ──────────────────
    def add_chunks(self, chunks: List[dict], embeddings: List[List[float]]):
        """chunks: [{"id":..., "doc_id":..., "content":...}, ...]"""
        if not embeddings:
            logger.warning("[RAG存储] add_chunks调用但embeddings为空, 跳过")
            return
        new_dim = len(embeddings[0])
        if self.dimension == 0:
            self.dimension = new_dim
        elif new_dim != self.dimension:
            logger.warning("[RAG存储] embedding维度不匹配: 现有=%d, 新=%d, 将清除旧索引并使用新维度",
                           self.dimension, new_dim)
            self.chunks = []
            self.embeddings = []
            self.dimension = new_dim
        logger.info("[RAG存储] 添加 %d 个chunks, dim=%d", len(chunks), self.dimension)
        self.chunks.extend(chunks)
        self.embeddings.extend(embeddings)
        self._rebuild_index()
        self._save()
        logger.info("[RAG存储] 索引重建并保存完成, 总 chunks=%d", len(self.chunks))

    # ────────────────── 语义搜索 ──────────────────
    def search(self, query_embedding: List[float], top_k: int = 5,
               min_score: float = 0.0) -> List[Tuple[dict, float]]:
        logger.info("[RAG查询] 向量搜索: top_k=%d, min_score=%.2f, 索引chunks=%d",
                    top_k, min_score, len(self.chunks))
        if self._index is None or not self.chunks:
            logger.warning("[RAG查询] 索引为空, 返回空结果")
            return []
        query = np.array([query_embedding], dtype=np.float32)
        norm = np.linalg.norm(query)
        if norm > 0:
            query = query / norm
        k = min(top_k, len(self.chunks))

        if self._use_faiss:
            scores, indices = self._index.search(query, k)
            results = []
            for s, i in zip(scores[0], indices[0]):
                if 0 <= i < len(self.chunks) and float(s) >= min_score:
                    results.append((self.chunks[i], float(s)))
            logger.info("[RAG查询] FAISS搜索完成, 返回 %d 条 (阈值过滤后), 最高分=%.4f",
                        len(results), results[0][1] if results else 0)
            return results
        else:
            sims = (self._index @ query.T).flatten()
            top_idx = np.argsort(sims)[::-1][:k]
            results = [(self.chunks[i], float(sims[i]))
                       for i in top_idx if float(sims[i]) >= min_score]
            logger.info("[RAG查询] numpy搜索完成, 返回 %d 条 (阈值过滤后), 最高分=%.4f",
                        len(results), results[0][1] if results else 0)
            return results

    # ────────────────── 删除某文档的所有块 ──────────────────
    def update_doc_category(self, doc_id: int, category: str):
        count = 0
        for c in self.chunks:
            if c.get("doc_id") == doc_id:
                c["category"] = category
                count += 1
        if count:
            self._save()
        logger.info("[RAG存储] 更新doc_id=%d的分类为'%s', 影响 %d 个chunks", doc_id, category, count)

    def remove_doc_chunks(self, doc_id: int):
        before = len(self.chunks)
        new_chunks, new_embs = [], []
        for c, e in zip(self.chunks, self.embeddings):
            if c.get("doc_id") != doc_id:
                new_chunks.append(c)
                new_embs.append(e)
        self.chunks = new_chunks
        self.embeddings = new_embs
        self._rebuild_index()
        self._save()
        logger.info("[RAG存储] 删除doc_id=%d的chunks: %d -> %d", doc_id, before, len(self.chunks))

    def clear(self):
        logger.info("[RAG存储] 清空所有索引数据")
        self.chunks, self.embeddings = [], []
        self._index = None
        self.dimension = 0
        path = self._data_path()
        if os.path.exists(path):
            os.remove(path)
