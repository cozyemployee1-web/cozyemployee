// cozyemployee-mesh/mesh-conversation.js
//
// The Mesh Conversation Workflow — the main orchestration layer.
//
// Adapted from bot-communicator's useAgentResponder hook + triggerAgents loop.
// In bot-communicator: a React hook running in the browser, sequential agent
//   calls in a while loop, no durability.
// In our system: an Upstash Workflow (durable, resumable, QStash-backed).
//   Each round is a workflow step — if it crashes, QStash replays from the
//   last completed step. No lost state. No silent failures.
//
// Flow:
//   Human message → QStash → /api/workflow/mesh-conversation
//   → Step 1: Moderator DPN (which personalities respond?)
//   → Step 2: Fan-out to selected personality DPNs (parallel Boxes)
//   → Step 3: Persist messages + publish to Ably
//   → Step 4: If shouldContinue, loop (up to maxRounds)
//   → Step 5: Synthesizer delivers final synthesis to human
//
// The big difference from bot-communicator: this runs server-side, durably,
// with real parallel execution. The browser just subscribes to Ably events.

const { serve } = require("@upstash/workflow/express");
const ably = require("../workflows/src/ably");
const { runManagerRoute, runManagerReflect } = require("./manager");
const { runAgentsParallel } = require("./agent");
const { getAllPersonalities, getPersonality } = require("./personalities");
const { getMeshRedis, keys } = require("./mesh-storage");

const redis = getMeshRedis();

const MAX_ROUNDS = 12;
const ENERGY_FLOOR = 0.15;

