// cozyemployee-mesh/reflect.js
//
// Private Cognition — adapted from bot-communicator's agent-reflect.
//
// In bot-communicator: Supabase Edge Function + Gemini tool-call with record_reflection.
// In our system: a Box DPN that generates structured private notes, stored in
//   Upstash Redis and published to Ably for the ops dashboard "thinking room."
//
// This is what makes agents feel like they have actual positions instead of
// just reacting to the last message. Unvoiced disagreements are surfaced
// back into the next round via conversationContext.privateNotes.

const { Box, Agent, BoxApiKey } = require("@upstash/box");
const ably = require("../workflows/src/ably");
const { getSnapshot } = require("./snapshots");
const { meshBoxConfig } = require("./box-env");

const MODEL = "openrouter/stepfun/step-3.5-flash:free";

const REFLECTION_SCHEMA_PROMPT = `Respond with ONLY valid JSON matching this exact structure:
{
  "respondedTo": "what I was responding to (1 sentence)",
  "myResponse": "brief summary of what I said (1 sentence)",
  "reasoning": "why I said it (1-2 sentences)",
  "agreements": ["point I agree with from others (max 3, 1 sentence each)"],
  "disagreements": ["point I disagree with and why (max 3, 1 sentence each)"],
  "openQuestions": ["things I'm uncertain about (max 3, 1 sentence each)"],
  "confidence": 0.0,
  "nextMoveIfCalled": "what I'd say next if asked (1 sentence)"
}`;

async function runReflection({ personalityName, personalityPrompt, myResponse, recentMessages, channelId, sessionId, runId }) {
  const contextStr = (recentMessages || []).slice(-15)
    .map(m => `${m.sender}: ${m.text.slice(0, 200)}`)
    .join('\n');

  const prompt = `You are the internal reasoning engine for "${personalityName}".
Their core cognitive lens: ${(personalityPrompt || '').split('\n').slice(1, 3).join(' ')}

Generate a concise private reflection about what ${personalityName} just said publicly.
Keep each field to 1-2 sentences. Arrays max 3 items.
Be honest about disagreements — these are PRIVATE notes, not public statements.

Recent conversation:
${contextStr}

${personalityName}'s public response was:
"${myResponse}"

${REFLECTION_SCHEMA_PROMPT}`;

  let box;
  let note;

  try {
    const snapshotId = getSnapshot('reflect');
    box = snapshotId
      ? await Box.fromSnapshot(snapshotId, {
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 60000,
        })
      : await Box.create({
          runtime: "python",
          agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
          ...meshBoxConfig(),
          timeout: 60000,
        });

    const result = await box.agent.run({ prompt });
    const raw = typeof result.result === "string" ? result.result : JSON.stringify(result.result);

    // Parse reflection JSON
    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        note = JSON.parse(cleaned.slice(start, end + 1));
      } else {
        throw new Error('no JSON object');
      }
    } catch (parseErr) {
      // Fallback reflection
      note = {
        respondedTo: '(parse error)',
        myResponse: myResponse.slice(0, 200),
        reasoning: 'Reflection could not be parsed.',
        agreements: [],
        disagreements: [],
        openQuestions: [],
        confidence: 0.5,
        nextMoveIfCalled: 'unknown',
      };
    }

    // Store in Redis (hot cache — accessible by next-round agent context)
    await storeReflectionInRedis(personalityName, channelId, note);

    // Publish to Ably thinking room — ops dashboard shows agents' inner monologue
    try {
      await ably.emitToChannel(`thinking-${personalityName}`, 'reflection', {
        id: `reflect-${Date.now()}`,
        personality: personalityName,
        channelId,
        sessionId,
        note,
        timestamp: new Date().toISOString(),
      });
    } catch (ablyErr) {
      console.warn(`[reflect] Ably publish failed for ${personalityName}:`, ablyErr.message);
    }

    console.log(`[reflect] ${personalityName} — disagreements=${note.disagreements?.length || 0}, confidence=${note.confidence}`);
    return note;

  } catch (err) {
    console.error(`[reflect] ${personalityName} Box error:`, err.message);
    return null;
  } finally {
    if (box) {
      try { await box.delete(); } catch (_) {}
    }
  }
}

// ─── Store reflection in Redis ────────────────────────────────────────────────
// Uses dedicated mesh Redis via mesh-storage — NOT Cozy's personal memory.
async function storeReflectionInRedis(personalityName, channelId, note) {
  try {
    const { getMeshRedis, keys } = require("./mesh-storage");
    const redis = getMeshRedis();
    const key = keys.notes(channelId, personalityName);
    await redis.set(key, JSON.stringify(note), { ex: 3600 });
    console.log(`[reflect] Stored to mesh Redis: ${key}`);
  } catch (err) {
    console.warn(`[reflect] Redis store failed:`, err.message);
  }
}

// ─── Fetch unvoiced disagreements for a personality ───────────────────────────
// NOTE: manager.js now owns this — this function is kept for backwards compat
// but delegates to mesh-storage. Both point at the same mesh Redis keys.
async function getPrivateNotes(personalityName, channelId) {
  try {
    const { getMeshRedis, keys } = require("./mesh-storage");
    const redis = getMeshRedis();
    const key = keys.notes(channelId, personalityName);
    const raw = await redis.get(key);
    if (!raw) return [];
    const note = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return note.disagreements || [];
  } catch (err) {
    console.warn(`[reflect] Redis fetch failed for ${personalityName}:`, err.message);
    return [];
  }
}

module.exports = { runReflection, getPrivateNotes, storeReflectionInRedis };
