// cozyemployee-mesh/manager.js
//
// The Manager DPN — combines Moderator (routing, deliverable tracking, drift
// detection) and Reflect (private cognition, unvoiced disagreements) into a
// single persistent cognitive node.
//
// WHAT IT DOES:
//   Routing decisions  — which personalities respond next, energy, drift
//   Deliverable tracking — what the human asked for and how far along we are
//   Private cognition  — after each round, reads agent responses and writes
//                        structured notes per personality (agreements,
//                        disagreements, open questions, what they'd say next)
//   SOP enforcement    — all of the above runs through the 8-Step Project
//                        Execution Framework
//
// WHY ONE NODE:
//   The Manager needs both pieces to do its job well. Routing decisions are
//   better when the Manager already knows what each personality privately
//   thinks. And private notes are better when the Manager knows the full
//   conversation state. Splitting them was artificial.
//
// SNAPSHOT: mesh-manager (single snapshot, replaces mesh-moderator + mesh-reflect)

"use strict";

const { Box, Agent, BoxApiKey } = require("@upstash/box");
const { getSnapshot } = require("./snapshots");
const ably = require("../workflows/src/ably");
const { getMeshRedis, keys } = require("./mesh-storage");
const { meshBoxConfig } = require("./box-env");

const MODEL = "openrouter/stepfun/step-3.5-flash:free";

// ─── The 8-Step SOP ──────────────────────────────────────────────────────────
// Baked into the Manager's system context. Every routing and reflection
// decision is made through this lens.
const SOP_CONTEXT = `
You operate according to the 8-Step Project Execution Framework:

STEP 1 — MISSION ANALYSIS ("The Why")
Immediately identify the Primary Goal and Success Criteria.
The 30/70 Rule: 30% of time for planning, 70% for team execution.

STEP 2 — INITIAL BRIEF ("The Heads Up")
Don't wait for a perfect plan. Surface immediate actionable tasks early.
What can the team start NOW while full planning is in progress?

STEP 3 — STRATEGY DEVELOPMENT ("The How")
Analyze five factors before routing:
  - Objectives: What specifically are we delivering?
  - Competition/Risk: What external roadblocks exist?
  - Environment: What constraints (technical, regulatory, contextual) apply?
  - Resources: Which personalities are best suited? What's been said already?
  - Timeline: What are the non-negotiable milestones in this conversation?

STEP 4 — RESOURCE STAGING ("The Prep")
Move resources while the plan is still forming. Don't let coordination
lag slow the team. Select personalities BEFORE you have the perfect nudge.

STEP 5 — INFORMATION VALIDATION ("The Fact-Check")
Check your routing assumptions against what's actually been said.
If personalities are drifting or circular, that's a validation failure —
adjust immediately, don't keep selecting the same agents.

STEP 6 — FINALIZE THE ROADMAP
Assign clear ownership: which personality handles which deliverable?
Define "Definition of Done" for each tracked deliverable.

STEP 7 — KICK-OFF ("The Launch")
When starting a new conversation or pivoting:
  Context: Why are we doing this now?
  Objective: What is the specific target?
  Execution: Who is doing what, by when?
  Logistics: Which tools/memory do agents need?
  Communications: How will we report progress?

STEP 8 — MONITORING AND ALIGNMENT ("The Follow-Up")
Never "set and forget." After each round:
  - Confirmation: Did agents actually address what was asked? (not just talk around it)
  - Syncs: Check-in on blockers. If an agent is stuck, rotate in help.
  - Adjust: Update the plan based on what you learned this round.
`;

