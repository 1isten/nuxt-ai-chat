/// <reference types="node" />
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './server/db/schema.ts',
  out: './server/db/migrations/sqlite',
  dbCredentials: {
    url: 'file:' + (process.env.DB_PATH || process.env.NUXT_DB_PATH || './.data/ai.db'),
  },
  casing: 'snake_case',
});
