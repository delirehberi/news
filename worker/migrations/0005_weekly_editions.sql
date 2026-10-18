-- Migration number: 0005 	 2026-10-18T00:00:00.000Z
-- Weekly video candidate snapshots and Turkish weekly editions.
CREATE TABLE IF NOT EXISTS weekly_candidates (
    week TEXT NOT NULL,
    url TEXT NOT NULL,
    article_id TEXT,
    title TEXT NOT NULL,
    source TEXT,
    summary TEXT,
    image_url TEXT,
    is_liked INTEGER DEFAULT 0,
    follower_likes INTEGER DEFAULT 0,
    importance_score REAL DEFAULT 1.0,
    source_count INTEGER DEFAULT 1,
    seen_count INTEGER DEFAULT 1,
    cluster_id TEXT,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (week, url)
);

CREATE TABLE IF NOT EXISTS weekly_editions (
    week TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('draft','approved','published')),
    title_tr TEXT,
    intro_tr TEXT,
    items_json TEXT DEFAULT '[]',
    script_json TEXT,
    youtube_video_id TEXT,
    published_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_weekly_editions_status ON weekly_editions (status);

