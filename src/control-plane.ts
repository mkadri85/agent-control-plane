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
}

/** What `observe` tells the caller: may the agent proceed, and why. */
export interface Observation {
  allowed: boolean;
  decision: Decision;
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
  private readonly gate: ReturnType<typeof confidenceGate>;
  private readonly now: () => number;

  constructor(private readonly cfg: ControlPlaneConfig) {
    this.signals = new SignalPlane({ sink: cfg.signalSink });
    this.killSwitch = new KillSwitch();
    this.gate = confidenceGate(cfg.gate);
    this.now = cfg.now ?? (() => Date.now());
  }

  /** Get a handle for one agent in the fleet. */
  wrap(agentId: AgentId): WrappedAgent {
    return { agentId, observe: (event) => this.observe(agentId, event) };
  }

  private observe(agentId: AgentId, raw: ObservableEvent): Observation {
    // 1. Kill switch: a hard stop that beats everything else.
    if (this.killSwitch.isTripped(agentId)) {
      return { allowed: false, decision: { action: "blocked", reason: "kill switch tripped" } };
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

    // 3. Reasoning layer: is this agent actually broken?
    const windowMs = this.cfg.windowMs ?? 60_000;
    const window = this.signals.recent(agentId, windowMs, this.now());
    const health = this.diagnose(window);
    if (health.status === "healthy") {
      return { allowed: true, decision: { action: "allow", reason: "healthy" } };
    }

    // 4. Confidence gate: act or escalate.
    const remediation = (this.cfg.planRemediation ?? defaultPlan)(health, agentId);
    const decision = this.gate(health, remediation);

    // 5. Action layer.
    if (decision.action === "auto_remediate" && decision.remediation) {
      void this.apply(agentId, decision.remediation);
      // a reroute lets the agent keep working; a pause/rollback stops this step
      return { allowed: decision.remediation.kind === "reroute", decision };
    }
    if (decision.action === "escalate") {
      // contain first, then hand the full replay to a human
      void this.cfg.actions.pause(agentId, "containing before human review");
      this.cfg.onEscalate({ agentId, health, decision, replay: this.signals.replay(agentId) });
      return { allowed: false, decision };
    }
    return { allowed: true, decision };
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
