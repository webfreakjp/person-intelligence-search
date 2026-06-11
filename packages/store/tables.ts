import type {
  FieldCandidateRow,
  FieldDefinitionRow,
  FieldValueRow,
  ImportBatchRow,
  MentionRow,
  PersonAliasRow,
  PersonCandidateRow,
  PersonContextRow,
  PersonProfileRow,
  PersonRelationshipRow,
  PersonRow,
  PersonSummaryRow,
  ProcessingJobRow,
  SchemaRow,
  SearchDocumentRow,
  SnsAccountRow,
  SnsMetricRow,
  SourceDocumentRow,
  SourcePayloadRow,
  SourceVersionRow,
  TenantRow
} from '../shared/types.ts';

export type ColumnType =
  | 'uuid'
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'timestamptz'
  | 'date'
  | 'jsonb'
  | 'text_array'
  | 'uuid_array'
  | 'vector';

export interface TableMeta {
  pk: string;
  columns: Record<string, ColumnType>;
}

export interface TableRowMap {
  tenants: TenantRow;
  persons: PersonRow;
  person_aliases: PersonAliasRow;
  person_profiles: PersonProfileRow;
  person_sns_accounts: SnsAccountRow;
  person_sns_metrics: SnsMetricRow;
  source_documents: SourceDocumentRow;
  source_payloads: SourcePayloadRow;
  source_document_versions: SourceVersionRow;
  import_batches: ImportBatchRow;
  processing_jobs: ProcessingJobRow;
  extracted_person_mentions: MentionRow;
  person_candidates: PersonCandidateRow;
  person_contexts: PersonContextRow;
  person_summaries: PersonSummaryRow;
  person_relationships: PersonRelationshipRow;
  schemas: SchemaRow;
  field_definitions: FieldDefinitionRow;
  person_field_values: FieldValueRow;
  extracted_field_candidates: FieldCandidateRow;
  person_search_documents: SearchDocumentRow;
}

export type TableName = keyof TableRowMap;

