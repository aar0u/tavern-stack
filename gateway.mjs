// An OpenAI-compatible chat endpoint for SillyTavern in front of any OpenAI-compatible upstream: ST always talks to http://gateway:8789/v1,
// and everything about the upstream (address, key, model, request tweaks) lives in the environment, not in ST's settings.
//   UPSTREAM_URL  base URL, e.g. https://openrouter.ai/api/v1            (required)
//   UPSTREAM_KEY  bearer key; leave it empty for an upstream that needs none (cpa)
//   MODEL         sent upstream instead of the model ST asks for, e.g. an OpenRouter preset "@preset/st"
//   BODY          JSON merged over every request, e.g. {"reasoning":{"enabled":false}}
//   RETRIES       extra attempts on 429/502/503/504 and network errors (default 2)
//   ORIGINS       comma-separated page origins allowed to call it from a browser (CORS), for scripts that talk to the API directly
//                 (default: SillyTavern on http://127.0.0.1:8000 and http://localhost:8000)
//   HOST, PORT    listen address (default 127.0.0.1:8789)
// usage: gateway.mjs | --self-test
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const ENDS_WITH_MODEL_TURN = /ending with a model turn/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createGateway({ upstream, key, model, body: extra = {}, retries = 2, origins = [], sleep = wait, log = () => {} }) {
  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  async function forward(payload, signal) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(`${upstream}/chat/completions`, {
          method: "POST",
          headers: { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal.aborted || attempt >= retries) throw error;
        log(`retry ${attempt + 1}/${retries}: ${error.message}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      // Gemini (through cpa) sometimes answers 200 with no choices at all and 0 completion tokens; the same request usually works again.
      const empty = response.status === 200 && !payload.stream && attempt < retries && (await response.clone().json().catch(() => null))?.choices?.length === 0;
      if ((!RETRY_STATUS.has(response.status) && !empty) || attempt >= retries) return response;
      await response.arrayBuffer();
      log(`retry ${attempt + 1}/${retries}: ${empty ? "empty completion" : response.status}`);
      await sleep(Math.min(Number(response.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt, 10_000));
    }
  }

  // Gemini answers a request that ends with an assistant message (a prefill, a script's "continue") with 400; learned from the first
  // such answer, so upstreams that accept prefills never get the extra turn. The model then answers anew rather than continuing exactly.
  let needsUserTurn = false;
  const endsWithAssistant = (messages) => messages?.at(-1)?.role === "assistant";
  const withUserTurn = (messages) => (endsWithAssistant(messages) ? [...messages, { role: "user", content: "Continue." }] : messages);

  async function chat(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { error: { message: "request body is not JSON" } });
    }
    const sent = { ...payload, ...extra, ...(model && { model }) };
    const started = Date.now();
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    let response;
    try {
      if (needsUserTurn) sent.messages = withUserTurn(sent.messages);
      response = await forward(sent, controller.signal);
      if (response.status === 400 && !needsUserTurn && endsWithAssistant(sent.messages) && ENDS_WITH_MODEL_TURN.test(await response.clone().text())) {
        needsUserTurn = true;
        log(`${sent.model} rejects a trailing assistant message: appending a user turn from now on`);
        sent.messages = withUserTurn(sent.messages);
        response = await forward(sent, controller.signal);
      }
    } catch (error) {
      log(`${sent.model} unreachable: ${error.message}`);
      return send(res, 502, { error: { message: `upstream unreachable: ${error.message}` } });
    }
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (sent.stream) {
      // A stream the upstream breaks off leaves nothing in ST but a shorter reply; the client closing it (the stop button) is no news.
      await pipeline(Readable.fromWeb(response.body), res).catch((error) => {
        if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") log(`${sent.model} stream cut: ${error.cause?.message ?? error.message}`);
      });
      return log(`${sent.model} ${response.status} ${seconds}s (stream)`);
    }
    const text = await response.text();
    res.end(text);
    let usage;
    try {
      usage = JSON.parse(text).usage;
    } catch {}
    log(`${sent.model} ${response.status} ${seconds}s` + (usage ? ` in=${usage.prompt_tokens} out=${usage.completion_tokens} reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 0}` : ""));
  }

  return createServer((req, res) => {
    // Only listed origins, not "*": any web page could otherwise spend the upstream quota through the local port.
    if (origins.includes(req.headers.origin)) {
      res.setHeader("access-control-allow-origin", req.headers.origin);
      res.setHeader("access-control-allow-headers", "content-type, authorization");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const path = (req.url ?? "").split("?")[0].replace(/^\/v1(?=\/)/, "");
    if (path === "/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && path === "/models") return send(res, 200, { object: "list", data: [{ id: model ?? "default", object: "model" }] });
    if (req.method === "POST" && path === "/chat/completions") return chat(req, res).catch((error) => res.headersSent || send(res, 500, { error: { message: error.message } }));
    send(res, 404, { error: { message: `no route ${req.method} ${path}` } });
  });
}

if (process.argv.includes("--self-test")) {
  const calls = [];
  const plan = [];
  let picky = false;
  const fake = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ url: req.url, auth: req.headers.authorization, body });
    if (picky && body.messages?.at(-1)?.role === "assistant") return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Requests ending with a model turn are not supported." } }));
    const status = plan.shift() ?? 200;
    if (status === "empty") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 0 } }));
    if (status !== 200) return res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `fake ${status}` } }));
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      return setTimeout(() => (body.cut ? res.destroy() : res.end("data: [DONE]\n\n")), 10);
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } }));
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const upstream = await listen(fake);
  const lines = [];
  const sleeps = [];
  const gateway = createGateway({ upstream: `${upstream}/v1`, key: "k", model: "@preset/st", body: { reasoning: { enabled: false } }, retries: 2, sleep: async (ms) => sleeps.push(ms), log: (line) => lines.push(line) });
  const base = await listen(gateway);
  const post = (path, payload) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  const ask = { model: "some/model-sillytavern-asks-for", stream: false, reasoning: { effort: "high" }, messages: [{ role: "user", content: "hi" }] };

  let r = await post("/v1/chat/completions", ask);
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, "/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer k", "the gateway's own key, not ST's");
  assert.deepEqual(calls[0].body, { model: "@preset/st", stream: false, reasoning: { enabled: false }, messages: ask.messages }, "model and BODY override what ST sent");
  assert.match(lines.at(-1), /^@preset\/st 200 [\d.]+s in=12 out=3 reasoning=0$/);

  calls.length = 0;
  plan.push(429, 503);
  r = await post("/chat/completions", ask);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 3, "two retryable failures, then success");
  assert.deepEqual(sleeps, [1000, 2000], "backoff doubles");

  calls.length = 0;
  sleeps.length = 0;
  plan.push("empty");
  r = await post("/v1/chat/completions", ask);
  assert.equal((await r.json()).choices[0].message.content, "ok", "an empty completion is asked for again");
  assert.equal(calls.length, 2);
  calls.length = 0;
  plan.push("empty", "empty", "empty");
  r = await post("/v1/chat/completions", ask);
  assert.deepEqual((await r.json()).choices, [], "still empty when the retries run out: passed through, not turned into an error");
  assert.equal(calls.length, 3);
  calls.length = 0;
  plan.push("empty");
  await (await post("/v1/chat/completions", { ...ask, stream: true })).text();
  assert.equal(calls.length, 1, "a stream is never inspected or retried");
  plan.length = 0;

  calls.length = 0;
  plan.push(429, 429, 429);
  r = await post("/v1/chat/completions", ask);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.message, "fake 429", "the upstream's answer is passed through when retries run out");
  assert.equal(calls.length, 3);

  calls.length = 0;
  plan.push(400);
  r = await post("/v1/chat/completions", ask);
  assert.equal(r.status, 400);
  assert.equal(calls.length, 1, "other errors are not retried");

  r = await post("/v1/chat/completions", { ...ask, stream: true });
  assert.equal(await r.text(), "data: one\n\ndata: [DONE]\n\n", "streams pass through");
  assert.match(lines.at(-1), /\(stream\)$/);

  const logged = lines.length;
  r = await post("/v1/chat/completions", { ...ask, stream: true, cut: true });
  await r.text().catch(() => {});
  await wait(50);
  assert.ok(lines.slice(logged).some((line) => /^@preset\/st stream cut: /.test(line)), "a stream the upstream breaks off is logged");
  const closing = lines.length;
  r = await post("/v1/chat/completions", { ...ask, stream: true });
  await r.body.getReader().cancel();
  await wait(50);
  assert.equal(lines.slice(closing).some((line) => /stream cut/.test(line)), false, "the client closing the stream (the stop button) is not");

  r = await fetch(`${base}/v1/models`);
  assert.deepEqual((await r.json()).data.map((m) => m.id), ["@preset/st"]);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await post("/v1/chat/completions", "not json")).status, 400);
  assert.equal((await post("/v1/nothing", {})).status, 404);

  const cors = createGateway({ upstream: `${upstream}/v1`, origins: ["http://127.0.0.1:8000"] });
  const corsBase = await listen(cors);
  r = await fetch(`${corsBase}/v1/models`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:8000", "access-control-request-method": "GET" } });
  assert.equal(r.status, 204, "preflight is answered");
  assert.equal(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:8000");
  r = await fetch(`${corsBase}/v1/models`, { headers: { origin: "http://127.0.0.1:8000" } });
  assert.equal(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:8000", "real responses carry it too");
  r = await fetch(`${corsBase}/v1/models`, { headers: { origin: "https://evil.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null, "other origins get no CORS headers");

  const prefill = [{ role: "user", content: "hi" }, { role: "assistant", content: "Once" }];
  const prefillAsk = (base) => fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: prefill }) });
  picky = true;
  const learning = createGateway({ upstream: `${upstream}/v1`, log: (line) => lines.push(line) });
  const learningBase = await listen(learning);
  calls.length = 0;
  r = await prefillAsk(learningBase);
  assert.equal(r.status, 200, "a rejected trailing assistant message is retried with a user turn");
  assert.deepEqual(calls.map((c) => c.body.messages.length), [2, 3]);
  assert.deepEqual(calls[1].body.messages.at(-1), { role: "user", content: "Continue." });
  calls.length = 0;
  await prefillAsk(learningBase);
  assert.deepEqual(calls.map((c) => c.body.messages.length), [3], "learned: the next one goes out once, already fixed");
  picky = false;
  const tolerant = createGateway({ upstream: `${upstream}/v1` });
  calls.length = 0;
  await prefillAsk(await listen(tolerant));
  assert.deepEqual(calls.map((c) => c.body.messages.length), [2], "an upstream that accepts prefills never gets the extra turn");

  const keyless = createGateway({ upstream: `${upstream}/v1` });
  calls.length = 0;
  await fetch(`${await listen(keyless)}/v1/chat/completions`, { method: "POST", body: JSON.stringify(ask) });
  assert.equal(calls[0].auth, undefined, "no key configured: no Authorization header is sent");

  const down = createGateway({ upstream: "http://127.0.0.1:9", key: "k", retries: 1, sleep: async () => {} });
  r = await fetch(`${await listen(down)}/v1/chat/completions`, { method: "POST", body: JSON.stringify(ask) });
  assert.equal(r.status, 502, "an unreachable upstream is a 502 with a message");
  assert.match((await r.json()).error.message, /unreachable/);

  for (const server of [gateway, cors, learning, tolerant, keyless, down, fake]) server.closeAllConnections?.();
  await Promise.all([gateway, cors, learning, tolerant, keyless, down, fake].map((server) => new Promise((resolve) => server.close(resolve))));
  console.log("gateway self-test passed");
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { UPSTREAM_URL, UPSTREAM_KEY, MODEL, BODY, RETRIES, ORIGINS = "http://127.0.0.1:8000,http://localhost:8000", HOST = "127.0.0.1", PORT = "8789" } = process.env;
  if (!UPSTREAM_URL) {
    console.error("gateway: set UPSTREAM_URL (see .gateway.env.example)");
    process.exit(1);
  }
  const server = createGateway({
    upstream: UPSTREAM_URL.replace(/\/+$/, ""),
    key: UPSTREAM_KEY || undefined,
    model: MODEL || undefined,
    body: BODY ? JSON.parse(BODY) : {},
    retries: RETRIES === undefined ? 2 : Number(RETRIES),
    origins: ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    log: (line) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`),
  });
  server.listen(Number(PORT), HOST, () => console.log(`gateway: ${HOST}:${PORT} -> ${UPSTREAM_URL}${MODEL ? ` (model ${MODEL})` : ""}`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
