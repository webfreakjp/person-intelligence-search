# PostgreSQL with PGroonga (Japanese full-text search) + pgvector.
# groonga/pgroonga images are based on the official postgres image, so the
# PGDG apt repository is already configured and provides pgvector.
FROM groonga/pgroonga:4.0.4-debian-16

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16-pgvector \
  && rm -rf /var/lib/apt/lists/*
