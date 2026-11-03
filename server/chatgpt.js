// Direct public-client OAuth documented at:
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// Uses only this app's own grants. Never reads Codex or ChatGPT credentials.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const TERMINAL_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);
const random = () => randomBytes(32).toString("base64url");
function appError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}
const withoutTokens = ({
  access_token,
  refresh_token,
  id_token,
  expires_at,
  scopes,
  ...registration
}) => registration;

function serviceError(status, body, requestId) {
  const code =
    typeof body?.error?.code === "string"
      ? body.error.code
      : typeof body?.error === "string"
        ? body.error
        : undefined;
  const known = {
    subscription_sharing_user_not_eligible:
      "ChatGPT plan usage is unavailable for this account, workspace, or policy.",
    subscription_sharing_usage_limit_exceeded:
      "Your ChatGPT plan usage limit for this app was reached. Review https://chatgpt.com/settings/usage and retry after usage becomes available.",
    subscription_sharing_usage_unavailable:
      "ChatGPT could not check plan usage. Retry later.",
    subscription_sharing_unsupported_capability:
      "The selected model or request capability is not supported by ChatGPT plan usage.",
    subscription_sharing_route_not_supported:
      "ChatGPT plan usage is not enabled for this endpoint.",
    subscription_sharing_invalid_user:
      "ChatGPT could not validate the signed-in account. Sign in again if access was revoked.",
    invalid_client:
      "The ChatGPT client registration was rejected. Check integration availability.",
  };
  const error = appError(
    known[code] ||
      `ChatGPT request failed (HTTP ${status}${code ? `, ${code.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100)}` : ""}). ${status === 503 ? "The preview may be unavailable; retry later." : status === 401 ? "Check your account and sign in again if needed." : status === 403 ? "Your account or workspace may not be eligible for this preview." : "Retry later or check your ChatGPT settings."}`,
  );
  error.status = status;
  error.code = code;
  error.requestId = requestId;
  error.bodyShape =
    body && typeof body === "object" ? Object.keys(body) : typeof body;
  error.param = body?.error?.param;
  return error;
}

