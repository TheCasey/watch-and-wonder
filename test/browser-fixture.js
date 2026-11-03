// Isolated UI fixture. No remote auth or generation; never used by the production launcher.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startService } from "../server/app.js";
import { fakeGeneration } from "./fixtures.js";
const dataDir = await mkdtemp(path.join(os.tmpdir(), "wonder-browser-test-"));
const service = await startService({
  port: 3221,
  dataDir,
  chatgpt: {
    status: async () => ({
      connected: true,
      eligible: true,
      accounts: [],
      model: "fixture",
      models: [{ slug: "fixture", displayName: "Isolated test model" }],
      issues: [],
    }),
    generate: async (request) => fakeGeneration(request),
    close() {},
  },
  downloader: {
    health: async () => ({ ready: true }),
    download: async () => {
      throw Object.assign(new Error(), {
        userMessage: "Test fixture does not download media.",
      });
    },
  },
});
console.log(`Isolated browser fixture at ${service.url}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
