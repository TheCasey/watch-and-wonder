import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  options,
  generateWorksheet,
  validateWorksheet,
  chunkSegments,
} from "../server/worksheet.js";
import {
  parseScript,
  sourceSegments,
  validateVideoURL,
  createDownloader,
} from "../server/source.js";

import { fakeGeneration } from "./fixtures.js";
test("scripts keep every character, timed subtitles keep real timings, and malformed timings fail", () => {
  const text = "abc 😊 edge".repeat(10000);
  const transcript = parseScript(text);
  assert.equal(transcript.text, text);
  assert.equal(
    transcript.segments
      .map((s) => s.text)
      .join("")
      .replace(/\s/g, ""),
    text.replace(/\s/g, ""),
  );
  assert.ok(transcript.segments.every((s) => s.startMs === undefined));
  const timed = parseScript(
    "WEBVTT\n\n00:01.200 --> 00:03.400\nA paper bridge.\n\n00:03.400 --> 00:06.000\nFold it again.",
  );
  assert.equal(timed.segments.length, 2);
  assert.equal(timed.segments[0].startMs, 1200);
  assert.equal(timed.segments[1].endMs, 6000);
  assert.throws(
    () => parseScript("00:04.000 --> 00:03.000\nBad timing"),
    /invalid/,
  );
  assert.throws(() => parseScript("x".repeat(900001)), /exceeds/);
});
test("only individual HTTPS YouTube and PBS links are accepted", () => {
  assert.equal(
    validateVideoURL("https://www.youtube.com/watch?v=hello"),
    "https://www.youtube.com/watch?v=hello",
  );
  assert.ok(validateVideoURL("https://video.pbs.org/video/hello/"));
  for (const url of [
    "http://youtube.com/watch?v=a",
    "https://youtube.com.evil.test/",
    "https://127.0.0.1/",
    "https://youtube.com:444/a",
    "https://user@youtube.com/a",
    "file:///etc/passwd",
    "https://www.youtube.com/playlist?list=abc",
  ])
    assert.throws(() => validateVideoURL(url));
});
test("unverifiable evidence, invented blank answers, and bad quiz choices cannot become a worksheet", () => {
  const transcript = parseScript("Paper folds make the bridge stronger.");
  const settings = options({ sections: ["blanks"], quiz: true });
  const request = {
    title: "Bridge",
    source: sourceSegments(transcript),
    selectedSectionKinds: ["blanks"],
    quiz: 1,
  };
  const value = JSON.parse(fakeGeneration({ input: JSON.stringify(request) }));
  assert.ok(validateWorksheet(value, sourceSegments(transcript), settings));
  const missing = structuredClone(value);
  missing.sections[0].items[0].evidence[0].quote = "Made up movie detail";
  assert.throws(
    () => validateWorksheet(missing, sourceSegments(transcript), settings),
    /not in the transcript/,
  );
  const answer = structuredClone(value);
  answer.sections[0].items[0].answer = "banana";
  assert.throws(
    () => validateWorksheet(answer, sourceSegments(transcript), settings),
    /could not be verified/,
  );
  const quiz = structuredClone(value);
  quiz.quiz[0].answer = "no such choice";
  assert.throws(
    () => validateWorksheet(quiz, sourceSegments(transcript), settings),
    /invalid answer choices/,
  );
});
test("long scripts cover every source segment in order and resume validated chunks after a failure", async () => {
  const transcript = {
    text: "",
    segments: Array.from({ length: 9 }, (_, i) => ({
      text: `Part ${i} explains a paper bridge and its folded supports. ${"Useful detail. ".repeat(10)}`,
    })),
  };
  const settings = options({
    sections: ["watch", "reflection", "activity"],
    flashcards: true,
    quiz: true,
  });
  const cache = {},
    seen = [];
  let call = 0;
  const generate = async (request) => {
    call++;
    if (call === 3) throw new Error("usage limit");
    const source = JSON.parse(request.input).source;
    seen.push(...source.map((s) => s.id));
    return fakeGeneration(request);
  };
  const args = {
    title: "Bridge",
    transcript,
    settings,
    generate,
    chunkLimit: 450,
    cached: cache,
    checkpoint: async (key, output) => {
      cache[key] = output;
    },
  };
  await assert.rejects(generateWorksheet(args), /usage limit/);
  assert.equal(Object.keys(cache).length, 2);
  const result = await generateWorksheet({
    ...args,
    generate: async (request) => {
      seen.push(...JSON.parse(request.input).source.map((s) => s.id));
      return fakeGeneration(request);
    },
  });
  assert.equal(new Set(seen).size, 9);
  assert.equal(
    result.sourceParts,
    chunkSegments(sourceSegments(transcript), 450).length,
  );
  assert.deepEqual(
    result.sections.map((s) => s.kind),
    settings.sections,
  );
  assert.equal(
    result.sections.find((s) => s.kind === "activity").items.length,
    1,
  );
  assert.ok(result.quiz.length && result.flashcards.length);
});
test("reflection-only lessons process every chunk and create only the selected final section", async () => {
  const transcript = parseScript(
    Array.from(
      { length: 12 },
      (_, i) => `Scene ${i}. A bridge uses folded paper to span a gap.`,
    ).join("\n\n"),
  );
  let calls = 0;
  const result = await generateWorksheet({
    title: "Reflection",
    transcript,
    settings: { sections: ["reflection"] },
    chunkLimit: 110,
    generate: async (request) => {
      calls++;
      return fakeGeneration(request);
    },
  });
  assert.equal(calls, result.sourceParts + 1);
  assert.deepEqual(
    result.sections.map((s) => s.kind),
    ["reflection"],
  );
});
test("downloader health and errors do not expose process logs", async () => {
  const downloader = createDownloader({
    run: async () => {
      throw new Error("private stdout");
    },
  });
  assert.equal((await downloader.health()).ready, false);
  await assert.rejects(
    downloader.download("https://youtu.be/example", "/tmp"),
    (error) =>
      !error.message.includes("private stdout") &&
      error.userMessage.includes("could not be downloaded"),
  );
});

