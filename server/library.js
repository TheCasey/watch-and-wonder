import path from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "./storage.js";
import {
  fail,
  parseScript,
  sourceSegments,
  validateVideoURL,
} from "./source.js";
import { options, generateWorksheet, validateWorksheet } from "./worksheet.js";

export async function createLibrary({ dataDir, whisper, downloader, chatgpt }) {
  const root = path.join(dataDir, "lessons");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lessons = new Map(),
    pending = new Set();
  let running = false,
    closing = false;
  const validID = (id) => {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
      throw fail("Lesson not found.");
    return id;
  };
  const directory = (id) => path.join(root, validID(id));
  const save = (lesson) =>
    writeJSON(path.join(directory(lesson.id), "lesson.json"), lesson);
  for (const id of await readdir(root)) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    const lesson = await readJSON(path.join(root, id, "lesson.json"));
    if (["importing", "generating", "queued"].includes(lesson.status)) {
      lesson.status = "failed";
      lesson.error =
        "Processing was interrupted. Retry to resume from saved progress.";
      await save(lesson);
    }
    lessons.set(id, lesson);
  }
  function get(id) {
    const lesson = lessons.get(validID(id));
    if (!lesson) throw fail("Lesson not found.");
    return lesson;
  }
  function idle(lesson) {
    if (["importing", "generating", "queued"].includes(lesson.status))
      throw fail("Let this lesson finish processing first.");
  }
  const update = async (lesson, changes) => {
    Object.assign(lesson, changes, { updatedAt: new Date().toISOString() });
    await save(lesson);
  };
  async function processQueue() {
    if (running || closing) return;
    running = true;
    try {
      while (pending.size && !closing) {
        const id = pending.values().next().value;
        pending.delete(id);
        const lesson = get(id);
        try {
          if (!lesson.transcript) {
            await update(lesson, {
              status: "importing",
              stage: "Downloading video audio",
              error: null,
            });
            let downloaded;
            try {
              downloaded = await downloader.download(lesson.url, directory(id));
              if (lesson.title === "Untitled video lesson")
                lesson.title = downloaded.title;
              lesson.duration = downloaded.duration;
              await update(lesson, {
                stage: "Transcribing with local Whisper",
              });
              lesson.transcript = await whisper.transcribe(downloaded.file);
              await update(lesson, {
                status: "ready",
                stage: "Transcript ready to review",
              });
            } finally {
              if (downloaded?.file) await rm(downloaded.file, { force: true });
            }
          }
          if (lesson.intent === "generate") {
            await update(lesson, {
              status: "generating",
              stage: "Preparing worksheet",
              error: null,
            });
            const cacheFile = path.join(directory(id), "generation-cache.json");
            const cache = await readJSON(cacheFile, {});
            const worksheet = await generateWorksheet({
              title: lesson.title,
              transcript: lesson.transcript,
              settings: lesson.settings,
              generate: (request) => chatgpt.generate(request),
              cached: cache,
              checkpoint: async (key, output) => {
                cache[key] = output;
                await writeJSON(cacheFile, cache);
              },
              progress: (stage) => update(lesson, { stage }),
            });
            const version = randomUUID();
            await writeJSON(
              path.join(directory(id), `worksheet-${version}.json`),
              {
                worksheet,
                settings: lesson.settings,
                transcript: lesson.transcript,
              },
            );
            lesson.worksheet = worksheet;
            lesson.worksheetSettings = structuredClone(lesson.settings);
            lesson.worksheetTranscript = structuredClone(lesson.transcript);
            lesson.version = version;
            lesson.versions ??= [];
            lesson.versions.push({
              id: version,
              createdAt: worksheet.generatedAt,
            });
            await update(lesson, {
              status: "done",
              stage: "Ready to print",
              intent: null,
              error: null,
            });
          }
        } catch (error) {
          await update(lesson, {
            status: "failed",
            error:
              error.userMessage ||
              "Processing failed. Your saved transcript and previous worksheet are safe. Check setup and retry.",
            stage: "Needs attention",
          });
        }
      }
    } finally {
      running = false;
    }
  }
  function enqueue(lesson) {
    pending.add(lesson.id);
    setImmediate(() => processQueue().catch(() => {}));
  }
  return {
    get,
    list: () =>
      [...lessons.values()]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(
          ({
            transcript,
            worksheet,
            worksheetTranscript,
            worksheetSettings,
            ...lesson
          }) => ({
            ...lesson,
            hasTranscript: Boolean(transcript),
            hasWorksheet: Boolean(worksheet),
          }),
        ),
    async create(value) {
      if (!value || typeof value !== "object")
        throw fail("Enter a link or transcript.");
      const type = value.type === "script" ? "script" : "url";
      const lesson = {
        id: randomUUID(),
        title:
          typeof value.title === "string" && value.title.trim()
            ? value.title.trim().slice(0, 180)
            : type === "script"
              ? "Untitled script lesson"
              : "Untitled video lesson",
        type,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        settings: options(value.settings),
        versions: [],
        intent: null,
      };
      if (type === "script") {
        lesson.transcript = parseScript(value.text);
        lesson.status = "ready";
        lesson.stage = "Transcript ready to review";
      } else {
        lesson.url = validateVideoURL(value.url);
        lesson.status = "queued";
        lesson.stage = "Waiting to import";
      }
      await save(lesson);
      lessons.set(lesson.id, lesson);
      if (type === "url") enqueue(lesson);
      return lesson;
    },
    async generate(id, settings) {
      const lesson = get(id);
      idle(lesson);
      if (!lesson.transcript)
        throw fail("Import or retry the video before creating a worksheet.");
      await update(lesson, {
        settings: options(settings),
        intent: "generate",
        status: "queued",
        stage: "Waiting to generate",
        error: null,
      });
      enqueue(lesson);
      return lesson;
    },
    async retry(id) {
      const lesson = get(id);
      idle(lesson);
      if (lesson.status !== "failed")
        throw fail("This lesson does not need a retry.");
      await update(lesson, {
        status: "queued",
        error: null,
        stage: "Waiting to resume",
      });
      enqueue(lesson);
      return lesson;
    },
    async editTranscript(id, text) {
      const lesson = get(id);
      idle(lesson);
      const transcript = parseScript(text);
      await update(lesson, {
        transcript,
        status: "ready",
        stage: "Transcript updated; generate to apply changes",
        error: null,
        intent: null,
      });
      return lesson;
    },
    async rename(id, title) {
      const lesson = get(id);
      idle(lesson);
      if (typeof title !== "string" || !title.trim())
        throw fail("Enter a lesson title.");
      await update(lesson, { title: title.trim().slice(0, 180) });
      return lesson;
    },
    async editWorksheet(id, value) {
      const lesson = get(id);
      idle(lesson);
      if (!lesson.worksheet) throw fail("Generate a worksheet first.");
      const worksheet = {
        ...validateWorksheet(
          value,
          sourceSegments(lesson.worksheetTranscript || lesson.transcript),
          lesson.worksheetSettings || lesson.settings,
        ),
        generatedAt: new Date().toISOString(),
        sourceParts: lesson.worksheet.sourceParts,
        reviewed: true,
      };
      const version = randomUUID();
      await writeJSON(path.join(directory(id), `worksheet-${version}.json`), {
        worksheet,
        settings: lesson.worksheetSettings || lesson.settings,
        transcript: lesson.worksheetTranscript || lesson.transcript,
      });
      lesson.versions.push({
        id: version,
        createdAt: worksheet.generatedAt,
        edited: true,
      });
      await update(lesson, { worksheet, version });
      return lesson;
    },
    async version(id, version) {
      const lesson = get(id);
      if (!lesson.versions.some((v) => v.id === version))
        throw fail("Worksheet version not found.");
      return readJSON(path.join(directory(id), `worksheet-${version}.json`));
    },
    async restore(id, version) {
      const lesson = get(id);
      idle(lesson);
      if (!lesson.versions.some((v) => v.id === version))
        throw fail("Worksheet version not found.");
      const saved = await readJSON(
        path.join(directory(id), `worksheet-${version}.json`),
      );
      const worksheet = saved.worksheet || saved;
      const settings =
        saved.settings || lesson.worksheetSettings || lesson.settings;
      const transcript =
        saved.transcript || lesson.worksheetTranscript || lesson.transcript;
      const restoredVersion = randomUUID();
      await writeJSON(
        path.join(directory(id), `worksheet-${restoredVersion}.json`),
        { worksheet, settings, transcript },
      );
      lesson.versions.push({
        id: restoredVersion,
        createdAt: new Date().toISOString(),
        restored: true,
      });
      await update(lesson, {
        worksheet,
        worksheetSettings: settings,
        worksheetTranscript: transcript,
        version: restoredVersion,
        status: "done",
        stage: "Saved worksheet restored",
        error: null,
      });
      return lesson;
    },
    async remove(id) {
      const lesson = get(id);
      idle(lesson);
      await rm(directory(id), { recursive: true });
      lessons.delete(id);
    },
    busy: () => running || pending.size > 0,
    async close() {
      closing = true;
    },
  };
}
