import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources so tests don't need a build.
    conditions: ['source'],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
