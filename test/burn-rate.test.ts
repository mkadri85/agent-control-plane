import { describe, expect, it } from "vitest";
import {
  BurnRateMonitor,
  burnRateDetector,
  controlPlane,
  type Actions,
  type AgentEvent,
} from "../src/index.js";

/** Feed n events at 1s spacing starting at t0; okPattern decides pass/fail. */
function feed(
  m: BurnRateMonitor,
  agentId: string,
  n: number,
  t0: number,
  ok: (i: number) => boolean,
): number {
  let ts = t0;
  for (let i = 0; i < n; i++) {
    ts = t0 + i * 1_000;
    m.record({ agentId, ts, type: "tool_call", ok: ok(i), tool: "t" });
  }
  return ts;
}

const OPTS = {
  tripRatio: 2,
  currentWindowMs: 10_000,
  minCurrentSamples: 5,
  minBaselineSamples: 20,
  baselineFloor: 0.02,
  absoluteCeiling: 0.6,
};

describe("BurnRateMonitor: cold start", () => {
  it("computes no burn rate and stays active below minBaselineSamples", () => {
    const m = new BurnRateMonitor(OPTS);
    const ts = feed(m, "a", 10, 0, (i) => i % 5 !== 0); // 20% failures, but only 10 samples
    const snap = m.snapshot("a", ts);
    expect(snap.burnRate).toBeNull();
    expect(snap.mode).toBe("active");
  });

  it("absolute ceiling still trips during cold start", () => {
    const m = new BurnRateMonitor(OPTS);
    const ts = feed(m, "a", 8, 0, () => false); // 100% failure from birth
    expect(m.mode("a")).toBe("propose_only");
    expect(m.snapshot("a", ts).reason).toContain("ceiling");
  });
});

describe("BurnRateMonitor: burn trip", () => {
  it("latches propose_only when current rate burns 2x past own baseline", () => {
    const m = new BurnRateMonitor(OPTS);
    let demoted = 0;
    m.onDemote(() => demoted++);
    // long healthy history: ~5% failures
    const t1 = feed(m, "a", 60, 0, (i) => i % 20 !== 0);
    expect(m.mode("a")).toBe("active");
    // sudden incident: 40% failures in the current window (well over 2x of ~5%)
    feed(m, "a", 10, t1 + 1_000, (i) => i % 5 > 1);
    expect(m.mode("a")).toBe("propose_only");
    expect(demoted).toBe(1);
    const snap = m.snapshot("a", t1 + 11_000);
    expect(snap.reason).toContain("burn rate");
  });

  it("agents are independent: one agent's burn does not demote another", () => {
    const m = new BurnRateMonitor(OPTS);
    const t1 = feed(m, "a", 60, 0, (i) => i % 20 !== 0);
    feed(m, "b", 60, 0, () => true);
    feed(m, "a", 10, t1 + 1_000, () => false);
    expect(m.mode("a")).toBe("propose_only");
    expect(m.mode("b")).toBe("active");
  });
});

describe("BurnRateMonitor: slow-drift backstop", () => {
  it("a slow ramp that never doubles its own baseline is still caught by the ceiling", () => {
    // degradation slow enough that the trailing baseline keeps up: burn ratio
    // stays under 2, but the absolute level eventually crosses the ceiling.
    const m = new BurnRateMonitor({ ...OPTS, tripRatio: 100 }); // disable ratio path
    let ts = 0;
    let i = 0;
    // ramp failure probability from 0 to 100% over 200 events, deterministically
    for (; i < 200 && m.mode("slow") === "active"; i++) {
      ts = i * 1_000;
      const failEvery = Math.max(1, Math.round(200 / Math.max(1, i))); // denser failures over time
      m.record({ agentId: "slow", ts, type: "tool_call", ok: i % failEvery !== 0 });
    }
    expect(m.mode("slow")).toBe("propose_only");
    expect(m.snapshot("slow", ts).reason).toContain("ceiling");
  });
});

