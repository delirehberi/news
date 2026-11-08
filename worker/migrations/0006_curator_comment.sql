-- Migration number: 0006 	 2026-11-06T00:00:00.000Z
-- Curator comments / thoughts on highlighted articles and weekly candidate snapshots.
ALTER TABLE articles ADD COLUMN curator_comment TEXT;
ALTER TABLE weekly_candidates ADD COLUMN curator_comment TEXT;
