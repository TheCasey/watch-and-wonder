import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createChatGPT, readSummaryStream } from "../server/chatgpt.js";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "test-request",
    },
  });
const events = (data) =>
  new Response(
    data.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
async function harness(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "class-chatgpt-"));
  const env = {
    now: Date.now(),
    calls: [],
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    subject: "account-1",
    tokenCalls: 0,
    ...overrides,
  };
  env.fetchImpl = async (url, options = {}) => {
    url = String(url);
    env.calls.push({ url, ...options });
    if (url.endsWith("/.well-known/jwks.json")) return json({ keys: [jwk] });
    if (url.endsWith("/.well-known/openid-configuration"))
      return json({ revocation_endpoint: "https://auth.openai.com/revoke" });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    if (url.endsWith("/oauth/token")) {
      env.tokenCalls++;
      const body = options.body;
      if (body.get("grant_type") === "refresh_token") {
        env.refreshes = (env.refreshes || 0) + 1;
        if (env.refreshError) return json({ error: env.refreshError }, 400);
        return json({
          access_token: "refreshed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: env.scope,
        });
      }
      assert.equal(body.get("resource"), "https://api.openai.com/v1");
      assert.equal(body.get("client_id"), "oaiapp_test");
      assert.equal(
        body.get("redirect_uri"),
        env.auth.searchParams.get("redirect_uri"),
      );
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier"))
          .digest("base64url"),
        env.auth.searchParams.get("code_challenge"),
      );
      let idToken = await new SignJWT({
        nonce: env.badNonce
          ? "wrong-nonce"
          : env.auth.searchParams.get("nonce"),
        email: "student@example.com",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(
          env.badIssuer ? "https://evil.example" : "https://auth.openai.com",
        )
        .setAudience(env.badAudience ? "wrong-client" : "oaiapp_test")
        .setSubject(env.subject)
        .setIssuedAt(Math.floor(env.now / 1000))
        .setExpirationTime(
          Math.floor(env.now / 1000) + (env.expiredToken ? -30 : 3600),
        )
        .sign(privateKey);
      if (env.badSignature) {
        const parts = idToken.split(".");
        parts[2] = "A".repeat(parts[2].length);
        idToken = parts.join(".");
      }
      return json({
        access_token: "secret-access",
        refresh_token: "secret-refresh",
        id_token: idToken,
        expires_in: 3600,
        token_type: "Bearer",
        scope: env.scope,
      });
    }
    if (url.endsWith("/v1/models")) {
      if (env.modelError) return json({ error: { code: env.modelError } }, 403);
      return json({
        models: [
          { slug: "internal-hidden", visibility: "hide" },
          { slug: "gpt-image-test", visibility: "list" },
          {
            slug: "entitled-text-model",
            display_name: "Plan text model",
            visibility: "list",
            context_window: 128000,
          },
        ],
      });
    }
    if (url.endsWith("/v1/responses")) {
      env.responseBody = JSON.parse(options.body);
      if (env.responseError)
        return events([
          { type: "response.output_text.delta", delta: "partial" },
          {
            type: "response.failed",
            response: { error: { code: env.responseError } },
          },
        ]);
      if (
        env.studyToolResponse &&
        env.responseBody.instructions.startsWith(
          "Create only the requested academic study tools",
        )
      )
        return events([
          {
            type: "response.output_text.delta",
            delta: JSON.stringify(env.studyToolResponse),
          },
          { type: "response.completed", response: { status: "completed" } },
        ]);
      if (
        env.flashcardResponse &&
        env.responseBody.instructions.startsWith(
          "Create academic study flashcards",
        )
      )
        return events([
          {
            type: "response.output_text.delta",
            delta: JSON.stringify(env.flashcardResponse),
          },
          { type: "response.completed", response: { status: "completed" } },
        ]);
      return events([
        { type: "response.output_text.delta", delta: "# Class notes\n" },
        { type: "response.output_text.delta", delta: "An accurate summary." },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    }
    throw new Error(`Unexpected test request: ${url}`);
  };
  const client = createChatGPT({
    dataDir,
    fetchImpl: env.fetchImpl,
    now: () => env.now,
  });
  t.after(async () => {
    client.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  env.client = client;
  env.dataDir = dataDir;
  env.begin = async (options) => {
    const { url } = await client.startSignIn(options);
    env.auth = new URL(url);
    return env.auth;
  };
  env.callback = async (changes) => {
    const callback = new URL(env.auth.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({
      code: "test-code",
      state: env.auth.searchParams.get("state"),
      client_id: "oaiapp_test",
      ...changes,
    });
    const response = await fetch(callback);
    await response.text();
    return response;
  };
  env.connect = async (options) => {
    await env.begin(options);
    assert.equal((await env.callback()).status, 200);
  };
  return env;
}

test("ChatGPT signs in with PKCE and validated identity, discovers an entitled model, streams a summary, and keeps credentials private", async (t) => {
  const env = await harness(t);
  assert.equal((await env.client.status()).connected, false);
  assert.equal(env.calls.length, 0);
  await env.begin();
  assert.equal(env.auth.origin, "https://auth.openai.com");
  assert.equal(env.auth.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(env.auth.searchParams.get("code_challenge_method"), "S256");
  assert.match(env.auth.searchParams.get("scope"), /chatgpt.tokens.use.direct/);
  assert.equal((await env.callback()).status, 200);
  const status = await env.client.status();
  assert.equal(status.connected, true);
  assert.equal(status.eligible, true);
  assert.equal(status.model, "entitled-text-model");
  assert.equal(status.models.length, 1);
  assert.equal(status.account.email, "student@example.com");
  assert.doesNotMatch(
    JSON.stringify(status),
    /secret-access|secret-refresh|id_token|access_token/,
  );
  assert.equal(
    (await stat(path.join(env.dataDir, "chatgpt"))).mode & 0o777,
    0o700,
  );
  assert.equal(
    (await stat(path.join(env.dataDir, "chatgpt/accounts.json"))).mode & 0o777,
    0o600,
  );
  assert.match(
    await env.client.generate({
      instructions: "Create worksheet",
      input: "A lecture about cells.",
    }),
    /An accurate summary/,
  );
  assert.equal(env.responseBody.model, "entitled-text-model");
  assert.equal(env.responseBody.store, false);
  assert.equal(env.responseBody.stream, true);
  assert.deepEqual(env.responseBody.input, [
    { role: "user", content: "A lecture about cells." },
  ]);
  assert.equal(env.responseBody.max_output_tokens, undefined);
  assert.equal(env.responseBody.temperature, undefined);
  assert.equal(
    env.calls.filter((call) => call.url.endsWith("/responses")).length,
    1,
  );
});

test("ChatGPT rejects mismatched state before code exchange", async (t) => {
  const env = await harness(t);
  await env.begin();
  assert.equal((await env.callback({ state: "attacker" })).status, 400);
  assert.equal(env.tokenCalls, 0);
  assert.equal((await env.client.status()).connected, false);
  assert.equal((await env.client.status()).pending, true);
  assert.equal((await env.callback()).status, 200);
});

test("ChatGPT rejects invalid ID token audience and nonce without saving tokens", async (t) => {
  for (const bad of [
    "badAudience",
    "badNonce",
    "badIssuer",
    "expiredToken",
    "badSignature",
  ]) {
    const env = await harness(t, { [bad]: true });
    await env.begin();
    assert.equal((await env.callback()).status, 400);
    assert.equal((await env.client.status()).connected, false);
    assert.doesNotMatch(
      await readFile(path.join(env.dataDir, "chatgpt/accounts.json"), "utf8"),
      /secret-access|secret-refresh/,
    );
  }
});

test("ChatGPT keeps identity-only sign-in but never invokes inference without plan scope", async (t) => {
  const env = await harness(t, { scope: "openid email profile" });
  await env.connect();
  const status = await env.client.status();
  assert.equal(status.connected, true);
  assert.equal(status.eligible, false);
  assert.match(status.issues.join(" "), /not granted/);
  await assert.rejects(
    env.client.generate({ instructions: "Create worksheet", input: "Text" }),
    /permission was not granted/,
  );
  assert.ok(!env.calls.some((call) => /\/models|\/responses/.test(call.url)));
  await env.begin();
  assert.equal(env.auth.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(env.auth.searchParams.get("prompt"), "consent");
});

test("ChatGPT refreshes a rotating session once for concurrent callers and saves replacement tokens", async (t) => {
  const env = await harness(t);
  await env.connect();
  env.now += 3600_000;
  const [first, second] = await Promise.all([
    env.client.status(),
    env.client.status(),
  ]);
  assert.equal(first.eligible, true);
  assert.equal(second.eligible, true);
  assert.equal(env.refreshes, 1);
  const saved = JSON.parse(
    await readFile(path.join(env.dataDir, "chatgpt/accounts.json"), "utf8"),
  );
  assert.equal(saved.accounts[0].refresh_token, "rotated-refresh");
  const refresh = env.calls.find(
    (call) =>
      call.body instanceof URLSearchParams &&
      call.body.get("grant_type") === "refresh_token",
  );
  assert.equal(refresh.body.get("scope"), null);
  assert.equal(refresh.body.get("client_id"), "oaiapp_test");
});

test("ChatGPT terminal refresh clears unusable credentials and retains registration", async (t) => {
  const env = await harness(t, { refreshError: "invalid_grant" });
  await env.connect();
  env.now += 3600_000;
  const status = await env.client.status();
  assert.equal(status.connected, false);
  assert.equal(status.eligible, false);
  assert.match(status.issues.join(" "), /revoked/);
  await env.begin();
  assert.equal(env.auth.searchParams.get("client_id"), "oaiapp_test");
});

test("ChatGPT reports ineligible accounts and never silently switches billing", async (t) => {
  const env = await harness(t, {
    modelError: "subscription_sharing_user_not_eligible",
  });
  await env.connect();
  const status = await env.client.status();
  assert.equal(status.eligible, false);
  assert.equal(status.connected, true);
  assert.match(status.issues.join(" "), /unavailable for this account/);
  await assert.rejects(
    env.client.generate({ instructions: "Worksheet", input: "Lecture" }),
    (error) => error.userMessage?.includes("unavailable for this account"),
  );
  assert.ok(
    !env.calls.some(
      (call) =>
        call.url.includes("backend-api") || call.url.includes("/audio/"),
    ),
  );
});

test("ChatGPT plan usage errors after streaming began fail the summary", async (t) => {
  const env = await harness(t, {
    responseError: "subscription_sharing_usage_limit_exceeded",
  });
  await env.connect();
  await assert.rejects(
    env.client.generate({ instructions: "Worksheet", input: "Lecture" }),
    (error) =>
      error.code === "subscription_sharing_usage_limit_exceeded" &&
      error.userMessage.includes("usage limit"),
  );
});

test("ChatGPT sign-out revokes renewal and retains client registration for future sign-in", async (t) => {
  const env = await harness(t);
  await env.connect();
  const hostId = env.auth.searchParams.get("ext_agent_host_id");
  assert.equal((await env.client.signOut()).connected, false);
  const revoke = env.calls.find((call) => call.url.endsWith("/revoke"));
  assert.equal(revoke.body.get("token"), "secret-refresh");
  const saved = await readFile(
    path.join(env.dataDir, "chatgpt/accounts.json"),
    "utf8",
  );
  assert.doesNotMatch(saved, /secret-access|secret-refresh|id_token/);
  await env.begin();
  assert.equal(env.auth.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(env.auth.searchParams.get("ext_agent_host_id"), hostId);
  assert.equal(env.auth.searchParams.get("id_token_hint"), null);
  assert.equal(env.auth.searchParams.get("prompt"), null);
});

test("SSE requires a completed event and supports CRLF split across byte chunks", async () => {
  await assert.rejects(
    readSummaryStream(
      events([{ type: "response.output_text.delta", delta: "partial" }]),
    ),
    /without a completed worksheet/,
  );
  await assert.rejects(
    readSummaryStream(events([{ type: "response.incomplete" }])),
    /before completing/,
  );
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"response.output_text.delta","delta":"ok"}\r',
        ),
      );
      controller.enqueue(
        new TextEncoder().encode(
          '\n\r\ndata: {"type":"response.completed"}\r\n\r\n',
        ),
      );
      controller.close();
    },
  });
  assert.equal(await readSummaryStream(new Response(body)), "ok");
});
