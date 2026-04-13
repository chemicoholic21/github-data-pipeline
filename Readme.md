# GitHub Data Pipeline

> A headless data pipeline that ingests, caches, and analyzes GitHub data — transforming it into structured insights stored in Postgres and Redis.

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](https://opensource.org/licenses/ISC)
[![pnpm](https://img.shields.io/badge/pnpm-10.33.0-F69220?style=flat-square&logo=pnpm)](https://pnpm.io/)

---

## Table of contents

- [About](#about)
- [System architecture](#system-architecture)
- [Data flow](#data-flow)
- [Module structure](#module-structure)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Usage](#usage)
- [Scripts](#scripts)
- [Database](#database)

---

## About

This project is a **headless, queue-driven ETL pipeline** that connects to the GitHub API (REST and GraphQL), discovers repositories and contributors at scale, enriches profiles via external sources (Apify / LinkedIn), and stores structured insights in PostgreSQL — with Redis acting as a rate-limit-aware cache layer to avoid redundant API calls.

Core capabilities:

- Bulk repository discovery across GitHub organisations and topics
- Contributor profiling and LinkedIn enrichment via Apify
- Async, concurrent job processing powered by BullMQ
- Drizzle ORM schema with Neon (serverless) and standard `pg` support
- Runtime schema validation with Zod throughout the pipeline

---

## System architecture

The diagram below shows how the major services relate to each other — ingestion scripts feed into a BullMQ job queue, workers pull jobs and hit the GitHub API, results are validated and written to Postgres, and Redis acts as the caching layer.


<br/>



<details>
<summary>View as inline SVG</summary>

```
CLI / scripts  →  BullMQ queue  →  Workers  →  GitHub API
                                      ↓              ↓
                                   Zod validate   (cache miss)
                                      ↓
                              Postgres (Drizzle)  +  Redis cache
```

</details>

<br/>

| Component | Role |
|---|---|
| `src/cli.ts` | Entry point — exposes CLI commands |
| BullMQ + ioredis | Async job queue and worker scheduling |
| `@octokit/rest` + `@octokit/graphql` | GitHub API client (REST and GraphQL) |
| Drizzle ORM + `pg` / Neon | Typed Postgres access and migrations |
| ioredis / `@upstash/redis` | Self-hosted and serverless Redis cache |
| Zod | Runtime validation of all API responses |

---

## Data flow

Each pipeline run follows this sequence — from trigger to durable storage:

<br/>
 <p align="center">
  <img src="github_api_cache_hit_miss_flow.svg" alt="GitHub API cache hit/miss flow" width="100%" />
</p>

<br/>

**Step-by-step:**

1. **Trigger** — a CLI command or the `bulk-discover` script kicks off a run
2. **Enqueue** — jobs (repo, user, PR) are pushed to a BullMQ queue
3. **Worker picks up** — a concurrency-controlled processor dequeues the job
4. **Cache check** — Redis is consulted first; a cache hit short-circuits the API call
5. **GitHub API fetch** — on a cache miss, Octokit fetches from REST or GraphQL
6. **Validate** — the response is parsed through a Zod schema
7. **Persist + cache** — validated data is upserted into Postgres and written back to Redis with a TTL

---

## Module structure

The `src/` directory is organised by concern — each subfolder owns one layer of the pipeline:

<br/>



<br/>

```
github-data-pipeline/
├── src/
│   ├── cli.ts                        # Entry point — CLI command definitions
│   ├── db/
│   │   ├── schema.ts                 # Drizzle table definitions
│   │   └── client.ts                 # pg / Neon connection setup
│   ├── queue/
│   │   ├── queues.ts                 # BullMQ queue definitions
│   │   └── jobs.ts                   # Job type definitions
│   ├── workers/
│   │   ├── repo.worker.ts            # Repository ingestion processor
│   │   └── user.worker.ts            # Contributor enrichment processor
│   ├── github/
│   │   ├── client.ts                 # Octokit init and auth
│   │   └── rate-limit.ts             # Rate-limit handling
│   ├── cache/
│   │   ├── redis.ts                  # ioredis / @upstash/redis abstraction
│   │   └── keys.ts                   # Cache key conventions
│   └── scripts/
│       ├── bulk-discover.ts          # Batch repository discovery
│       └── enrich-linkedin-apify.ts  # LinkedIn enrichment via Apify
├── drizzle.config.ts                 # Drizzle Kit migration config
├── tsconfig.json                     # TypeScript compiler config
├── package.json
└── pnpm-lock.yaml
```![github_api_cache_hit_miss_flow](https://github.com/user-attachments/assets/2a3a4741-2661-4993-882d-ef69cc183dbd)


---

## Tech stack

| Package | Purpose |
|---|---|
| `typescript` | Static typing throughout |
| `drizzle-orm` + `drizzle-kit` | ORM and schema migration |
| `pg` + `@neondatabase/serverless` | PostgreSQL drivers (standard + serverless) |
| `ioredis` + `@upstash/redis` | Redis clients (self-hosted + Upstash) |
| `bullmq` | Job queue and worker framework |
| `@octokit/rest` + `@octokit/graphql` | GitHub API clients |
| `zod` | Runtime schema validation |
| `axios` | HTTP client for external enrichment APIs |
| `dotenv` | Environment variable loading |
| `tsx` | TypeScript execution for scripts |

---

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** ≥ 10
- A running **PostgreSQL** instance (or a [Neon](https://neon.tech) project)
- A running **Redis** instance (or an [Upstash](https://upstash.com) database)
- A **GitHub personal access token** with `repo` and `read:org` scopes

---

## Installation

```bash
# Clone the repo
git clone https://github.com/chemicoholic21/github-data-pipeline.git
cd github-data-pipeline

# Install dependencies
pnpm install

# Push the database schema
pnpm db:push
```

---

## Environment variables

Create a `.env` file at the repo root:

```env
# PostgreSQL connection string
DATABASE_URL=postgresql://user:password@host:5432/dbname

# GitHub personal access token
GITHUB_TOKEN=ghp_...

# Redis connection (self-hosted)
REDIS_URL=redis://localhost:6379

# Upstash Redis (serverless alternative)
UPSTASH_REDIS_REST_URL=https://...
UPSTASH_REDIS_REST_TOKEN=...

# Apify API token (for LinkedIn enrichment)
APIFY_TOKEN=...
```

---

## Usage

```bash
# Start the pipeline in dev mode (watch)
pnpm dev

# Run the bulk discovery script
pnpm bulk-discover

# Run LinkedIn enrichment
pnpm enrich-linkedin

# Build for production
pnpm build

# Start the compiled build
pnpm start
```

---

## Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `tsx watch src/cli.ts` | Start CLI in watch mode |
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `start` | `node dist/cli.js` | Run the compiled build |
| `bulk-discover` | `tsx src/scripts/bulk-discover.ts` | Batch repository discovery |
| `enrich-linkedin` | `tsx src/scripts/enrich-linkedin-apify.ts` | LinkedIn enrichment via Apify |
| `db:push` | `drizzle-kit push` | Push schema to database |
| `lint` | `eslint src --ext .ts` | Lint TypeScript source |
| `format` | `prettier --write "src/**/*.ts"` | Format source files |

---

## Database

Schema migrations are managed by [Drizzle Kit](https://orm.drizzle.team/kit-docs/overview). The schema is defined in `src/db/schema.ts` and targets PostgreSQL.

```bash
# Introspect and push schema changes
pnpm db:push
```

Both standard `pg` (for self-hosted Postgres) and `@neondatabase/serverless` (for Neon) are supported — the active driver is determined by the `DATABASE_URL` environment variable.
