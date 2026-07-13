import type {
  AgentEvent,
  AgentId,
  Decision,
  Detector,
  Finding,
  Health,
  Remediation,
} from "./types.js";
import { SignalPlane, type SignalSink } from "./signal-plane.js";
import { KillSwitch } from "./kill-switch.js";
import { confidenceGate, type GatePolicy } from "./confidence-gate.js";
import type { Actions } from "./actions.js";
import { BurnRateMonitor, type AgentMode, type BurnRateOptions, type BurnSnapshot } from "./burn-rate.js";

/** Everything the control plane hands a human when it decides to escalate. */
export interface EscalationContext {
  agentId: AgentId;
  health: Health;
  decision: Decision;
  replay: AgentEvent[];
}

export interface ControlPlaneConfig {
  /** The reasoning layer: run in order, worst finding wins. */
  detectors: Detector[];
  /** The action layer implementation. */
  actions: Actions;
  /** Called when the gate decides a human is needed. */
  onEscalate: (ctx: EscalationContext) => void;
  /** Confidence-gate policy (threshold, auto-allowed remediations). */
  gate?: GatePolicy;
  /** How far back detectors look, in ms. Default 60_000. */
  windowMs?: number;
  /** Optional durable sink for the signal plane. */
  signalSink?: SignalSink;
  /** Injectable clock, for tests and demos. Default Date.now. */
  now?: () => number;
  /** Map a diagnosis to a proposed remediation. Default: pause. */
  planRemediation?: (health: Health, agentId: AgentId) => Remediation;
  /**
   * Enable the baseline-relative burn-rate breaker: alarm on the derivative,
   * not the level. Pass options, or a prebuilt monitor to share/inspect it.
   */
  burnRate?: BurnRateOptions | BurnRateMonitor;
  /** Called when the breaker latches an agent into propose-only. */
  onDemote?: (ctx: { agentId: AgentId; snapshot: BurnSnapshot; replay: AgentEvent[] }) => void;
}

/** What `observe` tells the caller: may the agent proceed, and why. */
export interface Observation {
  allowed: boolean;
  decision: Decision;
  /**
   * "propose_only" while the burn-rate breaker has this agent demoted: the
   * agent may keep producing, but its outputs are proposals for a human, not
   * actions. "active" otherwise (and always, when burnRate is not configured).
   */
  mode: AgentMode;
}

/** Fleet-level health view: burn snapshots plus kill-switch state per agent. */
export interface FleetView {
  agents: Array<BurnSnapshot & { killed: boolean }>;
  generatedAt: number;
}

/** A per-agent handle onto the control plane. */
export interface WrappedAgent {
  agentId: AgentId;
  observe(event: ObservableEvent): Observation;
}

/** An event as reported by the agent (the plane stamps agentId and ts). */
export type ObservableEvent = Omit<AgentEvent, "agentId" | "ts"> & { ts?: number };

/**
 * The control plane. Wraps a fleet of agents so that every decision is recorded
 * (signal plane), diagnosed (reasoning), gated (confidence gate), and either
 * auto-remediated or escalated (action layer), with a kill switch over all of it.
 */
export class ControlPlane {
  readonly signals: SignalPlane;
  readonly killSwitch: KillSwitch;
  /** The burn-rate breaker, exposed like killSwitch. Undefined unless configured. */
  readonly burnRate?: BurnRateMonitor;
  private readonly gate: ReturnType<typeof confidenceGate>;
  private readonly now: () => number;

  constructor(private readonly cfg: ControlPlaneConfig) {
    this.signals = new SignalPlane({ sink: cfg.signalSink });
    this.killSwitch = new KillSwitch();
    this.gate = confidenceGate(cfg.gate);
    this.now = cfg.now ?? (() => Date.now());
    if (cfg.burnRate) {
      this.burnRate = cfg.burnRate instanceof BurnRateMonitor
        ? cfg.burnRate
        : new BurnRateMonitor(cfg.burnRate);
      if (cfg.onDemote) {
        this.burnRate.onDemote((snapshot) => {
          cfg.onDemote?.({ agentId: snapshot.agentId, snapshot, replay: this.signals.replay(snapshot.agentId) });
        });
      }
    }
  }

