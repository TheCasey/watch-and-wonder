import test from "node:test";
import assert from "node:assert/strict";
import { worksheetFlow, orderBySource } from "../public/worksheet-order.js";
const item = (prompt, refs) => ({
  prompt,
  answer: "example",
  choices: [],
  evidence: refs.map(([sourceId, quote]) => ({ sourceId, quote })),
});
const transcript = {
  segments: [
    { text: "First fact. Second fact.", startMs: 0, endMs: 5000 },
    { text: "Middle fact.", startMs: 10000, endMs: 15000 },
    { text: "Later fact.", startMs: 20000, endMs: 25000 },
    { text: "Final fact.", startMs: 30000, endMs: 35000 },
  ],
};
test("watching questions interleave across types; multi-source questions wait until all required content is covered", () => {
  const worksheet = {
    sections: [
      { kind: "blanks", items: [item("late blank", [["s3", "Later fact."]])] },
      {
        kind: "reflection",
        items: [item("reflect afterward", [["s1", "First fact."]])],
      },
      {
        kind: "watch",
        items: [
          item("early question", [["s1", "First fact."]]),
          item("whole-video question", [
            ["s1", "First fact."],
            ["s4", "Final fact."],
          ]),
        ],
      },
      {
        kind: "activity",
        items: [item("try afterward", [["s2", "Middle fact."]])],
      },
      {
        kind: "vocabulary",
        items: [item("middle word", [["s2", "Middle fact."]])],
      },
      {
        kind: "sketch",
        items: [item("early sketch", [["s1", "Second fact."]])],
      },
    ],
  };
  const before = JSON.stringify(worksheet);
  const flow = worksheetFlow(worksheet, transcript);
  assert.deepEqual(
    flow.map((g) => g.kind),
    ["during", "reflection", "activity"],
  );
  assert.deepEqual(
    flow[0].items.map((x) => x.item.prompt),
    [
      "early question",
      "early sketch",
      "middle word",
      "late blank",
      "whole-video question",
    ],
  );
  assert.deepEqual(
    flow[0].items.map((x) => x.kind),
    ["watch", "sketch", "vocabulary", "blanks", "watch"],
  );
  assert.equal(JSON.stringify(worksheet), before);
});
test("plain scripts use paragraph and quote order, with stable ties", () => {
  const source = {
    segments: transcript.segments.map(({ text }) => ({ text })),
  };
  const items = [
    item("later", [["s3", "Later fact."]]),
    item("second", [["s1", "Second fact."]]),
    item("first A", [["s1", "First fact."]]),
    item("first B", [["s1", "First fact."]]),
  ];
  assert.deepEqual(
    orderBySource(items, source).map((x) => x.prompt),
    ["first A", "first B", "second", "later"],
  );
});
test("sorting uses the time when the answer is available, rather than the earliest reference", () => {
  const items = [
    item("spans early and late", [
      ["s1", "First fact."],
      ["s4", "Final fact."],
    ]),
    item("middle", [["s2", "Middle fact."]]),
  ];
  assert.deepEqual(
    orderBySource(items, transcript).map((x) => x.prompt),
    ["middle", "spans early and late"],
  );
  const afterOnly = worksheetFlow(
    {
      sections: [
        { kind: "activity", items: [items[0]] },
        { kind: "reflection", items: [items[1]] },
      ],
    },
    transcript,
  );
  assert.deepEqual(
    afterOnly.map((g) => g.kind),
    ["reflection", "activity"],
  );
});
