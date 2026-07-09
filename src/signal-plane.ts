import type { AgentEvent, AgentId } from "./types.js";

/** Somewhere to durably ship events (a DB, a log pipeline, a queue). */
export interface SignalSink {
  write(event: AgentEvent): void;
}

/**
 * The signal plane. Records one replayable event per agent decision and lets you
 * replay an agent's full history or query a recent window. In-memory ring buffer
 * by default; hand it a sink to also ship events somewhere durable.
 */
export class SignalPlane {
  private events: AgentEvent[] = [];
  private readonly capacity: number;
  private readonly sink?: SignalSink;

  constructor(opts: { capacity?: number; sink?: SignalSink } = {}) {
    this.capacity = opts.capacity ?? 10_000;
    this.sink = opts.sink;
  }

  /** Record a decision. Trims the oldest event once capacity is reached. */
  record(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
    this.sink?.write(event);
  }

  /** Every recorded decision for one agent, oldest first. */
  replay(agentId: AgentId): AgentEvent[] {
    return this.events.filter((e) => e.agentId === agentId);
  }

  /** Events for one agent within the last `windowMs` relative to `now`. */
  recent(agentId: AgentId, windowMs: number, now: number): AgentEvent[] {
    return this.events.filter((e) => e.agentId === agentId && now - e.ts <= windowMs);
  }

  /** All events across every agent (read-only). */
  all(): readonly AgentEvent[] {
    return this.events;
  }
}