describe("BurnRateMonitor: poisoning guards", () => {
  it("freezes baseline learning while burn rate is elevated", () => {
    const m = new BurnRateMonitor({ ...OPTS, tripRatio: 100, absoluteCeiling: 1.01 }); // never latch
    const t1 = feed(m, "a", 60, 0, (i) => i % 20 !== 0); // ~5% baseline
    const before = m.snapshot("a", t1).baseline;
    // incident: 60% failures; burn >> freezeLearningAbove, so baseline must not learn it
    const t2 = feed(m, "a", 20, t1 + 1_000, (i) => i % 5 > 2);
    const after = m.snapshot("a", t2).baseline;
    expect(after).toBeLessThan(before + 0.05); // barely moved despite a 60%-failure storm
  });

  it("learns improvement faster than degradation (asymmetric EWMA)", () => {
    const opts = { ...OPTS, tripRatio: 1000, absoluteCeiling: 1.01, freezeLearningAbove: 1000 };
    const worse = new BurnRateMonitor(opts);
    const better = new BurnRateMonitor(opts);
    // both start from a 50% baseline history
    const t1 = feed(worse, "a", 40, 0, (i) => i % 2 === 0);
    feed(better, "a", 40, 0, (i) => i % 2 === 0);
    // then 20 all-fail events vs 20 all-pass events
    const wSnap = (feed(worse, "a", 20, t1 + 1_000, () => false), worse.snapshot("a", t1 + 21_000));
    const bSnap = (feed(better, "a", 20, t1 + 1_000, () => true), better.snapshot("a", t1 + 21_000));
    const up = wSnap.baseline - 0.5; // movement toward failure
    const down = 0.5 - bSnap.baseline; // movement toward health
    expect(down).toBeGreaterThan(up); // improvement learned faster
  });
});

describe("BurnRateMonitor: recovery", () => {
  it("cooldown auto-promotes after sustained recovery", () => {
    const m = new BurnRateMonitor({ ...OPTS, cooldownMs: 30_000 });
    const t1 = feed(m, "a", 60, 0, (i) => i % 20 !== 0);
    feed(m, "a", 10, t1 + 1_000, () => false); // trip
    expect(m.mode("a")).toBe("propose_only");
    // before cooldown elapses: still demoted
    expect(m.snapshot("a", t1 + 20_000).mode).toBe("propose_only");
    // after cooldown, with the bad window aged out: promoted
    expect(m.snapshot("a", t1 + 120_000).mode).toBe("active");
  });

  it("manual demote and reset mirror the kill switch", () => {
    const m = new BurnRateMonitor(OPTS);
    let promoted = 0;
    m.onPromote(() => promoted++);
    m.demote("a", "operator call", 5_000);
    expect(m.mode("a")).toBe("propose_only");
    expect(m.snapshot("a", 5_000).reason).toBe("operator call");
    m.reset("a");
    expect(m.mode("a")).toBe("active");
    expect(promoted).toBe(1);
  });
});

describe("burnRateDetector adapter", () => {
  it("returns a failing finding while demoted, null when healthy", () => {
    const m = new BurnRateMonitor(OPTS);
    const det = burnRateDetector(m);
    const t1 = feed(m, "a", 60, 0, () => true);
    const healthyWindow: AgentEvent[] = [{ agentId: "a", ts: t1, type: "tool_call", ok: true }];
    expect(det(healthyWindow)).toBeNull();
    m.demote("a", "test", t1);
    const f = det(healthyWindow);
    expect(f?.status).toBe("failing");
    expect(f?.reason).toBe("test");
  });
});

describe("ControlPlane integration", () => {
  const actions: Actions = { reroute() {}, rollback() {}, pause() {} };

  it("demotes via burn rate, reports mode propose_only, and fleet() reflects it", () => {
    let clock = 0;
    const demotions: string[] = [];
    const plane = controlPlane({
      detectors: [],
      actions,
      onEscalate: () => {},
      now: () => clock,
      burnRate: { ...OPTS },
      onDemote: ({ agentId, snapshot }) => demotions.push(`${agentId}:${snapshot.reason}`),
    });
    const agent = plane.wrap("a");
    // healthy history
    for (let i = 0; i < 60; i++) {
      clock = i * 1_000;
      agent.observe({ type: "tool_call", ok: i % 20 !== 0, tool: "t" });
    }
    // incident
    let last = agent.observe({ type: "tool_call", ok: true, tool: "t" });
    for (let i = 0; i < 10; i++) {
      clock = 61_000 + i * 1_000;
      last = agent.observe({ type: "tool_call", ok: false, tool: "t" });
    }
    expect(last.mode).toBe("propose_only");
    expect(last.allowed).toBe(true); // proposals still flow
    expect(last.decision.action).toBe("escalate");
    expect(demotions.length).toBe(1);

    const fleet = plane.fleet();
    const a = fleet.agents.find((x) => x.agentId === "a");
    expect(a?.mode).toBe("propose_only");
    expect(a?.killed).toBe(false);
  });

  it("kill switch still beats demotion, and mode defaults to active without burnRate", () => {
    const plane = controlPlane({ detectors: [], actions, onEscalate: () => {}, now: () => 0 });
    const agent = plane.wrap("a");
    expect(agent.observe({ type: "tool_call", ok: true }).mode).toBe("active");
    plane.killSwitch.trip("a");
    const obs = agent.observe({ type: "tool_call", ok: true });
    expect(obs.allowed).toBe(false);
    expect(obs.decision.action).toBe("blocked");
  });
});
