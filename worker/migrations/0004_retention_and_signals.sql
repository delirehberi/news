-- Migration number: 0004 	 2026-10-15T00:00:00.000Z
-- Re-sighting signals, per-article retention and stored embeddings for cross-run topic clustering.
ALTER TABLE articles ADD COLUMN seen_count INTEGER DEFAULT 1;
ALTER TABLE articles ADD COLUMN last_seen_at DATETIME;
ALTER TABLE articles ADD COLUMN expires_at DATETIME;
ALTER TABLE articles ADD COLUMN embedding TEXT;

UPDATE articles SET last_seen_at = created_at WHERE last_seen_at IS NULL;
UPDATE articles SET expires_at = datetime(created_at, '+4 days') WHERE expires_at IS NULL AND source = 'newsletter';
UPDATE articles SET expires_at = datetime(created_at, '+2 days') WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_articles_expires_at ON articles (expires_at);
CREATE INDEX IF NOT EXISTS idx_articles_last_seen_at ON articles (last_seen_at);

-- Gmail messages already decomposed, so re-fetches within the search window are skipped.
CREATE TABLE IF NOT EXISTS processed_emails (
    message_id TEXT PRIMARY KEY,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