export function createChatGPT({
  dataDir,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  model: requestedModel = process.env.CHATGPT_WORKSHEET_MODEL,
  signInTimeoutMs = 10 * 60_000,
} = {}) {
  if (!dataDir)
    throw appError("ChatGPT credential storage requires a data directory.");
  const directory = path.join(dataDir, "chatgpt");
  const filename = path.join(directory, "accounts.json");
  let state,
    loading,
    refreshPromise,
    pending,
    lastIssue,
    lastErrorCode,
    cachedModels,
    cachedAccountId,
    cachedAt = 0,
    jwks,
    jwksAt = 0,
    generation = 0,
    authPhase = "signed_out";

  async function save() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temp = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(temp, filename);
    await chmod(filename, 0o600);
  }
  async function load() {
    if (state) return;
    loading ??= (async () => {
      try {
        state = JSON.parse(await readFile(filename, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT")
          throw appError(
            "ChatGPT credential storage could not be read. Restore it or remove the app credential file and sign in again.",
          );
        state = {
          version: 1,
          host_id: `urn:uuid:${randomUUID()}`,
          active: null,
          accounts: [],
        };
        await save();
      }
      if (
        state.version !== 1 ||
        !Array.isArray(state.accounts) ||
        typeof state.host_id !== "string"
      )
        throw appError("ChatGPT credential storage has an unsupported format.");
    })();
    await loading;
  }
  const active = () =>
    state?.accounts.find((account) => account.id === state.active);
  async function request(url, options = {}, timeout = 30_000) {
    const response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(timeout),
      redirect: "error",
    });
    if (!response.ok) {
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      throw serviceError(
        response.status,
        body,
        response.headers.get("x-request-id") ||
          response.headers.get("openai-request-id"),
      );
    }
    return response;
  }
  async function tokenRequest(params) {
    return (
      await request(`${ISSUER}/api/accounts/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(params),
      })
    ).json();
  }
  async function identity(idToken, clientId, nonce, refresh = false) {
    if (typeof idToken !== "string")
      throw appError("ChatGPT sign-in did not return an identity token.");
    const keys = async (force) => {
      if (!jwks || force || now() - jwksAt > 60 * 60_000) {
        jwks = createLocalJWKSet(
          await (await request(`${ISSUER}/.well-known/jwks.json`)).json(),
        );
        jwksAt = now();
      }
      return jwks;
    };
    const verify = async (key) =>
      jwtVerify(idToken, key, {
        issuer: ISSUER,
        audience: clientId,
        requiredClaims: ["sub", "exp", "iat"],
        algorithms: ["RS256", "PS256", "ES256"],
        clockTolerance: 5,
        currentDate: new Date(now()),
      });
    let result;
    try {
      result = await verify(await keys());
    } catch (error) {
      if (error.code !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
      result = await verify(await keys(true));
    }
    if (
      !result.payload.sub ||
      typeof result.payload.sub !== "string" ||
      (!refresh && result.payload.nonce !== nonce)
    )
      throw appError(
        "ChatGPT identity verification failed. Start sign-in again.",
      );
    return result.payload;
  }
  function tokenFields(tokens, old = {}) {
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      (tokens.token_type && tokens.token_type.toLowerCase() !== "bearer") ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0
    )
      throw appError(
        "ChatGPT returned an incomplete token set. Sign in again.",
      );
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || old.refresh_token,
      id_token: tokens.id_token || old.id_token,
      expires_at: now() + tokens.expires_in * 1000,
      scopes:
        typeof tokens.scope === "string"
          ? tokens.scope.split(/\s+/).filter(Boolean)
          : old.scopes || [],
    };
  }
  async function session() {
    await load();
    const account = active();
    if (!account?.access_token)
      throw appError(
        "Continue with ChatGPT in the app settings before creating a worksheet.",
      );
    if (account.expires_at > now() + 60_000) return account;
    if (!account.refresh_token)
      throw appError(
        "Your ChatGPT session expired. Continue with ChatGPT again.",
      );
    if (!refreshPromise) {
      const epoch = generation;
      refreshPromise = (async () => {
        try {
          const tokens = await tokenRequest({
            grant_type: "refresh_token",
            client_id: account.client_id,
            refresh_token: account.refresh_token,
            resource: RESOURCE,
          });
          if (tokens.id_token) {
            let claim;
            try {
              claim = await identity(
                tokens.id_token,
                account.client_id,
                undefined,
                true,
              );
            } catch {
              throw appError(
                "ChatGPT refresh identity verification failed. Continue with ChatGPT again.",
              );
            }
            if (claim.sub !== account.subject)
              throw appError(
                "Refreshed ChatGPT identity did not match the selected account. Sign in again.",
              );
          }
          if (generation !== epoch || active() !== account)
            throw appError(
              "ChatGPT account changed while refreshing. Retry with the selected account.",
            );
          Object.assign(account, tokenFields(tokens, account));
          await save();
          return account;
        } catch (error) {
          if (TERMINAL_REFRESH.has(error.code) && generation === epoch) {
            Object.assign(account, {
              access_token: undefined,
              refresh_token: undefined,
              id_token: undefined,
              expires_at: undefined,
              scopes: [],
            });
            await save();
            throw appError(
              "Your ChatGPT authorization expired or was revoked. Continue with ChatGPT again.",
            );
          }
          throw error;
        }
      })().finally(() => {
        refreshPromise = undefined;
      });
    }
    return refreshPromise;
  }
  async function catalog(account) {
    if (
      !cachedModels ||
      cachedAccountId !== account.id ||
      now() - cachedAt > 60_000
    ) {
      const response = await request(`${RESOURCE}/models`, {
        headers: { authorization: `Bearer ${account.access_token}` },
      });
      const body = await response.json();
      if (!Array.isArray(body.models))
        throw appError(
          "ChatGPT returned an unexpected model catalog. Check that plan sharing is enabled for this app.",
        );
      if (active() !== account || !account.access_token)
        throw appError(
          "ChatGPT account changed while checking available models. Retry with the selected account.",
        );
      cachedAccountId = account.id;
      cachedModels = body.models
        .filter(
          (item) =>
            item.visibility === "list" &&
            typeof item.slug === "string" &&
            !/image|audio|realtime|transcri|tts|sora/i.test(item.slug),
        )
        .map((item) => ({
          slug: item.slug,
          displayName: item.display_name || item.slug,
          contextWindow:
            Number(item.context_window ?? item.context_length) || undefined,
        }));
      cachedAt = now();
    }
    if (!cachedModels.length)
      throw appError(
        "No supported text models are available to this ChatGPT account.",
      );
    if (
      requestedModel &&
      !cachedModels.some((item) => item.slug === requestedModel)
    )
      throw appError(
        `The configured worksheet model is unavailable to this ChatGPT account. Choose a model from the account catalog or remove CHATGPT_WORKSHEET_MODEL.`,
      );
    return cachedModels;
  }
  async function status() {
    await load();
    const account = active();
    const result = {
      connected: Boolean(account?.access_token),
      eligible: false,
      signInPending: Boolean(pending),
      pending: Boolean(pending),
      status: pending
        ? "pending"
        : active()?.access_token
          ? "connected"
          : authPhase,
      accounts: state.accounts.map((item) => ({
        id: item.id,
        email: item.email,
        label: item.email
          ? `${item.email} (${item.client_id.slice(-6)})`
          : `ChatGPT account ${item.client_id.slice(-6)}`,
        active: item.id === state.active,
      })),
      issues: lastIssue ? [lastIssue] : [],
      ...(lastErrorCode ? { errorCode: lastErrorCode } : {}),
    };
    if (account) result.account = { id: account.id, email: account.email };
    if (!result.connected) return result;
    try {
      const current = await session();
      if (!current.scopes.includes(DIRECT_SCOPE))
        throw appError(
          "Signed in, but ChatGPT plan usage was not granted. Continue with ChatGPT again to enable plan usage.",
        );
      result.models = await catalog(current);
      const chosen =
        result.models.find((item) => item.slug === requestedModel) ||
        result.models[0];
      result.model = chosen.slug;
      result.modelDisplayName = chosen.displayName;
      result.eligible = true;
    } catch (error) {
      result.issues.push(
        error.userMessage ||
          "The ChatGPT connection could not be checked. Retry later.",
      );
      if (error.code) result.errorCode = error.code;
      result.connected = Boolean(active()?.access_token);
    }
    return result;
  }
  function stopPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.close();
    pending.server.closeIdleConnections();
    pending = undefined;
  }
  async function startSignIn({ accountId, newAccount = false } = {}) {
    await load();
    if (pending) return { url: pending.url };
    const selected = newAccount
      ? undefined
      : accountId
        ? state.accounts.find((account) => account.id === accountId)
        : active();
    if (accountId && !selected)
      throw appError("Choose a saved ChatGPT account or add a new account.");
    const transaction = {
      state: random(),
      nonce: random(),
      verifier: random(),
      clientId: selected?.client_id,
      selected,
      epoch: generation,
      expiresAt: now() + signInTimeoutMs,
    };
    const server = createServer(async (req, res) => {
      const finish = (success, text) => {
        res.writeHead(success ? 200 : 400, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        res.end(text);
      };
      if (
        req.method !== "GET" ||
        req.headers.host !== `127.0.0.1:${server.address()?.port}`
      ) {
        finish(false, "Invalid callback request.");
        return;
      }
      let callback;
      try {
        callback = new URL(req.url, transaction.redirectUri);
      } catch {
        finish(false, "Invalid callback URL.");
        return;
      }
      if (callback.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (
        !pending ||
        pending.transaction !== transaction ||
        transaction.consumed
      ) {
        finish(false, "This sign-in has already completed.");
        return;
      }
      if (callback.searchParams.get("state") !== transaction.state) {
        finish(
          false,
          "ChatGPT sign-in could not be verified. Return to the original sign-in tab.",
        );
        return;
      }
      transaction.consumed = true;
      try {
        if (now() >= transaction.expiresAt)
          throw appError("ChatGPT sign-in expired. Start sign-in again.");
        if (callback.searchParams.has("error"))
          throw appError(
            "ChatGPT sign-in was declined or unavailable. Start sign-in again if you want to grant plan access.",
          );
        const issued = callback.searchParams.get("client_id");
        const clientId = transaction.clientId || issued;
        if (
          !clientId ||
          clientId === "dynamic_agent_client" ||
          (transaction.clientId && issued && issued !== transaction.clientId)
        )
          throw appError(
            "ChatGPT registration did not return the expected client identity. Start sign-in again.",
          );
        if (!callback.searchParams.get("code"))
          throw appError(
            "ChatGPT sign-in did not return an authorization code.",
          );
        const tokens = await tokenRequest({
          grant_type: "authorization_code",
          code: callback.searchParams.get("code"),
          client_id: clientId,
          code_verifier: transaction.verifier,
          redirect_uri: transaction.redirectUri,
          resource: RESOURCE,
        });
        const claims = await identity(
          tokens.id_token,
          clientId,
          transaction.nonce,
        );
        if (selected && selected.subject !== claims.sub)
          throw appError(
            "The signed-in ChatGPT account did not match the selected account. Add a new account instead.",
          );
        if (generation !== transaction.epoch)
          throw appError(
            "Sign-in was canceled because the selected account changed. Start again.",
          );
        let record = state.accounts.find(
          (item) => item.client_id === clientId && item.subject === claims.sub,
        );
        record ??= {
          id: randomUUID(),
          client_id: clientId,
          subject: claims.sub,
          issuer: ISSUER,
        };
        Object.assign(
          record,
          {
            email: typeof claims.email === "string" ? claims.email : undefined,
          },
          tokenFields(tokens),
        );
        if (!state.accounts.includes(record)) state.accounts.push(record);
        state.active = record.id;
        generation++;
        cachedModels = undefined;
        lastIssue = undefined;
        lastErrorCode = undefined;
        authPhase = "connected";
        await save();
        finish(
          true,
          "ChatGPT connected. Return to Watch & Wonder to check plan eligibility. You may close this tab.",
        );
      } catch {
        authPhase = callback.searchParams.has("error") ? "cancelled" : "failed";
        lastIssue =
          "ChatGPT sign-in failed verification, was declined, or is unavailable for this account. Start sign-in again; no API billing fallback is used.";
        finish(false, lastIssue);
      } finally {
        stopPending();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    transaction.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: selected?.client_id || "dynamic_agent_client",
      ...(selected ? {} : { agent_name_hint: "Watch & Wonder" }),
      ext_agent_host_id: state.host_id,
      response_type: "code",
      redirect_uri: transaction.redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(transaction.verifier)
        .digest("base64url"),
      ...(selected?.id_token ? { id_token_hint: selected.id_token } : {}),
      ...(selected?.email ? { login_hint: selected.email } : {}),
      ...(selected?.access_token && !selected.scopes?.includes(DIRECT_SCOPE)
        ? { prompt: "consent" }
        : {}),
    }).toString();
    const timer = setTimeout(() => {
      authPhase = "expired";
      lastIssue = "ChatGPT sign-in timed out. Continue with ChatGPT again.";
      stopPending();
    }, signInTimeoutMs);
    timer.unref();
    server.unref();
    pending = { server, transaction, timer, url: url.toString() };
    lastIssue = undefined;
    lastErrorCode = undefined;
    authPhase = "pending";
    return { url: pending.url };
  }
  async function signOut() {
    await load();
    generation++;
    stopPending();
    authPhase = "signed_out";
    const account = active();
    let revoked = !account?.refresh_token;
    if (account?.refresh_token) {
      try {
        const metadata = await (
          await request(`${ISSUER}/.well-known/openid-configuration`)
        ).json();
        const endpoint = new URL(metadata.revocation_endpoint);
        if (endpoint.origin !== ISSUER)
          throw appError("Unexpected revocation endpoint.");
        await request(endpoint.toString(), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: account.refresh_token,
            token_type_hint: "refresh_token",
            client_id: account.client_id,
          }),
        });
        revoked = true;
      } catch {
        /* Always clear local tokens; a remote outage must not prevent sign-out. */
      }
    }
    if (account)
      Object.assign(account, withoutTokens(account), {
        access_token: undefined,
        refresh_token: undefined,
        id_token: undefined,
        expires_at: undefined,
        scopes: [],
      });
    cachedModels = undefined;
    lastErrorCode = undefined;
    lastIssue = revoked
      ? undefined
      : "Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings if needed.";
    await save();
    return status();
  }
  async function generate({ instructions, input, model, schema }) {
    const account = await session();
    if (!account.scopes.includes(DIRECT_SCOPE))
      throw appError(
        "ChatGPT plan usage permission was not granted. Continue with ChatGPT again.",
      );
    const models = await catalog(account);
    const selected =
      models.find((item) => item.slug === (model || requestedModel)) ||
      (!model && !requestedModel ? models[0] : null);
    if (!selected)
      throw appError(
        "The selected model is unavailable to this account. Refresh the connection and choose again.",
      );
    const epoch = generation;
    const current = await session();
    if (epoch !== generation)
      throw appError("Account changed. Retry generation.");
    const response = await request(
      `${RESOURCE}/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${current.access_token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: selected.slug,
          store: false,
          stream: true,
          instructions,
          ...(schema
            ? {
                text: {
                  format: {
                    type: "json_schema",
                    name: "learning_worksheet",
                    strict: true,
                    schema,
                  },
                },
              }
            : {}),
          input:
            typeof input === "string"
              ? [{ role: "user", content: input }]
              : input,
        }),
      },
      15 * 60_000,
    );
    const result = await readSummaryStream(response);
    if (epoch !== generation)
      throw appError("Account changed. Retry generation.");
    return result;
  }
  return {
    status,
    health: status,
    startSignIn,
    signOut,
    generate,
    async selectAccount(id) {
      await load();
      if (!state.accounts.some((item) => item.id === id))
        throw appError("ChatGPT account was not found.");
      generation++;
      stopPending();
      state.active = id;
      cachedModels = undefined;
      lastIssue = undefined;
      await save();
      return status();
    },
    close: stopPending,
  };
}

