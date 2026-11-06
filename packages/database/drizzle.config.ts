import { defineConfig } from 'drizzle-kit';

// Generates table DDL only. Roles, grants and RLS live in reviewed custom SQL migrations.
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/schema.ts',
    './src/schema-work.ts',
    './src/schema-integrations.ts',
    './src/schema-knowledge.ts',
    './src/schema-artifact-provenance.ts',
    './src/schema-client-access.ts',
  ],
  out: './migrations',
  casing: 'snake_case',
});
