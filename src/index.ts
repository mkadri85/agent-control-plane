export type {
  AgentId,
  AgentEvent,
  EventType,
  Detector,
  Finding,
  Health,
  HealthStatus,
  Decision,
  GateAction,
  Remediation,
  RemediationKind,
} from "./types.js";

export { SignalPlane } from "./signal-plane.js";
export type { SignalSink } from "./signal-plane.js";

export { KillSwitch } from "./kill-switch.js";
export type { KillScope } from "./kill-switch.js";

export { confidenceGate } from "./confidence-gate.js";
export type { GatePolicy } from "./confidence-gate.js";

export { loopDetector, costRunawayDetector, errorRateDetector, driftDetector } from "./detector.js";

export { BurnRateMonitor, burnRateDetector } from "./burn-rate.js";
export type { AgentMode, BurnRateOptions, BurnSnapshot } from "./burn-rate.js";

export type { Actions } from "./actions.js";

export { ControlPlane } from "./control-plane.js";
export type {
  ControlPlaneConfig,
  WrappedAgent,
  Observation,
  ObservableEvent,
  EscalationContext,
  FleetView,
} from "./control-plane.js";

import { ControlPlane, type ControlPlaneConfig } from "./control-plane.js";

/** Convenience factory. `const plane = controlPlane({ ... })`. */
export function controlPlane(cfg: ControlPlaneConfig): ControlPlane {
  return new ControlPlane(cfg);
}
