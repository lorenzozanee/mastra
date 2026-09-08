import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeStorageTests } from '@internal/storage-test-utils';
import { createClient } from '@libsql/client';
import {
  knowledgeImporterBindingKey,
  KnowledgeSchemaError,
  MastraCompositeStore,
  TABLE_KNOWLEDGE_SCHEMA,
} from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';

import { LibSQLStore } from '../..';
import { getLibSQLKnowledgeIsolationKey, KnowledgeLibSQL } from '.';

describe('LibSQLStore explicit Knowledge activation', () => {
  it.each([false, true])('does not create Knowledge objects during ordinary startup (composed=%s)', async composed => {
    const client = createClient({ url: ':memory:' });
    const adapter = new LibSQLStore({ id: 'ordinary', client });
    const store = composed ? new MastraCompositeStore({ id: 'composed', default: adapter }) : adapter;
    try {
      await store.init();
      expect(await store.getStore('memory')).toBeDefined();
      const tables = await client.execute("SELECT name FROM sqlite_master WHERE name GLOB 'mastra_knowledge_*'");
      expect(tables.rows).toEqual([]);
      expect(await store.getStore('knowledge')).toBeDefined();
      const marker = await client.execute(`SELECT version FROM ${TABLE_KNOWLEDGE_SCHEMA} WHERE id = 'canonical'`);
      expect(marker.rows[0]?.version).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('leaves unknown Knowledge artifacts intact during startup and failed activation', async () => {
    const client = createClient({ url: ':memory:' });
    const store = new LibSQLStore({ id: 'unknown-artifacts', client });
    try {
      await client.execute('CREATE TABLE mastra_knowledge_nodes (id TEXT PRIMARY KEY, payload TEXT)');
      await client.execute("INSERT INTO mastra_knowledge_nodes VALUES ('private', 'preserve')");
      await client.execute('CREATE TABLE knowledge_documents_dimension_3 (id TEXT PRIMARY KEY, payload TEXT)');
      await client.execute("INSERT INTO knowledge_documents_dimension_3 VALUES ('vector', 'preserve')");
      await store.init();
      const before = await client.execute('SELECT * FROM sqlite_master ORDER BY name');
      await expect(store.getStore('knowledge')).rejects.toBeInstanceOf(KnowledgeSchemaError);
      expect((await client.execute('SELECT * FROM sqlite_master ORDER BY name')).rows).toEqual(before.rows);
      expect((await client.execute('SELECT * FROM mastra_knowledge_nodes')).rows).toEqual([
        { id: 'private', payload: 'preserve' },
      ]);
      expect((await client.execute('SELECT * FROM knowledge_documents_dimension_3')).rows).toEqual([
        { id: 'vector', payload: 'preserve' },
      ]);
      await expect(store.init()).resolves.toBeUndefined();
      expect(await store.getStore('memory')).toBeDefined();
    } finally {
      await store.close();
    }
  });
});

createKnowledgeStorageTests(() => new KnowledgeLibSQL({ url: 'file::memory:?cache=shared' }));

describe('KnowledgeLibSQL recognized empty experimental schema', () => {
  const seed = async (client: ReturnType<typeof createClient>) => {
    const sql = await readFile(new URL('./fixtures/published-1.21.1.sql', import.meta.url), 'utf8');
    await client.batch(
      sql
        .split(';')
        .map(statement => statement.trim())
        .filter(Boolean),
      'write',
    );
  };

  it('replaces only the empty published layout and leaves vector state untouched', async () => {
    const client = createClient({ url: ':memory:' });
    try {
      await seed(client);
      await client.execute('CREATE TABLE knowledge_documents_dimension_3 (id TEXT PRIMARY KEY)');
      await client.execute("INSERT INTO knowledge_documents_dimension_3 VALUES ('untouched')");
      await Promise.all([new KnowledgeLibSQL({ client }).init(), new KnowledgeLibSQL({ client }).init()]);
      const columns = await client.execute('PRAGMA table_info(mastra_knowledge_nodes)');
      expect(columns.rows.map(row => row.name)).toContain('isScope');
      expect(columns.rows.map(row => row.name)).not.toContain('type');
      expect((await client.execute('SELECT * FROM knowledge_documents_dimension_3')).rows).toEqual([
        { id: 'untouched' },
      ]);
    } finally {
      client.close();
    }
  });

  it.each(['nodes', 'records', 'mentions', 'cursors', 'activity', 'semantic_outbox'])(
    'refuses replacement if %s contains data',
    async suffix => {
      const client = createClient({ url: ':memory:' });
      try {
        await seed(client);
        const table = `mastra_knowledge_${suffix}`;
        const columns = await client.execute(`PRAGMA table_info(${table})`);
        const names = columns.rows.map(row => `"${row.name}"`).join(',');
        await client.execute({
          sql: `INSERT INTO ${table} (${names}) VALUES (${columns.rows.map(() => '?').join(',')})`,
          args: columns.rows.map(row => (row.type === 'INTEGER' ? 1 : 'retained')),
        });
        const before = await client.execute('SELECT * FROM sqlite_master ORDER BY name');
        await expect(new KnowledgeLibSQL({ client }).init()).rejects.toBeInstanceOf(KnowledgeSchemaError);
        expect((await client.execute('SELECT * FROM sqlite_master ORDER BY name')).rows).toEqual(before.rows);
        expect((await client.execute(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
      } finally {
        client.close();
      }
    },
  );

  it.each([
    'CREATE TABLE mastra_knowledge_unknown (id TEXT)',
    'CREATE TRIGGER custom_knowledge_trigger AFTER INSERT ON mastra_knowledge_nodes BEGIN SELECT 1; END',
    'CREATE VIEW unrelated_view AS SELECT * FROM mastra_knowledge_nodes',
  ])('rejects unrecognized or externally referenced layouts without mutation: %s', async sql => {
    const client = createClient({ url: ':memory:' });
    try {
      await seed(client);
      await client.execute(sql);
      const before = await client.execute('SELECT * FROM sqlite_master ORDER BY name');
      await expect(new KnowledgeLibSQL({ client }).init()).rejects.toBeInstanceOf(KnowledgeSchemaError);
      expect((await client.execute('SELECT * FROM sqlite_master ORDER BY name')).rows).toEqual(before.rows);
    } finally {
      client.close();
    }
  });

  it('rolls back the empty legacy layout if canonical creation fails and permits a retry', async () => {
    const client = createClient({ url: ':memory:' });
    try {
      await seed(client);
      const before = await client.execute('SELECT * FROM sqlite_master ORDER BY name');
      const execute = client.execute.bind(client);
      const spy = vi.spyOn(client, 'execute').mockImplementation(async statement => {
        const sql = typeof statement === 'string' ? statement : statement.sql;
        if (sql.startsWith('CREATE TABLE') && sql.includes('mastra_knowledge_schema')) {
          throw new Error('injected schema creation failure');
        }
        return execute(statement);
      });
      await expect(new KnowledgeLibSQL({ client }).init()).rejects.toThrow();
      spy.mockRestore();
      expect((await client.execute('SELECT * FROM sqlite_master ORDER BY name')).rows).toEqual(before.rows);
      await new KnowledgeLibSQL({ client }).init();
      expect((await client.execute(`SELECT * FROM ${TABLE_KNOWLEDGE_SCHEMA}`)).rows).toHaveLength(1);
    } finally {
      client.close();
    }
  });
});

describe('KnowledgeLibSQL schema completion marker', () => {
  it('writes the marker only after canonical initialization succeeds', async () => {
    const client = createClient({ url: ':memory:' });
    try {
      await new KnowledgeLibSQL({ client }).init();
      const marker = await client.execute(`SELECT version FROM ${TABLE_KNOWLEDGE_SCHEMA} WHERE id = 'canonical'`);
      expect(marker.rows[0]?.version).toBe(1);
    } finally {
      client.close();
    }
  });

  it('rejects a markerless partial schema without mutating it', async () => {
    const client = createClient({ url: ':memory:' });
    try {
      await client.execute('CREATE TABLE mastra_knowledge_nodes (id TEXT PRIMARY KEY)');
      await expect(new KnowledgeLibSQL({ client }).init()).rejects.toBeInstanceOf(KnowledgeSchemaError);
      const tables = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mastra_knowledge_%' ORDER BY name",
      );
      expect(tables.rows.map(row => row.name)).toEqual(['mastra_knowledge_nodes']);
    } finally {
      client.close();
    }
  });
});

describe('KnowledgeLibSQL shared access epochs', () => {
  it('reconciles one identity scope authority across restart without touching other principals', async () => {
    const path = join(tmpdir(), `mastra-knowledge-curator-profile-${randomUUID()}.db`);
    const url = `file:${path}`;
    const firstClient = createClient({ url });
    try {
      const first = new KnowledgeLibSQL({ client: firstClient, storageIsolationKey: url });
      await first.init();
      const plan = await first.reconcileStructure({
        scopes: [
          { address: 'principal:curator', name: 'Curator' },
          { address: 'principal:host', name: 'Host' },
          { address: 'scope:a', name: 'A' },
          { address: 'scope:b', name: 'B' },
        ],
      });
      await first.reconcileScopeReferenceGrants({
        scopeRefId: plan.scopes['principal:curator']!,
        grants: [
          {
            scopeNodeId: plan.scopes['scope:a']!,
            scopeRefId: plan.scopes['principal:curator']!,
            role: 'owner',
          },
        ],
      });
      await first.upsertScopeGrant({
        scopeNodeId: plan.scopes['scope:a']!,
        scopeRefId: plan.scopes['principal:host']!,
        role: 'owner',
      });
      firstClient.close();

      const restartedClient = createClient({ url });
      try {
        const restarted = new KnowledgeLibSQL({ client: restartedClient, storageIsolationKey: url });
        await restarted.init();
        const changed = await restarted.reconcileScopeReferenceGrants({
          scopeRefId: plan.scopes['principal:curator']!,
          grants: [
            {
              scopeNodeId: plan.scopes['scope:b']!,
              scopeRefId: plan.scopes['principal:curator']!,
              role: 'owner',
            },
          ],
        });
        expect(changed.changed).toBe(true);
        expect(await restarted.listScopeGrants()).toEqual(
          expect.arrayContaining([
            {
              scopeNodeId: plan.scopes['scope:a'],
              scopeRefId: plan.scopes['principal:host'],
              role: 'owner',
              canSuggest: undefined,
            },
            {
              scopeNodeId: plan.scopes['scope:b'],
              scopeRefId: plan.scopes['principal:curator'],
              role: 'owner',
              canSuggest: undefined,
            },
          ]),
        );

        const epoch = await restarted.getAccessEpoch();
        await expect(
          restarted.reconcileScopeReferenceGrants({
            scopeRefId: plan.scopes['principal:curator']!,
            grants: [
              {
                scopeNodeId: randomUUID(),
                scopeRefId: plan.scopes['principal:curator']!,
                role: 'owner',
              },
            ],
          }),
        ).rejects.toBeDefined();
        expect(await restarted.getAccessEpoch()).toBe(epoch);
        expect(
          (await restarted.listScopeGrants()).find(grant => grant.scopeRefId === plan.scopes['principal:curator']),
        ).toMatchObject({ scopeNodeId: plan.scopes['scope:b'], role: 'owner' });
      } finally {
        restartedClient.close();
      }
    } finally {
      firstClient.close();
      await rm(path, { force: true });
    }
  });

  it('serializes concurrent grant reconciliation across clients', async () => {
    const path = join(tmpdir(), `mastra-knowledge-access-${randomUUID()}.db`);
    const url = `file:${path}`;
    const firstClient = createClient({ url });
    const secondClient = createClient({ url });
    try {
      const first = new KnowledgeLibSQL({ client: firstClient, storageIsolationKey: url });
      const second = new KnowledgeLibSQL({ client: secondClient, storageIsolationKey: url });
      await first.init();
      await second.init();
      const plan = {
        scopes: [
          { address: 'principal:shared', name: 'Shared principal' },
          {
            address: 'project:shared',
            name: 'Shared project',
            grants: [{ scopeRefAddress: 'principal:shared', role: 'edit' as const }],
          },
        ],
      };

      const [left, right] = await Promise.all([first.reconcileStructure(plan), second.reconcileStructure(plan)]);

      expect(left.scopes).toEqual(right.scopes);
      expect([left.changed, right.changed].sort()).toEqual([false, true]);
      expect(await first.getAccessEpoch()).toBe(1);
      expect(await second.getAccessEpoch()).toBe(1);
      expect(await second.listScopeGrants()).toEqual([
        {
          scopeNodeId: left.scopes['project:shared'],
          scopeRefId: left.scopes['principal:shared'],
          role: 'edit',
          canSuggest: undefined,
        },
      ]);

      const withRole = (role: 'append' | 'owner') => ({
        scopes: [
          { address: 'principal:shared', name: 'Shared principal' },
          {
            address: 'project:shared',
            name: 'Shared project',
            grants: [{ scopeRefAddress: 'principal:shared', role }],
          },
        ],
      });
      const [appendResult, ownerResult] = await Promise.all([
        first.reconcileStructure(withRole('append')),
        second.reconcileStructure(withRole('owner')),
      ]);
      const finalRole = appendResult.accessEpoch > ownerResult.accessEpoch ? 'append' : 'owner';
      expect([appendResult.accessEpoch, ownerResult.accessEpoch].sort()).toEqual([2, 3]);
      expect(await first.getAccessEpoch()).toBe(3);
      expect(await first.listScopeGrants()).toEqual([
        {
          scopeNodeId: left.scopes['project:shared'],
          scopeRefId: left.scopes['principal:shared'],
          role: finalRole,
          canSuggest: undefined,
        },
      ]);
    } finally {
      firstClient.close();
      secondClient.close();
      await rm(path, { force: true });
    }
  });
});

describe('KnowledgeLibSQL semantic outbox claims', () => {
  it('claims disjoint visible scopes without scanning or claiming a hidden backlog', async () => {
    const path = join(tmpdir(), `mastra-knowledge-outbox-scopes-${randomUUID()}.db`);
    const url = `file:${path}`;
    const firstClient = createClient({ url });
    const secondClient = createClient({ url });
    try {
      const first = new KnowledgeLibSQL({ client: firstClient, storageIsolationKey: url });
      const second = new KnowledgeLibSQL({ client: secondClient, storageIsolationKey: url });
      await first.init();
      await second.init();
      const firstScopeId = randomUUID();
      const secondScopeId = randomUUID();
      await first.createNode({ id: firstScopeId, name: 'First claim scope', isScope: true, scopeIds: [] });
      await first.createNode({ id: secondScopeId, name: 'Second claim scope', isScope: true, scopeIds: [] });
      for (let index = 0; index < 150; index++) {
        await first.createNode({ name: `Second hidden subject ${index}`, scopeIds: [secondScopeId] });
      }
      const firstSubject = await first.createNode({ name: 'First visible subject', scopeIds: [firstScopeId] });

      const [firstClaim, secondClaim] = await Promise.all([
        first.claimSemanticOutbox({ workerId: 'first-scope-worker', scopeIds: [firstScopeId], limit: 1 }),
        second.claimSemanticOutbox({ workerId: 'second-scope-worker', scopeIds: [secondScopeId], limit: 1 }),
      ]);

      expect(firstClaim).toHaveLength(1);
      expect(firstClaim[0]?.documentId).toContain(firstSubject.id);
      expect(secondClaim).toHaveLength(1);
      expect(secondClaim[0]?.scopeIds).toEqual([secondScopeId]);
    } finally {
      firstClient.close();
      secondClient.close();
      await rm(path, { force: true });
    }
  });

  it('claims each entry through only one client', async () => {
    const path = join(tmpdir(), `mastra-knowledge-outbox-${randomUUID()}.db`);
    const url = `file:${path}`;
    const firstClient = createClient({ url });
    const secondClient = createClient({ url });
    try {
      const first = new KnowledgeLibSQL({ client: firstClient, storageIsolationKey: url });
      const second = new KnowledgeLibSQL({ client: secondClient, storageIsolationKey: url });
      await first.init();
      await second.init();
      const scopeId = randomUUID();
      await first.createNode({ id: scopeId, name: 'Claim scope', isScope: true, scopeIds: [] });
      await first.createNode({ name: 'Claim subject', scopeIds: [scopeId] });

      const now = new Date();
      const [firstClaim, secondClaim] = await Promise.all([
        first.claimSemanticOutbox({ workerId: 'worker-1', now }),
        second.claimSemanticOutbox({ workerId: 'worker-2', now }),
      ]);
      const claimedIds = [...firstClaim, ...secondClaim].map(entry => entry.id);
      expect(claimedIds.length).toBeGreaterThan(0);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      expect([firstClaim.length, secondClaim.length].filter(count => count > 0)).toHaveLength(1);
    } finally {
      firstClient.close();
      secondClient.close();
      await rm(path, { force: true });
    }
  });
});

describe('KnowledgeLibSQL importer run claims', () => {
  it('claims a binding through one client and fences heartbeats and finalization by worker', async () => {
    const path = join(tmpdir(), `mastra-knowledge-import-claim-${randomUUID()}.db`);
    const url = `file:${path}`;
    const firstClient = createClient({ url });
    const secondClient = createClient({ url });
    try {
      const first = new KnowledgeLibSQL({ client: firstClient, storageIsolationKey: url });
      const second = new KnowledgeLibSQL({ client: secondClient, storageIsolationKey: url });
      await first.init();
      await second.init();
      const binding = knowledgeImporterBindingKey({ source: 'calendar:primary', scope: 'project:mastra' });
      await first.enqueueImportRun({
        id: 'run-1',
        importerId: 'calendar',
        binding,
        importKind: 'static',
        triggerKind: 'webhook',
        payloadKey: '__mastra_internal/import-payload/run-1',
        payload: '{"payload":{"event":"first"}}',
      });
      await first.enqueueImportRun({
        id: 'run-2',
        importerId: 'calendar',
        binding,
        importKind: 'static',
        triggerKind: 'webhook',
        payloadKey: '__mastra_internal/import-payload/run-2',
        payload: '{"payload":{"event":"second"}}',
      });

      const [firstClaim, secondClaim] = await Promise.all([
        first.claimImportRun({ importerId: 'calendar', binding, workerId: 'worker-1', leaseKey: 'lease/' }),
        second.claimImportRun({ importerId: 'calendar', binding, workerId: 'worker-2', leaseKey: 'lease/' }),
      ]);
      const claimed = firstClaim ?? secondClaim;
      const owner = firstClaim ? 'worker-1' : 'worker-2';
      const other = firstClaim ? 'worker-2' : 'worker-1';
      const ownerStore = firstClaim ? first : second;
      const otherStore = firstClaim ? second : first;
      expect(claimed).toMatchObject({ id: 'run-1', status: 'running' });
      expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
      await expect(
        otherStore.heartbeatImportRun({
          id: 'run-1',
          importerId: 'calendar',
          binding,
          workerId: other,
          leaseKey: 'lease/run-1',
        }),
      ).resolves.toBe(false);
      await expect(
        otherStore.finalizeImportRun({
          id: 'run-1',
          importerId: 'calendar',
          binding,
          workerId: other,
          leaseKey: 'lease/run-1',
          status: 'succeeded',
          state: [{ key: 'cursor', value: 'forged' }],
        }),
      ).resolves.toBeNull();
      await expect(
        ownerStore.finalizeImportRun({
          id: 'run-1',
          importerId: 'calendar',
          binding,
          workerId: owner,
          leaseKey: 'lease/run-1',
          status: 'succeeded',
          state: [{ key: 'cursor', value: 'first' }],
        }),
      ).resolves.toMatchObject({ status: 'succeeded' });
      await expect(
        otherStore.claimImportRun({ importerId: 'calendar', binding, workerId: other, leaseKey: 'lease/' }),
      ).resolves.toMatchObject({ id: 'run-2', status: 'running' });
      await expect(first.getImportState({ importerId: 'calendar', binding, key: 'cursor' })).resolves.toMatchObject({
        value: 'first',
      });
    } finally {
      firstClient.close();
      secondClient.close();
      await rm(path, { force: true });
    }
  });

  it('atomically skips overlapping cron enqueue across clients', async () => {
    const path = join(tmpdir(), `mastra-knowledge-import-cron-${randomUUID()}.db`);
    const url = `file:${path}`;
    const firstClient = createClient({ url });
    const secondClient = createClient({ url });
    try {
      const first = new KnowledgeLibSQL({ client: firstClient, storageIsolationKey: url });
      const second = new KnowledgeLibSQL({ client: secondClient, storageIsolationKey: url });
      await first.init();
      await second.init();
      const binding = knowledgeImporterBindingKey({ source: 'calendar:primary', scope: 'project:mastra' });
      const enqueue = (store: KnowledgeLibSQL, id: string) =>
        store.enqueueImportRun({
          id,
          importerId: 'calendar',
          binding,
          importKind: 'static',
          triggerKind: 'cron',
          payloadKey: `__mastra_internal/import-payload/${id}`,
          payload: '{}',
          skipIfActiveCron: true,
        });

      const runs = await Promise.all([enqueue(first, 'cron-1'), enqueue(second, 'cron-2')]);
      expect(runs.map(run => run.status).sort()).toEqual(['queued', 'skipped']);
    } finally {
      firstClient.close();
      secondClient.close();
      await rm(path, { force: true });
    }
  });
});

describe('KnowledgeLibSQL storage isolation', () => {
  it('identifies domains configured for the same URL as one physical backend', () => {
    expect(new KnowledgeLibSQL({ url: 'file:shared.db' }).getStorageIsolationKey()).toBe(
      new KnowledgeLibSQL({ url: 'file:./shared.db' }).getStorageIsolationKey(),
    );
    expect(getLibSQLKnowledgeIsolationKey({ url: 'file:///tmp/shared.db' })).toBe(
      getLibSQLKnowledgeIsolationKey({ url: 'file://localhost/tmp/shared.db' }),
    );
    expect(getLibSQLKnowledgeIsolationKey({ url: 'libsql://EXAMPLE.com/db?mode=ro' })).toBe(
      getLibSQLKnowledgeIsolationKey({ url: 'libsql://example.com:443/db' }),
    );
    expect(new KnowledgeLibSQL({ url: 'file:first.db' }).getStorageIsolationKey()).not.toBe(
      new KnowledgeLibSQL({ url: 'file:second.db' }).getStorageIsolationKey(),
    );

    const firstClient = createClient({ url: 'file:first-client.db' });
    const secondClient = createClient({ url: 'file:second-client.db' });
    try {
      expect(getLibSQLKnowledgeIsolationKey({ client: firstClient })).toBe(
        getLibSQLKnowledgeIsolationKey({ client: secondClient }),
      );
      expect(getLibSQLKnowledgeIsolationKey({ client: firstClient, storageIsolationKey: 'first' })).not.toBe(
        getLibSQLKnowledgeIsolationKey({ client: secondClient, storageIsolationKey: 'second' }),
      );
    } finally {
      firstClient.close();
      secondClient.close();
    }
  });
});
