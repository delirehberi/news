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
- `GET /` — Server-side rendered news feed with filters (`?sort=hot|latest|digest`, `?source=hackernews|lobsters|reddit|stackernews|newsletter`).
- `GET /article/:id` — SSR single-article permalink page with social card preview meta tags.
- `GET /weekly` — Turkish SSR archive of approved and published weekly editions (`lang="tr"`).
- `GET /weekly/:week` — Turkish SSR weekly edition page (`YYYY-Www`) with curated Turkish summaries and responsive YouTube video embed.
- `GET /rss.xml` — Real-time RSS 2.0 feed of curated articles.
- `GET /api/articles` — JSON API for articles.
- `POST /api/articles/:id/like` — Like an article (anonymous or signed Nostr event).
- `POST /api/articles/:id/dislike` — Curator dislike and AI negative taste embedding.
- `POST /api/admin/weekly/snapshot` — Admin-guarded manual trigger to snapshot live top/liked stories into `weekly_candidates`.
- `GET /api/admin/weekly/:week/candidates` — Admin-guarded candidate list for a given ISO week (`YYYY-Www`).
- `GET /api/admin/weekly/:week` — Admin-guarded weekly edition state (`draft | approved | published`).
- `PUT /api/admin/weekly/:week` — Admin-guarded weekly edition upsert with forward-only status transitions (`draft → approved → published`).

## Weekly Turkish Video & Digest Pipeline (`video/`)

The `video/` package is a standalone Node.js (v22+ native TypeScript) CLI and Remotion project that turns each week's top curated stories into:
1. A public Turkish weekly digest at `/weekly/:week` (`lang="tr"`).
2. A 2–5 minute 1920×1080 30fps narrated Turkish YouTube video (`video.mp4`) with ElevenLabs voice synthesis, word-level synchronized captions, and a custom PNG thumbnail (`thumbnail.png`).

### One-Time Setup
1. Install dependencies and create `video/.env` from `video/.env.example`:
   ```bash
   make video-init
   ```
2. Fill in `video/.env` (gitignored).
3. Run the one-time loopback PKCE OAuth flow (`http://127.0.0.1:<port>`, scope `youtube.upload`) to obtain your YouTube refresh token and copy it into `video/.env`:
   ```bash
   make video-auth
   ```

### Environment Variables (`video/.env`)
| Variable | Required For | Default | Description |
| :--- | :--- | :--- | :--- |
| `NEWS_API_BASE_URL` | All commands | `https://news.emre.xyz` | Base URL of the deployed (or local) Cloudflare Worker. |
| `INGESTION_SECRET` | All commands | *(required)* | Shared admin Bearer secret matching the Worker's `INGESTION_SECRET`. |
| `AI_GATEWAY_BASE_URL` | `translate`, `script` | — | OpenAI-compatible `/chat/completions` base URL (e.g. `https://ai.workouse.com/v1`). |
| `AI_GATEWAY_API_KEY` | `translate`, `script` | — | API key / Cloudflare AI Gateway token for the LLM endpoint. |
| `AI_MODEL` | `translate`, `script` | — | Model identifier for Turkish translation and narration script generation. |
| `ELEVENLABS_API_KEY` | `voice` | — | ElevenLabs API key (`xi-api-key`). If omitted alongside `ELEVENLABS_VOICE_ID`, `voice` falls back to deterministic silent mock audio and alignments. |
| `ELEVENLABS_VOICE_ID` | `voice` | — | ElevenLabs Turkish-capable voice ID. |
| `ELEVENLABS_MODEL_ID` | `voice` | `eleven_multilingual_v2` | ElevenLabs TTS model ID. |
| `YOUTUBE_CLIENT_ID` | `auth`, `upload` | — | Google Cloud OAuth 2.0 Desktop client ID (YouTube Data API v3 enabled). |
| `YOUTUBE_CLIENT_SECRET` | `auth`, `upload` | — | Google Cloud OAuth 2.0 Desktop client secret. |
| `YOUTUBE_REFRESH_TOKEN` | `upload` | — | Refresh token printed by `make video-auth`. |
| `YOUTUBE_PRIVACY` | `upload` | `private` | YouTube upload privacy status (`private`, `unlisted`, or `public`). |
| `VIDEO_ITEM_COUNT` | `select` | `6` | Number of top stories selected per weekly edition (`1`–`15`). |

### Makefile Targets
All `video-*` targets default to the **previous ISO week in UTC** (`YYYY-Www`). Pass `WEEK=2026-W42` to target a specific week:

- `make video-init` — Install `video/` dependencies and initialize `video/.env` from `video/.env.example`.
- `make video-auth` — Run the one-time loopback YouTube OAuth2 PKCE flow and print `YOUTUBE_REFRESH_TOKEN`.
- `make video-draft [WEEK=YYYY-Www]` — Run the draft stage (`select` → `translate` → `script`), writing `video/out/<week>/selection.json`, `translation.json`, `script.json`, and editable `script.md`, and saving the edition on the Worker as `status: "draft"`.
- `make video-approve [WEEK=YYYY-Www]` — Parse and validate `video/out/<week>/script.md` (checking required sections and the 280–700 word narration budget), update `script.json`, and promote the Worker edition to `status: "approved"` (making `/weekly/<week>` live).
- `make video-produce [WEEK=YYYY-Www]` — Run the production stage (`voice` → `render` → `upload`):
  - `voice`: Synthesizes per-segment Turkish audio (`audio/<n>.mp3`) and word/caption timings (`audio/<n>.json`), caching segments by SHA-256 `narration_hash`.
  - `render`: Downloads story OG images (with branded card fallback) and renders `video.mp4` + `thumbnail.png` via Remotion.
  - `upload`: Streams `video.mp4` (resumable upload) and `thumbnail.png` to YouTube with Turkish chapters (`00:00` first) and source links, then marks the edition `status: "published"` with `youtube_video_id` (idempotent on re-runs).
- `make video-typecheck` — Run `tsc --noEmit` on the `video/` package.
- `make video-test` — Run Vitest unit and end-to-end tests in `video/`.

### Weekly Routine & Editorial Approval Gate
Production steps (`voice`, `render`, `upload`) enforce a strict **approval gate**: they check the Worker edition status first and refuse to run while the edition is still in `draft`.

1. **Generate the weekly draft** (defaults to last week):
   ```bash
   make video-draft
   ```
2. **Review and edit the Turkish narration script**:
   Open `video/out/<week>/script.md` in your editor and adjust the `## Intro`, story `### <headline_tr>` and narration text under `## Story N: <url>`, or `## Outro` sections as needed (keeping total narration within 280–700 words).
3. **Approve the script and publish the Turkish web edition**:
   ```bash
   make video-approve
   ```
   This validates `script.md` and transitions the Worker edition from `draft` to `approved`, publishing `https://news.emre.xyz/weekly/<week>`.
4. **Synthesize voice, render video, and upload to YouTube**:
   ```bash
   make video-produce
   ```
5. **Publish on YouTube** (if uploaded with `YOUTUBE_PRIVACY=private`):
   Review the uploaded video, chapters, and custom thumbnail in YouTube Studio and switch visibility to Public.

## License
MIT License. Feel free to fork, modify, and deploy your own personalized news AI.