test("yt-dlp completion exit 101 is accepted only when a completed media file exists", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wonder-ytdlp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const downloader = createDownloader({
    run: async () => {
      await writeFile(path.join(directory, "media.webm"), "completed audio");
      await writeFile(
        path.join(directory, "media.info.json"),
        JSON.stringify({ title: "A public clip", duration: 19 }),
      );
      throw Object.assign(new Error("download limit reached"), {
        code: "PROCESS_FAILED",
        exitCode: 101,
      });
    },
  });
  const result = await downloader.download(
    "https://youtu.be/example",
    directory,
  );
  assert.equal(result.title, "A public clip");
  assert.equal(result.file, path.join(directory, "media.webm"));
  const missing = createDownloader({
    run: async () => {
      throw Object.assign(new Error(), {
        code: "PROCESS_FAILED",
        exitCode: 101,
      });
    },
  });
  await assert.rejects(
    missing.download("https://youtu.be/example", directory),
    /No downloadable audio/,
  );
});

test("an incomplete final worksheet invalidates partial caches so retry can recover", async () => {
  const transcript = parseScript("Paper folds make a bridge stronger."),
    cache = {};
  const args = {
    title: "Bridge",
    transcript,
    settings: { sections: ["watch"] },
    cached: cache,
    checkpoint: async (key, value) => {
      cache[key] = value;
    },
  };
  await assert.rejects(
    generateWorksheet({
      ...args,
      generate: async () =>
        JSON.stringify({
          title: "Bridge",
          sections: [],
          quiz: [],
          flashcards: [],
        }),
    }),
    /missing/,
  );
  assert.ok(Object.values(cache).every((value) => value === null));
  let calls = 0;
  const result = await generateWorksheet({
    ...args,
    generate: async (request) => {
      calls++;
      return fakeGeneration(request);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.sections[0].kind, "watch");
});

test("missing evidence and invented quotes are corrected with precise feedback before saving a part", async () => {
  const transcript = parseScript("Paper folds make a bridge stronger.");
  const settings = { sections: ["watch"], flashcards: true, quiz: true };
  const requests = [],
    progress = [],
    saved = [];
  const result = await generateWorksheet({
    title: "Bridge",
    transcript,
    settings,
    progress: async (stage) => progress.push(stage),
    checkpoint: async (key, value) => saved.push(value),
    generate: async (request) => {
      const input = JSON.parse(request.input);
      requests.push(input);
      const value = JSON.parse(fakeGeneration(request));
      if (requests.length === 1) delete value.sections[0].items[0].evidence;
      if (requests.length === 2)
        value.flashcards[0].evidence[0].quote = "Not present in the source";
      return JSON.stringify(value);
    },
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].repair.invalidPath, "sections[0].items[0].evidence");
  assert.equal(requests[2].repair.invalidPath, "flashcards[0].evidence");
  assert.deepEqual(requests[1].source, requests[0].source);
  assert.equal(saved.length, 1);
  assert.equal(result.sections[0].items[0].evidence[0].quote, transcript.text);
  assert.equal(
    progress.filter((stage) => stage.includes("correcting source references"))
      .length,
    2,
  );
});

test("invalid drafts stop after two correction attempts; quota failures are never automatically retried", async () => {
  const transcript = parseScript("Paper folds make a bridge stronger.");
  let calls = 0,
    saves = 0;
  await assert.rejects(
    generateWorksheet({
      title: "Bridge",
      transcript,
      settings: { sections: ["watch"] },
      checkpoint: async () => {
        saves++;
      },
      generate: async (request) => {
        calls++;
        const value = JSON.parse(fakeGeneration(request));
        value.sections[0].items[0].evidence = [];
        return JSON.stringify(value);
      },
    }),
    (error) =>
      error.code === "INVALID_WORKSHEET" &&
      /two correction attempts/.test(error.userMessage),
  );
  assert.equal(calls, 3);
  assert.equal(saves, 0);
  calls = 0;
  await assert.rejects(
    generateWorksheet({
      title: "Bridge",
      transcript,
      settings: { sections: ["watch"] },
      generate: async () => {
        calls++;
        throw Object.assign(new Error("Plan limit reached"), {
          code: "subscription_sharing_usage_limit_exceeded",
        });
      },
    }),
    /Plan limit/,
  );
  assert.equal(calls, 1);
});

test("malformed JSON and null questions are repairable model-format errors", async () => {
  const transcript = parseScript("Paper folds make a bridge stronger.");
  let calls = 0;
  const result = await generateWorksheet({
    title: "Bridge",
    transcript,
    settings: { sections: ["watch"] },
    generate: async (request) => {
      calls++;
      if (calls === 1) return '{"sections":';
      const value = JSON.parse(fakeGeneration(request));
      if (calls === 2) value.sections[0].items[0] = null;
      return JSON.stringify(value);
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.sections[0].items.length, 1);
});

test("detailed generation uses smaller ordered batches without losing source coverage or density", async () => {
  const transcript = {
    segments: Array.from({ length: 18 }, (_, i) => ({
      text: `Scene ${i}: ${"paper folds bridge load ".repeat(45)}`,
    })),
  };
  const detailed = [],
    main = [];
  for (const [density, requests] of [
    ["detailed", detailed],
    ["main", main],
  ])
    await generateWorksheet({
      title: "Bridge",
      transcript,
      settings: { sections: ["watch"], density },
      generate: async (request) => {
        requests.push(JSON.parse(request.input));
        return fakeGeneration(request);
      },
    });
  assert.ok(detailed.length > main.length);
  assert.deepEqual(
    detailed.flatMap((r) => r.source.map((s) => s.id)),
    sourceSegments(transcript).map((s) => s.id),
  );
  assert.ok(
    detailed.every(
      (r) => r.source.reduce((n, s) => n + s.text.length, 0) <= 6000,
    ),
  );
  assert.ok(
    detailed.reduce((n, r) => n + r.targetDuringVideoQuestionsTotal, 0) >
      main.reduce((n, r) => n + r.targetDuringVideoQuestionsTotal, 0),
  );
});

test("an invalid cached part is discarded and regenerated instead of trapping retries", async () => {
  const transcript = parseScript("Paper folds make a bridge stronger."),
    cache = {};
  const args = {
    title: "Bridge",
    transcript,
    settings: { sections: ["watch"] },
    cached: cache,
    checkpoint: async (key, value) => {
      cache[key] = value;
    },
  };
  await generateWorksheet({
    ...args,
    generate: async (request) => fakeGeneration(request),
  });
  Object.values(cache)[0].sections[0].items[0].evidence = [];
  let calls = 0;
  const result = await generateWorksheet({
    ...args,
    generate: async (request) => {
      calls++;
      return fakeGeneration(request);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.sections[0].items[0].evidence.length, 1);
});

test("each generation request requires source evidence and restricts references to its own source part", async () => {
  const transcript = parseScript("Paper folds make a bridge stronger.");
  await generateWorksheet({
    title: "Bridge",
    transcript,
    settings: { sections: ["watch"] },
    generate: async (request) => {
      const source = JSON.parse(request.input).source,
        schema = request.schema;
      const evidence = schema.$defs.question.properties.evidence;
      assert.ok(schema.$defs.question.required.includes("evidence"));
      assert.equal(evidence.minItems, 1);
      assert.equal(evidence.maxItems, 8);
      assert.deepEqual(
        evidence.items.properties.sourceId.enum,
        source.map((s) => s.id),
      );
      assert.deepEqual(evidence.items.required, ["sourceId", "quote"]);
      assert.equal(schema.properties.flashcards.maxItems, 0);
      assert.equal(schema.properties.quiz.maxItems, 0);
      return fakeGeneration(request);
    },
  });
});
