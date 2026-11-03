import { mkdir, writeFile } from "node:fs/promises";
import { renderPDF } from "../server/pdf.js";
import { options, validateWorksheet } from "../server/worksheet.js";
import { parseScript, sourceSegments } from "../server/source.js";
const source = [
  "A bridge spans a gap and supports a load. In our experiment the gap is the space between two books, and the load is a collection of coins.",
  "First, lay a flat sheet of paper across two books. Add coins one at a time. Record how many coins it holds before the paper bends into the gap.",
  "Next, fold a sheet of the same paper into an accordion shape. Place it across the same gap and add the same kind of coins one at a time. Record the result.",
  "Keep the distance between the books, the paper size, and the coin type the same. Change only the shape of the paper. This makes the comparison fair.",
  "Our folded paper supported more coins than our flat paper. The folds changed the structure without adding more paper. Shape can change how a material supports a load.",
  "A test is more useful when we repeat it. Repeat each design three times. Compare the results and ask which design worked most consistently.",
];
const transcript = parseScript(source.join("\n\n"));
const ev = (n) => [{ sourceId: `s${n}`, quote: source[n - 1] }];
const item = (prompt, answer, n) => ({
  prompt,
  answer,
  evidence: ev(n),
  choices: [],
});
const settings = options({
  sections: [
    "blanks",
    "watch",
    "reflection",
    "activity",
    "vocabulary",
    "sketch",
  ],
  flashcards: true,
  quiz: true,
});
const value = {
  title: "Paper bridges: the power of a fold",
  introduction:
    "Watch how a simple sheet of paper becomes a bridge. Listen for the changes that make a fair test. Pause when you need time to write.",
  sections: [
    {
      kind: "blanks",
      items: [
        item("A bridge spans a ___ and supports a load.", "gap", 1),
        item(
          "Change only the ___ of the paper to make the comparison fair.",
          "shape",
          4,
        ),
      ],
    },
    {
      kind: "watch",
      items: [
        item(
          "What are the two bridge designs being compared?",
          "A flat sheet and a sheet folded into an accordion shape.",
          3,
        ),
        item(
          "Name two things that should stay the same during the comparison.",
          "The distance between the books, paper size, or coin type.",
          4,
        ),
        item(
          "Why do the builders repeat the test three times?",
          "To compare results and see which design works most consistently.",
          6,
        ),
      ],
    },
    {
      kind: "reflection",
      items: [
        item(
          "What surprised you about changing the shape of the paper? Use one observation to explain your thinking.",
          "Example: A fold changed the structure and helped the same amount of paper hold more coins.",
          5,
        ),
        item(
          "What would you change in a second bridge design? What would you keep the same to compare it fairly?",
          "Responses vary. Change one design feature and keep the gap, paper size, and coin type constant.",
          4,
        ),
      ],
    },
    {
      kind: "activity",
      items: [
        item(
          "Suggested extension: design your own paper bridge.\n\nGoal: Find a paper shape that spans a gap and supports a small load.\nMaterials: two books, two equal sheets of paper, and several identical coins. Ask an adult before testing, and keep coins away from younger children.\n\n1. Set the books a short distance apart.\n2. Test a flat paper bridge. Add one coin at a time.\n3. Fold a second sheet into a shape of your choice. Keep the gap the same.\n4. Repeat each test three times and record the coin counts.\n\nMy design held ______, ______, and ______ coins.\nWhat feature would I improve next, and why?",
          "Example: Draw the bridge, record three trials for each design, and explain one change to test next.",
          6,
        ),
      ],
    },
    {
      kind: "vocabulary",
      items: [
        item(
          "In your own words, what does load mean in this experiment?",
          "The coins the bridge supports.",
          1,
        ),
      ],
    },
    {
      kind: "sketch",
      items: [
        item(
          "Draw your bridge from the side. Label the gap, the load, and the folded paper. Explain how your sketch connects to the test.",
          "Sketches vary. Look for labels that match the source experiment.",
          1,
        ),
      ],
    },
  ],
  flashcards: [
    {
      front: "What is a load in the bridge test?",
      back: "The collection of coins supported by the paper bridge.",
      evidence: ev(1),
    },
    {
      front: "What makes this a fair comparison?",
      back: "Change the paper shape while keeping the book gap, paper size, and coin type the same.",
      evidence: ev(4),
    },
    {
      front: "Why repeat each design three times?",
      back: "To compare repeated results and find which design works most consistently.",
      evidence: ev(6),
    },
  ],
  quiz: [
    {
      ...item("Which variable changes in the comparison?", "Paper shape", 4),
      choices: ["Paper shape", "Coin type", "Distance between books"],
    },
    item(
      "Explain one reason to repeat a test.",
      "Repeating helps compare results and notice consistency.",
      6,
    ),
  ],
};
const worksheet = validateWorksheet(
  value,
  sourceSegments(transcript),
  settings,
);
const lesson = { title: value.title, transcript, settings, worksheet };
await mkdir("output/pdf", { recursive: true });
await mkdir("tmp/pdfs", { recursive: true });
for (const kind of ["guided", "key", "cards", "quiz", "quiz-key"]) {
  const file = `${kind === "guided" ? "output/pdf" : "tmp/pdfs"}/sample-paper-bridge-${kind}.pdf`;
  await writeFile(file, await renderPDF({ lesson, kind }));
  console.log(file);
}
await writeFile("tmp/pdfs/sample-lesson.json", JSON.stringify(lesson));
