#!/usr/bin/env node
// Usage: node scripts/ingest-knowledge.js --tenant <uuid> --file <path> [--source <label>]
require('dotenv').config();
const fs = require('fs');
const { chunkText, storeChunks } = require('../src/modules/knowledge/knowledgeService');

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

  const tenantId = flag('--tenant');
  const filePath = flag('--file');
  const source   = flag('--source') || filePath;

  if (!tenantId || !filePath) {
    console.error('Usage: node scripts/ingest-knowledge.js --tenant <uuid> --file <path> [--source <label>]');
    process.exit(1);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  const chunks = chunkText(text);

  console.log(`Chunked into ${chunks.length} pieces. Embedding and storing...`);

  const stored = await storeChunks(tenantId, chunks, source);
  console.log(`Done. Stored ${stored} chunks for tenant ${tenantId}.`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
