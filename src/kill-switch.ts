import type { AgentId } from "./types.js";

export type KillScope = AgentId | "global";

/**
 * A global and per-agent kill switch. Build the off switch before you need it,
 * not during the outage. When tripped, the control plane blocks the agent's
 * next action outright, no deploy required.
 */
export class KillSwitch {
  private globalTripped = false;
  private readonly tripped = new Set<AgentId>();
  private readonly listeners: Array<(scope: KillScope) => void> = [];

  /** Trip the switch. Default scope is the whole fleet. */
  trip(scope: KillScope = "global"): void {
    if (scope === "global") this.globalTripped = true;
    else this.tripped.add(scope);
    for (const l of this.listeners) l(scope);
  }

  /** Reset the switch. Default scope is the whole fleet. */
  reset(scope: KillScope = "global"): void {
    if (scope === "global") this.globalTripped = false;
    else this.tripped.delete(scope);
  }

  /** Is this agent (or the whole fleet) currently stopped. */
  isTripped(agentId?: AgentId): boolean {
    if (this.globalTripped) return true;
    return agentId ? this.tripped.has(agentId) : false;
  }

  /** Notified whenever the switch is tripped. */
  onTrip(fn: (scope: KillScope) => void): void {
    this.listeners.push(fn);
  }
}
