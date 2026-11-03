// Constrain the provider's output shape; local validation still verifies actual quotes.
export function worksheetSchema(segments, settings) {
  const string = (maxLength, minLength = 1) => ({
    type: "string",
    minLength,
    maxLength,
  });
  const object = (properties) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  const array = (items, maxItems, minItems = 0) => ({
    type: "array",
    items,
    minItems,
    maxItems,
  });
  const evidence = array(
    object({
      sourceId: { type: "string", enum: segments.map((s) => s.id) },
      quote: string(1000, 4),
    }),
    8,
    1,
  );
  const question = object({
    prompt: string(4000),
    answer: string(4000),
    choices: array(string(500), 6),
    evidence,
  });
  return {
    ...object({
      title: string(180),
      introduction: string(800, 0),
      sections: array(
        object({
          kind: {
            type: "string",
            enum: settings.sections.length ? settings.sections : ["watch"],
          },
          items: array({ $ref: "#/$defs/question" }, 150, 1),
        }),
        settings.sections.length ? 40 : 0,
      ),
      flashcards: array(
        object({ front: string(800), back: string(1800), evidence }),
        settings.flashcards ? 150 : 0,
      ),
      quiz: array({ $ref: "#/$defs/question" }, settings.quiz ? 150 : 0),
    }),
    $defs: { question },
  };
}
