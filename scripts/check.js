import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
for (const directory of ["server", "public", "scripts", "desktop", "test"]) {
  for (const file of await readdir(directory))
    if (/\.(?:js|cjs)$/.test(file)) {
      const result = spawnSync(
        process.execPath,
        ["--check", `${directory}/${file}`],
        { encoding: "utf8" },
      );
      if (result.status) {
        console.error(result.stderr);
        process.exitCode = 1;
      }
    }
}
if (!process.exitCode) console.log("JavaScript syntax checks passed.");
