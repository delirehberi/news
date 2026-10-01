-- Migration number: 0003 	 2026-09-28T00:00:00.000Z
ALTER TABLE articles ADD COLUMN sources TEXT DEFAULT '[]';
ALTER TABLE articles ADD COLUMN source_count INTEGER DEFAULT 1;
ALTER TABLE articles ADD COLUMN importance_score REAL DEFAULT 1.0;
ALTER TABLE articles ADD COLUMN cluster_id TEXT;
