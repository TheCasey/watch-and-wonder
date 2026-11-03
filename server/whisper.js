import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { access, stat, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { runProcess } from "./process.js";
import { parseWhisperJSON } from "./transcript.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const safeError = (message) =>
  Object.assign(new Error(message), { userMessage: message });

export function createWhisper({
  cli = process.env.WHISPER_CLI || "whisper-cli",
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  modelPath = process.env.WHISPER_MODEL_PATH || "models/ggml-base.en.bin",
  language = process.env.WHISPER_LANGUAGE || "en",
  threads = Number(
    process.env.WHISPER_THREADS || Math.min(os.availableParallelism(), 8),
  ),
  run = runProcess,
  tempRoot = os.tmpdir(),
} = {}) {
  modelPath = path.resolve(root, modelPath);
  if (!Number.isInteger(threads) || threads < 1 || threads > 128)
    throw new Error("WHISPER_THREADS must be an integer from 1 to 128.");
  if (!/^[a-z]{2,3}$/.test(language) && language !== "auto")
    throw new Error(
      "WHISPER_LANGUAGE must be a language code such as en or auto.",
    );
  const check = async () => {
    const issues = [];
    const results = await Promise.allSettled([
      run(ffmpeg, ["-version"], { timeoutMs: 8_000 }),
      run(cli, ["--help"], { timeoutMs: 8_000 }),
      (async () => {
        await access(modelPath, constants.R_OK);
        if (!(await stat(modelPath)).isFile())
          throw new Error("Model is not a file.");
      })(),
    ]);
    if (results[0].status === "rejected")
      issues.push(
        "FFmpeg is unavailable. Install ffmpeg or set FFMPEG_PATH in .env.",
      );
    if (results[1].status === "rejected")
      issues.push(
        "whisper-cli is unavailable. Install whisper.cpp or set WHISPER_CLI in .env.",
      );
    if (results[2].status === "rejected")
      issues.push(
        "Whisper model missing. Run npm run setup:local or set WHISPER_MODEL_PATH in .env.",
      );
    return {
      ready: issues.length === 0,
      provider: "whisper.cpp",
      model: path.basename(modelPath),
      issues,
    };
  };
  let cached,
    checkedAt = 0;
  return {
    async health() {
      if (!cached || Date.now() - checkedAt > 10_000) {
        cached = await check();
        checkedAt = Date.now();
      }
      return cached;
    },
    async transcribe(file) {
      const health = await check();
      if (!health.ready) throw safeError(health.issues.join(" "));
      const temporary = await mkdtemp(path.join(tempRoot, "wonder-whisper-"));
      const wav = path.join(temporary, "audio.wav");
      const transcript = path.join(temporary, "transcript");
      try {
        try {
          await run(
            ffmpeg,
            [
              "-nostdin",
              "-hide_banner",
              "-loglevel",
              "error",
              "-y",
              "-protocol_whitelist",
              "file,pipe",
              "-i",
              path.resolve(file),
              "-vn",
              "-ac",
              "1",
              "-ar",
              "16000",
              "-c:a",
              "pcm_s16le",
              wav,
            ],
            { timeoutMs: 10 * 60_000 },
          );
        } catch (error) {
          throw safeError(
            error.code === "PROCESS_TIMEOUT"
              ? "Audio conversion timed out. Retry the job."
              : "FFmpeg could not convert the recording. Check the saved source media and available disk space.",
          );
        }
        try {
          // Keep native segment timestamps enabled; -nt would disable their inference.
          await run(
            cli,
            [
              "-m",
              modelPath,
              "-f",
              wav,
              "-l",
              language,
              "-t",
              String(threads),
              "-oj",
              "-of",
              transcript,
            ],
            { timeoutMs: 2 * 60 * 60_000 },
          );
        } catch (error) {
          throw safeError(
            error.code === "PROCESS_TIMEOUT"
              ? "Local Whisper exceeded two hours. Try a smaller model or retry."
              : "Local Whisper failed. Verify the model file and available memory, then retry.",
          );
        }
        let result;
        try {
          result = JSON.parse(await readFile(`${transcript}.json`, "utf8"));
        } catch {
          throw safeError(
            "Whisper did not produce readable JSON. Verify your whisper-cli and model, then retry.",
          );
        }
        try {
          return parseWhisperJSON(result);
        } catch (error) {
          throw safeError(error.message);
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  };
}