export async function readSummaryStream(response) {
  if (!response.body)
    throw appError(
      "ChatGPT returned no response stream. Retry the saved transcript.",
    );
  let buffer = "",
    text = "",
    completed = false;
  const decoder = new TextDecoder();
  function consume(block) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw appError(
        "ChatGPT returned an invalid event stream. Retry the saved transcript.",
      );
    }
    if (event.type === "response.output_text.delta") text += event.delta || "";
    if (event.type === "response.completed") {
      if (event.response?.status && event.response.status !== "completed")
        throw appError(
          "ChatGPT returned an incomplete worksheet. Retry the saved transcript.",
        );
      completed = true;
      if (!text)
        text = (event.response?.output || [])
          .flatMap((item) => item.content || [])
          .filter((item) => item.type === "output_text")
          .map((item) => item.text)
          .join("");
    }
    if (event.type === "response.failed" || event.type === "error")
      throw serviceError(
        response.status,
        { error: event.response?.error || event.error || event },
        response.headers.get("x-request-id"),
      );
    if (event.type === "response.incomplete")
      throw appError(
        "ChatGPT stopped before completing the worksheet. Retry the saved transcript.",
      );
  }
  for await (const chunk of response.body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
      /\r\n/g,
      "\n",
    );
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
    }
    if (buffer.length > 4_000_000 || text.length > 4_000_000)
      throw appError(
        "ChatGPT worksheet exceeded the supported size. Retry with a smaller transcript.",
      );
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!completed || !text.trim())
    throw appError(
      "ChatGPT stream ended without a completed worksheet. Retry the saved transcript.",
    );
  return text.trim();
}
