import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../db/schema';

export type AppSchema = typeof schema;
export type AppDb = LibSQLDatabase<AppSchema>;

export interface CreateDbOptions {
  /** Absolute path to the SQLite file. Pass ':memory:' for an in-memory db. */
  path: string;
  /** Run drizzle migrations on first use. Defaults to true. */
  runMigrations?: boolean;
  /** Override the migrations folder (defaults to <pkg>/server/db/migrations/sqlite). */
  migrationsFolder?: string;
}

export interface DbHandle {
  db: AppDb;
  schema: AppSchema;
  client: Client;
  close: () => Promise<void>;
}

// Resolve the migrations folder. Strategies in order:
//  1) MIGRATIONS_DIR env var (recommended for packaged apps).
//  2) Relative to this file's URL — works for the standalone Electron-side
//     server where this module is loaded from disk.
//  3) Fall back to <cwd>/server/db/migrations/sqlite — needed in Nuxt dev,
//     where Nitro bundles this module into `.nuxt/dev/index.mjs` and the
//     `import.meta.url` strategy points at the wrong directory.
function defaultMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const fromUrl = path.resolve(
    fileURLToPath(new URL('../db/migrations/sqlite', import.meta.url)),
  );
  if (fs.existsSync(path.join(fromUrl, 'meta', '_journal.json'))) return fromUrl;
  return path.resolve(process.cwd(), 'server/db/migrations/sqlite');
}

/** Create a Drizzle DB handle bound to a libsql/SQLite file. */
export async function createDb(options: CreateDbOptions): Promise<DbHandle> {
  if (options.path !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(options.path)), { recursive: true });
  }
  const url = options.path === ':memory:' ? ':memory:' : `file:${path.resolve(options.path)}`;
  const client = createClient({ url });
  const db = drizzle(client, { schema });

  if (options.runMigrations !== false) {
    await migrate(db, {
      migrationsFolder: options.migrationsFolder ?? defaultMigrationsDir(),
    });
  }

  return {
    db,
    schema,
    client,
    close: async () => { client.close(); },
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton used by the bundled Nuxt API routes.
// External h3 servers should call `setDb(handle)` (or `createDb` then `setDb`)
// before invoking any of the imported handlers.
// ---------------------------------------------------------------------------

let _handle: DbHandle | null = null;
let _initPromise: Promise<DbHandle> | null = null;

/** Inject a pre-built DB handle (used by the standalone Electron-side server). */
export function setDb(handle: DbHandle): void {
  _handle = handle;
}

/**
 * Lazily initialize from env on first call (used by Nuxt dev/build).
 *  - DB_PATH (preferred) or NUXT_DB_PATH env var.
 *  - Falls back to ./.data/ai.db relative to cwd.
 */
export async function getDb(): Promise<DbHandle> {
  if (_handle) return _handle;
  if (!_initPromise) {
    const dbPath = process.env.DB_PATH || process.env.NUXT_DB_PATH || path.join(process.cwd(), '.data', 'ai.db');
    _initPromise = createDb({ path: dbPath }).then((h) => {
      _handle = h;
      return h;
    });
  }
  return _initPromise;
}

/** Convenience accessors. Throw if `setDb` / `getDb` hasn't been called. */
export function db(): AppDb {
  if (!_handle) throw new Error('[db] not initialized. Call setDb() or await getDb() first.');
  return _handle.db;
}

export { schema };
