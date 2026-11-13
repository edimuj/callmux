import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/dashboard',
  timeout: 25_000,
  expect: { timeout: 8_000 },
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
})
