
CREATE TABLE IF NOT EXISTS datarefine_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  revision integer NOT NULL DEFAULT 0,
  body jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS datarefine_files (
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('original', 'csv', 'report', 'details', 'training', 'train', 'validation', 'test')),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (id, kind)
);

CREATE TABLE IF NOT EXISTS datarefine_file_chunks (
  id uuid NOT NULL,
  kind text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 1048576),
  PRIMARY KEY (id, kind, position),
  FOREIGN KEY (id, kind) REFERENCES datarefine_files (id, kind) ON DELETE CASCADE
);