  /** Fleet-level health view across every agent the plane has seen. */
  fleet(): FleetView {
    const now = this.now();
    const killed = (id: AgentId) => this.killSwitch.isTripped(id);
    if (this.burnRate) {
      const seen = new Set<AgentId>();
      const agents = this.burnRate.fleet(now).map((s) => {
        seen.add(s.agentId);
        return { ...s, killed: killed(s.agentId) };
      });
      for (const e of this.signals.all()) {
        if (!seen.has(e.agentId)) {
          seen.add(e.agentId);
          agents.push({ ...this.burnRate.snapshot(e.agentId, now), killed: killed(e.agentId) });
        }
      }
      return { agents, generatedAt: now };
    }
    const ids = [...new Set(this.signals.all().map((e) => e.agentId))];
    return {
      agents: ids.map((agentId) => ({
        agentId, baseline: 0, current: null, burnRate: null,
        samples: { baseline: 0, current: 0 }, mode: "active" as AgentMode,
        killed: killed(agentId),
      })),
      generatedAt: now,
    };
  }

  /** Get a handle for one agent in the fleet. */
  wrap(agentId: AgentId): WrappedAgent {
    return { agentId, observe: (event) => this.observe(agentId, event) };
  }

  private observe(agentId: AgentId, raw: ObservableEvent): Observation {
    // 1. Kill switch: a hard stop that beats everything else.
    if (this.killSwitch.isTripped(agentId)) {
      return {
        allowed: false,
        decision: { action: "blocked", reason: "kill switch tripped" },
        mode: this.burnRate?.mode(agentId) ?? "active",
      };
    }

    // 2. Signal plane: record the decision as one replayable event.
    const event: AgentEvent = {
      agentId,
      ts: raw.ts ?? this.now(),
      type: raw.type,
      ok: raw.ok,
      tool: raw.tool,
      tokens: raw.tokens,
      detail: raw.detail,
    };
    this.signals.record(event);
    this.burnRate?.record(event);

    // 2b. Burn-rate breaker: while demoted, everything is a proposal.
    if (this.burnRate && this.burnRate.mode(agentId) === "propose_only") {
      const snap = this.burnRate.snapshot(agentId, event.ts);
      return {
        allowed: true,
        mode: "propose_only",
        decision: {
          action: "escalate",
          reason: snap.reason ?? "burn-rate breaker latched: propose-only until reset or cooldown",
        },
      };
    }

    // 3. Reasoning layer: is this agent actually broken?
    const windowMs = this.cfg.windowMs ?? 60_000;
    const window = this.signals.recent(agentId, windowMs, this.now());
    const health = this.diagnose(window);
    if (health.status === "healthy") {
      return { allowed: true, decision: { action: "allow", reason: "healthy" }, mode: "active" };
    }

    // 4. Confidence gate: act or escalate.
    const remediation = (this.cfg.planRemediation ?? defaultPlan)(health, agentId);
    const decision = this.gate(health, remediation);

    // 5. Action layer.
    if (decision.action === "auto_remediate" && decision.remediation) {
      void this.apply(agentId, decision.remediation);
      // a reroute lets the agent keep working; a pause/rollback stops this step
      return { allowed: decision.remediation.kind === "reroute", decision, mode: "active" };
    }
    if (decision.action === "escalate") {
      // contain first, then hand the full replay to a human
      void this.cfg.actions.pause(agentId, "containing before human review");
      this.cfg.onEscalate({ agentId, health, decision, replay: this.signals.replay(agentId) });
      return { allowed: false, decision, mode: "active" };
    }
    return { allowed: true, decision, mode: "active" };
  }

  private diagnose(events: AgentEvent[]): Health {
    const findings = this.cfg.detectors
      .map((d) => d(events))
      .filter((f): f is Finding => f !== null);
    if (findings.length === 0) return { status: "healthy", confidence: 1, reasons: [] };
    const failing = findings.filter((f) => f.status === "failing");
    const chosen = failing.length ? failing : findings;
    return {
      status: failing.length ? "failing" : "degraded",
      confidence: Math.max(...chosen.map((f) => f.confidence)),
      reasons: chosen.map((f) => f.reason),
    };
  }

  private async apply(agentId: AgentId, r: Remediation): Promise<void> {
    if (r.kind === "reroute") await this.cfg.actions.reroute(agentId, r.detail);
    else if (r.kind === "rollback") await this.cfg.actions.rollback(agentId, r.detail);
    else await this.cfg.actions.pause(agentId, r.detail);
  }
}

function defaultPlan(): Remediation {
  return { kind: "pause" };
}
