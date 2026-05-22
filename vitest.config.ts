import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'scripts/**/*.test.ts'],
    env: {
      // Disable auth bypass in tests even when .env has PLAYGROUND_AUTH_BYPASS=1.
      PLAYGROUND_AUTH_BYPASS: '0',
    },
  },
});
