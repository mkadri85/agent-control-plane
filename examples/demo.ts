/**
 * A runnable demo. Simulates a small fleet and shows the control plane catching
 * a rogue agent live in the terminal.
 *
 *   npm run demo
 */
import {
  controlPlane,
  loopDetector,
  costRunawayDetector,
  errorRateDetector,
  driftDetector,
  type Actions,
  type Health,
  type Remediation,
  type WrappedAgent,
  type ObservableEvent,
} from "../src/index.js";

// --- tiny terminal styling (no deps) ---
const style = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- action layer: in this demo we just narrate what would happen ---
const actions: Actions = {
  reroute: (id, d) => console.log(style.cyan(`    -> reroute ${id}: ${d ?? "switch to fallback model"}`)),
  rollback: (id, d) => console.log(style.cyan(`    -> rollback ${id}: ${d ?? "last known-good version"}`)),
  pause: (id, d) => console.log(style.yellow(`    -> pause ${id}: ${style.dim(d ?? "")}`)),
};

// map a diagnosis to a proposed fix: a loop is a known-safe reroute, everything
// else is a pause the gate can choose to auto-apply or escalate
function planRemediation(health: Health): Remediation {
  const reasons = health.reasons.join(" ");
  if (reasons.includes("looping")) return { kind: "reroute", detail: "known loop, switch model" };
  return { kind: "pause", detail: reasons };
}

const plane = controlPlane({
  detectors: [
    loopDetector({ repeats: 4 }),
    costRunawayDetector({ maxTokens: 5000 }),
    errorRateDetector({ threshold: 0.6 }),
    driftDetector(),
  ],
  actions,
  gate: { autoActThreshold: 0.8, autoAllow: ["reroute", "pause"] },
  planRemediation,
  onEscalate: ({ agentId, health, replay }) => {
    console.log(style.red(style.bold(`    ESCALATE ${agentId} -> human`)));
    console.log(style.red(`    why: ${health.reasons.join("; ")} (confidence ${health.confidence.toFixed(2)})`));
    console.log(style.dim(`    handing over the last ${Math.min(6, replay.length)} of ${replay.length} recorded decisions:`));
    for (const e of replay.slice(-6)) {
      const t = new Date(e.ts).toISOString().slice(11, 19);
      console.log(style.dim(`      ${t}  ${e.type.padEnd(15)} ${(e.tool ?? "").padEnd(8)} ${e.ok ? "ok " : "ERR"}  ${e.tokens ?? 0} tok`));
    }
  },
});

function report(agent: WrappedAgent, event: ObservableEvent, label: string) {
  const { allowed, decision } = agent.observe(event);
  const tag = allowed ? style.green("allowed ") : style.red("stopped ");
  const note = decision.action === "allow" ? "" : style.dim(`  [${decision.action}: ${decision.reason}]`);
  console.log(`    ${tag} ${label}${note}`);
}

async function main() {
  console.log(style.bold("\n  agent-control-plane  ") + style.dim("live demo\n"));

  // 1. A healthy agent just works.
  console.log(style.bold("  agent-01 ") + style.dim("healthy: three clean tool calls"));
  const a1 = plane.wrap("agent-01");
  for (let i = 0; i < 3; i++) report(a1, { type: "tool_call", tool: "search", ok: true, tokens: 120 }, `call ${i + 1}`);
  await sleep(300);

  // 2. A looping agent: high confidence, known-safe fix -> the loop closes itself.
  console.log(style.bold("\n  agent-04 ") + style.dim("starts looping on a failing tool"));
  const a4 = plane.wrap("agent-04");
  for (let i = 0; i < 4; i++) {
    report(a4, { type: "tool_call", tool: "search", ok: false, tokens: 200 }, `retry ${i + 1}`);
    await sleep(180);
  }

  // 3. Subtle quality drift: ambiguous, low confidence -> escalate to a human.
  console.log(style.bold("\n  agent-09 ") + style.dim("output quality quietly drifting"));
  const a9 = plane.wrap("agent-09");
  const drift = [true, false, true, false];
  for (let i = 0; i < drift.length; i++) {
    report(a9, { type: "model_response", ok: drift[i], tokens: 300 }, `response ${i + 1}`);
    await sleep(180);
  }

  // 4. Cost runaway: high confidence, safe fix -> auto-paused, no human needed.
  console.log(style.bold("\n  agent-07 ") + style.dim("burning tokens far past its budget"));
  const a7 = plane.wrap("agent-07");
  report(a7, { type: "model_response", ok: true, tokens: 12000 }, "one very expensive step");
  await sleep(300);

  // 5. The kill switch stops the whole fleet, no deploy required.
  console.log(style.bold("\n  kill switch ") + style.dim("tripped for the whole fleet"));
  plane.killSwitch.trip("global");
  report(a1, { type: "tool_call", tool: "search", ok: true, tokens: 120 }, "agent-01 tries another call");

  console.log(style.dim("\n  Every decision above is in the signal plane and can be replayed.\n"));
}

void main();
