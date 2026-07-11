const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../../db/db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

// `signal` (Issue 29): the voice turn's combined close/deadline AbortSignal —
// aborts the in-flight embedding fetch. Absent (WhatsApp path, ingestion),
// behavior is unchanged.
async function embed(text, signal = null) {
  const request = {
    content: { parts: [{ text }] },
    outputDimensionality: 768
  };
  const result = signal
    ? await embeddingModel.embedContent(request, { signal })
    : await embeddingModel.embedContent(request);
  return result.embedding.values;
}

async function storeChunks(tenantId, chunks, source) {
  for (const chunk of chunks) {
    const embedding = await embed(chunk);
    await db.query(
      `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
       VALUES ($1, $2, $3::vector, $4)`,
      [tenantId, chunk, `[${embedding.join(',')}]`, source]
    );
  }
  return chunks.length;
}

async function getRelevantChunks(tenantId, query, topK = 3, { signal = null } = {}) {
  const queryEmbedding = await embed(query, signal);
  // `id` rides along for trace retrieval provenance (Issue 22) — every
  // consumer reads only content/similarity, so this is capture-only.
  const { rows } = await db.query(
    `SELECT id, content, 1 - (embedding <=> $2::vector) AS similarity
     FROM knowledge_chunks
     WHERE tenant_id = $1
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [tenantId, `[${queryEmbedding.join(',')}]`, topK]
  );
  return rows;
}

function chunkText(text, maxLen = 500, overlap = 50) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current && (current.length + trimmed.length + 1) > maxLen) {
      chunks.push(current.trim());
      // Keep tail of previous chunk as overlap
      current = current.slice(-overlap) + ' ' + trimmed;
    } else {
      current = current ? current + '\n' + trimmed : trimmed;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

module.exports = { embed, storeChunks, getRelevantChunks, chunkText };
