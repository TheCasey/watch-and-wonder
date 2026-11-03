# Changelog

## 0.1.4 - 2026-11-03

- Interleave all while-you-watch question types in video order in the app, guided-notes PDFs, and matching teacher keys.
- Place questions after all referenced information has been covered; use paragraph order for untimed scripts. Keep reflections and application activities afterward.
- Use continuous question numbers and a single optional word bank. Existing lessons use the new ordering without regeneration.
- Order separate practice-quiz questions by the same source chronology.

## 0.1.3 - 2026-11-03

- Widen fill-in-the-blank writing spaces in the app preview and PDF exports, with extra room for longer answers. Existing lessons use the new spacing without regeneration.

## 0.1.2 - 2026-11-03

- Remove timestamp prefixes from printed worksheet questions. Source timings remain available in the app and teacher answer-key references.

## 0.1.1 - 2026-11-03

- Require source references in the model output schema and restrict IDs to the current source part.
- Fix repeated detailed-generation failures when a model omits source evidence.
- Generate detailed lessons in smaller ordered batches while retaining the selected density and full source coverage.
- Automatically request up to two corrected drafts for invalid model output, with precise validation feedback. Keep exact-quote checks in place.
- Discard invalid cached parts so retry can regenerate them. Stop immediately for account, quota, and network failures.
- Preserve the saved transcript, completed parts, and previous worksheet if correction attempts cannot complete.

## 0.1.0 - 2026-11-03

- Initial local app: video/script import, Whisper transcription, guided notes, separate study tools, source evidence, PDF export, and versioned edits.
