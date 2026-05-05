import { getDb } from '../utils/db';

/**
 * Nitro startup hook that triggers DB lazy-init in dev/build mode.
 *
 * The synchronous `db()` accessor in `server/utils/db.ts` requires the
 * handle to already exist. In the standalone Electron-side server we call
 * `setDb()` explicitly; here, when Nuxt/Nitro starts, we kick off
 * `getDb()` so migrations run and the singleton is populated before any
 * request hits a handler.
 */
export default defineNitroPlugin(async () => {
  await getDb();
});
