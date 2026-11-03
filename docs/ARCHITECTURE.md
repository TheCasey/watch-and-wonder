# Implementation notes

Watch & Wonder is a separate Electron application and loopback-only Express service. The same browser interface can run with `npm start`. It has no extension, database server, or hosted application dependency.

## Flow

1. `server/source.js` validates a restricted video domain or parses a script/SRT/VTT file. `yt-dlp` downloads at most one video using argument arrays, with configuration and cookie import disabled.
2. `server/whisper.js` converts local media to mono 16 kHz PCM with FFmpeg, then runs whisper.cpp. It retains native segment timings and removes intermediate WAV files. The library removes downloaded media after transcription.
3. `server/library.js` serializes expensive work and persists progress atomically. A video stops at transcript review; generation starts only on an explicit create/retry action. Interrupted jobs become retryable after restart.
4. `server/chatgpt.js` implements this app's own documented public-client OAuth grant and plan inference. It verifies signed identity tokens and uses the account model catalog. Responses requests use a list of user input messages, `store:false`, and `stream:true`. Only a completed terminal stream event counts as success.
5. `server/worksheet.js` processes the full source in ordered chunks. It validates question kinds, lengths, answer choices, actual source IDs, verbatim evidence, and blank answers. It saves validated parts for retry. Reflection/activity synthesis uses bounded verified excerpts from across the source. Content and model choices participate in cache keys; missing final sections invalidate incomplete partial caches.
6. `server/pdf.js` renders student notes, teacher keys, flashcards, and quizzes locally. Student PDFs omit answers/evidence, except an explicitly selected word bank and normal multiple-choice options. Exports use the worksheet's source/settings snapshot, even after a transcript or future generation settings change.
7. `public/app.js` renders model text using textContent and DOM construction. It supports source edits, question edits, study tools, PDF/TSV downloads, renaming, deletion, and version restoration.

## Source grounding is a review aid

Verbatim quote validation is a deterministic check that cited text exists; it is not an entailment proof. A model can quote a real sentence but interpret it incorrectly. Parent/teacher review remains part of the workflow. Plain scripts never acquire fabricated video times. A script may differ from a released movie; transcript-only processing cannot interpret unseen visuals.

## Local security and storage

The HTTP service binds to 127.0.0.1, checks Host/Origin and cross-site fetch metadata, and requires a per-run random token on private API requests. The interface obtains that token from a same-origin bootstrap endpoint. No token is placed in URLs. PDF downloads use authenticated fetch and temporary object URLs. The browser has no Node integration. Electron uses context isolation and sandboxed renderer processes; external windows are restricted to the expected sign-in, usage, and GitHub destinations.

App OAuth credentials have their own private directory, atomic writes, Unix 0600 permissions, validated state/nonce/PKCE, rotating token refresh, and revocation on sign-out. Audio, source scripts, credentials, caches, and models are excluded from Git. A local library backup includes private material; back it up deliberately and exclude credentials when sharing lessons.

Child processes use no shell, have bounded log tails/timeouts, and are terminated on app shutdown. Closing the Mac app while work is active asks whether to keep working or quit and resume later. Browser-server users need to keep their terminal process running.

## Dependency rationale

The production dependencies are Express, jose, and PDFKit. The Node project carries no Python runtime requirement for worksheet generation. FFmpeg, whisper.cpp, and yt-dlp are external executables, detected in Setup. Electron packaging is a development-only concern. Dev-tool glob/minimatch versions are overridden to patched versions and packaging is verified with those overrides.

Potential future work: a notarized installer with dependency provisioning, optional higher-accuracy local models in the UI, stand-alone offline HTML study decks, H5P exports, richer accessible PDF tagging, additional fonts, and image/diagram-aware source ingestion. None of these are required by the current local transcript-to-print flow.
