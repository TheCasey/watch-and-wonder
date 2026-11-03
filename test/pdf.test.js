import test from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { renderPDF } from "../server/pdf.js";
const item = {
  prompt: "Explain the design choice.",
  answer: "ANSWER_ONLY_MARKER",
  choices: [],
  evidence: [
    { sourceId: "s1", quote: "EVIDENCE_ONLY_MARKER explains the design." },
  ],
};
const lesson = {
  title: "Print separation check",
  settings: {
    paper: "LETTER",
    lines: "standard",
    level: "middle",
    wordBank: false,
  },
  transcript: {
    segments: [
      {
        text: "EVIDENCE_ONLY_MARKER explains the design.",
        startMs: 1000,
        endMs: 3000,
      },
    ],
  },
  worksheet: {
    title: "Print separation check",
    introduction: "Watch and notice.",
    sections: [{ kind: "watch", items: [item] }],
    flashcards: [
      {
        front: "A short question",
        back: "A clear answer",
        evidence: item.evidence,
      },
    ],
    quiz: [item],
  },
};
async function textOf(pdf) {
  const task = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
  const doc = await task.promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((x) => x.str).join(" ");
  }
  await task.destroy();
  return text;
}
test("student PDFs never include answers or evidence quotes; keys include both", async () => {
  for (const kind of ["guided", "quiz"]) {
    const text = await textOf(await renderPDF({ lesson, kind }));
    assert.doesNotMatch(text, /ANSWER_ONLY_MARKER|EVIDENCE_ONLY_MARKER/);
    assert.match(text, /Explain the design choice/);
  }
  for (const kind of ["key", "quiz-key"]) {
    const text = await textOf(await renderPDF({ lesson, kind }));
    assert.match(text, /ANSWER_ONLY_MARKER/);
    assert.match(text, /EVIDENCE_ONLY_MARKER/);
  }
});
test("long cards fit inside page margins without dropping their final text", async () => {
  const long = structuredClone(lesson);
  long.worksheet.flashcards = [
    {
      front: "Why? ".repeat(100) + "FRONT_END",
      back: "Because this is a detailed answer. ".repeat(45) + "BACK_END",
      evidence: item.evidence,
    },
  ];
  const text = await textOf(await renderPDF({ lesson: long, kind: "cards" }));
  assert.match(text, /FRONT_END/);
  assert.match(text, /BACK_END/);
});

test("guided notes and answer keys share interleaved chronology, numbering, and one word bank", async () => {
  const mixed = structuredClone(lesson);
  mixed.settings.wordBank = true;
  mixed.transcript.segments = [
    { text: "First fact.", startMs: 0, endMs: 1000 },
    { text: "Middle fact.", startMs: 2000, endMs: 3000 },
    { text: "Last fact.", startMs: 4000, endMs: 5000 },
  ];
  const question = (prompt, sourceId, quote) => ({
    ...structuredClone(item),
    prompt,
    evidence: [{ sourceId, quote }],
  });
  mixed.worksheet.sections = [
    {
      kind: "blanks",
      items: [question("MIDDLE_BLANK ___", "s2", "Middle fact.")],
    },
    {
      kind: "reflection",
      items: [question("REFLECTION_AFTERWARD", "s1", "First fact.")],
    },
    {
      kind: "watch",
      items: [
        question("LATE_QUESTION", "s3", "Last fact."),
        question("EARLY_QUESTION", "s1", "First fact."),
      ],
    },
  ];
  for (const kind of ["guided", "key"]) {
    const text = await textOf(await renderPDF({ lesson: mixed, kind }));
    const labels = [
      "1. EARLY_QUESTION",
      "2. MIDDLE_BLANK",
      "3. LATE_QUESTION",
      "4. REFLECTION_AFTERWARD",
    ];
    for (const label of labels) assert.ok(text.includes(label), label);
    assert.ok(
      labels.every(
        (label, i) =>
          i === 0 || text.indexOf(labels[i - 1]) < text.indexOf(label),
      ),
    );
    assert.equal(
      (text.match(/Word bank:/g) || []).length,
      kind === "guided" ? 1 : 0,
    );
    if (kind === "guided") {
      assert.doesNotMatch(text, /\d{2}:\d{2}:\d{2}/);
      assert.match(text, /MIDDLE_BLANK _{28,}/);
    }
  }
});
