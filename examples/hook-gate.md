# Gate harness tool calls with Jev hooks

Agent harnesses intercept their own tool calls: a `PreToolUse` hook sees every
proposed action before it runs and can allow, deny, or escalate it. This
source-checkout example connects that interception point to `jev_decide`, so a
written policy — not a hand-written regex list — decides which calls are too
dangerous to run silently. The judgment happens out of band: it adds nothing to
the conversation, and every tool call that does not match the harness matcher
never pays for it.

The same runner serves Claude Code and Codex, which share the hook wire
protocol (a `PreToolUse` JSON payload on stdin, a
`hookSpecificOutput.permissionDecision` verdict on stdout). OpenCode and pi
intercept in-process; their wrappers below shell out to the same script.

## How the gate routes

Speed comes from routing, quality from the judgment; each layer only handles
what the previous one could not:

1. **The harness matcher is the free router.** Scope the hook to the tools
   worth judging (`Bash`, `Write`, `Edit`, MCP tools). Everything else never
   starts a process.
2. **Local rules defer before any model call.** `--skip` regexes match
   obviously safe shapes (`^Bash git status`), and inputs over 4,000 characters
   defer: both print nothing and exit 0, so the harness's own permission flow
   applies at zero cost.
3. **One `jev_decide` call** — candidates `proceed`/`block`, escape hatches on,
   your policy in `priorities`, the tool call framed as untrusted facts —
   judges exactly what matched.
4. **A verdict is emitted only on a confident, valid judgment.** `deny` needs
   `block` selected with probability at or above `--block-threshold`
   (default 0.85). Everything else prints nothing and exits 0: provider
   errors, timeouts, `invalid_response`, and escapes to `investigate`/`none`
   all defer to the harness's own permission system. A Jev outage never
   blocks the agent, and the gate never fabricates an allow.

This is the same shape as the LLM routing literature: the matcher is the cheap
router, Jev's Choice distribution is the quality estimator, and the deny
threshold is the cost dial. Raise it to deny less, lower it toward 0.5 to deny
more; like any threshold, tune it against your own traffic, not a benchmark.

## Quick start

```sh
npm ci
# Inspect the constructed judgment without any credentials:
node examples/hook-gate.mjs --policy "No force pushes. Never touch the production database." \
  --dry-run < examples/hook-gate-sample.json

# Live (needs TYPESAFE_API_KEY, or a configured JEV_PROVIDER):
node examples/hook-gate.mjs --policy-file policy.md < examples/hook-gate-sample.json
```

`--policy` / `--policy-file` carry the policy (bounded at 2,000 characters to
fit `jev_decide` priorities). `--ask` maps the `ask_user` escape hatch to
`permissionDecision: "ask"` (Claude Code only — Codex reports `ask` as an
unsupported verdict and continues the call). `--allow-threshold` opts into
auto-allowing confidently safe calls; it is off by default because `allow`
bypasses the harness's own permission prompt. `--timeout-ms` (default 15,000)
bounds the judgment; on timeout the gate defers.

The deny reason is shown to the model as feedback, so it names the measured
probability, the threshold, and the first line of the policy, and asks for a
compliant alternative. The MCP client forwards only the Jev environment it
needs (provider, credentials, optional `JEV_MCP_MODEL`); nothing else from the
hook's environment reaches the subprocess.

## Claude Code

`.claude/settings.json` in the project (or `~/.claude/settings.json`):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/jev-mcp/examples/hook-gate.mjs --policy-file /path/to/policy.md",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Keep the harness `timeout` above `--timeout-ms` so the gate defers first and
the harness never kills a hook that was about to defer anyway. `deny` reasons
reach the model; `allow` and `ask` reasons are shown to the user.

## Codex

`~/.codex/hooks.json` (or inline `[hooks]` tables in `config.toml`):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/jev-mcp/examples/hook-gate.mjs --policy-file /path/to/policy.md",
            "timeout": 30,
            "statusMessage": "Checking tool call with Jev"
          }
        ]
      }
    ]
  }
}
```

Codex requires reviewing and trusting each hook in `/hooks` before it runs,
re-trusting on every change; do not enable `--ask` here, as Codex reports
`ask` verdicts as hook errors and continues the call. A no-verdict exit 0 is
Codex's documented non-decision path and falls back to its approval flow.

## OpenCode

OpenCode plugins intercept in-process. Create
`.opencode/plugins/jev-gate.ts` that shells out to the same runner and throws
to block:

```ts
import { spawn } from "node:child_process"

export const JevGate = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: input.tool, tool_input: output.args })
      const child = spawn(process.execPath, ["/path/to/jev-mcp/examples/hook-gate.mjs", "--policy-file", "/path/to/policy.md"])
      let stdout = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stdin.end(payload)
      const code = await new Promise((resolve) => child.on("close", resolve))
      if (code === 0 && stdout.trim()) {
        const verdict = JSON.parse(stdout).hookSpecificOutput
        if (verdict?.permissionDecision === "deny") throw new Error(verdict.permissionDecisionReason)
      }
    },
  }
}
```

Note that OpenCode's `tool.execute.before` has historically not fired for MCP
tool calls, only built-in tools; check the current behavior on your version.

## pi

pi extensions return `{ block, reason }` from the `tool_call` event. Create
`~/.pi/extensions/jev-gate.ts` (or a project extension) with the same spawn
pattern:

```ts
import { spawn } from "node:child_process"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: event.toolName, tool_input: event.input })
    const child = spawn(process.execPath, ["/path/to/jev-mcp/examples/hook-gate.mjs", "--policy-file", "/path/to/policy.md"])
    let stdout = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stdin.end(payload)
    await new Promise((resolve) => child.on("close", resolve))
    if (stdout.trim()) {
      const verdict = JSON.parse(stdout).hookSpecificOutput
      if (verdict?.permissionDecision === "deny") return { block: true, reason: verdict.permissionDecisionReason }
    }
  })
}
```

## Honesty and calibration

A policy gate is not a security boundary: it is one judgment layer in front of
the harness's own permission system, and a determined process can sometimes
talk past a judge. The tool call text is untrusted input framed as facts, but
framing is mitigation, not a guarantee.

Before trusting a threshold, run a small reproducible experiment: capture real
hook payloads (the `--dry-run` output shape), label each with your own
allow/block/unsure call, then sweep `--block-threshold` and count false denies
(calls blocked that should have run) and misses (calls that ran but should
have been blocked). Repeat with a pinned `JEV_MCP_MODEL` before making claims;
a tiny sample is only a smoke test. Expect roughly a second per judged call —
process spawn plus one Jev round trip — which is why the matcher and `--skip`
layers exist: judge the few, not the many.

Offline adapter checks run as part of `npm test`. They use controlled
responses and establish integration behavior, not model accuracy; no quality
or latency benchmark is claimed by the fixtures.
