import { config } from 'dotenv';
config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { posts } from './schema';

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });

const post = {
  title: 'PostgreSQL + Python + Next.js ML Stack: Complete Deployment Runbook',
  slug: 'postgresql-python-nextjs-ml-stack-runbook',
  excerpt:
    'Step-by-step runbook for deploying a full-stack ML application: PostgreSQL with pgvector extension, Python FastAPI middle tier with sentence-transformers, and a Next.js frontend — covering local Docker Compose development, schema setup, embedding pipeline, API deployment, Next.js environment wiring, and production deployment to Vercel plus Cloud Run.',
  category: 'postgres-ml' as const,
  published: true,
  isPremium: true,
  publishedAt: new Date('2026-06-14'),
  youtubeUrl: null,
  content: `## Stack Reference

| Layer | Technology | Deployment |
|-------|-----------|------------|
| Frontend | Next.js 15 (App Router) | Vercel |
| API | Python 3.12 + FastAPI | Cloud Run / Fly.io |
| Embeddings | sentence-transformers \`all-MiniLM-L6-v2\` | In-process |
| LLM (RAG) | OpenAI gpt-4o-mini | API |
| Database | PostgreSQL 16 + pgvector | Neon / Supabase / RDS |
| Local dev | Docker Compose | localhost |

---

## Phase 1 — PostgreSQL Setup

### 1.1 Enable pgvector

On managed providers (Neon, Supabase) pgvector is pre-installed:

\`\`\`sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- Expected: vector | 0.7.x
\`\`\`

On self-hosted PostgreSQL 16 (Debian/Ubuntu):

\`\`\`bash
apt install -y postgresql-16-pgvector
psql -U postgres -c "CREATE EXTENSION vector;"
\`\`\`

### 1.2 Create Application User

\`\`\`sql
CREATE USER ml_app WITH PASSWORD 'strong_password_here';
CREATE DATABASE knowledge_db OWNER ml_app;
\c knowledge_db
GRANT ALL ON SCHEMA public TO ml_app;
\`\`\`

### 1.3 Create Schema

\`\`\`sql
\c knowledge_db ml_app

CREATE TABLE documents (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  source_url  TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Adjust VECTOR dimensions to match your embedding model:
-- all-MiniLM-L6-v2  → VECTOR(384)
-- text-embedding-3-small → VECTOR(1536)
-- text-embedding-ada-002 → VECTOR(1536)
CREATE TABLE document_chunks (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  embedding    VECTOR(384),
  token_count  INTEGER,
  model_version TEXT DEFAULT 'all-MiniLM-L6-v2',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE search_logs (
  id              BIGSERIAL PRIMARY KEY,
  query_text      TEXT NOT NULL,
  top_chunk_ids   BIGINT[],
  latency_ms      INTEGER,
  session_id      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX ON documents (created_at DESC);
CREATE INDEX ON document_chunks (document_id);
CREATE INDEX ON document_chunks (model_version);
-- Build vector index after initial data load (see Phase 5)
\`\`\`

### 1.4 Verify Schema

\`\`\`bash
psql \$DATABASE_URL -c "\\d document_chunks"
# Should show: embedding | vector(384) | ...
\`\`\`

---

## Phase 2 — Python FastAPI Application

### 2.1 Project Structure

\`\`\`
api/
├── Dockerfile
├── requirements.txt
├── .env                  # local only — never commit
├── main.py
├── config.py
├── db.py
├── models.py
├── routers/
│   ├── __init__.py
│   ├── ingest.py
│   ├── search.py
│   └── ask.py
└── services/
    ├── __init__.py
    ├── embedder.py
    └── chunker.py
\`\`\`

### 2.2 requirements.txt

\`\`\`
fastapi==0.115.0
uvicorn[standard]==0.30.6
asyncpg==0.29.0
sentence-transformers==3.0.1
torch==2.4.0+cpu      # CPU-only torch — smaller image
openai==1.50.0
pydantic==2.9.0
pydantic-settings==2.5.2
python-multipart==0.0.9
httpx==0.27.2
\`\`\`

### 2.3 config.py

\`\`\`python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    database_url: str
    openai_api_key: str = ""
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embedding_dimensions: int = 384
    api_key: str = ""            # simple bearer token for Next.js → API auth

    model_config = SettingsConfigDict(env_file=".env")

settings = Settings()
\`\`\`

### 2.4 db.py

\`\`\`python
import asyncpg
from .config import settings

_pool: asyncpg.Pool | None = None

async def init_pool():
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
        init=_init_connection,
    )

async def _init_connection(conn):
    # Register the vector type codec so asyncpg knows how to handle it
    await conn.execute("SET application_name = 'ml_api'")

async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None

def get_pool() -> asyncpg.Pool:
    assert _pool is not None, "Pool not initialised"
    return _pool
\`\`\`

### 2.5 services/embedder.py

\`\`\`python
from sentence_transformers import SentenceTransformer
from .config import settings

class Embedder:
    def __init__(self):
        self.model = SentenceTransformer(settings.embedding_model)
        self.dims = self.model.get_sentence_embedding_dimension()

    def embed(self, text: str) -> list[float]:
        return self.model.encode(
            text, normalize_embeddings=True, show_progress_bar=False
        ).tolist()

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return self.model.encode(
            texts, normalize_embeddings=True,
            batch_size=32, show_progress_bar=False
        ).tolist()
\`\`\`

### 2.6 services/chunker.py

\`\`\`python
from dataclasses import dataclass

@dataclass
class Chunk:
    text: str
    token_count: int

def chunk_text(text: str, chunk_size: int = 400, overlap: int = 50) -> list[Chunk]:
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        window = words[i : i + chunk_size]
        chunk_text = " ".join(window)
        chunks.append(Chunk(text=chunk_text, token_count=len(window)))
        i += chunk_size - overlap
    return chunks
\`\`\`

### 2.7 models.py

\`\`\`python
from pydantic import BaseModel
from typing import Any

class IngestRequest(BaseModel):
    title: str
    content: str
    source_url: str | None = None
    metadata: dict[str, Any] | None = None

class IngestResponse(BaseModel):
    document_id: int
    chunks_created: int

class SearchRequest(BaseModel):
    query: str
    top_k: int = 5
    min_similarity: float = 0.3
    document_id: int | None = None

class SearchResult(BaseModel):
    chunk_id: int
    content: str
    document_title: str
    source_url: str | None
    similarity: float

class SearchResponse(BaseModel):
    results: list[SearchResult]
    latency_ms: int

class AskRequest(BaseModel):
    question: str
    top_k: int = 4
    min_similarity: float = 0.4
\`\`\`

### 2.8 routers/ingest.py

\`\`\`python
from fastapi import APIRouter
from ..models import IngestRequest, IngestResponse
from ..db import get_pool
from ..services.chunker import chunk_text
from ..main import get_embedder

router = APIRouter(prefix="/documents", tags=["ingest"])

@router.post("", response_model=IngestResponse)
async def ingest(req: IngestRequest):
    embedder = get_embedder()
    pool = get_pool()
    chunks = chunk_text(req.content)
    embeddings = embedder.embed_batch([c.text for c in chunks])

    async with pool.acquire() as conn:
        doc_id = await conn.fetchval(
            "INSERT INTO documents (title, source_url, metadata) "
            "VALUES ($1, $2, $3) RETURNING id",
            req.title, req.source_url, req.metadata or {}
        )
        await conn.executemany(
            "INSERT INTO document_chunks "
            "(document_id, chunk_index, content, embedding, token_count) "
            "VALUES ($1, $2, $3, $4::vector, $5)",
            [(doc_id, i, chunks[i].text, str(embeddings[i]), chunks[i].token_count)
             for i in range(len(chunks))]
        )

    return IngestResponse(document_id=doc_id, chunks_created=len(chunks))
\`\`\`

### 2.9 routers/search.py

\`\`\`python
from fastapi import APIRouter
from ..models import SearchRequest, SearchResponse, SearchResult
from ..db import get_pool
from ..main import get_embedder
import time

router = APIRouter(prefix="/search", tags=["search"])

@router.post("", response_model=SearchResponse)
async def search(req: SearchRequest):
    t0 = time.monotonic()
    embedder = get_embedder()
    pool = get_pool()
    vec = embedder.embed(req.query)

    # Build optional document filter
    where_clause = "WHERE 1 - (dc.embedding <=> $1::vector) >= $3"
    params: list = [str(vec), req.top_k, req.min_similarity]
    if req.document_id:
        where_clause += " AND dc.document_id = $4"
        params.append(req.document_id)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT dc.id, dc.content, d.title, d.source_url,
                   1 - (dc.embedding <=> $1::vector) AS similarity
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            {where_clause}
            ORDER BY dc.embedding <=> $1::vector
            LIMIT $2
            """,
            *params
        )

    return SearchResponse(
        results=[SearchResult(
            chunk_id=r["id"], content=r["content"],
            document_title=r["title"], source_url=r["source_url"],
            similarity=float(r["similarity"])
        ) for r in rows],
        latency_ms=int((time.monotonic() - t0) * 1000)
    )
\`\`\`

### 2.10 routers/ask.py

\`\`\`python
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI
from ..models import AskRequest
from ..db import get_pool
from ..main import get_embedder
import json

router = APIRouter(prefix="/ask", tags=["rag"])
_oai = AsyncOpenAI()

SYSTEM = (
    "You are a precise assistant. Answer using only the provided context. "
    "If the context does not contain the answer, say: 'I could not find that in the available documents.' "
    "Do not add information not present in the context."
)

@router.post("")
async def ask(req: AskRequest):
    embedder = get_embedder()
    pool = get_pool()
    vec = embedder.embed(req.question)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT dc.content, d.title,
                   1 - (dc.embedding <=> $1::vector) AS similarity
            FROM document_chunks dc
            JOIN documents d ON d.id = dc.document_id
            WHERE 1 - (dc.embedding <=> $1::vector) >= $2
            ORDER BY dc.embedding <=> $1::vector
            LIMIT $3
            """,
            str(vec), req.min_similarity, req.top_k
        )

    context = "\n\n---\n\n".join(
        f"[{r['title']}]\n{r['content']}" for r in rows
    )

    async def event_stream():
        if not rows:
            yield f"data: {json.dumps({'token': 'No relevant documents found.'})}\n\n"
            yield "data: [DONE]\n\n"
            return

        stream = await _oai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {req.question}"},
            ],
            stream=True,
            max_tokens=800,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta.content
            if delta:
                yield f"data: {json.dumps({'token': delta})}\n\n"
        # Send source titles
        sources = list({r["title"] for r in rows})
        yield f"data: {json.dumps({'sources': sources})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
\`\`\`

### 2.11 main.py

\`\`\`python
from contextlib import asynccontextmanager
from fastapi import FastAPI, Security, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from .services.embedder import Embedder
from .db import init_pool, close_pool
from .config import settings
from .routers import ingest, search, ask

_embedder: Embedder | None = None
_bearer = HTTPBearer(auto_error=False)

def get_embedder() -> Embedder:
    assert _embedder is not None
    return _embedder

def verify_token(creds: HTTPAuthorizationCredentials | None = Security(_bearer)):
    if settings.api_key and (not creds or creds.credentials != settings.api_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _embedder
    _embedder = Embedder()
    await init_pool()
    yield
    await close_pool()

app = FastAPI(title="ML API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # tighten in production
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(ingest.router, dependencies=[Security(verify_token)])
app.include_router(search.router, dependencies=[Security(verify_token)])
app.include_router(ask.router, dependencies=[Security(verify_token)])

@app.get("/health")
async def health():
    return {"status": "ok", "model": settings.embedding_model}
\`\`\`

### 2.12 Dockerfile

\`\`\`dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install build deps for asyncpg
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the embedding model into the image
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
\`\`\`

---

## Phase 3 — Local Development with Docker Compose

\`\`\`yaml
# docker-compose.yml (project root)
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ml_app
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: knowledge_db
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./schema.sql:/docker-entrypoint-initdb.d/01-schema.sql

  api:
    build: ./api
    environment:
      DATABASE_URL: postgresql://ml_app:devpassword@postgres:5432/knowledge_db
      OPENAI_API_KEY: \${OPENAI_API_KEY}
      API_KEY: dev-secret-key
    ports:
      - "8000:8000"
    depends_on:
      postgres:
        condition: service_healthy
    develop:
      watch:
        - action: sync+restart
          path: ./api
          target: /app

  nextjs:
    build: ./web
    environment:
      PYTHON_API_URL: http://api:8000
      PYTHON_API_KEY: dev-secret-key
      NEXT_PUBLIC_APP_URL: http://localhost:3000
    ports:
      - "3000:3000"
    depends_on:
      - api

volumes:
  pgdata:
\`\`\`

Start the stack:

\`\`\`bash
export OPENAI_API_KEY=sk-...
docker compose up --build
\`\`\`

Verify the API is healthy:

\`\`\`bash
curl http://localhost:8000/health
# {"status":"ok","model":"sentence-transformers/all-MiniLM-L6-v2"}
\`\`\`

---

## Phase 4 — Next.js Application Setup

### 4.1 Environment Variables

\`\`\`bash
# web/.env.local
PYTHON_API_URL=http://localhost:8000
PYTHON_API_KEY=dev-secret-key
\`\`\`

\`\`\`bash
# web/.env.production  (set as Vercel env vars, not committed)
PYTHON_API_URL=https://ml-api-xxxx.run.app
PYTHON_API_KEY=<strong-secret>
\`\`\`

### 4.2 API Client Utility

\`\`\`typescript
// web/lib/api.ts
const BASE = process.env.PYTHON_API_URL!;
const KEY  = process.env.PYTHON_API_KEY!;

function headers() {
  return {
    'Content-Type': 'application/json',
    ...(KEY ? { Authorization: \`Bearer \${KEY}\` } : {}),
  };
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(\`\${BASE}\${path}\`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(\`API \${path} failed \${res.status}: \${text}\`);
  }
  return res.json();
}

export async function apiStream(path: string, body: unknown): Promise<Response> {
  return fetch(\`\${BASE}\${path}\`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
}
\`\`\`

### 4.3 Search Page (Server Component)

\`\`\`typescript
// web/app/search/page.tsx
import { apiPost } from '@/lib/api';
import { SearchForm } from '@/components/SearchForm';

interface SearchResult {
  chunk_id: number;
  content: string;
  document_title: string;
  source_url: string | null;
  similarity: number;
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const results: SearchResult[] = searchParams.q
    ? (await apiPost<{ results: SearchResult[] }>('/search', {
        query: searchParams.q,
        top_k: 8,
      })).results
    : [];

  return (
    <main className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Knowledge Search</h1>
      <SearchForm defaultQuery={searchParams.q} />
      <ul className="mt-6 space-y-3">
        {results.map((r) => (
          <li key={r.chunk_id} className="border rounded-lg p-4 bg-white shadow-sm">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-sm">{r.document_title}</span>
              <span className="text-xs text-gray-400">
                {(r.similarity * 100).toFixed(0)}% match
              </span>
            </div>
            <p className="text-sm text-gray-600 line-clamp-3">{r.content}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
\`\`\`

### 4.4 Streaming Route Handler

\`\`\`typescript
// web/app/api/ask/route.ts
import { NextRequest } from 'next/server';
import { apiStream } from '@/lib/api';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const upstream = await apiStream('/ask', body);

  if (!upstream.ok) {
    return new Response('Upstream error', { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
\`\`\`

---

## Phase 5 — Build the Vector Index

Run after bulk-loading your initial documents. The HNSW index build is a one-time cost:

\`\`\`sql
-- Connect to the database and run:
CREATE INDEX CONCURRENTLY idx_chunks_embedding_hnsw
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Verify index is used:
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, 1 - (embedding <=> '[0.1, 0.2, ...]'::vector) AS sim
FROM document_chunks
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 5;
-- Look for: Index Scan using idx_chunks_embedding_hnsw
\`\`\`

Tune for query speed vs recall:

\`\`\`sql
-- Per-session (set in python via: await conn.execute("SET hnsw.ef_search = 40"))
SET hnsw.ef_search = 40;   -- higher = better recall, slower queries
\`\`\`

---

## Phase 6 — Test the Full Stack

### 6.1 Ingest a Document

\`\`\`bash
curl -X POST http://localhost:8000/documents \
  -H "Authorization: Bearer dev-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "PostgreSQL Performance Tuning",
    "content": "PostgreSQL offers several parameters for performance tuning... shared_buffers should be set to 25% of RAM. work_mem controls the memory available for sort operations...",
    "source_url": "https://docs.example.com/pg-tuning"
  }'
# Expected: {"document_id": 1, "chunks_created": 3}
\`\`\`

### 6.2 Semantic Search

\`\`\`bash
curl -X POST http://localhost:8000/search \
  -H "Authorization: Bearer dev-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"query": "how much memory should I give postgres", "top_k": 3}'
# Expected: results with similarity scores, top result mentioning shared_buffers
\`\`\`

### 6.3 RAG Ask

\`\`\`bash
curl -X POST http://localhost:8000/ask \
  -H "Authorization: Bearer dev-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the recommended shared_buffers setting?"}' \
  --no-buffer
# Expected: SSE stream of tokens forming a grounded answer
\`\`\`

### 6.4 Verify Vector Index Usage

\`\`\`sql
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes
WHERE indexname LIKE '%embedding%';
-- idx_scan should increment with each search request
\`\`\`

---

## Phase 7 — Production Deployment

### 7.1 Deploy Python API to Cloud Run

\`\`\`bash
# Build and push image:
gcloud auth configure-docker us-central1-docker.pkg.dev
docker build -t us-central1-docker.pkg.dev/PROJECT/repo/ml-api:latest ./api
docker push us-central1-docker.pkg.dev/PROJECT/repo/ml-api:latest

# Deploy:
gcloud run deploy ml-api \
  --image us-central1-docker.pkg.dev/PROJECT/repo/ml-api:latest \
  --region us-central1 \
  --memory 2Gi \
  --cpu 2 \
  --min-instances 1 \
  --max-instances 5 \
  --set-env-vars DATABASE_URL=\$DATABASE_URL \
  --set-env-vars OPENAI_API_KEY=\$OPENAI_API_KEY \
  --set-env-vars API_KEY=\$API_KEY \
  --no-allow-unauthenticated    # use Cloud Run IAM or API key auth
\`\`\`

\`--min-instances 1\` prevents cold starts from reloading the 90 MB embedding model on every request. One warm instance costs ~\$15–25/month on Cloud Run.

### 7.2 Deploy Next.js to Vercel

\`\`\`bash
vercel env add PYTHON_API_URL production
# Enter: https://ml-api-xxxx.run.app

vercel env add PYTHON_API_KEY production
# Enter: <strong random secret>

vercel --prod
\`\`\`

### 7.3 Verify Production Search Latency

\`\`\`bash
# From any machine:
time curl -X POST https://your-domain.com/api/search-proxy \
  -H "Content-Type: application/json" \
  -d '{"query": "postgres memory configuration"}'
# Target: < 200ms end-to-end for semantic search
\`\`\`

---

## Phase 8 — Monitoring

### Search Latency Query

\`\`\`sql
-- Average search latency by hour (last 24h):
SELECT
  date_trunc('hour', created_at) AS hour,
  COUNT(*) AS searches,
  AVG(latency_ms) AS avg_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
FROM search_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1
ORDER BY 1;
\`\`\`

### Embedding Coverage

\`\`\`sql
-- Check for chunks without embeddings (ingest failures):
SELECT COUNT(*) AS missing_embeddings
FROM document_chunks
WHERE embedding IS NULL;

-- Total documents and chunk counts:
SELECT
  d.title,
  COUNT(dc.id) AS chunk_count,
  SUM(dc.token_count) AS total_tokens
FROM documents d
LEFT JOIN document_chunks dc ON dc.document_id = d.id
GROUP BY d.id, d.title
ORDER BY d.created_at DESC
LIMIT 20;
\`\`\`

### HNSW Index Health

\`\`\`sql
-- Index size and scan count:
SELECT
  indexname,
  pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size,
  idx_scan,
  idx_tup_read
FROM pg_stat_user_indexes
WHERE tablename = 'document_chunks';
\`\`\`

---

## Troubleshooting Reference

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Slow first query after deploy | Embedding model cold start | Set \`--min-instances 1\` on Cloud Run |
| \`operator does not exist: vector <=> vector\` | pgvector not installed | \`CREATE EXTENSION vector;\` |
| Low similarity scores (all < 0.3) | Wrong embedding model or dimension mismatch | Verify schema \`VECTOR(n)\` matches model dims |
| Index scan not used in EXPLAIN | Not enough rows, or planner choosing seqscan | \`SET enable_seqscan = off;\` to force test; re-run ANALYZE |
| CORS error from browser | API CORS origins list | Add Next.js domain to \`allow_origins\` in FastAPI CORS middleware |
| Streaming response cuts off | Vercel response timeout | Move stream proxy to Vercel Edge route or increase timeout |
| \`asyncpg.TooManyConnectionsError\` | Pool exhausted | Add pgBouncer in front of Postgres, reduce \`max_size\` |`,
};

async function main() {
  console.log('Inserting PostgreSQL ML runbook...');
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
