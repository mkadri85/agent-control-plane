import { describe, it, expect, vi } from "vitest";
import {
  controlPlane,
  confidenceGate,
  loopDetector,
  driftDetector,
  SignalPlane,
  type Actions,
  type Health,
  type EscalationContext,
} from "../src/index.js";

function noopActions(): Actions {
  return { reroute: vi.fn(), rollback: vi.fn(), pause: vi.fn() };
}

describe("SignalPlane", () => {
  it("records and replays per agent, oldest first", () => {
    const sp = new SignalPlane();
    sp.record({ agentId: "a", ts: 1, type: "tool_call", ok: true });
    sp.record({ agentId: "b", ts: 2, type: "tool_call", ok: true });
    sp.record({ agentId: "a", ts: 3, type: "error", ok: false });
    const a = sp.replay("a");
    expect(a).toHaveLength(2);
    expect(a[0]?.ts).toBe(1);
    expect(a[1]?.type).toBe("error");
  });

  it("honours capacity by dropping the oldest event", () => {
    const sp = new SignalPlane({ capacity: 2 });
    sp.record({ agentId: "a", ts: 1, type: "tool_call", ok: true });
    sp.record({ agentId: "a", ts: 2, type: "tool_call", ok: true });
    sp.record({ agentId: "a", ts: 3, type: "tool_call", ok: true });
    expect(sp.all()).toHaveLength(2);
    expect(sp.replay("a")[0]?.ts).toBe(2);
  });
});

describe("loopDetector", () => {
  const detect = loopDetector({ repeats: 3 });
  const call = (tool: string) => ({ agentId: "a", ts: 0, type: "tool_call" as const, ok: false, tool });

  it("does not fire below the repeat limit", () => {
    expect(detect([call("x"), call("x")])).toBeNull();
  });

  it("fires when the same tool repeats to the limit", () => {
    const f = detect([call("x"), call("x"), call("x")]);
    expect(f?.status).toBe("failing");
    expect(f?.reason).toContain("looping");
  });

  it("does not fire when the tool varies", () => {
    expect(detect([call("x"), call("y"), call("x")])).toBeNull();
  });
});

describe("confidenceGate", () => {
  const gate = confidenceGate({ autoActThreshold: 0.8, autoAllow: ["reroute", "pause"] });
  const failing = (c: number): Health => ({ status: "failing", confidence: c, reasons: ["x"] });

  it("auto-remediates on high confidence and an allowed action", () => {
    const d = gate(failing(0.9), { kind: "reroute" });
    expect(d.action).toBe("auto_remediate");
  });

  it("escalates on low confidence", () => {
    const d = gate(failing(0.4), { kind: "pause" });
    expect(d.action).toBe("escalate");
  });

  it("escalates when the remediation is not auto-allowed, even at high confidence", () => {
    const d = gate(failing(0.99), { kind: "rollback" });
    expect(d.action).toBe("escalate");
  });

  it("allows a healthy agent", () => {
    const d = gate({ status: "healthy", confidence: 1, reasons: [] }, { kind: "pause" });
    expect(d.action).toBe("allow");
  });
});

describe("ControlPlane", () => {
  it("lets a healthy agent proceed", () => {
    const plane = controlPlane({ detectors: [loopDetector()], actions: noopActions(), onEscalate: () => {} });
    const agent = plane.wrap("a");
    const r = agent.observe({ type: "tool_call", tool: "search", ok: true, tokens: 10 });
    expect(r.allowed).toBe(true);
    expect(r.decision.action).toBe("allow");
  });

  it("auto-remediates a loop with a reroute and keeps the agent running", () => {
    const actions = noopActions();
    const plane = controlPlane({
      detectors: [loopDetector({ repeats: 3 })],
      actions,
      planRemediation: () => ({ kind: "reroute" }),
      onEscalate: () => {},
    });
    const agent = plane.wrap("a");
    let last = agent.observe({ type: "tool_call", tool: "s", ok: false });
    last = agent.observe({ type: "tool_call", tool: "s", ok: false });
    last = agent.observe({ type: "tool_call", tool: "s", ok: false });
    expect(last.decision.action).toBe("auto_remediate");
    expect(last.allowed).toBe(true);
    expect(actions.reroute).toHaveBeenCalledOnce();
  });

  it("escalates an ambiguous diagnosis and hands over the replay", () => {
    const escalations: EscalationContext[] = [];
    const actions = noopActions();
    const plane = controlPlane({
      detectors: [driftDetector({ min: 3 })],
      actions,
      onEscalate: (ctx) => escalations.push(ctx),
    });
    const agent = plane.wrap("a");
    agent.observe({ type: "model_response", ok: false });
    agent.observe({ type: "model_response", ok: false });
    const r = agent.observe({ type: "model_response", ok: false });
    expect(r.allowed).toBe(false);
    expect(r.decision.action).toBe("escalate");
    expect(actions.pause).toHaveBeenCalled();
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.replay.length).toBe(3);
  });

  it("blocks every action once the kill switch is tripped", () => {
    const plane = controlPlane({ detectors: [], actions: noopActions(), onEscalate: () => {} });
    const agent = plane.wrap("a");
    plane.killSwitch.trip("global");
    const r = agent.observe({ type: "tool_call", tool: "s", ok: true });
    expect(r.allowed).toBe(false);
    expect(r.decision.action).toBe("blocked");
  });
});
