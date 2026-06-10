import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'Full-Stack Machine Learning with PostgreSQL, Python, and Next.js',
  slug: 'postgresql-machine-learning-python-nextjs',
  excerpt:
    'A technical guide to building production ML applications using PostgreSQL with pgvector as the vector store, FastAPI as the Python middle tier for embedding generation and inference, and Next.js as the frontend — covering semantic search, retrieval-augmented generation, the data pipeline from document ingestion to query response, and deployment architecture.',
  category: 'postgres-ml' as const,
  published: true,
  isPremium: false,
  publishedAt: new Date('2026-06-14'),
  youtubeUrl: null,
  content: `PostgreSQL has moved beyond its role as a relational database. With the pgvector extension, it becomes a fully capable vector store — storing high-dimensional embeddings alongside structured data, querying them with approximate nearest-neighbour search, and combining vector similarity with SQL predicates in a single query. This makes it a natural foundation for ML applications where the data pipeline, the embeddings, and the business data all need to live in the same place.

This post walks through the architecture and implementation of a full-stack ML application: PostgreSQL with pgvector as the data layer, a Python FastAPI service as the ML middle tier, and a Next.js application as the frontend. The example use case is a document knowledge base with semantic search and retrieval-augmented generation (RAG) — the same pattern used in enterprise document Q&A, support ticket routing, and internal search tools.

---

## Architecture Overview

\`\`\`
User (Browser)
      │
      ▼
┌─────────────────────────────────────┐
│  Next.js Application                │
│  - Server Components (page render)  │
│  - Server Actions (mutations)       │
│  - Route Handlers (streaming)       │
└──────────────┬──────────────────────┘
               │ HTTP / Server-to-Server
               ▼
┌─────────────────────────────────────┐
│  Python FastAPI Middle Tier         │
│  - /embed  (generate embeddings)    │
│  - /search (semantic search)        │
│  - /ask    (RAG Q&A)                │
│  - Loads ML models at startup       │
│  - Manages PG connection pool       │
└──────────────┬──────────────────────┘
               │ asyncpg / psycopg3
               ▼
┌─────────────────────────────────────┐
│  PostgreSQL + pgvector              │
│  - documents table                  │
│  - document_chunks table            │
│    └── embedding vector(1536)       │
│  - search_logs table                │
│  - IVFFlat / HNSW index on vectors  │
└─────────────────────────────────────┘
\`\`\`

The Python layer owns the ML logic — model loading, embedding generation, and LLM calls. PostgreSQL owns the data — both the structured metadata and the vector embeddings. Next.js owns the user interface and delegates all ML-related work to the Python API, which it calls server-side.

---

## PostgreSQL and pgvector

### What pgvector Provides

pgvector adds a \`vector\` data type and three similarity operators:

| Operator | Measures | Use Case |
|----------|---------|---------|
| \`<->\` | L2 (Euclidean) distance | Image similarity, coordinate space |
| \`<#>\` | Negative inner product | When vectors are normalised |
| \`<=>\` | Cosine distance | Text embeddings (most common) |

Cosine distance is standard for text embeddings because it measures the angle between vectors — two documents about the same topic will have a small angle even if one is shorter than the other.

### Installing pgvector

\`\`\`sql
-- On self-hosted PostgreSQL 15/16:
-- (after: apt install postgresql-16-pgvector)
CREATE EXTENSION IF NOT EXISTS vector;

-- Neon, Supabase, and most managed Postgres providers
-- include pgvector pre-installed:
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
\`\`\`

### Schema Design

The central design decision is how to split documents. Full documents are rarely chunked as single embeddings — a 10-page PDF produces an embedding that averages out the meaning of all 10 pages, making it poor at matching a specific question. Chunking splits documents into 300–500 token segments, each with its own embedding, so a query about page 7 can match the right chunk.

\`\`\`sql
CREATE TABLE documents (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  source_url  TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE document_chunks (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,          -- position within document
  content     TEXT NOT NULL,             -- raw text of this chunk
  embedding   VECTOR(1536),              -- text-embedding-3-small = 1536 dims
  token_count INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Fast metadata lookup on document side:
CREATE INDEX ON documents (created_at DESC);
CREATE INDEX ON document_chunks (document_id);

-- Vector similarity index (build after bulk load):
CREATE INDEX ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE search_logs (
  id          BIGSERIAL PRIMARY KEY,
  query_text  TEXT NOT NULL,
  query_embedding VECTOR(1536),
  top_chunk_ids   BIGINT[],
  latency_ms      INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
\`\`\`

### Querying: Semantic Search in Pure SQL

\`\`\`sql
-- Find the 5 chunks most semantically similar to a query embedding:
SELECT
  dc.id,
  dc.content,
  d.title,
  d.source_url,
  1 - (dc.embedding <=> \$1::vector) AS similarity  -- convert distance to similarity
FROM document_chunks dc
JOIN documents d ON d.id = dc.document_id
ORDER BY dc.embedding <=> \$1::vector    -- ASC = closest first
LIMIT 5;
\`\`\`

The \`\$1::vector\` placeholder accepts the query embedding as a float array. The \`1 - distance\` calculation converts cosine distance (0 = identical, 2 = opposite) to cosine similarity (1 = identical, -1 = opposite) — more intuitive for scoring.

### Filtering: Combining Vectors with SQL

One of pgvector's most useful properties is that vector search is just another expression in a SQL query. You can filter by any column before or after the similarity search:

\`\`\`sql
-- Semantic search within a specific document:
SELECT dc.content, 1 - (dc.embedding <=> \$1::vector) AS similarity
FROM document_chunks dc
WHERE dc.document_id = \$2
ORDER BY dc.embedding <=> \$1::vector
LIMIT 5;

-- Semantic search filtered by metadata:
SELECT dc.content, 1 - (dc.embedding <=> \$1::vector) AS similarity
FROM document_chunks dc
JOIN documents d ON d.id = dc.document_id
WHERE d.metadata->>'department' = 'engineering'
  AND d.created_at > NOW() - INTERVAL '90 days'
ORDER BY dc.embedding <=> \$1::vector
LIMIT 5;
\`\`\`

This is the key advantage over standalone vector databases — you get vector search and SQL predicates in one query, on one server, without orchestrating two data stores.

---

## Python FastAPI Middle Tier

The Python layer serves two purposes: it runs the ML models (embedding model, optionally an LLM), and it manages the database connection pool. Next.js cannot load Python ML libraries directly, and you do not want to instantiate a sentence-transformer model on every HTTP request — the Python service loads models once at startup and serves many requests from that loaded state.

### Application Structure

\`\`\`
api/
├── main.py             # FastAPI app, lifespan hook loads models
├── config.py           # Settings from env vars (pydantic-settings)
├── db.py               # asyncpg connection pool
├── models.py           # Pydantic request/response schemas
├── routers/
│   ├── ingest.py       # POST /documents  (upload + chunk + embed)
│   ├── search.py       # POST /search     (semantic search)
│   └── ask.py          # POST /ask        (RAG Q&A)
└── services/
    ├── embedder.py     # Embedding model wrapper
    └── chunker.py      # Text splitting logic
\`\`\`

### Startup: Loading the Embedding Model

\`\`\`python
# main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from .services.embedder import Embedder
from .db import init_pool, close_pool

embedder: Embedder | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global embedder
    embedder = Embedder()          # loads model from disk once
    await init_pool()              # creates asyncpg connection pool
    yield
    await close_pool()

app = FastAPI(lifespan=lifespan)
\`\`\`

\`\`\`python
# services/embedder.py
from sentence_transformers import SentenceTransformer
import numpy as np

class Embedder:
    def __init__(self, model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self.model = SentenceTransformer(model_name)
        self.dimensions = self.model.get_sentence_embedding_dimension()

    def embed(self, text: str) -> list[float]:
        vec = self.model.encode(text, normalize_embeddings=True)
        return vec.tolist()

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        vecs = self.model.encode(texts, normalize_embeddings=True, batch_size=32)
        return vecs.tolist()
\`\`\`

Using \`all-MiniLM-L6-v2\` produces 384-dimensional embeddings and runs on CPU — appropriate for moderate traffic without GPU. For higher quality, swap to \`text-embedding-3-small\` via the OpenAI API (1536 dims, requires API key, adjust the schema \`VECTOR(384)\` accordingly).

### Database Pool

\`\`\`python
# db.py
import asyncpg
import os

_pool: asyncpg.Pool | None = None

async def init_pool():
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=os.environ["DATABASE_URL"],
        min_size=2,
        max_size=10,
        command_timeout=30,
    )

async def close_pool():
    if _pool:
        await _pool.close()

def get_pool() -> asyncpg.Pool:
    assert _pool is not None
    return _pool
\`\`\`

### Document Ingestion Endpoint

\`\`\`python
# routers/ingest.py
from fastapi import APIRouter, Depends
from ..models import IngestRequest, IngestResponse
from ..db import get_pool
from ..services.chunker import chunk_text
from ..main import embedder
import asyncpg

router = APIRouter()

@router.post("/documents", response_model=IngestResponse)
async def ingest_document(req: IngestRequest):
    pool = get_pool()

    # 1. Split document into chunks
    chunks = chunk_text(req.content, chunk_size=400, overlap=50)

    # 2. Embed all chunks in one batch call
    embeddings = embedder.embed_batch([c.text for c in chunks])

    async with pool.acquire() as conn:
        # 3. Insert document record
        doc_id = await conn.fetchval(
            "INSERT INTO documents (title, source_url, metadata) "
            "VALUES ($1, $2, $3) RETURNING id",
            req.title, req.source_url, req.metadata or {}
        )

        # 4. Bulk-insert chunks with embeddings
        await conn.executemany(
            "INSERT INTO document_chunks "
            "(document_id, chunk_index, content, embedding, token_count) "
            "VALUES ($1, $2, $3, $4::vector, $5)",
            [
                (doc_id, i, chunks[i].text, str(embeddings[i]), chunks[i].token_count)
                for i in range(len(chunks))
            ]
        )

    return IngestResponse(document_id=doc_id, chunks_created=len(chunks))
\`\`\`

### Semantic Search Endpoint

\`\`\`python
# routers/search.py
from fastapi import APIRouter
from ..models import SearchRequest, SearchResult, SearchResponse
from ..db import get_pool
from ..main import embedder
import time

router = APIRouter()

@router.post("/search", response_model=SearchResponse)
async def semantic_search(req: SearchRequest):
    pool = get_pool()
    t0 = time.monotonic()

    # 1. Embed the query
    query_vec = embedder.embed(req.query)

    # 2. Vector similarity search
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
              dc.id,
              dc.content,
              d.title,
              d.source_url,
              1 - (dc.embedding <=> $1::vector) AS similarity
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            ORDER BY dc.embedding <=> $1::vector
            LIMIT $2
            """,
            str(query_vec), req.top_k or 5
        )

    latency_ms = int((time.monotonic() - t0) * 1000)

    results = [
        SearchResult(
            chunk_id=r["id"],
            content=r["content"],
            document_title=r["title"],
            source_url=r["source_url"],
            similarity=float(r["similarity"]),
        )
        for r in rows
    ]

    return SearchResponse(results=results, latency_ms=latency_ms)
\`\`\`

### RAG Endpoint (Retrieval-Augmented Generation)

The RAG pattern combines vector search with an LLM. The query is first used to retrieve the most relevant chunks from PostgreSQL, then those chunks are passed as context to an LLM which synthesises a grounded answer:

\`\`\`python
# routers/ask.py
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from ..models import AskRequest
from ..db import get_pool
from ..main import embedder
import json

router = APIRouter()
client = AsyncOpenAI()    # reads OPENAI_API_KEY from env

@router.post("/ask")
async def ask(req: AskRequest):
    pool = get_pool()

    # 1. Retrieve relevant chunks
    query_vec = embedder.embed(req.question)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT dc.content, d.title,
                   1 - (dc.embedding <=> $1::vector) AS similarity
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            ORDER BY dc.embedding <=> $1::vector
            LIMIT 4
            """,
            str(query_vec)
        )

    # 2. Build context from retrieved chunks
    context = "\n\n---\n\n".join(
        f"Source: {r['title']}\n{r['content']}"
        for r in rows
        if float(r["similarity"]) > 0.4    # discard low-relevance chunks
    )

    if not context:
        return {"answer": "No relevant documents found.", "sources": []}

    # 3. Stream LLM response
    system_prompt = (
        "You are a helpful assistant. Answer the question using only the "
        "provided context. If the context does not contain the answer, say so. "
        "Do not fabricate information."
    )

    async def stream_response():
        stream = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {req.question}"},
            ],
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield f"data: {json.dumps({'token': delta})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream")
\`\`\`

---

## Next.js Frontend

The Next.js application calls the Python API from the server side — either in Server Components (for initial page data), Server Actions (for form submissions), or Route Handlers (for streaming). Client components handle streaming display.

### Server Action: Semantic Search

\`\`\`typescript
// app/actions/search.ts
'use server';

export interface SearchResult {
  chunk_id: number;
  content: string;
  document_title: string;
  source_url: string | null;
  similarity: number;
}

export async function search(query: string): Promise<SearchResult[]> {
  const res = await fetch(\`\${process.env.PYTHON_API_URL}/search\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, top_k: 5 }),
    cache: 'no-store',
  });

  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return data.results;
}
\`\`\`

\`\`\`typescript
// app/search/page.tsx
import { SearchForm } from '@/components/SearchForm';
import { search } from '@/app/actions/search';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const results = searchParams.q ? await search(searchParams.q) : [];

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Document Search</h1>
      <SearchForm defaultQuery={searchParams.q} />
      {results.length > 0 && (
        <ul className="mt-6 space-y-4">
          {results.map((r) => (
            <li key={r.chunk_id} className="border rounded p-4">
              <div className="flex justify-between mb-1">
                <span className="font-medium">{r.document_title}</span>
                <span className="text-sm text-gray-500">
                  {(r.similarity * 100).toFixed(1)}% match
                </span>
              </div>
              <p className="text-sm text-gray-700">{r.content}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
\`\`\`

### Route Handler: Streaming RAG Response

\`\`\`typescript
// app/api/ask/route.ts
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const { question } = await req.json();

  const upstream = await fetch(\`\${process.env.PYTHON_API_URL}/ask\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });

  // Proxy the SSE stream directly to the browser
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
\`\`\`

\`\`\`typescript
// components/AskBox.tsx
'use client';
import { useState } from 'react';

export function AskBox() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleAsk() {
    setAnswer('');
    setLoading(true);

    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          const payload = JSON.parse(line.slice(6));
          setAnswer((prev) => prev + payload.token);
        }
      }
    }
    setLoading(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about your documents..."
          className="flex-1 border rounded px-3 py-2"
          onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
        />
        <button
          onClick={handleAsk}
          disabled={loading || !question}
          className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
        >
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </div>
      {answer && (
        <div className="border rounded p-4 whitespace-pre-wrap text-sm">
          {answer}
        </div>
      )}
    </div>
  );
}
\`\`\`

---

## Vector Index Choice: IVFFlat vs HNSW

pgvector supports two approximate nearest-neighbour index types:

| Index | Build Time | Query Speed | Memory | Accuracy |
|-------|-----------|-------------|--------|----------|
| IVFFlat | Fast | Good | Low | Tunable via \`probes\` |
| HNSW | Slow | Excellent | High | Tunable via \`ef_search\` |

**IVFFlat** divides the vector space into \`lists\` clusters and searches \`probes\` clusters at query time. Build it after bulk-loading embeddings (not before — the index is better when it sees the full distribution):

\`\`\`sql
-- Rule of thumb: lists = rows / 1000, probes = lists / 10
CREATE INDEX ON document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);   -- for ~100k rows

SET ivfflat.probes = 10;   -- session-level, or set in postgresql.conf
\`\`\`

**HNSW** builds a multi-layer graph for logarithmic-time lookup. Use it when query latency matters more than index build time or memory:

\`\`\`sql
CREATE INDEX ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

SET hnsw.ef_search = 40;   -- increase for better recall at cost of speed
\`\`\`

For most document search use cases with < 1 million chunks, HNSW with default parameters delivers < 5 ms query latency and > 95% recall.

---

## Production Architecture

\`\`\`
                     CDN / Edge
                         │
                    Next.js (Vercel)
                         │ private network
                    Python API (Cloud Run / Fly.io)
                         │
                    pgBouncer (connection pooler)
                         │
                    PostgreSQL 16 (managed: Neon / RDS / Cloud SQL)
\`\`\`

Key production considerations:

**Model serving:** If traffic is high, move the embedding model to a dedicated inference service (HuggingFace Inference Endpoints, Modal, Replicate) and have the FastAPI tier call it rather than load the model in-process. This lets you scale the API tier and model tier independently.

**Connection pooling:** The Python API maintains an asyncpg pool (up to 10 connections). For multiple API replicas, add pgBouncer in front of PostgreSQL in transaction-pooling mode — this prevents connection exhaustion when the API scales horizontally.

**Embedding dimensions and cost:** \`all-MiniLM-L6-v2\` (384 dims, free, CPU) is the right starting point. Migrate to OpenAI \`text-embedding-3-small\` (1536 dims, ~\$0.02/million tokens) if recall quality needs improvement. Each dimension increase raises storage by 4× and index size proportionally.

**Re-embedding:** When you swap embedding models, existing stored embeddings are incompatible with new model outputs. Plan re-embedding as a background migration — add a \`model_version\` column to \`document_chunks\`, run the new embeddings in parallel, switch the index over, then drop old embeddings.

The companion runbook covers the complete deployment procedure: PostgreSQL pgvector setup, Python FastAPI application deployment with Docker, Next.js environment configuration, local Docker Compose for development, and production deployment to Vercel + Cloud Run.`,
};

async function main() {
  console.log('Inserting PostgreSQL ML blog post...');
  await db.insert(posts).values(post).onConflictDoUpdate({
    target: posts.slug,
    set: {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      published: post.published,
      isPremium: post.isPremium,
      publishedAt: post.publishedAt,
      youtubeUrl: post.youtubeUrl,
    },
  });
  console.log('Inserted:', JSON.stringify(post.title));
}

main().catch(console.error);
