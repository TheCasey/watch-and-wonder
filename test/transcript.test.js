import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWhisperJSON,
  timestamp,
  transcriptText,
  subtitlesText,
} from "../server/transcript.js";

test("native timestamps produce readable segments and correctly formatted subtitles", () => {
  const result = parseWhisperJSON({
    result: { language: "en" },
    transcription: [
      {
        offsets: { from: 1500, to: 4200 },
        text: " First sentence. Another sentence.",
      },
      { offsets: { from: 4200, to: 9200 }, text: " Next topic." },
    ],
  });
  assert.equal(result.text, "First sentence. Another sentence. Next topic.");
  assert.match(
    transcriptText(result),
    /^\[00:00:01 --> 00:00:04\]\nFirst sentence\. Another sentence\.\n\n\[00:00:04/,
  );
  assert.match(
    subtitlesText(result.segments),
    /^1\n00:00:01,500 --> 00:00:04,200\n/,
  );
  assert.equal(timestamp(3_661_125), "01:01:01");
  assert.equal(timestamp(3_661_125, { subtitle: true }), "01:01:01,125");
});

test("missing/invalid timestamps fail instead of fabricating alignment", () => {
  for (const offsets of [
    {},
    { from: -1, to: 1 },
    { from: 500, to: 100 },
    { from: NaN, to: Infinity },
  ]) {
    assert.throws(
      () => parseWhisperJSON({ transcription: [{ offsets, text: "Speech" }] }),
      /invalid segment timestamps/,
    );
  }
  assert.throws(() => parseWhisperJSON({ transcription: [] }), /No speech/);
  assert.equal(
    transcriptText({ text: "Legacy transcript" }),
    "Legacy transcript\n",
  );
});
