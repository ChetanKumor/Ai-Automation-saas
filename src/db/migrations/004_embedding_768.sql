-- Switch embedding from 3072 (gemini-embedding-001) to 768 (text-embedding-004)
ALTER TABLE knowledge_chunks DROP COLUMN embedding;
ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(768);
CREATE INDEX idx_knowledge_chunks_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
