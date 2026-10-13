import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { DSH_CPAMC_LANG: 'zh' },
    testTimeout: 30_000,
  },
})
