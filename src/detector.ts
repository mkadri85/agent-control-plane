import type { Detector } from "./types.js";

/**
 * Fires when an agent repeats the same tool call several times in a row. The
 * classic stuck-in-a-loop failure. High confidence, because a loop is unambiguous.
 */
export function loopDetector(opts: { repeats?: number } = {}): Detector {
  const limit = opts.repeats ?? 4;
  return (events) => {
    const calls = events.filter((e) => e.type === "tool_call");
    if (calls.length < limit) return null;
    const tail = calls.slice(-limit);
    const tool = tail[0]?.tool;
    if (tool && tail.every((e) => e.tool === tool)) {
      return {
        status: "failing",
        confidence: 0.9,
        reason: `looping on "${tool}" (${limit}x in a row)`,
      };
    }
    return null;
  };
}

/**
 * Fires when token spend in the window exceeds a budget. Confidence scales with
 * how far over budget the agent is.
 */
export function costRunawayDetector(opts: { maxTokens: number }): Detector {
  return (events) => {
    const spent = events.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
    if (spent <= opts.maxTokens) return null;
    const over = spent / opts.maxTokens;
    return {
      status: over > 2 ? "failing" : "degraded",
      confidence: Math.min(0.95, 0.5 + over / 4),
      reason: `token spend ${spent} over budget ${opts.maxTokens}`,
    };
  };
}

/** Fires when the recent failure rate crosses a threshold. */
export function errorRateDetector(opts: { threshold?: number; min?: number } = {}): Detector {
  const threshold = opts.threshold ?? 0.5;
  const min = opts.min ?? 4;
  return (events) => {
    if (events.length < min) return null;
    const errors = events.filter((e) => !e.ok).length;
    const rate = errors / events.length;
    if (rate < threshold) return null;
    return {
      status: rate >= 0.8 ? "failing" : "degraded",
      confidence: Math.min(0.9, rate),
      reason: `error rate ${(rate * 100).toFixed(0)}% over ${events.length} steps`,
    };
  };
}

/**
 * Fires on subtle quality drift: a run of low-confidence or low-quality model
 * responses that no single hard threshold catches. Deliberately reports MODEST
 * confidence, so the gate escalates to a human instead of acting on a guess.
 * This is the "silent degradation" case that standard checks miss.
 */
export function driftDetector(opts: { min?: number; qualityFloor?: number } = {}): Detector {
  const min = opts.min ?? 3;
  const floor = opts.qualityFloor ?? 0.5;
  return (events) => {
    const responses = events.filter((e) => e.type === "model_response");
    if (responses.length < min) return null;
    // treat a failed model_response as a quality miss
    const misses = responses.filter((e) => !e.ok).length;
    const missRate = misses / responses.length;
    if (missRate < floor) return null;
    return {
      status: "degraded",
      confidence: 0.5, // ambiguous on purpose
      reason: `output quality drifting (${misses}/${responses.length} weak responses)`,
    };
  };
}
