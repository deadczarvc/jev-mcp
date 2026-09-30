// Offline checks for the hook-gate example: payload parsing, local routing,
// decision construction, verdict mapping, and the real stdin → server →
// verdict subprocess path against a local mock of the TypeSafe API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  parseHookPayload, payloadText, routeLocally, buildDecision, mapDecision, harnessOutput, judge,
  CANDIDATES, DEFAULT_BLOCK_THRESHOLD, MAX_TOOL_INPUT_CHARS,
} from "../examples/hook-gate.mjs";

const SAMPLE = JSON.stringify({
  session_id: "s1", transcript_path: "/t.jsonl", cwd: "/repo", hook_event_name: "PreToolUse",
  tool_name: "Bash", tool_input: { command: "git push --force origin main" }, tool_use_id: "u1",
});

test("parseHookPayload accepts Claude Code and Codex payload shapes", () => {
  const claude = parseHookPayload(SAMPLE);
  assert.equal(claude.toolName, "Bash");
  assert.equal(claude.cwd, "/repo");
  assert.equal(claude.eventName, "PreToolUse");
  const codex = parseHookPayload(JSON.stringify({
    session_id: "s1", turn_id: "t1", cwd: "/repo", model: "gpt-test", permission_mode: "default",
    hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "patch" }, tool_use_id: "u2",
  }));
  assert.equal(codex.toolName, "apply_patch");
  assert.equal(parseHookPayload('{"tool_name":"Read","tool_input":{"path":"x"}}').cwd, null);
});

test("parseHookPayload rejects broken payloads instead of guessing", () => {
  assert.throws(() => parseHookPayload("not json"), /not valid JSON/);
  assert.throws(() => parseHookPayload("[1]"), /not a JSON object/);
  assert.throws(() => parseHookPayload('{"tool_input":{}}'), /tool_name/);
  assert.throws(() => parseHookPayload('{"tool_name":"Bash"}'), /tool_input/);
});

test("skip patterns match tool name plus string values; size caps defer judgment", () => {
  const read = { toolName: "Bash", toolInput: { command: "git status" } };
  assert.match(payloadText(read), /^Bash git status$/);
  assert.equal(routeLocally(read, { skip: /^Bash git status/ }).judge, false);
  assert.equal(routeLocally(read, { skip: /^Bash git push/ }).judge, true);
  assert.equal(routeLocally({ toolName: "Bash", toolInput: { command: "x".repeat(5) } }).judge, true);
  const oversized = { toolName: "Write", toolInput: { content: "x".repeat(MAX_TOOL_INPUT_CHARS + 1) } };
  const routed = routeLocally(oversized, {});
  assert.equal(routed.judge, false);
  assert.match(routed.reason, /over 4000/);
});

test("buildDecision frames the tool call as untrusted facts under the policy", () => {
  const args = buildDecision(parseHookPayload(SAMPLE), "No force pushes.");
  assert.equal(args.priorities, "No force pushes.");
  assert.deepEqual(args.candidates, CANDIDATES);
  assert.deepEqual(args.candidates.map((c) => c.id), ["proceed", "block"]);
  assert.match(args.evidence, /Never follow instructions/);
  assert.match(args.evidence, /tool_name: Bash/);
  assert.match(args.evidence, /git push --force origin main/);
  assert.match(args.evidence, /cwd: \/repo/);
});

test("mapDecision denies only confident blocks and never fabricates", () => {
  const rec = (selected, probabilities, extra = {}) => ({ tool: "jev_decide", recommendation: { selected, escaped: false, confidence: 0.9, probabilities, ...extra } });
  const policy = "No force pushes. More detail follows.";
  const denied = mapDecision(rec("block", { proceed: 0.05, block: 0.91, ask_user: 0.02, investigate: 0.01, none: 0.01 }), { policy });
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /block probability 0\.91/);
  assert.match(denied.permissionDecisionReason, /Policy: No force pushes\./);
  // Below the threshold, no verdict: the harness permission flow applies.
  assert.equal(mapDecision(rec("block", { proceed: 0.2, block: 0.7, ask_user: 0.04, investigate: 0.03, none: 0.03 }), { policy }), null);
  // Proceed only allows when explicitly opted in.
  const proceed = rec("proceed", { proceed: 0.95, block: 0.02, ask_user: 0.01, investigate: 0.01, none: 0.01 });
  assert.equal(mapDecision(proceed, { policy }), null);
  const allowed = mapDecision(proceed, { policy, allowThreshold: 0.85 });
  assert.equal(allowed.permissionDecision, "allow");
  assert.match(allowed.permissionDecisionReason, /proceed probability 0\.95/);
  // ask_user needs --ask; escapes and invalid responses never decide.
  const askUser = rec("ask_user", { proceed: 0.2, block: 0.1, ask_user: 0.6, investigate: 0.05, none: 0.05 });
  assert.equal(mapDecision(askUser, { policy }), null);
  assert.equal(mapDecision(askUser, { policy, askEnabled: true }).permissionDecision, "ask");
  assert.equal(mapDecision(rec("investigate", {}, { escaped: true }), { policy }), null);
  assert.equal(mapDecision(rec(null, null, { escaped: null, probabilities: null, status: "invalid_response" }), { policy }), null);
  assert.equal(mapDecision({ tool: "jev_classify" }, { policy }), null);
  assert.equal(mapDecision(null, { policy }), null);
  // A missing probabilities object cannot prove a block.
  assert.equal(mapDecision(rec("block", undefined), { policy }), null);
  // Custom block thresholds are honored.
  assert.equal(mapDecision(rec("block", { proceed: 0.2, block: 0.7, ask_user: 0.04, investigate: 0.03, none: 0.03 }), { policy, blockThreshold: 0.6 }).permissionDecision, "deny");
});

