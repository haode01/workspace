"""统一 AI 接口 —— 封装 OpenAI 兼容 API，支持文本生成/流式输出/Embedding/Todo建议/RAG问答"""

import logging
from typing import Generator

logger = logging.getLogger(__name__)


class AIClient:
    def __init__(self, config: dict):
        # 问答模型配置
        self.api_key = config.get("api_key", "")
        self.api_base = config.get("api_base", "https://api.openai.com/v1")
        self.model = config.get("model", "gpt-3.5-turbo")
        # Embedding 模型配置 (独立 key/base，留空则复用问答模型)
        self.embedding_model = config.get("embedding_model", "")
        self._emb_api_key = config.get("embedding_api_key", "") or self.api_key
        self._emb_api_base = config.get("embedding_api_base", "") or self.api_base
        self._client = None
        self._emb_client = None
        logger.info("[AI] 初始化: model=%s, embedding=%s (独立endpoint=%s), configured=%s",
                    self.model, self.embedding_model,
                    bool(config.get("embedding_api_base")), bool(self.api_key))

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(api_key=self.api_key, base_url=self.api_base)
        return self._client

    def _get_emb_client(self):
        """获取 embedding 专用客户端 (可能和问答是不同的服务)"""
        if self._emb_client is None:
            from openai import OpenAI
            self._emb_client = OpenAI(api_key=self._emb_api_key, base_url=self._emb_api_base)
        return self._emb_client

    def is_configured(self) -> bool:
        return bool(self.api_key)

    # ────────────────── 核心聊天 ──────────────────
    def chat(self, messages: list, stream: bool = False, **kwargs):
        logger.info("[AI调用] chat: model=%s, stream=%s, messages=%d条", self.model, stream, len(messages))
        client = self._get_client()
        try:
            resp = client.chat.completions.create(
                model=self.model, messages=messages, stream=stream, **kwargs
            )
            if stream:
                logger.info("[AI调用] 流式响应开始")
                return self._iter_stream(resp)
            content = resp.choices[0].message.content
            logger.info("[AI调用] 响应完成, 长度=%d", len(content) if content else 0)
            return content
        except Exception as e:
            logger.error("[AI调用] chat失败: %s", e)
            raise

    def _iter_stream(self, response) -> Generator[str, None, None]:
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    # ────────────────── 便捷方法 ──────────────────
    def generate_text(self, prompt: str, system: str = "") -> str:
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.append({"role": "user", "content": prompt})
        return self.chat(msgs)

    def generate_text_stream(self, prompt: str, system: str = "") -> Generator[str, None, None]:
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.append({"role": "user", "content": prompt})
        return self.chat(msgs, stream=True)

    # ────────────────── Embedding (使用独立客户端) ──────────────────
    def get_embedding(self, text: str) -> list[float]:
        logger.info("[AI调用] get_embedding: 文本长度=%d, model=%s", len(text), self.embedding_model)
        client = self._get_emb_client()
        try:
            resp = client.embeddings.create(model=self.embedding_model, input=text)
            emb = resp.data[0].embedding
            logger.info("[AI调用] embedding生成成功, 维度=%d", len(emb))
            return emb
        except Exception as e:
            logger.error("[AI调用] get_embedding失败: %s", e)
            raise

    EMBED_BATCH_SIZE = 10   # 单批条数 (DashScope 限制 ≤10)
    EMBED_MAX_WORKERS = 4    # 并行请求线程数

    def get_embeddings(self, texts: list[str]) -> list[list[float]]:
        logger.info("[AI调用] get_embeddings: 总%d条, model=%s", len(texts), self.embedding_model)
        client = self._get_emb_client()
        batches = [texts[i:i + self.EMBED_BATCH_SIZE]
                   for i in range(0, len(texts), self.EMBED_BATCH_SIZE)]
        total_batches = len(batches)
        logger.info("[AI调用] embedding分%d批, 并行度=%d", total_batches, self.EMBED_MAX_WORKERS)

        def _embed_batch(batch):
            resp = client.embeddings.create(model=self.embedding_model, input=batch)
            return [d.embedding for d in resp.data]

        try:
            if total_batches <= 1:
                # 单批直接调用
                result = _embed_batch(batches[0]) if batches else []
            else:
                # 多批并行
                from concurrent.futures import ThreadPoolExecutor
                result = [None] * total_batches
                with ThreadPoolExecutor(max_workers=self.EMBED_MAX_WORKERS) as pool:
                    future_map = {pool.submit(_embed_batch, b): idx
                                  for idx, b in enumerate(batches)}
                    for future in future_map:
                        idx = future_map[future]
                        result[idx] = future.result()
                        logger.info("[AI调用] embedding批次完成 %d/%d",
                                    sum(1 for r in result if r is not None), total_batches)
                # 展平
                result = [emb for batch_result in result for emb in batch_result]
            logger.info("[AI调用] 批量embedding完成, 总%d条, 维度=%d",
                        len(result), len(result[0]) if result else 0)
            return result
        except Exception as e:
            logger.error("[AI调用] get_embeddings失败: %s", e)
            raise

    # ────────────────── Todo 智能建议 ──────────────────
    def generate_todo_suggestions(self, history_tasks: list) -> str:
        logger.info("[AI调用] 生成Todo建议, 历史任务数=%d", len(history_tasks))
        task_lines = "\n".join(
            [f"- {t['title']} (priority: {t.get('priority', 2)})" for t in history_tasks[:20]]
        )
        prompt = (
            "Based on the user's recent task history, suggest 3-5 tasks for today.\n"
            'Return in JSON array format: [{"title": "...", "priority": 1-3}]\n\n'
            f"Recent tasks:\n{task_lines}"
        )
        result = self.generate_text(prompt, system="You are a productivity assistant. Reply in Chinese.")
        logger.info("[AI调用] Todo建议生成完成, 长度=%d", len(result) if result else 0)
        return result

    # ────────────────── RAG 问答 ──────────────────
    def rag_answer(self, question: str, context_chunks: list[str]) -> str:
        logger.info("[AI调用] RAG问答: question='%s', 上下文块数=%d", question[:100], len(context_chunks))
        context = "\n---\n".join(context_chunks)
        prompt = (
            "Answer the question based on the following context. "
            "If the context doesn't contain enough information, say so.\n\n"
            f"Context:\n{context}\n\nQuestion: {question}"
        )
        result = self.generate_text(
            prompt, system="You are a knowledgeable assistant. Answer in Chinese based on the provided context."
        )
        logger.info("[AI调用] RAG问答完成, 答案长度=%d", len(result) if result else 0)
        return result

    def rag_answer_stream(self, question: str, context_chunks: list[str]) -> Generator[str, None, None]:
        logger.info("[AI调用] RAG流式问答: question='%s', 上下文块数=%d", question[:100], len(context_chunks))
        context = "\n---\n".join(context_chunks)
        prompt = (
            "Answer the question based on the following context. "
            "If the context doesn't contain enough information, say so.\n\n"
            f"Context:\n{context}\n\nQuestion: {question}"
        )
        return self.generate_text_stream(
            prompt, system="You are a knowledgeable assistant. Answer in Chinese based on the provided context."
        )
