import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
      'scripts/**/src/**/*.test.ts'
    ],
    environment: 'node',
    coverage: {
      enabled: false
    }
  }
});
