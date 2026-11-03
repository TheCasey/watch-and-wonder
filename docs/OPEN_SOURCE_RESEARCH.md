# Open-source research and decisions

Reviewed November 3, 2026, for a local, printable-first video-to-worksheet app.

| Project | Useful capability | Decision |
| --- | --- | --- |
| [OpenWorksheets](https://github.com/openworksheets/openworksheets.github.io) | Browser-based self-correcting worksheets built over PDFs/images; AGPL-3.0 project | Worth evaluating for a future interactive worksheet export. Current app creates a fresh printable from transcript content rather than overlaying fields on an existing page. No code is bundled. |
| [Word Search Creator](https://wordsearchcreator.org/) | GPLv2 WYSIWYG word-search worksheet tool with PDF and SVG export | A possible separate companion for vocabulary puzzles; not a video-guided-notes engine. No code is bundled. |
| [PuzzleTide CLI](https://github.com/Caravaca-Labs/puzzletide-cli) | MIT-licensed deterministic word-search/crossword/sudoku generator with printable PDF output | A candidate if puzzle worksheets are added later. It has a small public history, so further review/testing is needed before adopting it. No code is bundled. |
| [H5P Fill in the Blanks](https://github.com/h5p/h5p-blanks) | Established interactive cloze-question content type, useful within the H5P ecosystem | Consider for a future H5P export. It brings content/runtime conventions that are unnecessary for the initial local print workflow. No H5P code is bundled. |
| [Vanilla Flashcard App Template](https://github.com/pedagogist/vanilla-flashcard-app-template) | Small Anki-like study app with progress tracking; MIT licensed | A good reference for a future standalone offline deck export. The current app has a simpler independently implemented reveal/previous/next viewer and TSV export. No template code is copied. |
| [rst2pdf](https://github.com/rst2pdf/rst2pdf) | MIT-licensed reStructuredText-to-PDF tool | Useful for document authoring, but would add a Python/toolchain requirement to an otherwise Node app. Not selected. |
| [PDFKit](https://pdfkit.org/) ([source](https://github.com/foliojs/pdfkit)) | Programmatic multi-page PDFs, embedded fonts, vector drawing, and text layout | Selected. Question blocks, answer lines, paper sizes, key separation, and cut-and-fold cards are controlled by the app rather than model-generated HTML. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Local Whisper inference and native timestamps | Selected external executable. Models downloaded separately and checksum-verified. |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp), [supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) | YouTube/PBS media extraction, with site-specific extractors | Selected external executable. Initial app intentionally accepts only YouTube, PBS, and PBS LearningMedia domains. Listed support cannot guarantee a particular video's availability. |

The chosen worksheet data model stores prompts, answers, optional choices, and exact source evidence. Print layout is deterministic; the model supplies content in a validated schema. Guided notes, parent keys, quizzes, and flashcards share that content without depending on a particular hosted educational product. Future exports can target H5P or other learning systems without replacing the source-grounded generation pipeline.
