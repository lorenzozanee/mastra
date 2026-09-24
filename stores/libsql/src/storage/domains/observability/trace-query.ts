import * as coreStorage from '@mastra/core/storage';
import type {
  TraceQueryResponse,
  TrustedTraceQueryPlan,
  TrustedTraceQueryPredicate,
  TrustedTraceQueryScalarPredicate,
} from '@mastra/core/storage';
import type { SqliteClient, SqliteInValue } from '../../db/client';

type SqlFragment = { sql: string; args: SqliteInValue[] };

const TRACE_STATUS_SQL =
  "CASE WHEN json_type(r.error) IS NOT NULL AND json_type(r.error) <> 'null' THEN 'error' ELSE 'success' END";

function compileField(field: string): SqlFragment {
  const fields: Record<string, string> = {
    traceId: 'r.traceId',
    threadId: 'r.threadId',
    resourceId: 'r.resourceId',
    startedAt: 'r.startedAt',
    endedAt: 'r.endedAt',
    durationMs: '(julianday(r.endedAt) - julianday(r.startedAt)) * 86400000',
    entityName: 'r.entityName',
    entityType: 'r.entityType',
    environment: 'r.environment',
    status: TRACE_STATUS_SQL,
  };
  if (field.startsWith('metadata.')) {
    const path = `$.${JSON.stringify(field.slice('metadata.'.length))}`;
    return { sql: 'json_extract(r.metadata, ?)', args: [path] };
  }
  const sql = fields[field];
  if (sql) return { sql, args: [] };
  throw new coreStorage.TraceQueryUnsupportedError(`LibSQL trace queries do not support the ${field} predicate`);
}

function compileScalar(predicate: TrustedTraceQueryScalarPredicate): SqlFragment {
  if (predicate.type === 'boolean') {
    const parts = predicate.args.map(compileScalar);
    return {
      sql: `(${parts.map(part => part.sql).join(predicate.operator === 'and' ? ' AND ' : ' OR ')})`,
      args: parts.flatMap(part => part.args),
    };
  }
  if (predicate.type === 'not') {
    const part = compileScalar(predicate.arg);
    return { sql: `NOT (${part.sql})`, args: part.args };
  }

  if (predicate.field === 'tags') {
    if (predicate.type !== 'collection') {
      throw new coreStorage.TraceQueryUnsupportedError(
        'LibSQL trace queries only support collection predicates for tags',
      );
    }
    if (!('value' in predicate)) {
      return {
        sql: `${predicate.operator === 'empty' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM json_each(r.tags))`,
        args: [],
      };
    }
    const exists = 'EXISTS (SELECT 1 FROM json_each(r.tags) AS tag WHERE tag.value = ?)';
    return {
      sql: predicate.operator === 'includes' ? exists : `NOT ${exists}`,
      args: [predicate.value],
    };
  }

  const field = compileField(predicate.field);
  if (predicate.type === 'presence') {
    return {
      sql: `${field.sql} IS ${predicate.operator === 'exists' ? 'NOT ' : ''}NULL`,
      args: field.args,
    };
  }
  if (predicate.type === 'membership') {
    const placeholders = predicate.values.map(() => '?').join(', ');
    const sql =
      predicate.operator === 'in'
        ? `${field.sql} IS NOT NULL AND ${field.sql} IN (${placeholders})`
        : `${field.sql} IS NULL OR ${field.sql} NOT IN (${placeholders})`;
    return {
      sql,
      args: [...field.args, ...field.args, ...predicate.values],
    };
  }
  if (predicate.type === 'collection') {
    throw new coreStorage.TraceQueryUnsupportedError(
      `LibSQL trace queries do not support ${predicate.operator} for ${predicate.field}`,
    );
  }

  const operators = { eq: '=', ne: 'IS NOT', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
  return {
    sql: `${field.sql} ${operators[predicate.operator]} ?`,
    args: [...field.args, predicate.value],
  };
}

function compilePredicate(predicate: TrustedTraceQueryPredicate): SqlFragment {
  if (predicate.type === 'relation') {
    throw new coreStorage.TraceQueryUnsupportedError(
      `LibSQL trace queries do not support ${predicate.collection} predicates`,
    );
  }
  if (predicate.type === 'boolean') {
    const parts = predicate.args.map(compilePredicate);
    return {
      sql: `(${parts.map(part => part.sql).join(predicate.operator === 'and' ? ' AND ' : ' OR ')})`,
      args: parts.flatMap(part => part.args),
    };
  }
  if (predicate.type === 'not') {
    const part = compilePredicate(predicate.arg);
    return { sql: `NOT (${part.sql})`, args: part.args };
  }
  return compileScalar(predicate);
}

function asIsoTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(value as string | number).toISOString();
}

