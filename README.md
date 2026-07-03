# AI Curated News

A fully autonomous, self-hosted AI News Aggregator powered by Cloudflare Workers, Vectorize, D1, and Nostr. 

This project constantly scrapes your favorite sources (Hacker News, Lobsters, and Reddit), generates AI embeddings for each article using Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`), and compares them against your personal upvote history to create a hyper-curated, personalized news feed.

## Features
- **AI Vector Search**: Uses semantic search (Cosine Similarity) to find articles that match your unique tastes based on your past upvotes.
- **Nostr Integration**: Authenticate your own likes to train the AI using NIP-07 (Nostr browser extensions), and allow your followers to easily re-publish your curated feed to global Nostr relays.
- **Multi-Source Ingestion**: Automatically pulls from HackerNews, Lobsters, and Reddit via a scheduled cron job.
- **Privacy-First**: Fully self-hosted on Cloudflare. You own the database, the vector index, and the AI execution.
- **Modern UI**: A beautifully designed, glassmorphic frontend built with Vite, Tailwind CSS v4, and Vanilla JS. Interleaved feeds, image previews, and follower counts built-in.

## Architecture
- **Frontend**: Vite + Tailwind CSS (`frontend/` directory).
- **Backend API**: Hono on Cloudflare Workers (`worker/` directory).
- **Database**: Cloudflare D1 (SQL).
- **Vector Database**: Cloudflare Vectorize (Metadata + 768-dimension embeddings).
- **AI Model**: `@cf/baai/bge-base-en-v1.5` for text embeddings.

## Setup & Deployment

### Prerequisites
- Node.js (v22+)
- A Cloudflare account (`npx wrangler login`)
- Nostr Extension (like Alby or nos2x) if you want to use the NIP-07 features.

### 1. Initialize Project
When you first clone the repository, run the initialization script:
```bash
make init
```
*This will automatically install dependencies, copy configuration templates (`.env` and `wrangler.jsonc`), and print a step-by-step deployment checklist to your terminal.*

### 2. Provision Infrastructure
Create your D1 database and Vectorize index on Cloudflare:

```bash
make db-init
make vectorize-init
```
Update your `worker/wrangler.jsonc` (which was created during `make init`) with your new `database_id` and Vectorize `index_name`. 
You can also enable or disable specific sources (e.g., `"ENABLE_REDDIT": "false"`) in the `vars` block.

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
*The `make push-secrets` command securely pipes your local environment variables directly into Cloudflare's vault without requiring manual interaction.*

### 4. Configure Frontend
Update `frontend/.env` (which was created during `make init`) with your desired API URL, custom subtitle, and theme preferences.

### 5. Initialize the Database
Apply the SQL schema to your remote D1 instance so your tables are created:
```bash
make db-apply-remote
```

### 6. Deploy the Full Stack
Deploy both the Hono backend API and the Vite frontend to Cloudflare in one go:
```bash
make deploy
```
*This command runs `make deploy-worker` and `make deploy-frontend` sequentially. It automatically builds your Vite app and deploys it to Cloudflare Pages, while deploying your backend to Cloudflare Workers.*

## Bootstrapping Your AI Model
For the AI to know what you like, it needs history. You can use the provided endpoints to ingest your existing upvotes from Lobsters, Reddit, or raw JSON exports from HackerNews. Once bootstrap profiles are ingested, the daily cron job will handle the rest!

## License
MIT License. Feel free to fork, modify, and deploy your own personalized news AI.
