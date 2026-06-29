System/Context:
You are an expert full-stack developer specializing in the Cloudflare ecosystem (Workers, D1, Vectorize, Workers AI, Pages) and decentralized protocols (Nostr). We are building a personalized, serverless AI news aggregator and curation agent.

Project Overview:
The system is a daily news aggregator hosted on news.emre.xyz. A Cloudflare Worker runs on a cron schedule to fetch personalized feeds from my authenticated Reddit account, Lobsters, and Hacker News. It uses Cloudflare Workers AI to generate embeddings of these articles and compares them against my "Interest Profile" stored in Cloudflare Vectorize. Top-scoring articles are saved to a Cloudflare D1 database and displayed on a static frontend (Cloudflare Pages).

The frontend has a "Liked it" button. Authentication and feedback are entirely handled via the Nostr protocol (NIP-07 browser extensions). Clicking "Like" signs a Nostr event. The backend Worker verifies the Schnorr signature to ensure it matches my authorized public key. If verified, the Worker updates the AI's Vectorize memory with the new article's embedding and broadcasts the event to Nostr relays.

Tech Stack:

    Backend: Cloudflare Workers (TypeScript, Hono or native fetch API)

    Databases: Cloudflare D1 (SQL), Cloudflare Vectorize (Vector DB)

    AI: Cloudflare Workers AI (e.g., @cf/baai/bge-base-en-v1.5 for text embeddings)

    Frontend: HTML, Vanilla JS, TailwindCSS (deployed via Cloudflare Pages)

    Cryptography/Decentralization: nostr-tools (npm package) for signature verification and event handling.

Core Environment Secrets & Variables needed:

    REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_REFRESH_TOKEN

    AUTHORIZED_NOSTR_PUBKEY (My hex pubkey to verify admin actions)

    Bindings for DB (D1), VECTOR_INDEX (Vectorize), and AI (Workers AI)

Step-by-Step Implementation Plan:
Please do not write all the code at once. Let's work through this iteratively. For this prompt, please acknowledge the architecture and write the code for Step 1 and Step 2 only.

    Step 1: Database Setup & Schemas: Write the schema.sql file for the D1 database to store fetched articles (id, title, url, source, created_at, is_liked). Include instructions on how to initialize the Vectorize index.

    Step 2: The Ingestion Worker (Cron): Write the TypeScript Cloudflare Worker code that triggers on a cron job. Have it fetch data from Hacker News API (top stories) and Lobsters (RSS or API) as a starting point. Save the parsed results (title, url, source) to the D1 database, ensuring no duplicate URLs are inserted.

    Step 3 : Implement Reddit OAuth fetching.

    Step 4 : Integrate Workers AI to generate embeddings for new articles and filter them based on vector similarity.

    Step 5 : Build the frontend HTML/JS to fetch from D1 and display the articles.

    Step 6 : Implement the window.nostr signing on the frontend, and the nostr-tools signature verification endpoint on the Worker to update Vectorize and broadcast the event.
