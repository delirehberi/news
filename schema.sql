DROP TABLE IF EXISTS articles;

CREATE TABLE articles (
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