export const TABLES: Record<TableName, TableMeta> = {
  tenants: {
    pk: 'id',
    columns: { id: 'uuid', name: 'text', metadata: 'jsonb', created_at: 'timestamptz' }
  },
  persons: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      canonical_name: 'text',
      display_name: 'text',
      person_type: 'text',
      status: 'text',
      metadata: 'jsonb',
      created_at: 'timestamptz',
      updated_at: 'timestamptz'
    }
  },
  person_aliases: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      person_id: 'uuid',
      alias: 'text',
      normalized_alias: 'text',
      alias_type: 'text',
      language: 'text',
      confidence: 'number',
      source_id: 'uuid',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  person_profiles: {
    pk: 'person_id',
    columns: {
      person_id: 'uuid',
      tenant_id: 'uuid',
      short_bio: 'text',
      profile_text: 'text',
      profile_embedding: 'vector',
      updated_at: 'timestamptz'
    }
  },
  person_sns_accounts: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      person_id: 'uuid',
      platform: 'text',
      handle: 'text',
      url: 'text',
      display_name: 'text',
      bio: 'text',
      verified: 'boolean',
      status: 'text',
      discovered_from_source_id: 'uuid',
      metadata: 'jsonb',
      created_at: 'timestamptz',
      updated_at: 'timestamptz'
    }
  },
  person_sns_metrics: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      account_id: 'uuid',
      measured_at: 'timestamptz',
      follower_count: 'integer',
      following_count: 'integer',
      post_count: 'integer',
      engagement_rate: 'number',
      metadata: 'jsonb'
    }
  },
  source_documents: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      source_type: 'text',
      source_subtype: 'text',
      title: 'text',
      body: 'text',
      url: 'text',
      source_name: 'text',
      published_at: 'timestamptz',
      received_at: 'timestamptz',
      language: 'text',
      content_hash: 'text',
      processing_status: 'text',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  source_payloads: {
    pk: 'source_id',
    columns: {
      source_id: 'uuid',
      tenant_id: 'uuid',
      raw_payload: 'jsonb',
      raw_html: 'text',
      extracted_text: 'text',
      file_id: 'uuid',
      metadata: 'jsonb'
    }
  },
  source_document_versions: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      source_id: 'uuid',
      version: 'integer',
      title: 'text',
      body: 'text',
      content_hash: 'text',
      received_at: 'timestamptz',
      metadata: 'jsonb'
    }
  },
  import_batches: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      source: 'text',
      import_type: 'text',
      status: 'text',
      total_count: 'integer',
      succeeded_count: 'integer',
      failed_count: 'integer',
      metadata: 'jsonb',
      created_at: 'timestamptz',
      completed_at: 'timestamptz'
    }
  },
  processing_jobs: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      source_id: 'uuid',
      job_type: 'text',
      status: 'text',
      priority: 'integer',
      attempts: 'integer',
      error_message: 'text',
      scheduled_at: 'timestamptz',
      started_at: 'timestamptz',
      finished_at: 'timestamptz',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  extracted_person_mentions: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      source_id: 'uuid',
      mention: 'text',
      normalized_mention: 'text',
      span_start: 'integer',
      span_end: 'integer',
      confidence: 'number',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  person_candidates: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      mention: 'text',
      normalized_mention: 'text',
      source_id: 'uuid',
      candidate_person_ids: 'uuid_array',
      confidence: 'number',
      status: 'text',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  person_contexts: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      person_id: 'uuid',
      source_id: 'uuid',
      role: 'text',
      context_text: 'text',
      context_tags: 'text_array',
      sentiment: 'text',
      importance: 'number',
      evidence_text: 'text',
      context_embedding: 'vector',
      occurred_at: 'timestamptz',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  person_summaries: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      person_id: 'uuid',
      summary_type: 'text',
      window: 'text',
      summary_text: 'text',
      summary_tags: 'text_array',
      summary_embedding: 'vector',
      source_count: 'integer',
      generated_at: 'timestamptz',
      metadata: 'jsonb'
    }
  },
  person_relationships: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      person_id: 'uuid',
      related_person_id: 'uuid',
      related_organization_id: 'uuid',
      relationship_type: 'text',
      source_id: 'uuid',
      confidence: 'number',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  schemas: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      key: 'text',
      name: 'text',
      target_entity: 'text',
      description: 'text',
      metadata: 'jsonb',
      created_at: 'timestamptz',
      updated_at: 'timestamptz'
    }
  },
  field_definitions: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      schema_id: 'uuid',
      key: 'text',
      label: 'text',
      type: 'text',
      description: 'text',
      searchable: 'boolean',
      filterable: 'boolean',
      sortable: 'boolean',
      embedding_target: 'boolean',
      required: 'boolean',
      options: 'jsonb',
      validation: 'jsonb',
      extraction_hints: 'jsonb',
      metadata: 'jsonb',
      created_at: 'timestamptz',
      updated_at: 'timestamptz'
    }
  },
  person_field_values: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      person_id: 'uuid',
      field_definition_id: 'uuid',
      value_text: 'text',
      value_number: 'number',
      value_boolean: 'boolean',
      value_date: 'date',
      value_json: 'jsonb',
      value_vector_text: 'text',
      source_id: 'uuid',
      confidence: 'number',
      metadata: 'jsonb',
      updated_at: 'timestamptz'
    }
  },
  extracted_field_candidates: {
    pk: 'id',
    columns: {
      id: 'uuid',
      tenant_id: 'uuid',
      person_id: 'uuid',
      field_definition_id: 'uuid',
      source_id: 'uuid',
      value_text: 'text',
      value_number: 'number',
      value_boolean: 'boolean',
      value_date: 'date',
      value_json: 'jsonb',
      confidence: 'number',
      status: 'text',
      conflict_with_value_id: 'uuid',
      metadata: 'jsonb',
      created_at: 'timestamptz'
    }
  },
  person_search_documents: {
    pk: 'person_id',
    columns: {
      person_id: 'uuid',
      tenant_id: 'uuid',
      searchable_text: 'text',
      searchable_tags: 'text_array',
      profile_text: 'text',
      recent_context_text: 'text',
      custom_field_text: 'text',
      embedding: 'vector',
      updated_at: 'timestamptz'
    }
  }
};

export function tableMeta(table: TableName): TableMeta {
  return TABLES[table];
}