function toTrace(row: Record<string, unknown>) {
  return {
    traceId: String(row.traceId),
    rootSpanId: String(row.rootSpanId),
    name: String(row.name),
    entityId: row.entityId == null ? null : String(row.entityId),
    parentSpanId: row.parentSpanId == null ? null : String(row.parentSpanId),
    createdAt: asIsoTimestamp(row.startedAt),
    metadata: row.metadata == null ? null : coreStorage.safelyParseJSON(row.metadata as string),
    inputPreview: coreStorage.buildInputPreview(row.input) ?? null,
    threadId: row.threadId == null ? null : String(row.threadId),
    resourceId: row.resourceId == null ? null : String(row.resourceId),
    startedAt: asIsoTimestamp(row.startedAt),
    endedAt: asIsoTimestamp(row.endedAt),
    entityName: row.entityName == null ? null : String(row.entityName),
    entityType: row.entityType == null ? null : String(row.entityType),
    environment: row.environment == null ? null : String(row.environment),
    status: row.status,
  };
}

export async function queryTraces(client: SqliteClient, plan: TrustedTraceQueryPlan): Promise<TraceQueryResponse> {
  if (plan.result !== 'traces') {
    throw new coreStorage.TraceQueryUnsupportedError('LibSQL trace queries do not support groups');
  }
  if (plan.paginationMode === 'delta') {
    throw new coreStorage.TraceQueryUnsupportedError('LibSQL trace queries do not support delta pagination');
  }

  const where = ['r.parentSpanId IS NULL', 'r.endedAt IS NOT NULL', 'r.startedAt >= ?', 'r.startedAt < ?'];
  const args: SqliteInValue[] = [plan.timeRange.from, plan.timeRange.to];
  if (plan.scope) {
    where.push('r.organizationId = ?');
    args.push(plan.scope.organizationId);
    if (plan.scope.resourceId) {
      where.push('r.resourceId = ?');
      args.push(plan.scope.resourceId);
    }
  }
  if (plan.where) {
    const predicate = compilePredicate(plan.where);
    where.push(`(${predicate.sql})`);
    args.push(...predicate.args);
  }
  const whereSql = where.join(' AND ');

  if (plan.paginationMode === 'page') {
    const countResult = await client.execute({
      sql: `SELECT COUNT(*) AS total FROM ${coreStorage.TABLE_SPANS} AS r WHERE ${whereSql}`,
      args,
    });
    const total = Number(countResult.rows[0]?.total ?? 0);
    const result = await client.execute({
      sql: `SELECT r.traceId, r.spanId AS rootSpanId, r.name, r.entityId, r.parentSpanId,
        r.startedAt, r.endedAt, json(r.metadata) AS metadata, json(r.input) AS input,
        r.threadId, r.resourceId, r.entityName, r.entityType, r.environment,
        ${TRACE_STATUS_SQL} AS status
        FROM ${coreStorage.TABLE_SPANS} AS r
        WHERE ${whereSql}
        ORDER BY r.${plan.orderBy.field} ${plan.orderBy.direction.toUpperCase()}, r.traceId ASC
        LIMIT ? OFFSET ?`,
      args: [...args, plan.perPage, plan.page * plan.perPage],
    });
    return coreStorage.traceQueryResponseSchema.parse({
      traces: result.rows.map(row => toTrace(row as Record<string, unknown>)),
      pagination: {
        total,
        page: plan.page,
        perPage: plan.perPage,
        hasMore: (plan.page + 1) * plan.perPage < total,
      },
    });
  }

  const comparison = plan.orderBy.direction === 'asc' ? '>' : '<';
  const pageWhere = [...where];
  const pageArgs = [...args];
  if (plan.cursor) {
    pageWhere.push(`(r.${plan.orderBy.field} ${comparison} ? OR (r.${plan.orderBy.field} = ? AND r.traceId > ?))`);
    pageArgs.push(plan.cursor.sortValue, plan.cursor.sortValue, plan.cursor.traceId);
  }
  const result = await client.execute({
    sql: `SELECT r.traceId, r.spanId AS rootSpanId, r.name, r.entityId, r.parentSpanId,
      r.startedAt, r.endedAt, json(r.metadata) AS metadata, json(r.input) AS input,
      r.threadId, r.resourceId, r.entityName, r.entityType, r.environment,
      ${TRACE_STATUS_SQL} AS status
      FROM ${coreStorage.TABLE_SPANS} AS r
      WHERE ${pageWhere.join(' AND ')}
      ORDER BY r.${plan.orderBy.field} ${plan.orderBy.direction.toUpperCase()}, r.traceId ASC
      LIMIT ?`,
    args: [...pageArgs, plan.limit + 1],
  });
  const rows = result.rows.slice(0, plan.limit).map(row => toTrace(row as Record<string, unknown>));
  const last = rows.at(-1);
  return coreStorage.traceQueryResponseSchema.parse({
    traces: rows,
    page: {
      next:
        result.rows.length > plan.limit && last
          ? coreStorage.encodeTraceQueryCursor(plan, {
              result: 'traces',
              sortValue: last[plan.orderBy.field],
              traceId: last.traceId,
            })
          : null,
    },
  });
}
