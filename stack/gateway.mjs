// An OpenAI-compatible chat endpoint for SillyTavern in front of any OpenAI-compatible upstream: ST always talks to http://gateway:8789/v1,
// and the upstream address and key live in the environment. Models and request parameters pass through from ST.
//   UPSTREAM_URL  base URL, e.g. https://openrouter.ai/api/v1            (required)
//   UPSTREAM_KEY  bearer key; leave it empty for an upstream that needs none (cpa)
//   RETRIES       extra attempts on 429/502/503/504 and network errors (default 2)
//   HOST, PORT    listen address (default 127.0.0.1:8789)
// usage: gateway.mjs | --self-test
//
// Keep this a thin relay. Add a feature only for a failure seen in real use, and put it in the shared path (forward, chat), not in a
// per-caller special case. Before adding code, check whether deleting or passing the request through unchanged solves it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const ENDS_WITH_MODEL_TURN = /ending with a model turn/i;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const contentType = (response) => ({ "content-type": response.headers.get("content-type") ?? "application/json" });

// What the log line says about an answer, read from a whole response or from each stream chunk. Upstreams that send no usage
// still show how much reasoning text came back (think, in characters).
function collect(stats, json) {
  if (json?.usage) stats.usage = json.usage;
  const choice = json?.choices?.[0];
  if (choice?.finish_reason) stats.finish = choice.finish_reason;
  const part = choice?.delta ?? choice?.message;
  stats.think += (part?.reasoning_content ?? part?.reasoning ?? "").length;
}

// reasoning= is shown only when the upstream reports it: cpa leaves it out when it did not think, and some models report tokens
// but return no thinking text, so think= alone says nothing about whether the model thought.
function describe(payload, { usage, finish, think }) {
  const effort = payload.reasoning_effort ?? payload.reasoning?.effort;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return [
    effort && `effort=${effort}`,
    usage && `in=${usage.prompt_tokens} out=${usage.completion_tokens}`,
    reasoning !== undefined && `reasoning=${reasoning}`,
    think && `think=${think}ch`,
    finish && `finish=${finish}`,
  ].filter(Boolean).map((part) => ` ${part}`).join("");
}

function tapStream(stats) {
  const decoder = new StringDecoder("utf8");
  let tail = "";
  return new Transform({
    transform(chunk, _encoding, done) {
      const lines = (tail + decoder.write(chunk)).split("\n");
      tail = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: {")) continue;
        try {
          collect(stats, JSON.parse(line.slice(6)));
        } catch {}
      }
      done(null, chunk);
    },
  });
}

