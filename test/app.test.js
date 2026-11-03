import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startService } from "../server/app.js";
import { fakeGeneration } from "./fixtures.js";
async function harness(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "wonder-integration-"),
  );
  let fail = false;
  const chatgpt = {
    status: async () => ({ eligible: true }),
    generate: async (request) => {
      if (fail)
        throw Object.assign(new Error(), { userMessage: "Plan limit reached" });
      return fakeGeneration(request);
    },
    close() {},
  };
  const service = await startService({
    dataDir: directory,
    port: 0,
    chatgpt,
    whisper: {
      health: async () => ({ ready: true }),
      transcribe: async () => ({
        text: "A paper bridge spans a gap.",
        segments: [
          { text: "A paper bridge spans a gap.", startMs: 0, endMs: 5000 },
        ],
      }),
    },
    downloader: {
      health: async () => ({ ready: true }),
      download: async () => {
        throw Object.assign(new Error(), {
          userMessage: "Video blocked. Paste a transcript instead.",
        });
      },
    },
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { token } = await (await fetch(`${service.url}/api/bootstrap`)).json();
  const request = async (url, method = "GET", body) => {
    const response = await fetch(`${service.url}/api${url}`, {
      method,
      headers: {
        "x-wonder-token": token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  };
  return {
    service,
    directory,
    request,
    fail: () => {
      fail = true;
    },
  };
}
async function settle(request, id) {
  for (let i = 0; i < 100; i++) {
    const lesson = await (await request(`/lessons/${id}`)).json();
    if (!["queued", "generating", "importing"].includes(lesson.status))
      return lesson;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job did not settle");
}
test("script → generation → isolated PDFs → edits → preserved version → failed regenerate retains original", async (t) => {
  const { request, directory, fail } = await harness(t);
  const response = await request("/lessons", "POST", {
    type: "script",
    title: "Paper bridge",
    text: "Paper folds make a bridge stronger. Test the folded bridge with a coin.",
    settings: {
      sections: ["blanks", "watch", "reflection", "activity"],
      quiz: true,
      flashcards: true,
    },
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.status, "ready");
  assert.equal(
    (await request(`/lessons/${created.id}/generate`, "POST", created.settings))
      .status,
    200,
  );
  const lesson = await settle(request, created.id);
  assert.equal(lesson.status, "done");
  assert.equal(lesson.worksheet.sections.length, 4);
  for (const kind of ["guided", "key", "cards", "quiz", "quiz-key"]) {
    const pdf = await request(`/lessons/${created.id}/export/${kind}`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.ok(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 4)
        .equals(Buffer.from("%PDF")),
    );
  }
  const tsv = await (
    await request(`/lessons/${created.id}/export/cards-tsv`)
  ).text();
  assert.ok(tsv.includes("\t"));
  const value = structuredClone(lesson.worksheet);
  value.sections.find((s) => s.kind === "watch").items[0].prompt =
    "Explain why this bridge changes.";
  const edited = await (
    await request(`/lessons/${created.id}/worksheet`, "PUT", value)
  ).json();
  assert.equal(edited.versions.length, 2);
  const old = await (
    await request(`/lessons/${created.id}/versions/${lesson.version}`)
  ).json();
  assert.notEqual(
    old.worksheet.sections[1].items[0].prompt,
    value.sections[1].items[0].prompt,
  );
  const restored = await (
    await request(`/lessons/${created.id}/restore`, "POST", {
      version: lesson.version,
    })
  ).json();
  assert.equal(restored.versions.length, 3);
  await request(`/lessons/${created.id}/worksheet`, "PUT", value);
  fail();
  await request(`/lessons/${created.id}/generate`, "POST", {
    ...created.settings,
    notes: "A different request to avoid the validated cache",
  });
  const failed = await settle(request, created.id);
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.worksheet.sections[1].items[0].prompt,
    value.sections[1].items[0].prompt,
  );
  const saved = JSON.parse(
    await readFile(
      path.join(directory, "lessons", created.id, "lesson.json"),
      "utf8",
    ),
  );
  assert.equal(saved.versions.length, 4);
  assert.equal((await request(`/lessons/${created.id}`, "DELETE")).status, 200);
  assert.equal((await readdir(path.join(directory, "lessons"))).length, 0);
});
test("cross-site requests, DNS rebinding, missing tokens, and invalid paths are blocked", async (t) => {
  const { service, request } = await harness(t);
  assert.equal((await fetch(`${service.url}/api/lessons`)).status, 401);
  assert.equal(
    (
      await fetch(`${service.url}/api/bootstrap`, {
        headers: { Origin: "https://untrusted.test" },
      })
    ).status,
    403,
  );
  const rebound = await new Promise((resolve, reject) => {
    const req = http.get(
      `${service.url}/api/bootstrap`,
      { headers: { Host: "untrusted.test" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await request("/lessons/not-an-id")).status, 400);
  const result = await request("/lessons", "POST", {
    type: "url",
    url: "https://youtube.com.evil.test/video",
  });
  assert.equal(result.status, 400);
});
test("failed link import stays retryable and does not break other lessons", async (t) => {
  const { request } = await harness(t);
  const imported = await (
    await request("/lessons", "POST", {
      type: "url",
      url: "https://youtu.be/example",
    })
  ).json();
  const failed = await settle(request, imported.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Video blocked/);
  assert.equal(
    (await request(`/lessons/${imported.id}/retry`, "POST")).status,
    200,
  );
  assert.equal((await settle(request, imported.id)).status, "failed");
  const script = await (
    await request("/lessons", "POST", {
      type: "script",
      text: "A different useful lesson.",
    })
  ).json();
  assert.equal(script.status, "ready");
});
