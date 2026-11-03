import { mkdir, stat, rename, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../server/process.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const model = process.argv[2] || "base.en";
if (
  !["tiny.en", "base.en", "small.en", "tiny", "base", "small"].includes(model)
)
  throw new Error("Choose tiny.en, base.en, small.en, tiny, base, or small.");
const filename = `ggml-${model}.bin`;
const directory = path.join(root, "models");
const destination = path.join(directory, filename);
await mkdir(directory, { recursive: true });

// The distributor publishes the LFS SHA-256 and byte length for each model.
const metadata = await fetch(
  "https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main?recursive=false",
  { signal: AbortSignal.timeout(30_000) },
);
if (!metadata.ok)
  throw new Error(
    "Could not retrieve the official Whisper model manifest. Try again later.",
  );
const entry = (await metadata.json()).find((item) => item.path === filename);
if (!entry?.lfs?.oid || !/^[a-f0-9]{64}$/.test(entry.lfs.oid))
  throw new Error("The model manifest is missing a SHA-256 checksum.");
async function hash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
const valid = await stat(destination)
  .then(
    async (info) =>
      info.size === entry.size && (await hash(destination)) === entry.lfs.oid,
  )
  .catch(() => false);
if (!valid) {
  const temporary = `${destination}.${randomUUID()}.part`;
  console.log(
    `Downloading ${filename} (${Math.round(entry.size / 1_000_000)} MB). This is a one-time local model download.`,
  );
  try {
    const response = await fetch(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename}`,
      { signal: AbortSignal.timeout(20 * 60_000) },
    );
    if (!response.ok || !response.body)
      throw new Error(`Whisper model download failed (${response.status}).`);
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (
      (await stat(temporary)).size !== entry.size ||
      (await hash(temporary)) !== entry.lfs.oid
    )
      throw new Error(
        "Downloaded model checksum did not match. Run setup again.",
      );
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
console.log(`Verified model: ${destination}`);
for (const [binary, args] of [
  [process.env.WHISPER_CLI || "whisper-cli", ["--help"]],
  [process.env.FFMPEG_PATH || "ffmpeg", ["-version"]],
]) {
  try {
    await runProcess(binary, args, { timeoutMs: 10_000 });
    console.log(`${binary}: ready`);
  } catch {
    process.exitCode = 1;
    console.error(
      `${binary}: missing. Install whisper.cpp and ffmpeg (macOS: brew install whisper.cpp ffmpeg), or set their paths in .env.`,
    );
  }
}
if (model !== "base.en")
  console.log(
    `Set WHISPER_MODEL_PATH=models/${filename} in .env to use this model.`,
  );
console.log(
  "No transcription API key or API billing is needed. Continue with ChatGPT in the app for worksheet generation.",
);