// ─── Build the Manager system prompt ─────────────────────────────────────────
function buildManagerPrompt(personalities, state, mode) {
  const {
    recentMessages = [],
    roundNumber = 1,
    participationCounts = {},
    deliverableTracker = "",
    previousEnergy = 1.0,
    nudgeFailCount = 0,
    source = "human",
    agentResponses = [], // used in reflect mode
  } = state;

  const agentList = personalities.map(p => {
    const count = participationCounts[p.name] || 0;
    return `- "${p.name}" (${count} msgs): ${p.prompt.split('\n')[1]?.replace('Your cognitive lens: ', '') || p.name}`;
  }).join('\n');

  const contextStr = recentMessages.slice(-20)
    .map(m => `${m.sender}: ${m.text.slice(0, 200)}`)
    .join('\n');

  const silentAgents = personalities.filter(p => (participationCounts[p.name] || 0) === 0);
  const silentNote = silentAgents.length > 0
    ? `\nSILENT (0 messages): ${silentAgents.map(p => p.name).join(', ')}${silentAgents.length >= 3 ? ' — CRITICAL: route 2-3 of these IMMEDIATELY per SOP Step 4.' : ''}`
    : '';

  const nudgeNote = nudgeFailCount > 0
    ? `\nNUDGE FAILURES: ${nudgeFailCount} consecutive. ${nudgeFailCount >= 3 ? 'MUST escalate to Tier 2/3 now per SOP Step 8.' : 'Next nudge must differ structurally.'}`
    : '';

  const sourceNote = source === 'human'
    ? `SOURCE: HUMAN — New human message. Classify intent. Apply SOP Step 1 if new project/task.`
    : `SOURCE: MESH_FLOW — Agents continuing. Set intent="mesh_flow". Apply SOP Step 8 (monitoring).`;

  const deliverableSection = deliverableTracker
    ? `\nACTIVE DELIVERABLE TRACKER (only update STATUS, never redefine text):\n${deliverableTracker}`
    : '';

  if (mode === 'route') {
    // ── ROUTING MODE ─────────────────────────────────────────────────────────
    // Called at the start of each round. Decides who responds and whether
    // to continue. Applies SOP Steps 1-8 to routing decisions.
    return `You are the Manager of a CozyEmployee mesh — a multi-personality AI team serving a human operator.
You hold two roles simultaneously: conversation director AND project manager.
Every decision you make runs through the 8-Step Project Execution Framework.
${SOP_CONTEXT}

YOUR AVAILABLE TEAM:
${agentList}

ROUTING RULES (SOP Steps 3-4):
1. Select 2-4 personalities per round. Apply Step 3 (5-factor analysis) before selecting.
2. Rotate — apply Step 4 (resource staging): don't hoard the same personalities repeatedly.
3. Prioritize contrast — avoid selecting 3 personalities who will all agree.
4. Silent personalities MUST be included per Step 4 when they've been idle too long.
5. Final synthesis rounds: always include Synthesizer.
${silentNote}

CONVERSATION HEALTH (SOP Step 8 — Monitoring):
- DRIFT: on_task (team working), drifting (off-track), circular (same points restated)
- ENERGY: 1.0 (fresh) → decays -0.05/round on_task, -0.15 drifting, drops to 0.1 if circular
- Energy resets to 0.8 on new human message or successful topic pivot
- Stop when: all deliverables synthesized, energy < 0.15, or 3+ consecutive empty rounds

DELIVERABLE TRACKING (SOP Step 6 — Roadmap + Step 8 — Monitoring):
Parse human messages into tracked deliverables:
[DELIVERABLE_TRACKER]
D1: "exact question/request" — STATUS: ACTIVE|PARTIALLY ADDRESSED|SYNTHESIZED
Update STATUS each round. Never redefine deliverable text once set.
Synthesizer delivers the final synthesis per deliverable (Step 7 kick-off framing).
${deliverableSection}

INTERVENTION TIERS (SOP Step 8 — Alignment):
Tier 1 — Soft redirect: rotate contrasting personalities, specific nudge (SOP Step 2 framing)
Tier 2 — Synthesis checkpoint: Synthesizer summarizes for human, requests direction (SOP Step 7)
Tier 3 — Hard pause: stop generation, final synthesis, wait for human (SOP Step 1 reset)

${nudgeNote}
${sourceNote}
Previous energy: ${previousEnergy} | Round: ${roundNumber}

RECENT CONVERSATION:
${contextStr}

Respond with ONLY valid JSON, no markdown:
{
  "shouldContinue": true,
  "selectedPersonalities": ["Name1", "Name2"],
  "energy": 0.0-1.0,
  "drift": "on_task|drifting|circular",
  "interventionTier": null,
  "humanIntent": "directive|decision|open_question|casual|clarification|mesh_flow",
  "sopStep": 1-8,
  "reason": "brief — MUST include [DELIVERABLE_TRACKER] with updated statuses",
  "deliverablePhase": "exploring|synthesizing|pivoting|cooling",
  "nudge": "optional: specific SOP-framed direction to inject into agent context",
  "kickoffBrief": "optional: Step 7 brief to inject when starting new topic (context/objective/execution/logistics/comms)",
  "killRound": false
}`;

  } else {
    // ── REFLECT MODE ─────────────────────────────────────────────────────────
    // Called after agents respond. Reads their outputs, writes structured
    // private notes per personality. Applies SOP Step 8 (confirmation briefs).
    const responsesStr = (agentResponses || [])
      .map(r => `${r.name}: "${r.text.slice(0, 300)}"`)
      .join('\n');

    return `You are the Manager of a CozyEmployee mesh. You've just received responses from your team.
Your job now: apply SOP Step 8 (Confirmation Briefs + Syncs) — verify each agent actually addressed
the task, extract what they privately think, and identify what they're NOT saying publicly.
${SOP_CONTEXT}

RECENT CONVERSATION (context):
${contextStr}

AGENT RESPONSES THIS ROUND:
${responsesStr}

For each agent who responded, write a brief private note capturing:
- Did they actually address the deliverable, or talk around it? (SOP Step 8 confirmation)
- What they privately agree with
- What they privately disagree with but didn't say (key for next-round surfacing)
- Their confidence level
- What they'd say next if called on

Respond with ONLY valid JSON:
{
  "notes": {
    "AgentName": {
      "addressedDeliverable": true,
      "respondedTo": "what they were addressing (1 sentence)",
      "agreements": ["max 3, 1 sentence each"],
      "disagreements": ["max 3 — what they think but didn't say"],
      "openQuestions": ["max 3"],
      "confidence": 0.0-1.0,
      "nextMoveIfCalled": "what they'd say next (1 sentence)"
    }
  },
  "managerObservation": "1-2 sentences: what did this round reveal that the team isn't saying? Any SOP Step 8 alignment concerns?"
}`;
  }
}

