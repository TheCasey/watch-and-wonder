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
