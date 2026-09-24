import { createClient } from '@libsql/client';
import { SpanType } from '@mastra/core/observability';
import { parseTraceQueryRequest, planTraceQuery } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';
import { ObservabilityLibSQL } from './index';

describe('ObservabilityLibSQL trace queries', () => {
  it('returns a persisted trace through the advanced query path', async () => {
    const client = createClient({ url: ':memory:' });
    const storage = new ObservabilityLibSQL({ client });

    try {
      await storage.init();
      await storage.createSpan({
        span: {
          traceId: 'trace-query-1',
          spanId: 'span-query-1',
          parentSpanId: null,
          name: 'synthetic workflow',
          spanType: SpanType.WORKFLOW_RUN,
          entityType: 'workflow_run',
          entityId: 'synthetic-workflow',
          isEvent: false,
          error: null,
          startedAt: new Date('2026-09-24T12:00:00.000Z'),
          endedAt: new Date('2026-09-24T12:00:01.000Z'),
        },
      });
      await storage.createSpan({
        span: {
          traceId: 'trace-query-2',
          spanId: 'span-query-2',
          parentSpanId: null,
          name: 'second synthetic workflow',
          spanType: SpanType.WORKFLOW_RUN,
          entityType: 'workflow_run',
          entityId: 'second-workflow',
          isEvent: false,
          startedAt: new Date('2026-09-24T12:00:00.000Z'),
          endedAt: new Date('2026-09-24T12:00:01.000Z'),
        },
      });
      await storage.createSpan({
        span: {
          traceId: 'trace-query-1',
          spanId: 'child-span-1',
          parentSpanId: 'span-query-1',
          name: 'workflow step',
          spanType: SpanType.WORKFLOW_STEP,
          entityType: 'workflow_step',
          entityId: 'synthetic-workflow',
          isEvent: false,
          startedAt: new Date('2026-09-24T12:00:00.200Z'),
          endedAt: new Date('2026-09-24T12:00:00.500Z'),
        },
      });
      await storage.createSpan({
        span: {
          traceId: 'running-trace',
          spanId: 'running-span',
          parentSpanId: null,
          name: 'running workflow',
          spanType: SpanType.WORKFLOW_RUN,
          entityType: 'workflow_run',
          entityId: 'running-workflow',
          isEvent: false,
          startedAt: new Date('2026-09-24T12:00:00.000Z'),
        },
      });
      await storage.createSpan({
        span: {
          traceId: 'outside-trace',
          spanId: 'outside-span',
          parentSpanId: null,
          name: 'out-of-range workflow',
          spanType: SpanType.WORKFLOW_RUN,
          entityType: 'workflow_run',
          entityId: 'outside-workflow',
          isEvent: false,
          startedAt: new Date('2026-09-24T13:00:00.000Z'),
          endedAt: new Date('2026-09-24T13:00:01.000Z'),
        },
      });

      const timeRange = {
        from: '2026-09-24T11:00:00.000Z',
        to: '2026-09-24T13:00:00.000Z',
      };
      const where = {
        op: 'and' as const,
        args: [
          { op: 'eq' as const, left: { path: 'entityType' }, right: { literal: 'workflow_run' } },
          { op: 'ne' as const, left: { path: 'threadId' }, right: { literal: 'excluded' } },
        ],
      };
      const firstPlan = planTraceQuery(parseTraceQueryRequest({ timeRange, where, page: { limit: 1, after: null } }));

      const firstPage = await storage.queryTraces(firstPlan);
      expect(firstPage).toMatchObject({
        traces: [{ traceId: 'trace-query-1', status: 'success' }],
        page: { next: expect.any(String) },
      });
      const next = (firstPage as { page: { next: string } }).page.next;
      const secondPlan = planTraceQuery(parseTraceQueryRequest({ timeRange, where, page: { limit: 1, after: next } }));
      await expect(storage.queryTraces(secondPlan)).resolves.toMatchObject({
        traces: [{ traceId: 'trace-query-2' }],
        page: { next: null },
      });
      expect(storage.getFeatures()).toContain('trace-query');
    } finally {
      client.close();
    }
  });

  it('rejects predicates over stores LibSQL does not persist', async () => {
    const client = createClient({ url: ':memory:' });
    const storage = new ObservabilityLibSQL({ client });
    const plan = planTraceQuery(
      parseTraceQueryRequest({
        timeRange: {
          from: '2026-09-24T11:00:00.000Z',
          to: '2026-09-24T13:00:00.000Z',
        },
        where: { scores: { some: { op: 'eq', left: { path: 'score' }, right: { literal: 1 } } } },
      }),
    );
    try {
      await expect(storage.queryTraces(plan)).rejects.toThrow('LibSQL trace queries do not support scores predicates');
    } finally {
      client.close();
    }
  });

  it('enforces advertised root-duration and tenant-scope capabilities', async () => {
    const client = createClient({ url: ':memory:' });
    const storage = new ObservabilityLibSQL({ client });

    try {
      await storage.init();
      await storage.createSpan({
        span: {
          traceId: 'scoped-trace',
          spanId: 'scoped-root',
          parentSpanId: null,
          name: 'scoped workflow',
          spanType: SpanType.WORKFLOW_RUN,
          entityType: 'workflow_run',
          entityId: 'scoped-workflow',
          organizationId: 'org-a',
          resourceId: 'resource-a',
          isEvent: false,
          startedAt: new Date('2026-09-24T12:00:00.000Z'),
          endedAt: new Date('2026-09-24T12:00:01.000Z'),
        },
      });

      const request = parseTraceQueryRequest({
        timeRange: {
          from: '2026-09-24T11:00:00.000Z',
          to: '2026-09-24T13:00:00.000Z',
        },
        where: { op: 'gt', left: { path: 'durationMs' }, right: { literal: 500 } },
      });
      const plan = planTraceQuery(request, { scope: { organizationId: 'org-a', resourceId: 'resource-a' } });
      await expect(storage.queryTraces(plan)).resolves.toMatchObject({
        traces: [{ traceId: 'scoped-trace' }],
      });
      expect(storage.getFeatures()).toEqual(['trace-query', 'trace-query-root-duration', 'trace-query-tenant-scope']);

      const wrongTenantPlan = planTraceQuery(request, { scope: { organizationId: 'org-b', resourceId: 'resource-a' } });
      await expect(storage.queryTraces(wrongTenantPlan)).resolves.toMatchObject({ traces: [] });
      const wrongResourcePlan = planTraceQuery(request, {
        scope: { organizationId: 'org-a', resourceId: 'resource-b' },
      });
      await expect(storage.queryTraces(wrongResourcePlan)).resolves.toMatchObject({ traces: [] });
    } finally {
      client.close();
    }
  });
});