export function createGateway({ upstream, key, retries = 2, sleep = wait, log = () => {} }) {
  const headers = { ...(key && { authorization: `Bearer ${key}` }), "content-type": "application/json" };
  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const unreachable = (error) => ({ error: { message: `upstream unreachable: ${error.message}` } });

  async function forward(payload, signal) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(`${upstream}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload), signal });
      } catch (error) {
        if (signal.aborted || attempt >= retries) throw error;
        log(`retry ${attempt + 1}/${retries}: ${error.message}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      // Gemini (through cpa) sometimes answers 200 with no choices at all and 0 completion tokens; the same request usually works again.
      // A choice with no content ('prohibited_content', 'safety') is the upstream's filter: it varies from call to call, so it is asked for again too.
      const answer = response.status === 200 && !payload.stream ? await response.clone().json().catch(() => null) : null;
      const choice = answer?.choices?.[0];
      const reason = choice?.finish_reason ?? "unknown";
      const blocked = Boolean(choice) && !choice.message?.content && !choice.message?.tool_calls?.length;
      const why = RETRY_STATUS.has(response.status) ? response.status : answer?.choices?.length === 0 ? "empty completion" : blocked ? `finish_reason=${reason}` : null;
      if (!why) return response;
      if (attempt >= retries) {
        if (!blocked) return response;
        // Passed on as an error: ST shows its message, where an empty reply would say nothing about why.
        log(`blocked: finish_reason=${reason}`);
        return new Response(JSON.stringify({ error: { message: `上游没有返回内容 (finish_reason: ${reason})`, type: "empty_completion", finish_reason: reason } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      await response.arrayBuffer();
      log(`retry ${attempt + 1}/${retries}: ${why}`);
      await sleep(Math.min(Number(response.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt, 10_000));
    }
  }

  // Gemini answers a request that ends with an assistant message (a prefill, a script's "continue") with 400; learned from the first
  // such answer, so upstreams that accept prefills never get the extra turn. The model then answers anew rather than continuing exactly.
  const needsUserTurn = new Set();
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
    // custom_include_body is commonly prefilled with a reasoning_effort slot set to '' so it can be edited on a phone; '' or null
    // means "not set" and must not reach the upstream, which rejects non-enum values. Valid slots ({reasoning: {enabled: ...}}) stay.
    if (!payload.reasoning_effort) delete payload.reasoning_effort;
    if (payload.reasoning && !payload.reasoning.effort) delete payload.reasoning.effort;
    const started = Date.now();
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    let response;
    try {
      if (needsUserTurn.has(payload.model)) payload.messages = withUserTurn(payload.messages);
      response = await forward(payload, controller.signal);
      if (response.status === 400 && !needsUserTurn.has(payload.model) && endsWithAssistant(payload.messages) && ENDS_WITH_MODEL_TURN.test(await response.clone().text())) {
        needsUserTurn.add(payload.model);
        log(`${payload.model} rejects a trailing assistant message: appending a user turn from now on`);
        payload.messages = withUserTurn(payload.messages);
        response = await forward(payload, controller.signal);
      }
    } catch (error) {
      log(`${payload.model} unreachable: ${error.message}`);
      return send(res, 502, unreachable(error));
    }
    res.writeHead(response.status, contentType(response));
    const stats = { usage: undefined, finish: undefined, think: 0 };
    const done = () => log(`${payload.model} ${response.status} ${((Date.now() - started) / 1000).toFixed(1)}s${payload.stream ? " (stream)" : ""}${describe(payload, stats)}`);
    if (payload.stream) {
      // A stream the upstream breaks off leaves nothing in ST but a shorter reply; the client closing it (the stop button) is no news.
      await pipeline(Readable.fromWeb(response.body), tapStream(stats), res).catch((error) => {
        if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") log(`${payload.model} stream cut: ${error.cause?.message ?? error.message}`);
      });
      return done();
    }
    const text = await response.text();
    res.end(text);
    try {
      collect(stats, JSON.parse(text));
    } catch {}
    done();
  }

  async function models(req, res) {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const query = new URL(req.url, "http://gateway").search;
      const response = await fetch(`${upstream}/models${query}`, { headers, signal: controller.signal });
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, contentType(response));
      res.end(body);
    } catch (error) {
      if (!res.destroyed) send(res, 502, unreachable(error));
    }
  }

  return createServer((req, res) => {
    // tradeoff: any web page the user opens can call this port; the port is open to the LAN without auth anyway. Allow-list origins if that changes.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    const path = (req.url ?? "").split("?")[0].replace(/^\/v1(?=\/)/, "");
    if (req.method === "GET" && path === "/models") return models(req, res);
    if (req.method === "POST" && path === "/chat/completions") return chat(req, res).catch((error) => res.headersSent || send(res, 500, { error: { message: error.message } }));
    send(res, 404, { error: { message: `no route ${req.method} ${path}` } });
  });
}

if (process.argv.includes("--self-test")) {
  // Only branches that fail silently (retry and blocked-answer handling, prefill learning, stream log parsing). Not the HTTP plumbing
  // (CORS, routes, /models, 502, keys): that is node's, and a break shows in ST at once.
  // A case needs a failure that would otherwise go unnoticed, not just a feature that exists. To cover a new bug, extend an existing
  // case by one assertion before adding a case, and drop a case whose branch no longer exists.
  const calls = [];
  const plan = [];
  let picky = false;
  const reply = (res, status, payload) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  const fake = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push(body);
    if (picky && body.model !== "tolerant" && body.messages.at(-1).role === "assistant") return reply(res, 400, { error: { message: "Requests ending with a model turn are not supported." } });
    const step = plan.shift() ?? 200;
    if (step === "empty") return reply(res, 200, { choices: [] });
    if (step === "blocked") return reply(res, 200, { choices: [{ message: { content: null }, finish_reason: "prohibited_content" }] });
    if (step !== 200) return reply(res, step, { error: { message: `fake ${step}` } });
    if (body.stream) {
      res.write('data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n');
      return res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":9,"completion_tokens_details":{"reasoning_tokens":7}}}\n\ndata: [DONE]\n\n');
    }
    reply(res, 200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  const lines = [];
  const sleeps = [];
  const gateway = createGateway({ upstream: `${await listen(fake)}/v1`, key: "k", sleep: async (ms) => sleeps.push(ms), log: (line) => lines.push(line) });
  const base = await listen(gateway);
  const ask = async (payload, ...steps) => {
    calls.length = 0;
    plan.push(...steps);
    return fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], ...payload }) });
  };

  let r = await ask({ reasoning_effort: "low", custom: { nested: [1, null] } });
  assert.equal((await r.json()).choices[0].message.content, "ok");
  assert.equal(calls[0].custom.nested.length, 2, "request parameters pass through");
  assert.match(lines.at(-1), /^m 200 [\d.]+s effort=low in=12 out=3 finish=stop$/, "reasoning= is left out when the upstream does not report it");

  r = await ask({ reasoning_effort: "", reasoning: { enabled: true, effort: "" } });
  assert.equal(calls[0].reasoning_effort, undefined, "an empty reasoning_effort is the unset slot, not sent to the upstream");
  assert.deepEqual(calls[0].reasoning, { enabled: true }, "a reasoning object keeps its valid members when effort is empty");

  r = await ask({}, 429, 503);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 3, "two retryable failures, then success");
  assert.deepEqual(sleeps, [1000, 2000], "backoff doubles");
  r = await ask({}, 429, 429, 429);
  assert.equal(r.status, 429, "the upstream's answer is passed through when retries run out");
  assert.equal(calls.length, 3);
  await ask({}, 400);
  assert.equal(calls.length, 1, "other errors are not retried");

  r = await ask({}, "empty");
  assert.equal((await r.json()).choices[0].message.content, "ok", "an empty completion is asked for again");
  r = await ask({}, "blocked");
  assert.equal((await r.json()).choices[0].message.content, "ok", "a filtered answer is asked for again");
  r = await ask({}, "blocked", "blocked", "blocked");
  assert.match((await r.json()).error.message, /prohibited_content/, "when the retries run out the reason goes to the user, not an empty reply");
  await (await ask({ stream: true }, "empty")).text();
  assert.equal(calls.length, 1, "a stream is never inspected or retried");

  r = await ask({ stream: true });
  assert.match(await r.text(), /data: \[DONE\]/, "streams pass through");
  assert.match(lines.at(-1), /\(stream\) in=5 out=9 reasoning=7 think=3ch finish=stop$/, "a stream's usage, reasoning text and finish reason are logged");

  const prefill = [{ role: "user", content: "hi" }, { role: "assistant", content: "Once" }];
  const lengths = async (model) => {
    await (await ask({ model, messages: prefill })).text();
    return calls.map((call) => call.messages.length);
  };
  assert.deepEqual(await lengths("m"), [2], "an upstream that accepts prefills never gets the extra turn");
  picky = true;
  assert.deepEqual(await lengths("m"), [2, 3], "a rejected trailing assistant message is retried with a user turn");
  assert.deepEqual(await lengths("m"), [3], "learned: the next one goes out once, already fixed");
  assert.deepEqual(await lengths("tolerant"), [2], "a rejection by one model does not change requests to another");

  for (const server of [gateway, fake]) server.closeAllConnections?.();
  await Promise.all([gateway, fake].map((server) => new Promise((resolve) => server.close(resolve))));
  console.log("gateway self-test passed");
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { UPSTREAM_URL, UPSTREAM_KEY, RETRIES, HOST = "127.0.0.1", PORT = "8789" } = process.env;
  if (!UPSTREAM_URL) {
    console.error("gateway: set UPSTREAM_URL in gateway.env (see README.md)");
    process.exit(1);
  }
  const server = createGateway({
    upstream: UPSTREAM_URL.replace(/\/+$/, ""),
    key: UPSTREAM_KEY || undefined,
    retries: RETRIES === undefined ? 2 : Number(RETRIES),
    log: (line) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`),
  });
  server.listen(Number(PORT), HOST, () => console.log(`gateway: ${HOST}:${PORT} -> ${UPSTREAM_URL}`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
