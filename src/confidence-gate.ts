import type { Decision, Health, Remediation, RemediationKind } from "./types.js";

export interface GatePolicy {
  /** Minimum confidence to act without a human. Default 0.8. */
  autoActThreshold?: number;
  /**
   * Remediations the plane may apply on its own, for known, low-risk, reversible
   * cases. Anything not listed here always escalates. Default: reroute + pause.
   */
  autoAllow?: RemediationKind[];
}

/**
 * The confidence gate: the whole safety design in one function.
 *
 * High confidence in the diagnosis AND a known-safe, reversible remediation ->
 * the loop closes itself. Anything novel, ambiguous, or risky -> escalate to a
 * human. Autonomy is earned per failure type, not switched on globally.
 */
export function confidenceGate(policy: GatePolicy = {}) {
  const threshold = policy.autoActThreshold ?? 0.8;
  const autoAllow = new Set<RemediationKind>(policy.autoAllow ?? ["reroute", "pause"]);

  return (health: Health, remediation: Remediation): Decision => {
    if (health.status === "healthy") {
      return { action: "allow", reason: "healthy" };
    }
    if (health.confidence >= threshold && autoAllow.has(remediation.kind)) {
      return {
        action: "auto_remediate",
        remediation,
        reason: `confidence ${health.confidence.toFixed(2)} >= ${threshold} and ${remediation.kind} is auto-allowed`,
      };
    }
    const why =
      health.confidence < threshold
        ? `confidence ${health.confidence.toFixed(2)} < ${threshold}`
        : `${remediation.kind} is not in the auto-allow list`;
    return { action: "escalate", remediation, reason: why };
  };
}
