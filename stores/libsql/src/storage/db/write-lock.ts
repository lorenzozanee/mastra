import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqliteClient } from './client';

/**
 * Per-client write serialization.
 *
 * `@libsql/client` backs a local (`file:`/`:memory:`) database with a single
 * underlying connection. An interactive `client.transaction('write')` issues a
 * `BEGIN` and then yields to the event loop on every `await tx.execute(...)`.
 * Any autocommit write (`client.execute`/`client.batch`) issued on the same
 * client during that window runs on the same connection — so it is swept into
 * the still-open transaction and is committed or rolled back with it, instead
 * of as its own statement. Two concurrent interactive transactions collide the
 * same way ("cannot start a transaction within a transaction").
 *
 * This is dormant under the default engine but the evented engine runs many
 * concurrent workflow snapshot writes per agent run, so a write issued by an
 * unrelated domain (e.g. creating a dataset experiment) can silently vanish.
 *
 * Serializing every write on a given client closes that window: writes — both
 * autocommit statements and full interactive transactions — run one at a time,
 * so none can interleave with an open transaction. Reads are intentionally not
 * gated for file-backed WAL connections. In-memory Knowledge reads use
 * withClientReadLock because they must share the writer's retained connection.
 */
const clientWriteChains = new WeakMap<SqliteClient, Promise<unknown>>();
const activeWrite = new AsyncLocalStorage<{ client: SqliteClient; active: boolean }>();

// Private in-memory reads share the writer's connection, unlike file-backed WAL reads.
export function withClientReadLock<T>(client: SqliteClient, fn: () => Promise<T>): Promise<T> {
  const current = activeWrite.getStore();
  return current?.active && current.client === client ? fn() : withClientWriteLock(client, fn);
}

/**
 * Runs `fn` after every previously-enqueued write on `client` has settled, and
 * returns its result. The chain advances regardless of whether `fn` resolves or
 * rejects, so one failed write never wedges the queue.
 */
export function withClientWriteLock<T>(client: SqliteClient, fn: () => Promise<T>): Promise<T> {
  const previous = clientWriteChains.get(client) ?? Promise.resolve();
  const run = () => {
    const context = { client, active: true };
    return activeWrite.run(context, async () => {
      try {
        return await fn();
      } finally {
        context.active = false;
      }
    });
  };
  const result = previous.then(run, run);
  // Tail that never rejects so a failed write doesn't poison the chain.
  clientWriteChains.set(
    client,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
