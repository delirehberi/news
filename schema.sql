DROP TABLE IF EXISTS articles;
DROP TABLE IF EXISTS user_preferences;

CREATE TABLE articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL,
    sources TEXT DEFAULT '[]',
    source_count INTEGER DEFAULT 1,
    importance_score REAL DEFAULT 1.0,
    cluster_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_liked BOOLEAN DEFAULT 0,
    image_url TEXT,
    summary TEXT,
    follower_likes INTEGER DEFAULT 0
);

CREATE TABLE user_preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
