import { detectCapabilities } from '../db/capabilities.ts';
import { createDriver, type DbDriver } from '../db/driver.ts';
import { runMigrations } from '../db/migrate.ts';
import { FIELD_TYPES, presentFieldValue } from '../schemas/fieldTypes.ts';
import type { DslFilter, DslTimeRange } from '../search/dsl.ts';
import { config } from '../shared/config.ts';
import type {
  Capabilities,
  FieldDefinitionRow,
  HydratedPerson,
  MatchedContext,
  PersonRow,
  ProcessingJobRow,
  SnsMetricRow
} from '../shared/types.ts';
import { clamp, pgArrayLiteral, relativeWindowStart } from '../shared/utils.ts';
import { type ColumnType, type TableName, type TableRowMap, tableMeta } from './tables.ts';

const q = (identifier: string) => `"${identifier}"`;
const escapeLike = (value: string) => value.replace(/[%_\\]/g, (char) => `\\${char}`);
const lowerLiteral = (values: unknown[]) => pgArrayLiteral(values.map((value) => String(value).toLowerCase()));

function serializeValue(type: ColumnType, value: unknown): unknown {
  if (value == null) return null;
  switch (type) {
    case 'jsonb':
      return JSON.stringify(value);
    case 'vector':
      return Array.isArray(value) ? `[${value.join(',')}]` : value;
    case 'text_array':
    case 'uuid_array':
      return Array.isArray(value) ? pgArrayLiteral(value) : value;
    default:
      return value;
  }
}

function deserializeValue(type: ColumnType | undefined, value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString();
  switch (type) {
    case 'number':
    case 'integer':
      return typeof value === 'string' ? Number(value) : value;
    case 'date':
      return String(value).slice(0, 10);
    case 'vector':
      return typeof value === 'string' ? JSON.parse(value) : value;
    case 'jsonb':
      return typeof value === 'string' ? JSON.parse(value) : value;
    default:
      return value;
  }
}

function deserializeRow<T extends TableName>(table: T, row: Record<string, unknown> | undefined): TableRowMap[T] | null {
  if (!row) return null;
  const { columns } = tableMeta(table);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) out[name] = deserializeValue(columns[name], value);
  return out as unknown as TableRowMap[T];
}

export interface FindOptions {
  orderBy?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  person_id: string;
  similarity?: number;
  score?: number;
}

/**
 * The single storage implementation. Runs on PostgreSQL (production) and on
 * PGlite (embedded dev database) through the same SQL path, so development
 * behavior matches production.
 */
export class SqlStore {
  readonly driver: DbDriver;
  private caps: Capabilities | null = null;

  constructor(driver: DbDriver) {
    this.driver = driver;
  }

  get kind(): 'postgres' | 'pglite' {
    return this.driver.kind;
  }