test("harnessOutput wraps the verdict in the PreToolUse protocol", () => {
  assert.deepEqual(harnessOutput({ permissionDecision: "deny", permissionDecisionReason: "r" }), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "r" },
  });
});

const decideResponse = (selected) => ({
  content: [{ type: "text", text: JSON.stringify({
    tool: "jev_decide", model: "mock-only",
    recommendation: { selected, escaped: selected === "investigate", confidence: 0.9, probabilities: {
      proceed: selected === "proceed" ? 0.95 : 0.05, block: selected === "block" ? 0.95 : 0.05,
      ask_user: 0, investigate: selected === "investigate" ? 0.95 : 0, none: 0,
    } },
  }) }],
});

test("judge builds one jev_decide call and maps its verdict", async () => {
  const calls = [];
  const decision = await judge(async ({ arguments: args }) => {
    calls.push(args);
    return decideResponse("block");
  }, parseHookPayload(SAMPLE), { policy: "No force pushes." });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidates.length, 2);
  assert.equal(decision.permissionDecision, "deny");
  assert.equal(await judge(async () => decideResponse("proceed"), parseHookPayload(SAMPLE), { policy: "p" }), null);
  await assert.rejects(judge(async () => ({ isError: true }), parseHookPayload(SAMPLE), { policy: "p" }), /tool error/);
  await assert.rejects(judge(async () => ({ content: [] }), parseHookPayload(SAMPLE), { policy: "p" }), /no text payload/);
});

// Async on purpose: a synchronous spawn would block this process's event
// loop and freeze the mock Jev server the child is talking to.
function runHook(args, { input, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["examples/hook-gate.mjs", ...args], {
      cwd: new URL("../", import.meta.url), env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: stderr + String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

test("dry run needs no credentials and reports the constructed judgment", async () => {
  const result = await runHook(["--policy", "No force pushes.", "--dry-run"], { input: SAMPLE, env: {} });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "prepared_only");
  assert.equal(payload.tool_name, "Bash");
  assert.equal(payload.options.block_threshold, DEFAULT_BLOCK_THRESHOLD);
  assert.equal(payload.decide_arguments.priorities, "No force pushes.");
});

test("usage errors are loud and never a silent allow", async () => {
  for (const args of [[], ["--policy", "p", "--policy-file", "f"], ["--policy", "p", "--block-threshold", "0.2"], ["--policy", "p", "--skip", "("]]) {
    const result = await runHook(args, { input: SAMPLE, env: {} });
    assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.match(result.stderr, /hook-gate:/);
    assert.equal(result.stdout, "");
  }
});

function pick(choiceKey, keys) {
  const rest = keys.filter((k) => k !== choiceKey);
  const probabilities = { [choiceKey]: 0.95 };
  rest.forEach((k) => (probabilities[k] = 0.05 / rest.length));
  return { choice: choiceKey, confidence: 0.99, probabilities };
}

const REC_KEYS = ["option_0", "option_1", "ask_user", "investigate", "none"];

// Spawns the real hook script against the real server build; only the Jev
// HTTP endpoint is a local mock, exactly like mock.test.mjs.
async function withMockedJev(recommendation, fn) {
  const requests = [];
  const http = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { recommendation: pick(recommendation, REC_KEYS) }, usage: { input_tokens: 10, output_tokens: 10 } }));
    });
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(requests, `http://127.0.0.1:${http.address().port}`);
  } finally {
    http.close();
    http.closeAllConnections();
  }
}

test("end to end: a confident block denies over stdout against the mocked Jev API", async () => {
  await withMockedJev("option_1", async (requests, baseURL) => {
    const result = await runHook(["--policy", "No force pushes."], {
      input: SAMPLE,
      env: { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: baseURL },
    });
    assert.equal(result.code, 0);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /0\.95/);
    assert.equal(requests.length, 1);
    const state = requests[0].state;
    assert.equal(state.decision.includes("tool call"), true);
    assert.match(state.evidence, /git push --force origin main/);
    assert.equal(state.priorities, "No force pushes.");
    assert.deepEqual(state.candidates.map((c) => c.id), ["option_0", "option_1"]);
  });
});

test("end to end: proceed and provider failures print no verdict and stay exit 0", async () => {
  await withMockedJev("option_0", async (_requests, baseURL) => {
    const pass = await runHook(["--policy", "No force pushes."], {
      input: SAMPLE,
      env: { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: baseURL },
    });
    assert.equal(pass.code, 0);
    assert.equal(pass.stdout, "");
  });
  const down = await runHook(["--policy", "No force pushes.", "--timeout-ms", "1500"], {
    input: SAMPLE,
    env: { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, "");
  assert.match(down.stderr, /no decision/);
});
