// Shared by the OpenCode and pi wiring examples. Runtime failures defer;
// only a valid deny from a successful child may block the host tool call.
import { spawn } from "node:child_process";

export function runHookGate(payload, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let failed = false;
    let escalation;
    const fail = () => {
      if (failed) return;
      failed = true;
      child?.kill("SIGTERM");
      escalation = setTimeout(() => { child?.kill("SIGKILL"); resolve(null); }, 3_500);
    };
    const timer = setTimeout(fail, timeoutMs);
    try {
      // A compiled host such as OpenCode has its own CLI as execPath.
      child = spawn("node", args, { stdio: ["pipe", "pipe", "ignore"] });
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (chunk) => {
        if (failed) return;
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 16_384) fail();
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        if (failed || code !== 0) return resolve(null);
        try {
          const v = JSON.parse(stdout).hookSpecificOutput;
          resolve(v?.hookEventName === "PreToolUse" && v.permissionDecision === "deny" &&
            typeof v.permissionDecisionReason === "string" && v.permissionDecisionReason.trim()
            ? v.permissionDecisionReason : null);
        } catch { resolve(null); }
      });
      child.stdin.end(JSON.stringify(payload));
    } catch { fail(); }
  });
}
