import { spawn } from "node:child_process";

const activeProcesses = new Set();
function terminate(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}
export function stopProcesses() {
  for (const child of activeProcesses) terminate(child, "SIGKILL");
}

// No shell: filenames, paths with spaces, and class names cannot become commands.
// Keep only bounded log tails; the transcript is written to a private temp file.
export function runProcess(
  executable,
  args,
  { timeoutMs = 120_000, maxLogBytes = 32_768 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    activeProcesses.add(child);
    let stdout = "",
      stderr = "",
      expired = false,
      forceKill;
    const tail = (old, data) =>
      (old + data.toString("utf8")).slice(-maxLogBytes);
    child.stdout.on("data", (chunk) => {
      stdout = tail(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(stderr, chunk);
    });
    const timer = setTimeout(() => {
      expired = true;
      terminate(child, "SIGTERM");
      forceKill = setTimeout(() => terminate(child, "SIGKILL"), 5_000);
      forceKill.unref();
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => {
      activeProcesses.delete(child);
      clearTimeout(timer);
      clearTimeout(forceKill);
      reject(error);
    });
    child.on("close", (code, signal) => {
      activeProcesses.delete(child);
      clearTimeout(timer);
      clearTimeout(forceKill);
      if (expired)
        return reject(
          Object.assign(new Error("Local process timed out."), {
            code: "PROCESS_TIMEOUT",
          }),
        );
      if (code !== 0)
        return reject(
          Object.assign(new Error("Local process failed."), {
            code: "PROCESS_FAILED",
            exitCode: code,
            signal,
            stderr,
          }),
        );
      resolve({ stdout, stderr });
    });
  });
}
