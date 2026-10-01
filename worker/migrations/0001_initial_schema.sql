-- Migration number: 0001 	 2026-06-29T00:00:00.000Z
CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_liked BOOLEAN DEFAULT 0,
    image_url TEXT,
    summary TEXT,
    follower_likes INTEGER DEFAULT 0
);
