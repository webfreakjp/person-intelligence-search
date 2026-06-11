-- Person Intelligence Search Platform: core schema
-- Placeholders ${EMBEDDING_DIMENSION} / ${DEFAULT_TENANT_ID} are substituted by the migration runner.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS platform_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_meta (key, value)
VALUES ('embedding_dimension', to_jsonb(${EMBEDDING_DIMENSION}::int))
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, name)
VALUES ('${DEFAULT_TENANT_ID}', 'Default Tenant')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS persons (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  canonical_name text NOT NULL,
  display_name text,
  person_type text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS persons_tenant_type_idx ON persons (tenant_id, person_type);
CREATE INDEX IF NOT EXISTS persons_tenant_status_idx ON persons (tenant_id, status);
CREATE INDEX IF NOT EXISTS persons_tenant_name_idx ON persons (tenant_id, canonical_name);

CREATE TABLE IF NOT EXISTS person_aliases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  alias text NOT NULL,
  normalized_alias text,
  alias_type text,
  language text,
  confidence numeric,
  source_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS person_aliases_normalized_idx ON person_aliases (tenant_id, normalized_alias);
CREATE INDEX IF NOT EXISTS person_aliases_person_idx ON person_aliases (person_id);

CREATE TABLE IF NOT EXISTS person_profiles (
  person_id uuid PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  short_bio text,
  profile_text text,
  profile_embedding vector(${EMBEDDING_DIMENSION}),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS person_sns_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  platform text NOT NULL,
  handle text,
  url text,
  display_name text,
  bio text,
  verified boolean,
  status text NOT NULL DEFAULT 'active',
  discovered_from_source_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS person_sns_accounts_platform_idx ON person_sns_accounts (tenant_id, platform, handle);
CREATE INDEX IF NOT EXISTS person_sns_accounts_person_idx ON person_sns_accounts (person_id);

CREATE TABLE IF NOT EXISTS person_sns_metrics (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL REFERENCES person_sns_accounts(id) ON DELETE CASCADE,
  measured_at timestamptz NOT NULL,
  follower_count bigint,
  following_count bigint,
  post_count bigint,
  engagement_rate numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS person_sns_metrics_latest_idx ON person_sns_metrics (tenant_id, account_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS person_sns_metrics_follower_idx ON person_sns_metrics (tenant_id, follower_count);

CREATE TABLE IF NOT EXISTS source_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_type text NOT NULL,
  source_subtype text,
  title text,
  body text,
  url text,
  source_name text,
  published_at timestamptz,
  received_at timestamptz NOT NULL,
  language text,
  content_hash text,
  processing_status text NOT NULL DEFAULT 'queued',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS source_documents_tenant_type_idx ON source_documents (tenant_id, source_type);
CREATE INDEX IF NOT EXISTS source_documents_url_idx ON source_documents (tenant_id, url);
CREATE INDEX IF NOT EXISTS source_documents_hash_idx ON source_documents (tenant_id, content_hash);
CREATE INDEX IF NOT EXISTS source_documents_status_idx ON source_documents (tenant_id, processing_status);

CREATE TABLE IF NOT EXISTS source_payloads (
  source_id uuid PRIMARY KEY REFERENCES source_documents(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  raw_payload jsonb,
  raw_html text,
  extracted_text text,
  file_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS source_document_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  title text,
  body text,
  content_hash text,
  received_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS source_document_versions_source_idx ON source_document_versions (source_id, version DESC);

CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source text,
  import_type text,
  status text NOT NULL,
  total_count integer,
  succeeded_count integer,
  failed_count integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid REFERENCES source_documents(id) ON DELETE SET NULL,
  job_type text NOT NULL,
  status text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  error_message text,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS processing_jobs_queue_idx ON processing_jobs (status, priority DESC, scheduled_at);
CREATE INDEX IF NOT EXISTS processing_jobs_tenant_idx ON processing_jobs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS processing_jobs_source_idx ON processing_jobs (source_id);

CREATE TABLE IF NOT EXISTS extracted_person_mentions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  mention text NOT NULL,
  normalized_mention text,
  span_start integer,
  span_end integer,
  confidence numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS extracted_person_mentions_source_idx ON extracted_person_mentions (source_id);

CREATE TABLE IF NOT EXISTS person_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  mention text NOT NULL,
  normalized_mention text,
  source_id uuid REFERENCES source_documents(id) ON DELETE SET NULL,
  candidate_person_ids uuid[],
  confidence numeric,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS person_candidates_status_idx ON person_candidates (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS person_contexts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  role text,
  context_text text,
  context_tags text[],
  sentiment text,
  importance numeric,
  evidence_text text,
  context_embedding vector(${EMBEDDING_DIMENSION}),
  occurred_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS person_contexts_person_time_idx ON person_contexts (tenant_id, person_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS person_contexts_source_idx ON person_contexts (source_id);

CREATE TABLE IF NOT EXISTS person_summaries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  summary_type text NOT NULL,
  "window" text,
  summary_text text NOT NULL,
  summary_tags text[],
  summary_embedding vector(${EMBEDDING_DIMENSION}),
  source_count integer,
  generated_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS person_summaries_person_idx ON person_summaries (tenant_id, person_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS person_relationships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  related_person_id uuid REFERENCES persons(id) ON DELETE CASCADE,
  related_organization_id uuid,
  relationship_type text NOT NULL,
  source_id uuid,
  confidence numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS person_relationships_person_idx ON person_relationships (tenant_id, person_id);

CREATE TABLE IF NOT EXISTS schemas (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  name text NOT NULL,
  target_entity text NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS field_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  schema_id uuid NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  key text NOT NULL,
  label text NOT NULL,
  type text NOT NULL,
  description text,
  searchable boolean NOT NULL DEFAULT false,
  filterable boolean NOT NULL DEFAULT false,
  sortable boolean NOT NULL DEFAULT false,
  embedding_target boolean NOT NULL DEFAULT false,
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  extraction_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, schema_id, key)
);

CREATE INDEX IF NOT EXISTS field_definitions_tenant_key_idx ON field_definitions (tenant_id, key);

CREATE TABLE IF NOT EXISTS person_field_values (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  field_definition_id uuid NOT NULL REFERENCES field_definitions(id) ON DELETE CASCADE,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  value_vector_text text,
  source_id uuid REFERENCES source_documents(id) ON DELETE SET NULL,
  confidence numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS person_field_values_person_idx ON person_field_values (tenant_id, person_id);
CREATE INDEX IF NOT EXISTS person_field_values_number_idx ON person_field_values (tenant_id, field_definition_id, value_number);
CREATE INDEX IF NOT EXISTS person_field_values_date_idx ON person_field_values (tenant_id, field_definition_id, value_date);
CREATE INDEX IF NOT EXISTS person_field_values_text_idx ON person_field_values (tenant_id, field_definition_id, value_text);

CREATE TABLE IF NOT EXISTS extracted_field_candidates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  person_id uuid REFERENCES persons(id) ON DELETE CASCADE,
  field_definition_id uuid NOT NULL REFERENCES field_definitions(id) ON DELETE CASCADE,
  source_id uuid REFERENCES source_documents(id) ON DELETE SET NULL,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  confidence numeric,
  status text NOT NULL,
  conflict_with_value_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS extracted_field_candidates_status_idx ON extracted_field_candidates (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS person_search_documents (
  person_id uuid PRIMARY KEY REFERENCES persons(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  searchable_text text,
  searchable_tags text[],
  profile_text text,
  recent_context_text text,
  custom_field_text text,
  embedding vector(${EMBEDDING_DIMENSION}),
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS person_search_documents_tenant_idx ON person_search_documents (tenant_id);

-- pgvector ANN indexes
CREATE INDEX IF NOT EXISTS person_profiles_embedding_hnsw
  ON person_profiles USING hnsw (profile_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS person_contexts_embedding_hnsw
  ON person_contexts USING hnsw (context_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS person_summaries_embedding_hnsw
  ON person_summaries USING hnsw (summary_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS person_search_documents_embedding_hnsw
  ON person_search_documents USING hnsw (embedding vector_cosine_ops);
