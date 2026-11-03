import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { runProcess } from "./process.js";

export const SOURCE_LIMIT = 900_000;
export const fail = (message) =>
  Object.assign(new Error(message), { userMessage: message });
export function validateVideoURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("Paste a complete YouTube or PBS video URL.");
  }
  const host = url.hostname.toLowerCase();
  const supported =
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "pbs.org" ||
    host.endsWith(".pbs.org") ||
    host === "pbslearningmedia.org" ||
    host.endsWith(".pbslearningmedia.org");
  if (
    !supported ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  )
    throw fail(
      "Use an HTTPS video link from YouTube, PBS, or PBS LearningMedia.",
    );
  if (
    url.searchParams.has("list") &&
    !url.searchParams.has("v") &&
    !host.includes("pbs")
  )
    throw fail("Paste an individual video, rather than a playlist.");
  url.hash = "";
  return url.toString();
}
export function parseScript(text) {
  if (typeof text !== "string" || !text.trim())
    throw fail("Paste a transcript or script first.");
  if (text.length > SOURCE_LIMIT)
    throw fail(
      "This script exceeds 900,000 characters. Split it into separate lessons.",
    );
  text = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  // Recognize real SRT/VTT cues. Plain scripts never receive invented timings.
  const cue =
    /(?:^|\n)(?:(\d+)\n)?(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(?:(\d{2,}):)?(\d{2}):(\d{2})[,.](\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  const timed = [...text.matchAll(cue)]
    .map((m) => ({
      startMs: ((+m[2] || 0) * 3600 + +m[3] * 60 + +m[4]) * 1000 + +m[5],
      endMs: ((+m[6] || 0) * 3600 + +m[7] * 60 + +m[8]) * 1000 + +m[9],
      text: m[10]
        .replace(/<[^>]*>/g, "")
        .replace(/\n/g, " ")
        .trim(),
    }))
    .filter((s) => s.text);
  if (timed.length) {
    const residue = text
      .replace(cue, "")
      .replace(/^WEBVTT[^\n]*(?:\n|$)/, "")
      .replace(/(?:^|\n)NOTE[^\n]*(?:\n(?!\s*\n)[^\n]*)*/g, "")
      .replace(/^(?:Kind|Language):[^\n]*$/gm, "")
      .trim();
    if (residue)
      throw fail(
        "This input mixes subtitle cues with untimed text. Use a complete SRT/VTT file, or remove the cue lines and paste it as a plain script.",
      );
    if (
      timed.some(
        (s, i) =>
          s.endMs < s.startMs || (i > 0 && s.startMs < timed[i - 1].startMs),
      )
    )
      throw fail(
        "Subtitle timings are out of order or invalid. Check the transcript.",
      );
    return { text: timed.map((s) => s.text).join("\n"), segments: timed };
  }
  const parts = text
    .split(/\n\s*\n/)
    .flatMap((p) => p.match(/[\s\S]{1,1600}(?:\s|$)|[\s\S]{1,1600}/g) || [])
    .map((s) => s.trim())
    .filter(Boolean);
  return { text, segments: parts.map((text) => ({ text })) };
}
export function sourceSegments(transcript) {
  return transcript.segments.map((segment, i) => ({
    ...segment,
    id: `s${i + 1}`,
  }));
}
export function createDownloader({
  executable = process.env.YT_DLP_PATH || "yt-dlp",
  run = runProcess,
} = {}) {
  return {
    async health() {
      try {
        await run(executable, ["--version"], { timeoutMs: 8000 });
        return { ready: true };
      } catch {
        return {
          ready: false,
          issues: [
            "Install yt-dlp to import video links. Pasted transcripts work without it.",
          ],
        };
      }
    },
    async download(url, directory) {
      url = validateVideoURL(url);
      for (const name of await readdir(directory))
        if (/^media\./.test(name))
          await rm(path.join(directory, name), { force: true });
      const output = path.join(directory, "media.%(ext)s");
      try {
        await run(
          executable,
          [
            "--ignore-config",
            "--no-playlist",
            "--no-progress",
            "--no-warnings",
            "--no-cache-dir",
            "--no-write-playlist-metafiles",
            "--max-downloads",
            "1",
            "--socket-timeout",
            "30",
            "--retries",
            "2",
            "--max-filesize",
            "2G",
            "--match-filters",
            "duration <= 14400 & !is_live",
            "-f",
            "bestaudio/best",
            "--write-info-json",
            "--no-write-thumbnail",
            "--no-write-subs",
            "-o",
            output,
            "--",
            url,
          ],
          { timeoutMs: 45 * 60_000 },
        );
      } catch (error) {
        // yt-dlp exits 101 after a successful single download when --max-downloads is reached.
        if (error.code !== "PROCESS_FAILED" || error.exitCode !== 101)
          throw fail(
            "The video could not be downloaded. Update yt-dlp and check that this individual video is publicly available. PBS access, region restrictions, DRM, or YouTube bot checks can block import. You can paste a transcript instead.",
          );
      }
      const files = await readdir(directory);
      const file = files.find(
        (name) => /^media\./.test(name) && !/\.(json|part|ytdl)$/.test(name),
      );
      if (!file)
        throw fail(
          "No downloadable audio was found. Paste a transcript instead.",
        );
      let metadata = {};
      try {
        metadata = JSON.parse(
          await readFile(path.join(directory, "media.info.json"), "utf8"),
        );
      } catch {
        /* Metadata is optional. */
      }
      await rm(path.join(directory, "media.info.json"), { force: true });
      return {
        file: path.join(directory, file),
        title:
          typeof metadata.title === "string"
            ? metadata.title.slice(0, 180)
            : "Video lesson",
        duration: metadata.duration || null,
      };
    },
  };
}
