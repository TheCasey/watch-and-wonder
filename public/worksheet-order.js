// Use the same source order for the app, student sheets, and teacher keys.
const normalize = (text) =>
  String(text || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
export function orderBySource(items, transcript, itemOf = (item) => item) {
  const segments = transcript?.segments || [];
  const timed =
    segments.length > 0 && segments.every((s) => Number.isFinite(s.endMs));
  const sources = new Map(
    segments.map((segment, index) => [`s${index + 1}`, { ...segment, index }]),
  );
  const position = (item) => {
    const references = (item.evidence || []).map((e) => {
      const source = sources.get(e.sourceId);
      if (!source) return [Infinity, Infinity, Infinity];
      const quote = normalize(e.quote),
        offset = normalize(source.text).indexOf(quote);
      return [
        timed ? source.endMs : source.index,
        source.index,
        offset < 0 ? Infinity : offset + quote.length,
      ];
    });
    // A question belongs where the video has covered ALL information needed to answer it.
    return references.sort(compare).at(-1) || [Infinity, Infinity, Infinity];
  };
  return items
    .map((entry, index) => ({
      entry,
      index,
      position: position(itemOf(entry)),
    }))
    .sort((a, b) => compare(a.position, b.position) || a.index - b.index)
    .map(({ entry }) => entry);
}
function compare(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}
export function worksheetFlow(worksheet, transcript) {
  const after = new Set(["reflection", "activity"]);
  const during = worksheet.sections
    .filter((s) => !after.has(s.kind))
    .flatMap((s) => s.items.map((item) => ({ kind: s.kind, item })));
  const groups = during.length
    ? [
        {
          kind: "during",
          items: orderBySource(during, transcript, (entry) => entry.item),
        },
      ]
    : [];
  for (const kind of ["reflection", "activity"]) {
    const items = worksheet.sections
      .filter((s) => s.kind === kind)
      .flatMap((s) => s.items.map((item) => ({ kind, item })));
    if (items.length) groups.push({ kind, items });
  }
  return groups;
}
