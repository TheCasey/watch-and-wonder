export function fakeGeneration({ input }) {
  const request = JSON.parse(input),
    source = request.source[0];
  const quote = source.text.slice(0, 120);
  const evidence = [{ sourceId: source.id, quote }];
  const item = (kind) => ({
    prompt:
      kind === "blanks"
        ? "The material in this example is ___."
        : kind === "activity"
          ? "Suggested extension: Build a paper bridge.\nMaterials: one sheet of paper and two books.\n1. Span the books with paper.\n2. Fold the paper and try again.\n3. Compare the shapes.\nAsk an adult before testing weights."
          : "What does this part of the source explain?",
    answer: kind === "blanks" ? quote.split(/\s+/)[0] : quote,
    choices: [],
    evidence,
  });
  return JSON.stringify({
    title: request.title || "A lesson",
    introduction: "Watch and notice.",
    sections: request.selectedSectionKinds.map((kind) => ({
      kind,
      items: [item(kind)],
    })),
    flashcards: request.flashcards
      ? [{ front: "What does this part explain?", back: quote, evidence }]
      : [],
    quiz: request.quiz
      ? [
          {
            ...item("watch"),
            choices: [quote, "An unrelated idea", "No information"],
            answer: quote,
          },
        ]
      : [],
  });
}
