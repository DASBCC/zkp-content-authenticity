/** Configura pruebas de navegador contra una infraestructura EVM local exclusiva de E2E. */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e", timeout: 120_000, fullyParallel: false, workers: 1,
  use: { baseURL: "http://127.0.0.1:5174", browserName: "chromium", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: "list",
  webServer: { command: "node scripts/e2e-stack.mjs", url: "http://127.0.0.1:5174/api/config", reuseExistingServer: false, timeout: 60_000 },
});
