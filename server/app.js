import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChatGPT } from "./chatgpt.js";
import { createWhisper } from "./whisper.js";
import { createDownloader, fail } from "./source.js";
import { createLibrary } from "./library.js";
import { stopProcesses } from "./process.js";
import { renderPDF } from "./pdf.js";
import { transcriptText, subtitlesText } from "./transcript.js";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function createService({
  dataDir = path.join(root, ".local"),
  whisper = createWhisper(),
  downloader = createDownloader(),
  chatgpt = createChatGPT({ dataDir }),
} = {}) {
  const app = express(),
    token = randomBytes(32).toString("base64url");
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.headers.host;
    const port = req.socket.localPort;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
      return res
        .status(403)
        .json({ error: "Open the app through its local address." });
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `http://127.0.0.1:${port}` &&
      origin !== `http://localhost:${port}`
    )
      return res.status(403).json({ error: "Origin not allowed." });
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.status(403).json({ error: "Cross-site request blocked." });
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  const library = await createLibrary({
    dataDir,
    whisper,
    downloader,
    chatgpt,
  });
  app.get("/api/bootstrap", (req, res) => res.json({ token }));
  app.use("/api", (req, res, next) => {
    const candidate = Buffer.from(req.headers["x-wonder-token"] || "");
    const expected = Buffer.from(token);
    if (
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    )
      return res
        .status(401)
        .json({ error: "Reload the app to reconnect to its local service." });
    next();
  });
  app.get("/api/health", async (req, res) =>
    res.json({
      whisper: await whisper.health(),
      downloader: await downloader.health(),
      dataDir,
      busy: library.busy(),
    }),
  );
  app.get("/api/account", async (req, res) => res.json(await chatgpt.status()));
  app.post("/api/account/sign-in", async (req, res) =>
    res.json(await chatgpt.startSignIn(req.body || {})),
  );
  app.post("/api/account/sign-out", async (req, res) =>
    res.json(await chatgpt.signOut()),
  );
  app.post("/api/account/select", async (req, res) =>
    res.json(await chatgpt.selectAccount(req.body.id)),
  );
  app.get("/api/lessons", (req, res) => res.json(library.list()));
  app.post("/api/lessons", async (req, res) =>
    res.status(201).json(await library.create(req.body)),
  );
  app.get("/api/lessons/:id", (req, res) =>
    res.json(library.get(req.params.id)),
  );
  app.post("/api/lessons/:id/generate", async (req, res) => {
    const status = await chatgpt.status();
    if (!status.eligible)
      throw fail(
        status.issues?.[0] ||
          "Continue with ChatGPT in Settings before generating.",
      );
    res.json(await library.generate(req.params.id, req.body));
  });
  app.post("/api/lessons/:id/retry", async (req, res) =>
    res.json(await library.retry(req.params.id)),
  );
  app.put("/api/lessons/:id/transcript", async (req, res) =>
    res.json(await library.editTranscript(req.params.id, req.body.text)),
  );
  app.put("/api/lessons/:id/title", async (req, res) =>
    res.json(await library.rename(req.params.id, req.body.title)),
  );
  app.put("/api/lessons/:id/worksheet", async (req, res) =>
    res.json(await library.editWorksheet(req.params.id, req.body)),
  );
  app.delete("/api/lessons/:id", async (req, res) => {
    await library.remove(req.params.id);
    res.json({ removed: true });
  });
  app.post("/api/lessons/:id/restore", async (req, res) =>
    res.json(await library.restore(req.params.id, req.body.version)),
  );
  app.get("/api/lessons/:id/versions/:version", async (req, res) =>
    res.json(await library.version(req.params.id, req.params.version)),
  );
  app.get("/api/lessons/:id/export/:kind", async (req, res) => {
    const lesson = library.get(req.params.id),
      kind = req.params.kind;
    const name =
      lesson.title
        .replace(/[^a-zA-Z0-9 _-]/g, "")
        .trim()
        .slice(0, 80) || "lesson";
    if (kind === "transcript") {
      if (!lesson.transcript) throw fail("The transcript is not ready yet.");
      res
        .attachment(`${name}-transcript.txt`)
        .type("text/plain")
        .send(transcriptText(lesson.transcript));
      return;
    }
    if (kind === "subtitles") {
      if (!lesson.transcript?.segments.every((s) => Number.isFinite(s.startMs)))
        throw fail("This transcript has no subtitle timings.");
      res
        .attachment(`${name}.srt`)
        .type("text/plain")
        .send(subtitlesText(lesson.transcript.segments));
      return;
    }
    if (!lesson.worksheet) throw fail("Generate a worksheet first.");
    if (kind === "json") {
      res.attachment(`${name}-worksheet.json`).json(lesson.worksheet);
      return;
    }
    if (kind === "cards-tsv") {
      const cell = (text) => text.replace(/[\t\r\n]+/g, " ");
      res
        .attachment(`${name}-cards.tsv`)
        .type("text/tab-separated-values")
        .send(
          lesson.worksheet.flashcards
            .map((c) => `${cell(c.front)}\t${cell(c.back)}`)
            .join("\n"),
        );
      return;
    }
    if (!["guided", "key", "cards", "quiz", "quiz-key"].includes(kind))
      throw fail("Unknown export format.");
    const pdf = await renderPDF({
      lesson: {
        ...lesson,
        settings: lesson.worksheetSettings || lesson.settings,
        transcript: lesson.worksheetTranscript || lesson.transcript,
      },
      kind,
    });
    res.attachment(`${name}-${kind}.pdf`).type("application/pdf").send(pdf);
  });
  app.use(
    express.static(path.join(root, "public"), { etag: false, maxAge: 0 }),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res
      .status(
        error.type === "entity.too.large" ? 413 : error.userMessage ? 400 : 500,
      )
      .json({
        error:
          error.type === "entity.too.large"
            ? "This input is too large. Split it into separate lessons."
            : error.userMessage ||
              "The local app could not complete this request. Check the library folder and retry.",
      });
  });
  return {
    app,
    library,
    chatgpt,
    async close() {
      await library.close();
      stopProcesses();
      chatgpt.close();
    },
  };
}
export async function startService(config = {}) {
  const service = await createService(config);
  const port = config.port ?? Number(process.env.PORT || 3220);
  const server = await new Promise((resolve, reject) => {
    const server = service.app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  server.requestTimeout = 5 * 60_000;
  return {
    ...service,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await service.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
    },
  };
}