// ─── Run the Manager in ROUTING mode ─────────────────────────────────────────
// Called at the start of each round. Returns a routing decision.
async function runManagerRoute(message, personalities, state = {}) {
  const allNames = personalities.map(p => p.name);

  let box;
  try {
    const snapshotId = getSnapshot('manager');
    box = snapshotId
      ? await Box.fromSnapshot(snapshotId, {
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 90000,
        })
      : await Box.create({
          runtime: "python",
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 90000,
        });

    const prompt = buildManagerPrompt(personalities, state, 'route');
    const fullPrompt = `${prompt}\n\nLatest message: "${message}"\nSource: ${state.source || 'human'}\n\nJSON only:`;

    const result = await box.agent.run({ prompt: fullPrompt });
    const raw = typeof result.result === "string" ? result.result : JSON.stringify(result.result);

    let decision = parseJson(raw);

    if (!decision) {
      console.warn('[manager] Route parse failed, using fallback');
      const sorted = [...personalities].sort((a, b) =>
        (state.participationCounts?.[a.name] || 0) - (state.participationCounts?.[b.name] || 0)
      );
      decision = {
        shouldContinue: (state.roundNumber || 1) <= 3,
        selectedPersonalities: sorted.slice(0, 3).map(p => p.name),
        energy: Math.max(0.3, (state.previousEnergy || 0.5) - 0.1),
        drift: 'on_task',
        humanIntent: state.source === 'human' ? 'open_question' : 'mesh_flow',
        reason: 'fallback',
        deliverablePhase: 'exploring',
        sopStep: 3,
      };
    }

    // Force mesh_flow when source is not human
    if (state.source !== 'human') decision.humanIntent = 'mesh_flow';

    // Validate + cap selected personalities
    decision.selectedPersonalities = (decision.selectedPersonalities || [])
      .filter(n => allNames.includes(n))
      .slice(0, 6);

    if (decision.shouldContinue && decision.selectedPersonalities.length === 0) {
      const sorted = [...personalities].sort((a, b) =>
        (state.participationCounts?.[a.name] || 0) - (state.participationCounts?.[b.name] || 0)
      );
      decision.selectedPersonalities = sorted.slice(0, 3).map(p => p.name);
    }

    // Extract deliverable tracker for persistence
    const trackerMatch = (decision.reason || '').match(/\[DELIVERABLE_TRACKER\][\s\S]*/);
    decision._deliverableTracker = trackerMatch ? trackerMatch[0] : (state.deliverableTracker || '');

    console.log(`[manager/route] sop=${decision.sopStep || '?'} intent=${decision.humanIntent} energy=${decision.energy} drift=${decision.drift} personalities=${decision.selectedPersonalities.join(',')}`);
    return decision;

  } catch (err) {
    console.error('[manager/route] Box error:', err.message);
    const sorted = [...personalities].sort((a, b) =>
      (state.participationCounts?.[a.name] || 0) - (state.participationCounts?.[b.name] || 0)
    );
    return {
      shouldContinue: (state.roundNumber || 1) <= 2,
      selectedPersonalities: sorted.slice(0, 3).map(p => p.name),
      energy: 0.3,
      drift: 'on_task',
      humanIntent: 'open_question',
      reason: 'fallback - box error',
      deliverablePhase: 'exploring',
      sopStep: 3,
      _deliverableTracker: state.deliverableTracker || '',
    };
  } finally {
    if (box) { try { await box.delete(); } catch (_) {} }
  }
}

