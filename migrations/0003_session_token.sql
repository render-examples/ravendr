-- Public-facing session token for /s/{token} URLs.
-- Short URL-safe string; the internal UUID stays as the primary key.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token text;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_idx
  ON sessions (token)
  WHERE token IS NOT NULL;