  async init({ migrate = true }: { migrate?: boolean } = {}): Promise<this> {
    if (migrate) await runMigrations(this.driver);
    this.caps = await detectCapabilities(this.driver, this.driver.kind);
    return this;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async ping(): Promise<boolean> {
    await this.driver.query('SELECT 1');
    return true;
  }

  async capabilities(): Promise<Capabilities> {
    if (!this.caps) this.caps = await detectCapabilities(this.driver, this.driver.kind);
    return this.caps;
  }

  get fullTextEnabled(): boolean {
    return Boolean(this.caps?.full_text.enabled);
  }

  // --- generic CRUD ---

  private pickColumns(table: TableName, row: Record<string, unknown>) {
    const { columns } = tableMeta(table);
    const names = Object.keys(row).filter((name) => name in columns);
    return { names, values: names.map((name) => serializeValue(columns[name] as ColumnType, row[name])) };
  }

  async insert<T extends TableName>(table: T, row: Partial<TableRowMap[T]>): Promise<TableRowMap[T]> {
    const { names, values } = this.pickColumns(table, row);
    const placeholders = names.map((_, index) => `$${index + 1}`);
    const { rows } = await this.driver.query(
      `INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    return deserializeRow(table, rows[0]) as TableRowMap[T];
  }

  async upsert<T extends TableName>(table: T, row: Partial<TableRowMap[T]>): Promise<TableRowMap[T]> {
    const { pk } = tableMeta(table);
    const { names, values } = this.pickColumns(table, row);
    const placeholders = names.map((_, index) => `$${index + 1}`);
    const updates = names.filter((name) => name !== pk).map((name) => `${q(name)} = EXCLUDED.${q(name)}`);
    const { rows } = await this.driver.query(
      `INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (${q(pk)}) DO UPDATE SET ${updates.join(', ')} RETURNING *`,
      values
    );
    return deserializeRow(table, rows[0]) as TableRowMap[T];
  }

  async get<T extends TableName>(table: T, pkValue: string): Promise<TableRowMap[T] | null> {
    const { pk } = tableMeta(table);
    const { rows } = await this.driver.query(`SELECT * FROM ${q(table)} WHERE ${q(pk)} = $1`, [pkValue]);
    return deserializeRow(table, rows[0]);
  }

  private whereClause(table: TableName, where: Record<string, unknown>, params: unknown[]): string {
    const { columns } = tableMeta(table);
    const fragments: string[] = [];
    for (const [name, value] of Object.entries(where)) {
      const type = columns[name];
      if (!type) throw new Error(`Unknown column ${table}.${name}`);
      if (value === null) {
        fragments.push(`${q(name)} IS NULL`);
      } else {
        params.push(serializeValue(type, value));
        fragments.push(`${q(name)} = $${params.length}`);
      }
    }
    return fragments.length ? `WHERE ${fragments.join(' AND ')}` : '';
  }

  async find<T extends TableName>(table: T, where: Partial<TableRowMap[T]> = {}, options: FindOptions = {}): Promise<TableRowMap[T][]> {
    const params: unknown[] = [];
    const clause = this.whereClause(table, where, params);
    const order = options.orderBy ? `ORDER BY ${q(options.orderBy)} ${options.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : '';
    const limit = options.limit != null ? `LIMIT ${Math.max(0, Math.trunc(options.limit))}` : '';
    const offset = options.offset ? `OFFSET ${Math.max(0, Math.trunc(options.offset))}` : '';
    const { rows } = await this.driver.query(`SELECT * FROM ${q(table)} ${clause} ${order} ${limit} ${offset}`, params);
    return rows.map((row: Record<string, unknown>) => deserializeRow(table, row) as TableRowMap[T]);
  }

  async findOne<T extends TableName>(table: T, where: Partial<TableRowMap[T]>): Promise<TableRowMap[T] | null> {
    return (await this.find(table, where, { limit: 1 }))[0] ?? null;
  }

  async count<T extends TableName>(table: T, where: Partial<TableRowMap[T]> = {}): Promise<number> {
    const params: unknown[] = [];
    const clause = this.whereClause(table, where, params);
    const { rows } = await this.driver.query<{ count: number | string }>(
      `SELECT count(*)::int AS count FROM ${q(table)} ${clause}`,
      params
    );
    return Number(rows[0]?.count ?? 0);
  }

  async update<T extends TableName>(table: T, pkValue: string, patch: Partial<TableRowMap[T]>): Promise<TableRowMap[T] | null> {
    const { pk } = tableMeta(table);
    const { names, values } = this.pickColumns(table, patch);
    if (!names.length) return this.get(table, pkValue);
    const sets = names.map((name, index) => `${q(name)} = $${index + 1}`);
    values.push(pkValue);
    const { rows } = await this.driver.query(
      `UPDATE ${q(table)} SET ${sets.join(', ')} WHERE ${q(pk)} = $${values.length} RETURNING *`,
      values
    );
    return deserializeRow(table, rows[0]);
  }

  async remove(table: TableName, pkValue: string): Promise<boolean> {
    const { pk } = tableMeta(table);
    const { rowCount } = await this.driver.query(`DELETE FROM ${q(table)} WHERE ${q(pk)} = $1`, [pkValue]);
    return (rowCount ?? 0) > 0;
  }

  async removeWhere<T extends TableName>(table: T, where: Partial<TableRowMap[T]>): Promise<number> {
    const params: unknown[] = [];
    const clause = this.whereClause(table, where, params);
    if (!clause) throw new Error('removeWhere requires conditions');
    const { rowCount } = await this.driver.query(`DELETE FROM ${q(table)} ${clause}`, params);
    return rowCount ?? 0;
  }

  // --- job queue (PostgreSQL-backed) ---

  async claimNextJob(): Promise<ProcessingJobRow | null> {
    const { rows } = await this.driver.query(`
      UPDATE processing_jobs SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM processing_jobs
        WHERE status IN ('queued', 'retrying') AND (scheduled_at IS NULL OR scheduled_at <= now())
        ORDER BY priority DESC, scheduled_at NULLS FIRST, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`);
    return deserializeRow('processing_jobs', rows[0]);
  }

  async jobStats(tenantId: string): Promise<Record<string, number>> {
    const { rows } = await this.driver.query<{ status: string; count: number | string }>(
      'SELECT status, count(*)::int AS count FROM processing_jobs WHERE tenant_id = $1 GROUP BY status',
      [tenantId]
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  // --- search execution ---

  private timeWindow(timeRange: DslTimeRange | null): { from: string | null; to: string | null } | null {
    if (!timeRange) return null;
    if (timeRange.relative) return { from: relativeWindowStart(timeRange.relative), to: null };
    return { from: timeRange.from ?? null, to: timeRange.to ?? null };
  }

  private scalarCondition(
    column: string,
    op: string,
    value: unknown,
    params: unknown[],
    kind: 'text' | 'number' | 'timestamptz' | 'date' = 'text'
  ): string {
    const cast = kind === 'number' ? '::numeric' : kind === 'timestamptz' ? '::timestamptz' : kind === 'date' ? '::date' : '';
    const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    if (op === 'between') {
      const pair = value as [unknown, unknown];
      params.push(pair[0], pair[1]);
      return `${column} BETWEEN $${params.length - 1}${cast} AND $${params.length}${cast}`;
    }
    if (op === 'in' || op === 'not_in') {
      const list = value as unknown[];
      if (kind === 'text') {
        params.push(lowerLiteral(list));
        return `${op === 'in' ? '' : 'NOT '}lower(${column}) = ANY($${params.length}::text[])`;
      }
      params.push(pgArrayLiteral(list));
      return `${op === 'in' ? '' : 'NOT '}${column} = ANY($${params.length}::numeric[])`;
    }
    if (op === 'contains') {
      params.push(`%${escapeLike(String(value))}%`);
      return `${column} ILIKE $${params.length}`;
    }
    if (!sqlOp) throw new Error(`Unsupported operator ${op}`);
    if (kind === 'text' && (op === 'eq' || op === 'neq')) {
      params.push(String(value).toLowerCase());
      return `lower(${column}) ${sqlOp} $${params.length}`;
    }
    params.push(value);
    return `${column} ${sqlOp} $${params.length}${cast}`;
  }

  private textArrayCondition(column: string, op: string, value: unknown, params: unknown[]): string {
    if (op === 'contains') {
      params.push(String(value));
      return `$${params.length} = ANY(${column})`;
    }
    params.push(pgArrayLiteral((value as unknown[]).map(String)));
    return op === 'contains_any' ? `${column} && $${params.length}::text[]` : `${column} @> $${params.length}::text[]`;
  }

  private filterCondition(filter: DslFilter, params: unknown[]): string {
    const { field, op, value, resolved } = filter;
    if (resolved.kind === 'sns_account') {
      params.push(resolved.platform);
      const sql = `EXISTS (SELECT 1 FROM person_sns_accounts a WHERE a.person_id = p.id AND a.platform = $${params.length} AND a.status <> 'deleted')`;
      return op === 'exists' ? sql : `NOT ${sql}`;
    }
    if (resolved.kind === 'sns_metric') {
      params.push(resolved.platform);
      const platformParam = params.length;
      const cmp = this.scalarCondition(`lm.${q(resolved.metric)}`, op, value, params, 'number');
      return `EXISTS (
        SELECT 1 FROM person_sns_accounts a
        JOIN LATERAL (
          SELECT m.${q(resolved.metric)} FROM person_sns_metrics m
          WHERE m.account_id = a.id ORDER BY m.measured_at DESC LIMIT 1
        ) lm ON true
        WHERE a.person_id = p.id AND a.platform = $${platformParam} AND ${cmp})`;
    }
    if (resolved.kind === 'custom') {
      const definition = resolved.definition;
      const column = FIELD_TYPES[definition.type]?.column ?? 'value_text';
      params.push(definition.id);
      const base = `SELECT 1 FROM person_field_values v WHERE v.person_id = p.id AND v.field_definition_id = $${params.length}`;
      if (op === 'exists') return `EXISTS (${base} AND v.${column} IS NOT NULL)`;
      if (op === 'not_exists') return `NOT EXISTS (${base} AND v.${column} IS NOT NULL)`;
      if (column === 'value_json') {
        if (op === 'contains') {
          params.push(String(value));
          return `EXISTS (${base} AND v.value_json ? $${params.length})`;
        }
        params.push(pgArrayLiteral((value as unknown[]).map(String)));
        return `EXISTS (${base} AND v.value_json ${op === 'contains_any' ? '?|' : '?&'} $${params.length}::text[])`;
      }
      if (column === 'value_boolean') {
        params.push(value === true || String(value).toLowerCase() === 'true');
        return `EXISTS (${base} AND v.value_boolean = $${params.length})`;
      }
      const kind = column === 'value_number' ? 'number' : column === 'value_date' ? 'date' : 'text';
      return `EXISTS (${base} AND ${this.scalarCondition(`v.${column}`, op, value, params, kind)})`;
    }
    switch (field) {
      case 'core.person.canonical_name':
        return this.scalarCondition('p.canonical_name', op, value, params);
      case 'core.person.display_name':
        return this.scalarCondition('p.display_name', op, value, params);
      case 'core.person.person_type':
        return this.scalarCondition('p.person_type', op, value, params);
      case 'core.person.status':
        return this.scalarCondition('p.status', op, value, params);
      case 'core.alias.alias':
        return `EXISTS (SELECT 1 FROM person_aliases al WHERE al.person_id = p.id AND ${this.scalarCondition('al.alias', op, value, params)})`;
      case 'core.context.context_tags':
        return `EXISTS (SELECT 1 FROM person_contexts c WHERE c.person_id = p.id AND ${this.textArrayCondition('c.context_tags', op, value, params)})`;
      case 'core.context.sentiment':
        return `EXISTS (SELECT 1 FROM person_contexts c WHERE c.person_id = p.id AND ${this.scalarCondition('c.sentiment', op, value, params)})`;
      case 'core.context.occurred_at':
        return `EXISTS (SELECT 1 FROM person_contexts c WHERE c.person_id = p.id AND ${this.scalarCondition('c.occurred_at', op, value, params, 'timestamptz')})`;
      case 'core.summary.summary_tags':
        return `EXISTS (SELECT 1 FROM person_summaries ps WHERE ps.person_id = p.id AND ${this.textArrayCondition('ps.summary_tags', op, value, params)})`;
      default:
        throw new Error(`Unsupported filter field: ${field}`);
    }
  }

  /** Hard structured filtering. Returns null when the DSL has no structured constraints. */
  async filterPersonIds(tenantId: string, filters: DslFilter[], timeRange: DslTimeRange | null): Promise<string[] | null> {
    const window = this.timeWindow(timeRange);
    if (!filters.length && !window) return null;
    const params: unknown[] = [tenantId];
    const conditions = filters.map((filter) => this.filterCondition(filter, params));
    if (window) {
      const parts: string[] = [];
      if (window.from) {
        params.push(window.from);
        parts.push(`c.occurred_at >= $${params.length}::timestamptz`);
      }
      if (window.to) {
        params.push(window.to);
        parts.push(`c.occurred_at <= $${params.length}::timestamptz`);
      }
      conditions.push(`EXISTS (SELECT 1 FROM person_contexts c WHERE c.person_id = p.id AND ${parts.join(' AND ')})`);
    }
    const { rows } = await this.driver.query<{ id: string }>(
      `SELECT p.id FROM persons p
       WHERE p.tenant_id = $1 AND p.status NOT IN ('deleted', 'merged')
       ${conditions.map((condition) => `AND ${condition}`).join('\n')}
       LIMIT 5000`,
      params
    );
    return rows.map((row) => row.id);
  }

  async vectorSearchPersons(
    tenantId: string,
    embedding: number[],
    { limit = 50, restrictTo = null as string[] | null } = {}
  ): Promise<SearchHit[]> {
    const params: unknown[] = [tenantId, `[${embedding.join(',')}]`];
    let restrict = '';
    if (restrictTo) {
      if (!restrictTo.length) return [];
      params.push(pgArrayLiteral(restrictTo));
      restrict = `AND person_id = ANY($${params.length}::uuid[])`;
    }
    const { rows } = await this.driver.query<{ person_id: string; similarity: number | string }>(
      `SELECT person_id, 1 - (embedding <=> $2::vector) AS similarity
       FROM person_search_documents
       WHERE tenant_id = $1 AND embedding IS NOT NULL ${restrict}
       ORDER BY embedding <=> $2::vector
       LIMIT ${Math.trunc(limit)}`,
      params
    );
    return rows.map((row) => ({ person_id: row.person_id, similarity: clamp(Number(row.similarity), 0, 1) }));
  }

  async fullTextSearchPersons(
    tenantId: string,
    query: string,
    { limit = 50, restrictTo = null as string[] | null } = {}
  ): Promise<SearchHit[]> {
    if (!this.fullTextEnabled || !query.trim()) return [];
    const params: unknown[] = [tenantId, query];
    let restrict = '';
    if (restrictTo) {
      if (!restrictTo.length) return [];
      params.push(pgArrayLiteral(restrictTo));
      restrict = `AND person_id = ANY($${params.length}::uuid[])`;
    }
    const { rows } = await this.driver.query<{ person_id: string; score: number | string }>(
      `SELECT person_id, pgroonga_score(tableoid, ctid) AS score
       FROM person_search_documents
       WHERE tenant_id = $1 AND searchable_text &@~ pgroonga_query_escape($2) ${restrict}
       ORDER BY score DESC
       LIMIT ${Math.trunc(limit)}`,
      params
    );
    const max = Math.max(...rows.map((row) => Number(row.score)), 1);
    return rows.map((row) => ({ person_id: row.person_id, score: Number((Number(row.score) / max).toFixed(4)) }));
  }

  async topContextsForPersons(
    tenantId: string,
    personIds: string[],
    { timeRange = null as DslTimeRange | null, perPerson = 3 } = {}
  ): Promise<Map<string, MatchedContext[]>> {
    const map = new Map<string, MatchedContext[]>(personIds.map((id) => [id, []]));
    if (!personIds.length) return map;
    const window = this.timeWindow(timeRange);
    const params: unknown[] = [tenantId, pgArrayLiteral(personIds)];
    const conditions = ['c2.tenant_id = $1', 'c2.person_id = pid.id'];
    if (window?.from) {
      params.push(window.from);
      conditions.push(`c2.occurred_at >= $${params.length}::timestamptz`);
    }
    if (window?.to) {
      params.push(window.to);
      conditions.push(`c2.occurred_at <= $${params.length}::timestamptz`);
    }
    const { rows } = await this.driver.query(
      `SELECT c.id AS context_id, c.person_id, c.source_id, c.role, c.sentiment, c.evidence_text, c.context_text, c.occurred_at, s.title
       FROM unnest($2::uuid[]) AS pid(id)
       JOIN LATERAL (
         SELECT * FROM person_contexts c2 WHERE ${conditions.join(' AND ')}
         ORDER BY c2.occurred_at DESC NULLS LAST LIMIT ${Math.trunc(perPerson)}
       ) c ON true
       LEFT JOIN source_documents s ON s.id = c.source_id`,
      params
    );
    for (const row of rows) {
      map.get(row.person_id)?.push({
        context_id: row.context_id,
        source_id: row.source_id,
        title: row.title ?? '',
        role: row.role,
        sentiment: row.sentiment,
        evidence_text: row.evidence_text ?? String(row.context_text ?? '').slice(0, 180),
        occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at
      });
    }
    return map;
  }

  async hydratePersons(tenantId: string, personIds: string[]): Promise<Map<string, HydratedPerson>> {
    const map = new Map<string, HydratedPerson>();
    if (!personIds.length) return map;
    const idsLiteral = pgArrayLiteral(personIds);
    const [persons, aliases, profiles, accounts, contexts, summaries, values, definitions] = await Promise.all([
      this.driver.query('SELECT * FROM persons WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, idsLiteral]),
      this.driver.query('SELECT * FROM person_aliases WHERE tenant_id = $1 AND person_id = ANY($2::uuid[]) ORDER BY created_at', [
        tenantId,
        idsLiteral
      ]),
      this.driver.query(
        'SELECT person_id, tenant_id, short_bio, profile_text, updated_at FROM person_profiles WHERE tenant_id = $1 AND person_id = ANY($2::uuid[])',
        [tenantId, idsLiteral]
      ),
      this.driver.query('SELECT * FROM person_sns_accounts WHERE tenant_id = $1 AND person_id = ANY($2::uuid[]) ORDER BY created_at', [
        tenantId,
        idsLiteral
      ]),
      this.driver.query(
        `SELECT c.id, c.tenant_id, c.person_id, c.source_id, c.role, c.context_text, c.context_tags, c.sentiment, c.importance, c.evidence_text, c.occurred_at, c.metadata, c.created_at
         FROM unnest($2::uuid[]) AS pid(id)
         JOIN LATERAL (
           SELECT * FROM person_contexts c2 WHERE c2.tenant_id = $1 AND c2.person_id = pid.id
           ORDER BY c2.occurred_at DESC NULLS LAST LIMIT 5
         ) c ON true`,
        [tenantId, idsLiteral]
      ),
      this.driver.query(
        `SELECT DISTINCT ON (person_id, summary_type) id, tenant_id, person_id, summary_type, "window", summary_text, summary_tags, source_count, generated_at, metadata
         FROM person_summaries WHERE tenant_id = $1 AND person_id = ANY($2::uuid[])
         ORDER BY person_id, summary_type, generated_at DESC`,
        [tenantId, idsLiteral]
      ),
      this.driver.query('SELECT * FROM person_field_values WHERE tenant_id = $1 AND person_id = ANY($2::uuid[])', [tenantId, idsLiteral]),
      this.driver.query('SELECT * FROM field_definitions WHERE tenant_id = $1', [tenantId])
    ]);

    const accountRows = accounts.rows.map((row: Record<string, unknown>) => deserializeRow('person_sns_accounts', row));
    const accountIds = accountRows.map((row) => row?.id).filter(Boolean) as string[];
    const metrics = accountIds.length
      ? await this.driver.query(
          'SELECT DISTINCT ON (account_id) * FROM person_sns_metrics WHERE account_id = ANY($1::uuid[]) ORDER BY account_id, measured_at DESC',
          [pgArrayLiteral(accountIds)]
        )
      : { rows: [] };
    const latestMetric = new Map<string, SnsMetricRow>(
      metrics.rows.map((row: Record<string, unknown>) => {
        const metric = deserializeRow('person_sns_metrics', row) as SnsMetricRow;
        return [metric.account_id, metric];
      })
    );
    const definitionById = new Map<string, FieldDefinitionRow>(
      definitions.rows.map((row: Record<string, unknown>) => {
        const definition = deserializeRow('field_definitions', row) as FieldDefinitionRow;
        return [definition.id, definition];
      })
    );

    const groupBy = <R extends { person_id: string }>(rows: R[]): Map<string, R[]> => {
      const grouped = new Map<string, R[]>();
      for (const row of rows) {
        if (!grouped.has(row.person_id)) grouped.set(row.person_id, []);
        grouped.get(row.person_id)?.push(row);
      }
      return grouped;
    };

    const aliasMap = groupBy(
      aliases.rows.map((row: Record<string, unknown>) => deserializeRow('person_aliases', row)).filter(Boolean) as never[]
    );
    const profileMap = new Map(
      profiles.rows.map((row: Record<string, unknown>) => [row.person_id, deserializeRow('person_profiles', row)])
    );
    const accountMap = groupBy(accountRows.filter(Boolean) as never[]);
    const contextMap = groupBy(
      contexts.rows.map((row: Record<string, unknown>) => deserializeRow('person_contexts', row)).filter(Boolean) as never[]
    );
    const summaryMap = groupBy(
      summaries.rows.map((row: Record<string, unknown>) => deserializeRow('person_summaries', row)).filter(Boolean) as never[]
    );
    const valueMap = groupBy(
      values.rows.map((row: Record<string, unknown>) => deserializeRow('person_field_values', row)).filter(Boolean) as never[]
    );

    for (const raw of persons.rows) {
      const person = deserializeRow('persons', raw) as PersonRow;
      map.set(person.id, {
        ...person,
        aliases: aliasMap.get(person.id) ?? [],
        profile: (profileMap.get(person.id) ?? null) as HydratedPerson['profile'],
        sns_accounts: (accountMap.get(person.id) ?? []).map((account: never) => ({
          ...(account as Record<string, unknown>),
          latest_metric: latestMetric.get((account as { id: string }).id) ?? null
        })) as HydratedPerson['sns_accounts'],
        recent_contexts: contextMap.get(person.id) ?? [],
        summaries: summaryMap.get(person.id) ?? [],
        fields: ((valueMap.get(person.id) ?? []) as never[])
          .filter((value) => definitionById.has((value as { field_definition_id: string }).field_definition_id))
          .map((value) =>
            presentFieldValue(
              definitionById.get((value as { field_definition_id: string }).field_definition_id) as FieldDefinitionRow,
              value as never
            )
          )
      });
    }
    return map;
  }

  /** Most frequent context/summary tags of the tenant (grounds the query parser). */
  async distinctTags(tenantId: string, limit = 100): Promise<string[]> {
    const { rows } = await this.driver.query<{ tag: string }>(
      `SELECT tag FROM (
         SELECT unnest(context_tags) AS tag FROM person_contexts WHERE tenant_id = $1
         UNION ALL
         SELECT unnest(summary_tags) AS tag FROM person_summaries WHERE tenant_id = $1
       ) tags
       GROUP BY tag ORDER BY count(*) DESC, tag LIMIT ${Math.trunc(limit)}`,
      [tenantId]
    );
    return rows.map((row) => row.tag);
  }

  /** Admin convenience name lookup (intentionally simple ILIKE; not the production full-text path). */
  async searchPersonsByName(tenantId: string, query: string, limit = 20, offset = 0): Promise<{ results: PersonRow[]; total: number }> {
    const params: unknown[] = [tenantId];
    let condition = '';
    if (query.trim()) {
      params.push(`%${escapeLike(query)}%`);
      condition = `AND (p.canonical_name ILIKE $2 OR p.display_name ILIKE $2 OR EXISTS (
        SELECT 1 FROM person_aliases a WHERE a.person_id = p.id AND a.alias ILIKE $2))`;
    }
    const { rows } = await this.driver.query(
      `SELECT p.*, count(*) OVER ()::int AS total FROM persons p
       WHERE p.tenant_id = $1 AND p.status <> 'deleted' ${condition}
       ORDER BY p.created_at DESC LIMIT ${Math.trunc(limit)} OFFSET ${Math.trunc(offset)}`,
      params
    );
    const total = rows.length ? Number((rows[0] as { total: number }).total) : 0;
    return {
      results: rows.map((row: Record<string, unknown>) => {
        const { total: _ignored, ...rest } = row;
        return deserializeRow('persons', rest) as PersonRow;
      }),
      total
    };
  }
}

export async function createStore(
  options: { provider?: 'postgres' | 'pglite'; databaseUrl?: string; pgliteDataDir?: string | null; migrate?: boolean } = {}
): Promise<SqlStore> {
  const driver = await createDriver(options);
  return new SqlStore(driver).init({ migrate: options.migrate ?? true });
}

export { config };
