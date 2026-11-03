# Verification

Verified on November 3, 2026, on an Apple Silicon Mac.

## Automated checks

- `npm run check`: JavaScript syntax checks.
- `npm test`: 29 tests covering source/subtitle parsing, restricted video URLs, real process argument handling and timeouts, OAuth state/PKCE and signed identity validation, rotating refresh and revocation, plan-scope gating, terminal streaming events, exact source quotes, blank-answer verification, valid quiz choices, complete long-script chunk coverage, retry caching, incomplete-cache invalidation, import errors, version edits/restoration, local request authentication, and PDF export.
- PDF text extraction verifies student exports omit answer/evidence markers while teacher keys contain them. A long-card case checks that text is not dropped.
- `npm audit`: zero reported vulnerabilities with the checked-in lockfile and patched dev-tool overrides.

Remote authentication and generation are mocked in the automated suite; no plan usage is consumed by those tests.

## Live local checks

- whisper.cpp with the real English base model successfully transcribed a short speech recording and retained segment times.
- A real YouTube import of the 19-second public clip `https://www.youtube.com/watch?v=jNQXAC9IVRw` downloaded, converted, and transcribed locally into four segments. Whisper misheard several words, confirming that review and larger-model options matter.
- A real PBS import of the 30-second preview `https://www.pbs.org/video/episode-2-preview-kbrfwk/` downloaded, converted, and transcribed into two segments.
- yt-dlp's exit 101 after reaching `--max-downloads 1` is treated as success only when a completed media file exists; a dedicated regression test covers this.
- The signed, installed Mac app launched with its bundled model, discovered external tools, and persisted its separate local library/account.
- An actual ChatGPT plan connection generated learning material from an original paper-bridge sample script: all seven selected section kinds, two flashcards, and two practice-quiz questions. All five PDF variants exported successfully. The live check caught and fixed a transport requirement: input must be a list of user messages.
- The sample prompts were reviewed and lightly edited using the app's versioned worksheet-edit endpoint. The sample remains in the local app library; private account credentials are never part of this repository.

## Interface and print inspection

Computer-use testing in an isolated fixture covered script import, transcript review, option selection, worksheet generation, card reveal, quiz selection/checking, and versioned question edits. The production Mac app was also opened and inspected after a real generation. Browser screenshots at a narrow viewport verified the responsive layout.

PDFs were rendered with Poppler and visually reviewed: four-page guided notes, four-page teacher key, foldable flashcards, and practice quiz. Questions, answer lines, drawing area, page numbers, and source references were checked. The main sample PDF is generated from an original script and is included under `docs/` for prospective users.

## Limits of verification

The live clips establish that this installation can retrieve those two public examples; they cannot guarantee every YouTube/PBS link, station, country, account, or future provider change. PBS LearningMedia is allowed by the importer but was not separately tested live. Long-script processing is tested with deterministic fixtures rather than a paid feature-length-film generation. Full accessibility PDF tagging, additional writing systems, and Windows/Linux desktop installers remain future work. This initial public release requires local dependency setup; it is not a notarized one-click installer.
