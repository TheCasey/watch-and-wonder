import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { LABELS } from "./worksheet.js";
import { sourceSegments } from "./source.js";
import { timestamp } from "./transcript.js";
import { worksheetFlow, orderBySource } from "../public/worksheet-order.js";
const font = (name) =>
  fileURLToPath(
    new URL(`../assets/fonts/NotoSans-${name}.ttf`, import.meta.url),
  );
export async function renderPDF({ lesson, kind = "guided" }) {
  const worksheet = lesson.worksheet;
  const key = ["key", "quiz-key"].includes(kind);
  const doc = new PDFDocument({
    size: lesson.settings.paper || "LETTER",
    margins: { top: 48, bottom: 55, left: 50, right: 50 },
    bufferPages: true,
    info: { Title: `${lesson.title} - ${kind}`, Author: "Watch & Wonder" },
  });
  const chunks = [];
  const complete = new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const left = 50,
    width = doc.page.width - 100,
    bottom = () => doc.page.height - 60;
  const lookup = new Map(
    sourceSegments(lesson.transcript).map((s) => [s.id, s]),
  );
  const fontSize = lesson.settings.level === "early" ? 12.5 : 10.5;
  doc.registerFont("Body", font("Regular")).registerFont("Bold", font("Bold"));
  const body = () => doc.font("Body").fontSize(fontSize).fillColor("#222d34");
  const ensure = (height) => {
    if (doc.y + height > bottom()) doc.addPage();
  };
  const paragraph = (text, size = fontSize, color = "#222d34") => {
    doc
      .font("Body")
      .fontSize(size)
      .fillColor(color)
      .text(text, left, doc.y, { width, lineGap: 3 });
    doc.moveDown(0.6);
  };
  const heading = (title) => {
    ensure(95);
    doc
      .moveDown(0.6)
      .font("Bold")
      .fontSize(14)
      .fillColor("#172e32")
      .text(title, left, doc.y, { width });
    doc.moveDown(0.7);
  };
  const reference = (item) => {
    return [
      ...new Set(
        item.evidence.map((e) => {
          const s = lookup.get(e.sourceId);
          return Number.isFinite(s?.startMs)
            ? timestamp(s.startMs)
            : `Paragraph ${e.sourceId.slice(1)}`;
        }),
      ),
    ].join(", ");
  };
  const answerLines = (count, sketch = false) => {
    const lineHeight = 23;
    if (sketch) {
      ensure(120);
      doc
        .lineWidth(0.7)
        .strokeColor("#bbc5c6")
        .rect(left, doc.y, width, 110)
        .stroke();
      doc.y += 122;
    }
    for (let i = 0; i < count; i++) {
      ensure(lineHeight + 2);
      doc
        .moveTo(left, doc.y + lineHeight - 5)
        .lineTo(left + width, doc.y + lineHeight - 5)
        .lineWidth(0.5)
        .strokeColor("#c6cece")
        .stroke();
      doc.y += lineHeight;
    }
    doc.y += 8;
  };
  const item = (entry, index, section) => {
    body();
    // Render placeholder tokens as handwriting space without changing saved prompts.
    const prompt =
      section === "blanks"
        ? entry.prompt.replace(
            /_{3,}/g,
            "_".repeat(
              Math.max(28, Math.min(56, [...entry.answer].length * 2)),
            ),
          )
        : entry.prompt;
    const label = `${index + 1}. ${prompt}`;
    const promptHeight = doc.heightOfString(label, { width, lineGap: 3 });
    const baseLines =
      { compact: 1, standard: 3, roomy: 5 }[lesson.settings.lines] || 3;
    const lines =
      section === "blanks"
        ? 0
        : section === "reflection"
          ? baseLines + 1
          : baseLines;
    const reserve = Math.min(
      540,
      promptHeight + (key ? 80 : section === "sketch" ? 150 : lines * 23 + 30),
    );
    ensure(reserve);
    paragraph(label);
    if (entry.choices?.length)
      entry.choices.forEach((choice, i) =>
        paragraph(`${String.fromCharCode(65 + i)}. ${choice}`, fontSize),
      );
    if (key) {
      paragraph(
        `${["reflection", "activity", "sketch"].includes(section) ? "Example / guidance" : "Answer"}: ${entry.answer}`,
        fontSize,
        "#235b53",
      );
      paragraph(`Source: ${reference(entry)}`, 8.5, "#626e72");
      for (const e of entry.evidence) paragraph(`"${e.quote}"`, 8, "#626e72");
    } else if (section !== "activity") answerLines(lines, section === "sketch");
    else answerLines(baseLines + 1);
    doc.moveDown(0.5);
  };
  try {
    doc
      .font("Bold")
      .fontSize(9)
      .fillColor("#3a625b")
      .text("WATCH & WONDER", left, 45, { characterSpacing: 1.6 });
    doc
      .moveDown(0.8)
      .fontSize(23)
      .fillColor("#162c30")
      .text(worksheet.title, left, doc.y, { width, lineGap: 2 });
    doc.moveDown(0.6);
    const subtitle = {
      guided: "GUIDED NOTES",
      key: "PARENT / TEACHER ANSWER KEY",
      cards: "CUT-OUT FLASHCARDS",
      quiz: "PRACTICE QUIZ",
      "quiz-key": "PRACTICE QUIZ ANSWER KEY",
    }[kind];
    paragraph(subtitle, 9, "#516462");
    if (!key && kind !== "cards") {
      paragraph(
        "Name: __________________________________    Date: __________________",
        10,
      );
    }
    if (lesson.url) paragraph(`Video: ${lesson.url}`, 8, "#626e72");
    if (key)
      paragraph(
        "Review these generated answers against the source. Reflection and activity answers are examples. Source quotes verify the referenced text, not every interpretation.",
        9,
        "#626e72",
      );
    else if (kind === "guided") paragraph(worksheet.introduction, 10);
    if (kind === "cards") {
      paragraph(
        "Cut along the borders. Fold each card between the question and answer.",
        9,
      );
      const gap = 14,
        cardWidth = (width - gap) / 2;
      let y = doc.y;
      for (let i = 0; i < worksheet.flashcards.length; i += 2) {
        const row = worksheet.flashcards.slice(i, i + 2);
        let cardSize = 10,
          heights,
          front,
          back,
          height;
        do {
          heights = row.map((card) => {
            doc.font("Bold").fontSize(cardSize);
            const front = doc.heightOfString(card.front, {
              width: cardWidth - 24,
              lineGap: 3,
            });
            doc.font("Body").fontSize(cardSize - 0.5);
            const back = doc.heightOfString(card.back, {
              width: cardWidth - 24,
              lineGap: 3,
            });
            return { front, back };
          });
          front = Math.max(...heights.map((h) => h.front)) + 38;
          back = Math.max(...heights.map((h) => h.back)) + 32;
          height = front + back;
          if (height <= bottom() - 48 || cardSize <= 7) break;
          cardSize -= 0.5;
        } while (true);
        if (height > bottom() - 48)
          throw new Error(
            "A flashcard is too long to print. Shorten it in Edit questions.",
          );
        if (y + height > bottom()) {
          doc.addPage();
          y = 48;
        }
        row.forEach((card, j) => {
          const x = left + j * (cardWidth + gap);
          doc
            .lineWidth(0.6)
            .strokeColor("#a9b9b5")
            .rect(x, y, cardWidth, height)
            .stroke();
          doc
            .dash(3, { space: 3 })
            .moveTo(x, y + front)
            .lineTo(x + cardWidth, y + front)
            .stroke()
            .undash();
          doc
            .font("Bold")
            .fontSize(8)
            .fillColor("#637d75")
            .text(`CARD ${i + j + 1}`, x + 12, y + 10, {
              width: cardWidth - 24,
            });
          doc
            .fontSize(cardSize)
            .fillColor("#222d34")
            .text(card.front, x + 12, y + 28, {
              width: cardWidth - 24,
              lineGap: 3,
            });
          doc
            .font("Body")
            .fontSize(cardSize - 0.5)
            .text(card.back, x + 12, y + front + 12, {
              width: cardWidth - 24,
              lineGap: 3,
            });
        });
        y += height + 16;
        doc.y = y;
      }
    } else if (kind === "quiz" || kind === "quiz-key") {
      heading("Check what you learned");
      orderBySource(worksheet.quiz, lesson.transcript).forEach((entry, index) =>
        item(entry, index, "quiz"),
      );
    } else {
      let questionIndex = 0;
      for (const group of worksheetFlow(worksheet, lesson.transcript)) {
        body();
        const firstHeight = doc.heightOfString(
          group.items[0]?.item.prompt || "",
          { width, lineGap: 3 },
        );
        ensure(Math.min(560, firstHeight + 180));
        heading(
          group.kind === "during" ? "While you watch" : LABELS[group.kind],
        );
        const blanks = group.items.filter((entry) => entry.kind === "blanks");
        if (blanks.length && lesson.settings.wordBank && !key) {
          const words = [
            ...new Set(blanks.map((entry) => entry.item.answer)),
          ].sort((a, b) => a.localeCompare(b));
          paragraph(`Word bank: ${words.join("  /  ")}`, 9, "#516462");
        }
        if (group.kind === "activity")
          paragraph(
            "Suggested extension - apply an idea from the video. Read the whole activity with an adult before starting.",
            9,
            "#516462",
          );
        for (const entry of group.items)
          item(entry.item, questionIndex++, entry.kind);
      }
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc
        .font("Body")
        .fontSize(8)
        .fillColor("#6c7777")
        .text(`Watch & Wonder  |  ${subtitle}`, left, doc.page.height - 36, {
          lineBreak: false,
          width: width - 65,
        });
      doc.text(
        `${i + 1} / ${range.count}`,
        left + width - 60,
        doc.page.height - 36,
        { lineBreak: false, width: 60, align: "right" },
      );
    }
    doc.end();
    return await complete;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}
