export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, Json>;

export interface TenantRow {
  id: string;
  name: string;
  metadata: JsonObject;
  created_at: string;
}

export interface PersonRow {
  id: string;
  tenant_id: string;
  canonical_name: string;
  display_name: string | null;
  person_type: string | null;
  status: string;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface PersonAliasRow {
  id: string;
  tenant_id: string;
  person_id: string;
  alias: string;
  normalized_alias: string | null;
  alias_type: string | null;
  language: string | null;
  confidence: number | null;
  source_id: string | null;
  metadata: JsonObject;
  created_at: string;
}

export interface PersonProfileRow {
  person_id: string;
  tenant_id: string;
  short_bio: string | null;
  profile_text: string | null;
  profile_embedding?: number[] | null;
  updated_at: string;
}

export interface SnsAccountRow {
  id: string;
  tenant_id: string;
  person_id: string;
  platform: string;
  handle: string | null;
  url: string | null;
  display_name: string | null;
  bio: string | null;
  verified: boolean | null;
  status: string;
  discovered_from_source_id: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface SnsMetricRow {
  id: string;
  tenant_id: string;
  account_id: string;
  measured_at: string;
  follower_count: number | null;
  following_count: number | null;
  post_count: number | null;
  engagement_rate: number | null;
  metadata: JsonObject;
}

export interface SourceDocumentRow {
  id: string;
  tenant_id: string;
  source_type: string;
  source_subtype: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  source_name: string | null;
  published_at: string | null;
  received_at: string;
  language: string | null;
  content_hash: string | null;
  processing_status: string;
  metadata: JsonObject;
  created_at: string;
}

export interface SourcePayloadRow {
  source_id: string;
  tenant_id: string;
  raw_payload: JsonObject | null;
  raw_html: string | null;
  extracted_text: string | null;
  file_id: string | null;
  metadata: JsonObject;
}

export interface SourceVersionRow {
  id: string;
  tenant_id: string;
  source_id: string;
  version: number;
  title: string | null;
  body: string | null;
  content_hash: string | null;
  received_at: string;
  metadata: JsonObject;
}

export interface ImportBatchRow {
  id: string;
  tenant_id: string;
  source: string | null;
  import_type: string | null;
  status: string;
  total_count: number | null;
  succeeded_count: number | null;
  failed_count: number | null;
  metadata: JsonObject;
  created_at: string;
  completed_at: string | null;
}

export interface ProcessingJobRow {
  id: string;
  tenant_id: string;
  source_id: string | null;
  job_type: string;
  status: string;
  priority: number;
  attempts: number;
  error_message: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  metadata: JsonObject;
  created_at: string;
}

export interface MentionRow {
  id: string;
  tenant_id: string;
  source_id: string;
  mention: string;
  normalized_mention: string | null;
  span_start: number | null;
  span_end: number | null;
  confidence: number | null;
  metadata: JsonObject;
  created_at: string;
}

export interface PersonCandidateRow {
  id: string;
  tenant_id: string;
  mention: string;
  normalized_mention: string | null;
  source_id: string | null;
  candidate_person_ids: string[] | null;
  confidence: number | null;
  status: string;
  metadata: JsonObject;
  created_at: string;
}

export interface PersonContextRow {
  id: string;
  tenant_id: string;
  person_id: string;
  source_id: string;
  role: string | null;
  context_text: string | null;
  context_tags: string[] | null;
  sentiment: string | null;
  importance: number | null;
  evidence_text: string | null;
  context_embedding?: number[] | null;
  occurred_at: string | null;
  metadata: JsonObject;
  created_at: string;
}

export interface PersonSummaryRow {
  id: string;
  tenant_id: string;
  person_id: string;
  summary_type: string;
  window: string | null;
  summary_text: string;
  summary_tags: string[] | null;
  summary_embedding?: number[] | null;
  source_count: number | null;
  generated_at: string;
  metadata: JsonObject;
}

export interface PersonRelationshipRow {
  id: string;
  tenant_id: string;
  person_id: string;
  related_person_id: string | null;
  related_organization_id: string | null;
  relationship_type: string;
  source_id: string | null;
  confidence: number | null;
  metadata: JsonObject;
  created_at: string;
}

export interface SchemaRow {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  target_entity: string;
  description: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface FieldDefinitionRow {
  id: string;
  tenant_id: string;
  schema_id: string;
  key: string;
  label: string;
  type: string;
  description: string | null;
  searchable: boolean;
  filterable: boolean;
  sortable: boolean;
  embedding_target: boolean;
  required: boolean;
  options: JsonObject;
  validation: JsonObject;
  extraction_hints: JsonObject;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface FieldValueRow {
  id: string;
  tenant_id: string;
  person_id: string;
  field_definition_id: string;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_json: Json | null;
  value_vector_text: string | null;
  source_id: string | null;
  confidence: number | null;
  metadata: JsonObject;
  updated_at: string;
}

export interface FieldCandidateRow {
  id: string;
  tenant_id: string;
  person_id: string | null;
  field_definition_id: string;
  source_id: string | null;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_json: Json | null;
  confidence: number | null;
  status: string;
  conflict_with_value_id: string | null;
  metadata: JsonObject;
  created_at: string;
}

export interface SearchDocumentRow {
  person_id: string;
  tenant_id: string;
  searchable_text: string | null;
  searchable_tags: string[] | null;
  profile_text: string | null;
  recent_context_text: string | null;
  custom_field_text: string | null;
  embedding?: number[] | null;
  updated_at: string;
}

export interface Capabilities {
  database: 'postgresql' | 'pglite';
  vector: boolean;
  full_text: { enabled: boolean; provider: 'pgroonga' | null };
  llm: { enabled: boolean; provider: string; model: string | null };
  embeddings: { enabled: boolean; provider: string; model: string; dimension: number };
}

export interface PresentedFieldValue {
  field_key: string;
  field_label: string;
  type: string;
  schema_id: string;
  value: Json | null;
  source_id: string | null;
  confidence: number | null;
  updated_at: string;
}

export interface HydratedPerson extends PersonRow {
  aliases: PersonAliasRow[];
  profile: PersonProfileRow | null;
  sns_accounts: Array<SnsAccountRow & { latest_metric: SnsMetricRow | null }>;
  recent_contexts: PersonContextRow[];
  summaries: PersonSummaryRow[];
  fields: PresentedFieldValue[];
}

export interface MatchedContext {
  context_id: string;
  source_id: string;
  title: string;
  role: string | null;
  sentiment: string | null;
  evidence_text: string;
  occurred_at: string | null;
}

export interface SearchResultItem {
  person_id: string;
  display_name: string;
  score: number;
  score_parts: { structured?: number; vector?: number; full_text?: number };
  matched_reasons: string[];
  matched_contexts: MatchedContext[];
  person: HydratedPerson;
}
