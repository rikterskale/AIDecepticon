import os from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const e2eDataDirectory = path.join(os.tmpdir(), `aidecepticon-e2e-${process.pid}`)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node server/index.js',
      url: 'http://127.0.0.1:8787/api/v1/health',
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        DATA_DIR: e2eDataDirectory,
        NODE_ENV: 'development',
        PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
        SENSOR_COMMAND_SIGNING_KEY: 'e2e-signing-key-with-at-least-32-random-bytes',
      },
    },
    {
      command: 'npm run dev:web -- --host 127.0.0.1',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
    },
  ],
})