// ─── Mesh Conversation Workflow ───────────────────────────────────────────────
const meshConversationWorkflow = serve(async (context) => {
  const {
    message,         // The human's message
    sessionId,       // Unique session/conversation ID
    channelId = "general",
    run_id,
    maxRounds = MAX_ROUNDS,
    activePersonalities, // Optional: override which personalities are active
  } = context.requestPayload;

  const runId = run_id || `mesh_${Date.now()}`;
  const personalities = activePersonalities
    ? activePersonalities.map(n => getPersonality(n)).filter(Boolean)
    : getAllPersonalities();

  // Signal start
  await ably.emitLifecycle(runId, "started", { message: message?.slice(0, 100), channelId, sessionId });
  await ably.health.workflowStarted(runId, { type: "mesh-conversation", channelId });

  // ── Load conversation history from Redis ─────────────────────────────────
  const historyKey = keys.history(sessionId);
  const convHistory = await context.run("load-history", async () => {
    try {
      const raw = await redis.get(historyKey);
      return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    } catch { return []; }
  });

  // Add human message to history
  const updatedHistory = [...convHistory, { sender: "Human", text: message, timestamp: Date.now() }];

  // ── Conversation state ───────────────────────────────────────────────────
  let round = 0;
  let energy = 1.0;
  let deliverableTracker = "";
  let nudgeFailCount = 0;
  let lastNudge = null;
  let consecutiveEmpty = 0;
  const participationCounts = {};
  personalities.forEach(p => { participationCounts[p.name] = 0; });

  const allMessages = [...updatedHistory];

  // ── Conversation loop ─────────────────────────────────────────────────────
  // Each round is a durable workflow step. QStash replays from the last
  // completed step on failure — no lost work.
  while (round < maxRounds && energy > ENERGY_FLOOR) {
    round++;

    // ── Step: Manager routes the round (SOP-driven) ────────────────────────
    const moderation = await context.run(`manage-round-${round}`, async () => {
      await ably.emitStep(runId, `round-${round}`, { round, energy }, "started");

      const latestMessage = allMessages[allMessages.length - 1]?.text || message;
      const source = round === 1 ? "human" : "mesh_flow";

      const decision = await runManagerRoute(latestMessage, personalities, {
        recentMessages: allMessages,
        roundNumber: round,
        previousResponders: allMessages.filter(m => m.sender !== "Human").map(m => m.sender),
        participationCounts,
        deliverableTracker,
        previousEnergy: energy,
        nudgeFailCount,
        source,
      });

      return decision;
    });

    // Update state from moderation decision
    energy = moderation.energy;
    if (moderation._deliverableTracker) {
      deliverableTracker = moderation._deliverableTracker;
    }

    // Handle nudge quality tracking
    if (lastNudge && moderation.nudge) {
      nudgeFailCount++;
    } else if (moderation.nudge) {
      nudgeFailCount = 0;
    }
    lastNudge = moderation.nudge || null;

    // Check stop conditions
    if (!moderation.shouldContinue || moderation.selectedPersonalities.length === 0) {
      console.log(`[mesh] Round ${round}: shouldContinue=false, stopping`);
      break;
    }
    if (moderation.interventionTier === 3) {
      console.log(`[mesh] Round ${round}: Tier 3 hard pause`);
      if (moderation.nudge) {
        allMessages.push({ sender: "[Moderator]", text: moderation.nudge, timestamp: Date.now() });
        await ably.emitToChannel(`mesh:${sessionId}`, "message", {
          sender: "[Moderator]",
          text: moderation.nudge,
          round,
          isModerator: true,
        });
      }
      break;
    }
    if (energy < ENERGY_FLOOR) {
      console.log(`[mesh] Round ${round}: energy depleted (${energy})`);
      break;
    }

    // Inject moderator nudge into context (not displayed publicly unless Tier 2+)
    if (moderation.nudge && moderation.interventionTier === 2) {
      allMessages.push({ sender: "[Moderator]", text: moderation.nudge, timestamp: Date.now() });
      await ably.emitToChannel(`mesh:${sessionId}`, "message", {
        sender: "[Moderator]",
        text: moderation.nudge,
        round,
        isModerator: true,
      });
    }

    // ── Step: Fan-out to selected personalities ───────────────────────────
    const responses = await context.run(`agents-round-${round}`, async () => {
      const selected = moderation.selectedPersonalities;

      // Fetch each agent's private notes (unvoiced disagreements from Manager)
      // Don't block fan-out — do this inline per agent
      const { getPrivateNotes } = require("./manager");

      const results = await runAgentsParallel(
        selected,
        allMessages[allMessages.length - 1]?.text || message,
        {
          recentMessages: allMessages,
          channelId,
          sessionId,
          nudge: moderation.nudge,
          runId,
          // privateNotes loaded per-agent inside runAgent via getPrivateNotes
        }
      );

      return results;
    });

    // ── Step: Persist + publish responses ────────────────────────────────
    await context.run(`publish-round-${round}`, async () => {
      let roundHadContent = false;

      for (const resp of responses) {
        if (!resp.text?.trim() || resp.skipped) continue;

        roundHadContent = true;
        const msg = { sender: resp.name, text: resp.text, timestamp: Date.now(), round };
        allMessages.push(msg);
        participationCounts[resp.name] = (participationCounts[resp.name] || 0) + 1;

        // Persist to Redis (conversation history)
        // (will do a full save at end of round for efficiency)

        // Publish to Ably for real-time delivery to UI
        await ably.emitToChannel(`mesh:${sessionId}`, "message", {
          sender: resp.name,
          text: resp.text,
          round,
          personality: resp.name,
          cost: resp.cost,
        });

        console.log(`[mesh] Round ${round}: ${resp.name} responded (${resp.text.length} chars)`);
      }

      if (!roundHadContent) consecutiveEmpty++;
      else consecutiveEmpty = 0;

      // Circuit breaker
      if (consecutiveEmpty >= 2) {
        console.log('[mesh] Circuit breaker: 2 consecutive empty rounds');
        energy = 0; // Will stop the loop
      }

      // Save full history to Redis after each round
      try {
        await redis.set(historyKey, JSON.stringify(allMessages), { ex: 86400 }); // 24h TTL
      } catch (err) {
        console.warn('[mesh] Redis history save failed:', err.message);
      }

      // ── Manager Reflection (fire-and-forget) ───────────────────────────
      // Manager writes private notes for each agent that responded.
      // Non-blocking — results feed into the NEXT round via Redis.
      const roundResponses = responses.filter(r => r.text?.trim() && !r.skipped);
      if (roundResponses.length > 0) {
        runManagerReflect(roundResponses, personalities, {
          recentMessages: allMessages,
          roundNumber: round,
          participationCounts,
          channelId,
          sessionId,
          runId,
        }).catch(err => console.warn('[mesh] Manager reflection error:', err.message));
      }
    });

    // Check circuit breaker
    if (consecutiveEmpty >= 2 || energy <= 0) break;

    // Emit round completion to ops dashboard
    await ably.emitStep(runId, `round-${round}`, {
      round,
      energy,
      drift: moderation.drift,
      respondents: responses.filter(r => !r.skipped).map(r => r.name),
      deliverablePhase: moderation.deliverablePhase,
    });
  }

  // ── Final state signal ────────────────────────────────────────────────────
  await ably.emitLifecycle(runId, "completed", {
    rounds: round,
    messageCount: allMessages.filter(m => m.sender !== "Human").length,
    energy,
  });
  await ably.health.workflowCompleted(runId, {
    type: "mesh-conversation",
    rounds: round,
    participants: Object.keys(participationCounts).filter(k => participationCounts[k] > 0),
  });

  return {
    sessionId,
    rounds: round,
    messages: allMessages.filter(m => m.sender !== "Human"),
    energy,
    deliverableTracker,
  };
});

module.exports = { meshConversationWorkflow };
