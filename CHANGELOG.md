# Changelog

## 0.1.1 - 2026-11-03

- Require source references in the model output schema and restrict IDs to the current source part.
- Fix repeated detailed-generation failures when a model omits source evidence.
- Generate detailed lessons in smaller ordered batches while retaining the selected density and full source coverage.
- Automatically request up to two corrected drafts for invalid model output, with precise validation feedback. Keep exact-quote checks in place.
- Discard invalid cached parts so retry can regenerate them. Stop immediately for account, quota, and network failures.
- Preserve the saved transcript, completed parts, and previous worksheet if correction attempts cannot complete.

## 0.1.0 - 2026-11-03

- Initial local app: video/script import, Whisper transcription, guided notes, separate study tools, source evidence, PDF export, and versioned edits.
