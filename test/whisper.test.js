import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWhisper } from "../server/whisper.js";
import { runProcess } from "../server/process.js";

async function fixture(
  t,
  { failAt, text = "Photosynthesis converts light into chemical energy." } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "whisper-test-"));
  const modelPath = path.join(root, "model with spaces.bin");
  await writeFile(modelPath, "model");
  const file = path.join(root, "recording $(invalid).webm");
  await writeFile(file, "audio");
  const tempRoot = path.join(root, "work");
  await mkdir(tempRoot);
  const calls = [];
  const run = async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === "--help" || args[0] === "-version") return {};
    if (executable === failAt)
      throw Object.assign(new Error("secret native process body"), {
        stderr: "private data",
      });
    if (executable === "ffmpeg") await writeFile(args.at(-1), "wav");
    else
      await writeFile(
        args[args.indexOf("-of") + 1] + ".json",
        JSON.stringify({
          result: { language: "en" },
          transcription: [{ offsets: { from: 0, to: 5200 }, text }],
        }),
      );
    return {};
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    modelPath,
    file,
    tempRoot,
    calls,
    whisper: createWhisper({
      cli: "whisper-cli",
      ffmpeg: "ffmpeg",
      modelPath,
      tempRoot,
      run,
      threads: 4,
      language: "en",
    }),
  };
}

test("converts WebM to 16kHz mono PCM, runs local Whisper with separate arguments and cleans temporary data", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.whisper.health()).ready, true);
  const transcript = await f.whisper.transcribe(f.file);
  assert.match(transcript.text, /Photosynthesis/);
  assert.deepEqual(
    transcript.segments.map(({ startMs, endMs }) => [startMs, endMs]),
    [[0, 5200]],
  );
  const conversion = f.calls.find((call) => call.args.includes("-i"));
  assert.equal(conversion.args[conversion.args.indexOf("-i") + 1], f.file);
  for (const [flag, expected] of [
    ["-ac", "1"],
    ["-ar", "16000"],
    ["-c:a", "pcm_s16le"],
  ])
    assert.equal(conversion.args[conversion.args.indexOf(flag) + 1], expected);
  const transcription = f.calls.find((call) => call.args.includes("-m"));
  assert.equal(transcription.args[1], f.modelPath);
  assert.ok(transcription.args.includes("-oj"));
  assert.ok(!transcription.args.includes("-nt"));
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test("conversion/Whisper failures retain actionable errors without exposing native output", async (t) => {
  for (const failAt of ["ffmpeg", "whisper-cli"]) {
    const f = await fixture(t, { failAt });
    await assert.rejects(f.whisper.transcribe(f.file), (error) => {
      assert.ok(error.userMessage);
      assert.doesNotMatch(error.message, /secret|private/);
      return true;
    });
    assert.deepEqual(await readdir(f.tempRoot), []);
  }
});

test("missing model is reported by health before conversion and empty transcripts fail safely", async (t) => {
  const f = await fixture(t, { text: "   " });
  await assert.rejects(f.whisper.transcribe(f.file), /No speech/);
  await rm(f.modelPath);
  assert.match((await f.whisper.health()).issues.join(" "), /model missing/);
  await assert.rejects(f.whisper.transcribe(f.file), /setup:local/);
});

test("subprocesses never invoke a shell and timeouts terminate the child", async () => {
  const argument = "$(echo should-not-execute); still a single argument";
  const result = await runProcess(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    argument,
  ]);
  assert.equal(result.stdout, argument);
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 30,
    }),
    { code: "PROCESS_TIMEOUT" },
  );
});
