export type AgentId = string;

export type EventType = "tool_call" | "model_response" | "error";

/**
 * One replayable record per decision an agent makes. This is the atom of the
 * signal plane: without it, every layer above is guessing.
 */
export interface AgentEvent {
  agentId: AgentId;
  ts: number; // epoch ms
  type: EventType;
  ok: boolean; // did the step succeed
  tool?: string; // tool name, for tool_call events
  tokens?: number; // tokens spent on this step
  detail?: string; // short human-readable note
}

export type HealthStatus = "healthy" | "degraded" | "failing";

/** A single detector's opinion about an agent's recent behavior. */
export interface Finding {
  status: HealthStatus;
  confidence: number; // 0..1, how sure the detector is
  reason: string;
}

/** The reasoning layer's combined diagnosis for one agent. */
export interface Health {
  status: HealthStatus;
  confidence: number; // 0..1
  reasons: string[];
}

/**
 * A detector inspects an agent's recent events and returns a Finding, or null
 * if nothing looks wrong to it.
 */
export type Detector = (events: AgentEvent[]) => Finding | null;

export type RemediationKind = "reroute" | "rollback" | "pause";

export interface Remediation {
  kind: RemediationKind;
  detail?: string;
}

export type GateAction = "allow" | "auto_remediate" | "escalate" | "blocked";

/** The confidence gate's ruling on what to do about a diagnosis. */
export interface Decision {
  action: GateAction;
  reason: string;
  remediation?: Remediation;
}
