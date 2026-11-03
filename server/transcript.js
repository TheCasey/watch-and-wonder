export function timestamp(milliseconds, { subtitle = false } = {}) {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor(value / 60_000) % 60;
  const seconds = Math.floor(value / 1_000) % 60;
  const base = [hours, minutes, seconds]
    .map((number) => String(number).padStart(2, "0"))
    .join(":");
  return subtitle ? `${base},${String(value % 1000).padStart(3, "0")}` : base;
}

export function parseWhisperJSON(value) {
  if (!value || !Array.isArray(value.transcription))
    throw new Error(
      "Whisper JSON did not contain timed transcription segments.",
    );
  const segments = value.transcription
    .map((segment) => ({
      startMs: segment.offsets?.from,
      endMs: segment.offsets?.to,
      text:
        typeof segment.text === "string"
          ? segment.text.trim().replace(/\s+/g, " ")
          : "",
    }))
    .filter((segment) => segment.text);
  if (!segments.length)
    throw new Error(
      "No speech was transcribed. Check that the class tab was playing audio.",
    );
  let previousStart = -1;
  for (const segment of segments) {
    if (
      !Number.isFinite(segment.startMs) ||
      !Number.isFinite(segment.endMs) ||
      segment.startMs < 0 ||
      segment.endMs < segment.startMs ||
      segment.startMs < previousStart
    ) {
      throw new Error(
        "Whisper returned invalid segment timestamps. Retry the local transcription.",
      );
    }
    previousStart = segment.startMs;
  }
  return {
    text: segments.map((segment) => segment.text).join(" "),
    language: value.result?.language || null,
    segments,
  };
}

export function transcriptText({ text, segments }) {
  // Legacy providers may return plain text without timings. Never invent timestamps.
  if (!segments?.length) return text.trim() + "\n";
  return (
    segments
      .map(
        (segment) =>
          `[${timestamp(segment.startMs)} --> ${timestamp(segment.endMs)}]\n${segment.text}`,
      )
      .join("\n\n") + "\n"
  );
}

export function subtitlesText(segments) {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${timestamp(segment.startMs, { subtitle: true })} --> ${timestamp(segment.endMs, { subtitle: true })}\n${segment.text}\n`,
    )
    .join("\n");
}
