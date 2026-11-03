import { startService } from "./app.js";
const service = await startService({
  dataDir: process.env.WATCH_WONDER_DATA_DIR,
});
console.log(`Watch & Wonder is ready at ${service.url}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await service.close();
    process.exit(0);
  });
