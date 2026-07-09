import type { AgentId } from "./types.js";

/**
 * The action layer. A deliberately short menu of real, reversible remediations
 * the control plane can apply to an agent. You implement these against your own
 * runtime (swap the model, revert a version, drain the agent's work to a queue).
 */
export interface Actions {
  /** Send the agent's traffic to a different model or provider. */
  reroute(agentId: AgentId, detail?: string): void | Promise<void>;
  /** Roll the agent back to its last known-good version. */
  rollback(agentId: AgentId, detail?: string): void | Promise<void>;
  /** Pause the agent and drain its work to a human queue. */
  pause(agentId: AgentId, detail?: string): void | Promise<void>;
}
