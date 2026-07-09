# agent-control-plane

[![CI](https://github.com/mkadri85/agent-control-plane/actions/workflows/ci.yml/badge.svg)](https://github.com/mkadri85/agent-control-plane/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
![runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)

A minimal, framework-agnostic **control plane for AI agent fleets**: a signal plane, a confidence gate, and a kill switch. Zero runtime dependencies.

AI agents have started causing the production incidents they were built to resolve. In April 2026 a coding agent deleted a company's production database and its backups in about nine seconds. The pattern is not rare, and it has the same shape every time: an agent takes a real action on an incomplete view of the world, and nothing stands between its intent and the damage.

This is a small reference implementation of the thing that stands in between. It is the companion to the write-up [**Who Operates the Operators?**](https://mkadri85.github.io/blog/agentic-sre-agent-fleets/).

It is not a framework. It is the skeleton you wrap around whatever agent you already run.

## The idea

Take the incident loop that keeps infrastructure alive and point it at the agents themselves:

- **Signal plane** - record one replayable event per agent decision. You cannot operate what you cannot see.
- **Reasoning layer** - detectors decide whether an agent is actually broken (a loop, a cost runaway, an error spike, quiet quality drift).
- **Confidence gate** - the whole safety design. High confidence in a known, reversible fix closes the loop itself; anything novel or ambiguous escalates to a human.
- **Action layer** - a short menu of reversible remediations: reroute, roll back, pause.
- **Kill switch** - a global and per-agent off switch you build before you need it.

```
   CONTROL PLANE    identity . policy . tool contracts . replay . kill switch
        ^  decide (escalate on low confidence)
   ACTION LAYER     reroute . roll back . pause
        ^
   REASONING LAYER  detect -> triage -> correlate   (is this agent broken?)
        ^
   SIGNAL PLANE     one replayable record per decision
        ^
   AGENT FLEET      [ a1 ] [ a2 ] [ a3 ] [ a9 failing ] ...
```

## Try it

```bash
git clone https://github.com/mkadri85/agent-control-plane
cd agent-control-plane
npm install
npm run demo
```

The demo runs a small fleet through the plane: a healthy agent proceeds, a looping agent is auto-rerouted, a cost runaway is auto-paused, a quietly drifting agent is escalated to a human with its full replay, and then the kill switch stops the whole fleet.

```text
  agent-control-plane  live demo

  agent-01 healthy: three clean tool calls
    allowed  call 1
    allowed  call 2
    allowed  call 3

  agent-04 starts looping on a failing tool
    allowed  retry 1
    allowed  retry 2
    allowed  retry 3
    -> reroute agent-04: known loop, switch model
    allowed  retry 4  [auto_remediate: confidence 0.90 >= 0.8 and reroute is auto-allowed]

  agent-09 output quality quietly drifting
    allowed  response 1
    allowed  response 2
    allowed  response 3
    -> pause agent-09: containing before human review
    ESCALATE agent-09 -> human
    why: output quality drifting (2/4 weak responses) (confidence 0.50)
    handing over the last 4 of 4 recorded decisions:
      model_response   ok   300 tok
      model_response   ERR  300 tok
      model_response   ok   300 tok
      model_response   ERR  300 tok
    stopped  response 4  [escalate: confidence 0.50 < 0.8]

  agent-07 burning tokens far past its budget
    -> pause agent-07: token spend 12000 over budget 5000
    stopped  one very expensive step  [auto_remediate: confidence 0.95 >= 0.8 and pause is auto-allowed]

  kill switch tripped for the whole fleet
    stopped  agent-01 tries another call  [blocked: kill switch tripped]
```

## Use it

```ts
import {
  controlPlane,
  loopDetector,
  costRunawayDetector,
  errorRateDetector,
  driftDetector,
  type Actions,
} from "agent-control-plane";

// You implement these against your own runtime.
const actions: Actions = {
  reroute: (id, why) => switchModel(id),
  rollback: (id, why) => revertAgent(id),
  pause: (id, why) => drainToHumanQueue(id),
};

const plane = controlPlane({
  detectors: [
    loopDetector({ repeats: 4 }),
    costRunawayDetector({ maxTokens: 50_000 }),
    errorRateDetector({ threshold: 0.6 }),
    driftDetector(),
  ],
  actions,
  gate: { autoActThreshold: 0.8, autoAllow: ["reroute", "pause"] },
  onEscalate: ({ agentId, health, replay }) => {
    pageOnCall(agentId, health, replay); // hand a human the full trace
  },
});

const agent = plane.wrap("agent-09");

// Report each decision your agent makes. The plane records it, diagnoses the
// agent, and tells you whether it may proceed.
const { allowed, decision } = agent.observe({
  type: "tool_call",
  tool: "search",
  ok: false,
  tokens: 300,
});

if (!allowed) {
  // the plane paused or escalated this agent; decision.reason says why
}

// The off switch, no deploy required:
plane.killSwitch.trip("agent-09"); // or "global" for the whole fleet
```

## The confidence gate

The gate is the only interesting decision in the system, so it is worth stating plainly. An agent earns autonomy per failure type; it is not a switch you flip once.

| Diagnosis | Proposed fix | Ruling |
| --- | --- | --- |
| Confidence >= threshold, fix is known-safe and reversible | reroute / pause | **auto-remediate** |
| Confidence below threshold | anything | **escalate** to a human |
| Any confidence, but the fix is not on the auto-allow list | rollback, etc. | **escalate** to a human |
| Healthy | none | **allow** |

The default threshold is `0.8` and the default auto-allowed actions are `reroute` and `pause`. Both are configurable per plane.

## What this is, and is not

- It **is** a dependency-free skeleton you can read in one sitting and wire into an existing agent runtime in an afternoon.
- It **is not** a hosted platform, an observability product, or a replacement for a real agent framework. It has no opinion about how your agents are built.
- The detectors and actions are deliberately simple. They are meant to be replaced with your own.

Detection is the hard part in practice: subtle, non-deterministic quality drift is exactly what standard checks miss. The `driftDetector` here is a placeholder for the more sensitive, continuous evaluation that real fleets need.

## Design principles

- **Reversible actions only.** Every built-in remediation can be undone. The gate is allowed to act on its own precisely because it cannot do anything it cannot take back.
- **Contain before you page.** On escalation the plane pauses the agent first, then hands a human the full replay.
- **The boring parts come first.** Per-agent identity, one recorded decision per step, and a kill switch matter more than the clever autonomous loop. Build them first.

## License

MIT. Built by [Mohamed Kadri](https://mkadri85.github.io/).