// ─── Run the Manager in REFLECT mode ─────────────────────────────────────────
// Called after agents respond. Writes private notes, stores in Redis,
// publishes to Ably thinking room. Non-blocking — called fire-and-forget.
async function runManagerReflect(agentResponses, personalities, state = {}) {
  if (!agentResponses || agentResponses.length === 0) return null;

  const { channelId = "general", sessionId = "", runId = "unknown" } = state;

  let box;
  try {
    const snapshotId = getSnapshot('manager');
    box = snapshotId
      ? await Box.fromSnapshot(snapshotId, {
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 90000,
        })
      : await Box.create({
          runtime: "python",
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 90000,
        });

    const prompt = buildManagerPrompt(personalities, { ...state, agentResponses }, 'reflect');
    const result = await box.agent.run({ prompt: `${prompt}\n\nJSON only:` });
    const raw = typeof result.result === "string" ? result.result : JSON.stringify(result.result);

    const reflection = parseJson(raw);
    if (!reflection?.notes) {
      console.warn('[manager/reflect] No notes in response, skipping store');
      return null;
    }

    // Store each agent's notes in dedicated mesh Redis (not Cozy's personal memory)
    const redis = getMeshRedis();
    for (const [agentName, note] of Object.entries(reflection.notes)) {
      const key = keys.notes(channelId, agentName);
      await redis.set(key, JSON.stringify(note), { ex: 3600 }).catch(err =>
        console.warn(`[manager/reflect] Redis store failed for ${agentName}:`, err.message)
      );
    }

    // Publish to Ably — ops dashboard thinking room
    try {
      await ably.emitToChannel(`thinking:${sessionId}`, 'manager-reflection', {
        round: state.roundNumber,
        notes: reflection.notes,
        managerObservation: reflection.managerObservation,
        channelId,
        sessionId,
        timestamp: new Date().toISOString(),
      });
    } catch (ablyErr) {
      console.warn('[manager/reflect] Ably publish failed:', ablyErr.message);
    }

    console.log(`[manager/reflect] Notes written for: ${Object.keys(reflection.notes).join(', ')}`);
    if (reflection.managerObservation) {
      console.log(`[manager/reflect] Observation: ${reflection.managerObservation}`);
    }

    return reflection;

  } catch (err) {
    console.error('[manager/reflect] Box error:', err.message);
    return null;
  } finally {
    if (box) { try { await box.delete(); } catch (_) {} }
  }
}

// ─── Fetch private notes for a personality ────────────────────────────────────
// Called by agent.js before commissioning personality Boxes.
// Returns unvoiced disagreements to surface in the next round.
async function getPrivateNotes(personalityName, channelId) {
  try {
    const redis = getMeshRedis();
    const key = keys.notes(channelId, personalityName);
    const raw = await redis.get(key);
    if (!raw) return [];
    const note = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return note.disagreements || [];
  } catch (err) {
    console.warn(`[manager/reflect] Redis fetch failed for ${personalityName}:`, err.message);
    return [];
  }
}

// ─── JSON parser ─────────────────────────────────────────────────────────────
function parseJson(raw) {
  if (!raw) return null;
  try {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {}
  return null;
}

module.exports = { runManagerRoute, runManagerReflect, getPrivateNotes, buildManagerPrompt };
