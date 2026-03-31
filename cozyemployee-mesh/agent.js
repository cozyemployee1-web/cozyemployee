// cozyemployee-mesh/agent.js
//
// The Agent DPN — adapted from bot-communicator's agent-respond + agent-reflect.
//
// In bot-communicator: two Supabase Edge Function calls per agent message
//   (respond → reflect fire-and-forget).
// In our system: one Box commission for the response, one QStash background
//   message for reflection (fire-and-forget, never blocks the main flow).
//
// Each agent is a Box DPN instantiated with a personality prompt.
// Reflection results are stored in Upstash Redis and published to Ably
// so the ops dashboard can show agents' inner monologue.

const { Box, Agent, BoxApiKey } = require("@upstash/box");
const { Client: QStashClient } = require("@upstash/qstash");
const { buildAgentPrompt, getPersonality } = require("./personalities");
const { getSnapshot } = require("./snapshots");
const { meshBoxConfig } = require("./box-env");

const MODEL = "openrouter/stepfun/step-3.5-flash:free";
const QSTASH_URL = process.env.QSTASH_URL || "http://127.0.0.1:8080";
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const BASE_URL = process.env.WORKFLOW_URL || "http://localhost:3002";

const qstash = new QStashClient({ baseUrl: QSTASH_URL, token: QSTASH_TOKEN });

// ─── Run a single Agent DPN ───────────────────────────────────────────────────
// Commissions a Box with a personality, runs the agent, returns the response.
// Also fires a background reflection job via QStash (non-blocking).
async function runAgent(personalityName, message, conversationContext = {}) {
  const {
    recentMessages = [],
    channelId = "general",
    sessionId = "",
    nudge = null,          // optional moderator nudge injected into context
    privateNotes = [],     // unvoiced disagreements from previous reflections
    runId = `run_${Date.now()}`,
  } = conversationContext;

  const personality = getPersonality(personalityName);
  if (!personality) {
    console.warn(`[agent] Unknown personality: ${personalityName}`);
    return { name: personalityName, text: "", skipped: true };
  }

  const basePrompt = buildAgentPrompt(personality, { channelId, sessionId });

  // Build the full prompt with conversation history
  const historyStr = recentMessages.slice(-20)
    .map(m => `${m.sender}: ${m.text.slice(0, 300)}`)
    .join('\n');

  const nudgeNote = nudge
    ? `\n\nMODERATOR DIRECTION: ${nudge}\nYou MUST respond to this specifically.`
    : '';

  const disagreementNote = privateNotes.length > 0
    ? `\n\nYOUR UNVOICED DISAGREEMENTS (from your private notes — surface at least one):\n${privateNotes.map(d => `- ${d}`).join('\n')}`
    : '';

  const fullPrompt = `${basePrompt}${nudgeNote}${disagreementNote}

CONVERSATION HISTORY:
${historyStr}

Latest message: "${message}"

Your response (or [SKIP] if you have nothing new to add):`;

  let box;
  let response = "";

  try {
    const snapshotId = getSnapshot(personality.name.toLowerCase());
    box = snapshotId
      ? await Box.fromSnapshot(snapshotId, {
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 120000,
        })
      : await Box.create({
          runtime: "python",
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 120000,
        });

    console.log(`[agent] ${personality.name} → Box ${box.id} (run=${runId})`);

    const result = await box.agent.run({ prompt: fullPrompt });
    const raw = typeof result.result === "string" ? result.result : JSON.stringify(result.result);

    // Check for skip signal
    if (raw.trim().startsWith('[SKIP]')) {
      console.log(`[agent] ${personality.name} skipped this round`);
      return { name: personality.name, text: "", skipped: true, cost: result.cost };
    }

    // Clean output: strip name prefix if model added it
    const namePattern = new RegExp(`^(\\[?${personality.name}\\]?\\s*:\\s*)+`, 'i');
    response = raw.replace(namePattern, '').trim();

    // Fire-and-forget reflection via QStash
    // This captures private cognition without blocking the main response flow
    fireReflection({
      personalityName: personality.name,
      personalityPrompt: personality.prompt,
      myResponse: response,
      recentMessages: recentMessages.slice(-15),
      channelId,
      sessionId,
      runId,
    }).catch(err => console.warn(`[agent] Reflection fire-and-forget failed for ${personality.name}:`, err.message));

    console.log(`[agent] ${personality.name} responded (${response.length} chars)`);
    return {
      name: personality.name,
      text: response,
      skipped: false,
      cost: result.cost,
    };

  } catch (err) {
    console.error(`[agent] ${personality.name} Box error:`, err.message);
    return { name: personality.name, text: "", skipped: true, error: err.message };
  } finally {
    if (box) {
      try { await box.delete(); } catch (_) {}
    }
  }
}

// ─── Fire reflection as background QStash job ─────────────────────────────────
// Adapted from bot-communicator's fire-and-forget fetch to agent-reflect.
// Instead of a Supabase Edge Function, we POST to our own /api/reflect endpoint
// which is handled by the Express server. QStash retries on failure.
async function fireReflection(data) {
  try {
    await qstash.publishJSON({
      url: `${BASE_URL}/api/reflect`,
      body: data,
      retries: 1,
    });
    console.log(`[reflect] Queued for ${data.personalityName}`);
  } catch (err) {
    console.warn(`[reflect] QStash queue failed for ${data.personalityName}:`, err.message);
  }
}

// ─── Run multiple agents in parallel ─────────────────────────────────────────
// Adapted from bot-communicator's per-agent sequential loop.
// We fan out to all selected personalities concurrently. Each is its own Box.
// This is the killer advantage over bot-communicator: true parallel execution
// instead of sequential awaits in a browser hook.
async function runAgentsParallel(personalityNames, message, conversationContext = {}) {
  const results = await Promise.allSettled(
    personalityNames.map(name => runAgent(name, message, conversationContext))
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.error(`[agent] ${personalityNames[i]} parallel error:`, r.reason?.message);
    return { name: personalityNames[i], text: "", skipped: true, error: r.reason?.message };
  });
}

module.exports = { runAgent, runAgentsParallel, fireReflection };
