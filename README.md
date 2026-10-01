# AI Curated News

A fully autonomous, self-hosted AI News Aggregator with Edge Server-Side Rendering (SSR), powered by Cloudflare Workers, Vectorize, D1, Hono JSX, and Nostr. 

This project constantly scrapes your favorite sources (Hacker News, Lobsters, Stacker News, Reddit, and Newsletters), generates AI embeddings for each article using Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`), and scores them to create a hyper-curated, personalized news feed rendered directly at the edge.

## Features
- **Edge Server-Side Rendering (SSR)**: Instant First Contentful Paint (FCP) and rich OpenGraph / Twitter Card preview meta tags powered by Hono JSX.
- **Built-in RSS 2.0 Feed**: Auto-generated standard RSS feed (`/rss.xml`) for feed readers and aggregators.
- **AI Vector Search**: Semantic search (Cosine Similarity) matches articles against your unique tastes based on your past upvotes.
- **Nostr Integration**: Authenticate likes to train the AI using NIP-07 (Nostr browser extensions), and allow followers to easily re-publish your curated feed to global Nostr relays.
- **Multi-Source Ingestion**: Automatically pulls from HackerNews, Lobsters, Stacker News, Reddit, and Gmail newsletters via scheduled cron jobs.
- **Unified Worker Architecture**: Single deployable Cloudflare Worker serving the SSR HTML frontend, static assets (Tailwind CSS v4 + client scripts), REST API endpoints, and background crons.

## Architecture
- **Unified Edge SSR & API**: Hono JSX on Cloudflare Workers ([`worker/src/index.tsx`](file:///home/delirehberi/www/news.emre.xyz/worker/src/index.tsx)).
- **Static Assets**: Compiled Tailwind CSS and client-side progressive enhancement scripts served via Cloudflare Workers Static Assets (`worker/public`).
- **Database**: Cloudflare D1 (SQL).
- **Vector Database**: Cloudflare Vectorize (Metadata + 768-dimension embeddings).
- **AI Model**: `@cf/baai/bge-base-en-v1.5` for text embeddings.

## Setup & Deployment

### Prerequisites
- Node.js (v22+)
- A Cloudflare account (`npx wrangler login`)
- Nostr Extension (like Alby or nos2x) for curator liking and follower publishing.

### 1. Initialize Project
When you first clone the repository, run the initialization script:
```bash
make init
```
*This will automatically install dependencies and copy configuration templates (`wrangler.jsonc`).*

### 2. Provision Infrastructure
Create your D1 database and Vectorize index on Cloudflare:

```bash
make db-init
make vectorize-init
```
Update your `worker/wrangler.jsonc` (created during `make init`) with your new `database_id` and Vectorize `index_name`. 
You can also toggle specific sources (e.g., `"ENABLE_REDDIT": "false"`) in the `vars` block.

### 3. Configure Secrets
The application requires Reddit OAuth credentials and a Nostr Pubkey for identity.
Export them to your environment (or use a `.envrc` file), and automatically push them to Cloudflare:

```bash
export REDDIT_CLIENT_ID="your_client_id"
export REDDIT_CLIENT_SECRET="your_client_secret"
export REDDIT_REFRESH_TOKEN="your_refresh_token"
export GMAIL_CLIENT_ID="your_client_id"
export GMAIL_CLIENT_SECRET="your_client_secret"
export GMAIL_REFRESH_TOKEN="your_refresh_token"
export AUTHORIZED_NOSTR_PUBKEY="your_nostr_pubkey_in_hex"

make push-secrets
```

### 4. Apply Database Migrations
Apply the standard D1 database migrations to your remote D1 instance:
```bash
make db-migrate
```

### 5. Deploy Unified SSR Worker
Build frontend assets and deploy the unified SSR worker to Cloudflare:
```bash
make deploy
```
*This compiles Tailwind CSS and client-side assets into `worker/public/`, then deploys the unified Worker to Cloudflare.*

## Routes & Endpoints
- `GET /` — Server-side rendered news feed with filters (`?sort=hot|latest`, `?source=hackernews|lobsters|reddit|stackernews`).
- `GET /article/:id` — SSR single-article permalink page with social card preview meta tags.
- `GET /rss.xml` — Real-time RSS 2.0 feed of curated articles.
- `GET /api/articles` — JSON API for articles.
- `POST /api/articles/:id/like` — Like an article (anonymous or signed Nostr event).
- `POST /api/articles/:id/dislike` — Curator dislike and AI negative taste embedding.

## License
MIT License. Feel free to fork, modify, and deploy your own personalized news AI.
