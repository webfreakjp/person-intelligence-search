-- Optional PGroonga migration: applied only when the pgroonga extension is available
-- and PGROONGA_ENABLED is true. Full-text search stays disabled without it.

CREATE EXTENSION IF NOT EXISTS pgroonga;

CREATE INDEX IF NOT EXISTS person_profiles_pgroonga_idx
  ON person_profiles USING pgroonga (profile_text);

CREATE INDEX IF NOT EXISTS source_documents_body_pgroonga_idx
  ON source_documents USING pgroonga (body);

CREATE INDEX IF NOT EXISTS person_contexts_text_pgroonga_idx
  ON person_contexts USING pgroonga (context_text);

CREATE INDEX IF NOT EXISTS person_summaries_text_pgroonga_idx
  ON person_summaries USING pgroonga (summary_text);

CREATE INDEX IF NOT EXISTS person_field_values_text_pgroonga_idx
  ON person_field_values USING pgroonga (value_text);

CREATE INDEX IF NOT EXISTS person_search_documents_text_pgroonga_idx
  ON person_search_documents USING pgroonga (searchable_text);
