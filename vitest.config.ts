import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources so tests don't need a build.
  resolve: { conditions: ['@staticforge/source'] },
  ssr: { resolve: { conditions: ['@staticforge/source'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/providers/*/test/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
