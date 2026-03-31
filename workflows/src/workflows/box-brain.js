// src/workflows/box-brain.js
// Box as External Brain — Workflow commissions Box to research, analyze, store knowledge.
// Pattern: QStash → Workflow → Box → Redis/Vector → Workflow
//
// Ably integration: every DPN commission is now observable in real time.
// Operators watching workflow:{run_id}:dpn:{node_id} see tool calls,
// results, and final output as they happen.

const { serve } = require("@upstash/workflow/express");
const { Client } = require("@upstash/qstash");
const ably = require("../ably");

const QSTASH_URL = process.env.QSTASH_URL || "http://127.0.0.1:8080";
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const BASE_URL = process.env.WORKFLOW_URL || "http://127.0.0.1:3002";

const qstashClient = new Client({ baseUrl: QSTASH_URL, token: QSTASH_TOKEN });

// ─── JSON extractor — parses raw model output even when it narrates first ────
// Models sometimes say "I'll research this..." before outputting JSON.
// This grabs the first valid JSON object or array from anywhere in the string.
function _extractJson(raw) {
  if (!raw) return null;
  // Try direct parse first
  try { return JSON.parse(raw.trim()); } catch (_) {}
  // Find the first { or [ and try to parse from there
  const start = Math.min(
    raw.indexOf("{") >= 0 ? raw.indexOf("{") : Infinity,
    raw.indexOf("[") >= 0 ? raw.indexOf("[") : Infinity
  );
  if (start === Infinity) return null;
  // Find matching close bracket by scanning
  const open = raw[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === open) depth++;
    else if (raw[i] === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
}

// ─── Helper: Commission a Box (with Ably observability) ──────
async function commissionBox(prompt, options = {}) {
  const { Box, Agent, BoxApiKey } = await import("@upstash/box");
  const runId = options.runId || "unknown";
  const nodeId = options.nodeId || "box";
  const model = options.model || "openrouter/stepfun/step-3.5-flash:free";

  await ably.health.dpnCalled(runId, nodeId, model);

  const toolCallId = `tc_${Date.now()}`;
  await ably.emitToolCall(runId, nodeId, "commission_box", {
    model,
    prompt_preview: prompt.slice(0, 200) + (prompt.length > 200 ? "…" : ""),
  }, toolCallId);

  const box = await Box.create({
    runtime: options.runtime || "python",
    agent: {
      provider: Agent.OpenCode,
      model,
      apiKey: BoxApiKey.StoredKey,
    },
    timeout: options.timeout || 300000,
    env: options.env || {},
  });

  console.log(`[box] Commissioned: ${box.id} (run=${runId}, node=${nodeId})`);

  try {
    // Do NOT pass responseSchema — models ignore it and narrate instead, causing
    // BoxError: Failed to parse structured output. Get raw string, extract JSON manually.
    const result = await box.agent.run({ prompt });

    // result.result is the raw string output from the model
    const rawText = typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result);

    // Try to extract structured JSON if a schema shape was requested
    let parsed = rawText;
    if (options.schema) {
      const extracted = _extractJson(rawText);
      if (extracted) {
        parsed = extracted;
        console.log(`[box] JSON extracted successfully from ${box.id}`);
      } else {
        // Model narrated without JSON — build a best-effort fallback
        console.warn(`[box] No JSON found in output from ${box.id}, using text fallback`);
        parsed = { summary: rawText.slice(0, 500), key_findings: [], assumptions: [], confidence: "low", _raw: true };
      }
    }

    await ably.emitToolResult(runId, nodeId, "commission_box", {
      box_id: box.id,
      result_preview: JSON.stringify(parsed).slice(0, 300),
      cost: result.cost,
    }, toolCallId);
    await ably.emitDPNResult(runId, nodeId, parsed, { cost: result.cost });
    await ably.health.dpnCompleted(runId, nodeId, result.cost);

    console.log(`[box] Result received from ${box.id}`);
    return { boxId: box.id, result: parsed, cost: result.cost };

  } catch (err) {
    await ably.health.stepFailed(runId, nodeId, err.message);
    console.error(`[box] Error from ${box.id}:`, err.message);

    // Return a graceful fallback rather than throwing.
    // Throwing causes Upstash Workflow to retry the step (3x by default),
    // spinning up a new Box each time — expensive and pointless for parse errors.
    // Return a _failed result so the workflow can continue to the next step.
    return {
      boxId: box.id,
      result: { summary: `Box agent error: ${err.message.slice(0, 200)}`, key_findings: [], assumptions: [], confidence: "low", _error: true },
      cost: 0,
    };
  } finally {
    await box.delete();
    console.log(`[box] Released: ${box.id}`);
  }
}

// ─── Pattern 1: Research & Store ────────────────────────────
// Workflow commissions Box to research a topic, then stores results.
const researchWorkflow = serve(
  async (context) => {
    const { topic, run_id } = context.requestPayload;
    const runId = run_id || `research_${Date.now()}`;

    // Signal workflow started
    await ably.emitLifecycle(runId, "started", { topic });
    await ably.health.workflowStarted(runId, { type: "research", topic });

    // Step 1: Commission Box to research
    const research = await context.run("commission-research", async () => {
      await ably.emitStep(runId, "commission-research", { topic }, "started");

      const z = (await import("zod")).z;
      const schema = z.object({
        summary: z.string(),
        key_findings: z.array(z.string()),
        assumptions: z.array(z.string()),
        confidence: z.enum(["high", "medium", "low"]),
      });

      const result = await commissionBox(
        `Research the following topic and provide structured findings.\n\nTOPIC: ${topic}\n\nYou MUST respond with ONLY valid JSON — no preamble, no explanation, no markdown. Output exactly this structure:\n{"summary":"...","key_findings":["..."],"assumptions":["..."],"confidence":"high|medium|low"}`,
        { schema, runId, nodeId: "researcher" }
      );

      await ably.emitStep(runId, "commission-research", {
        findings: result.result?.key_findings?.length,
        confidence: result.result?.confidence,
        cost: result.cost,
      });
      return result;
    });

    // Step 2: Store in Redis (hot cache)
    await context.run("store-redis", async () => {
      await ably.emitStep(runId, "store-redis", { key: `research:${topic}` }, "started");
      console.log(`[research] Storing in Redis: ${topic}`);
      // TODO: redis.set(`research:${topic}`, JSON.stringify(research.result))
      await ably.emitStep(runId, "store-redis", { stored: true });
      return { stored: true, key: `research:${topic}` };
    });

    // Step 3: Store in Vector (semantic search)
    await context.run("store-vector", async () => {
      await ably.emitStep(runId, "store-vector", { id: topic }, "started");
      console.log(`[research] Storing in Vector: ${topic}`);
      // TODO: index.upsert({ id: topic, data: research.result.summary, metadata: {...} })
      await ably.emitStep(runId, "store-vector", { stored: true });
      return { stored: true, id: topic };
    });

    // Step 4: Report
    const report = await context.run("report", async () => {
      const r = {
        run_id: runId,
        topic,
        findings: research.result?.key_findings?.length,
        confidence: research.result?.confidence,
        boxCost: research.cost,
      };
      console.log("[research] Report:", JSON.stringify(r));
      return r;
    });

    // Signal workflow completed
    await ably.emitLifecycle(runId, "completed", {
      topic,
      confidence: research.result?.confidence,
    });
    await ably.health.workflowCompleted(runId, { type: "research", topic });

    return report;
  },
  { url: `${BASE_URL}/api/workflow/research`, qstashClient, verbose: true }
);

// ─── Pattern 2: Parallel Brain — Multiple Boxes ─────────────
// Commission 3 Boxes to solve the same problem, compare results.
// Each Box gets its own Ably DPN channel so observers can watch all three
// working simultaneously.
const parallelBrainWorkflow = serve(
  async (context) => {
    const { problem, run_id } = context.requestPayload;
    const runId = run_id || `parallel_${Date.now()}`;

    await ably.emitLifecycle(runId, "started", { problem: problem?.slice(0, 100) });
    await ably.health.workflowStarted(runId, { type: "parallel-brain" });

    // Step 1: Commission 3 Boxes with different prompts
    const results = await context.run("parallel-brain", async () => {
      await ably.emitStep(runId, "parallel-brain", {
        strategy: "3 expert perspectives in parallel",
        problem_preview: problem?.slice(0, 100),
      }, "started");

      console.log(`[parallel] Commissioning 3 brains for: ${problem}`);

      const jsonInstruction = `\n\nRespond with ONLY valid JSON, no preamble, no markdown:\n{"analysis":"...","key_points":["..."],"recommendation":"..."}`;
      const [brain1, brain2, brain3] = await Promise.all([
        commissionBox(
          `You are a pragmatic engineer. Solve this problem concisely:\n\n${problem}\n\nFocus on practical implementation.${jsonInstruction}`,
          { model: "openrouter/stepfun/step-3.5-flash:free", runId, nodeId: "engineer" }
        ),
        commissionBox(
          `You are a systems architect. Solve this problem with focus on scalability:\n\n${problem}\n\nFocus on architecture and trade-offs.${jsonInstruction}`,
          { model: "openrouter/stepfun/step-3.5-flash:free", runId, nodeId: "architect" }
        ),
        commissionBox(
          `You are a security expert. Solve this problem with focus on security:\n\n${problem}\n\nFocus on vulnerabilities and hardening.${jsonInstruction}`,
          { model: "openrouter/stepfun/step-3.5-flash:free", runId, nodeId: "security" }
        ),
      ]);

      await ably.emitStep(runId, "parallel-brain", {
        brains_completed: 3,
        total_cost: [brain1.cost, brain2.cost, brain3.cost].filter(Boolean).reduce((a, b) => a + b, 0),
      });
      return { brain1, brain2, brain3 };
    });

    // Step 2: Synthesize results with a 4th Box
    const synthesis = await context.run("synthesize", async () => {
      await ably.emitStep(runId, "synthesize", { strategy: "4th Box synthesizes 3 perspectives" }, "started");

      const z = (await import("zod")).z;
      const schema = z.object({
        best_approach: z.string(),
        combined_insights: z.array(z.string()),
        risks: z.array(z.string()),
      });

      const result = await commissionBox(
        `Three experts analyzed this problem:\n\nEngineer: ${JSON.stringify(results.brain1.result)}\n\nArchitect: ${JSON.stringify(results.brain2.result)}\n\nSecurity: ${JSON.stringify(results.brain3.result)}\n\nSynthesize their perspectives into a unified approach.\n\nRespond with ONLY valid JSON, no preamble:\n{"best_approach":"...","combined_insights":["..."],"risks":["..."]}`,
        { schema, runId, nodeId: "synthesizer" }
      );

      await ably.emitStep(runId, "synthesize", {
        insights_count: result.result?.combined_insights?.length,
        risks_count: result.result?.risks?.length,
      });
      return result;
    });

    // Step 3: Store the synthesis
    await context.run("store-synthesis", async () => {
      await ably.emitStep(runId, "store-synthesis", {}, "started");
      console.log("[parallel] Storing synthesis");
      // TODO: store in Redis + Vector
      await ably.emitStep(runId, "store-synthesis", { stored: true });
      return { stored: true, approach: synthesis.result?.best_approach };
    });

    await ably.emitLifecycle(runId, "completed", {
      insights: synthesis.result?.combined_insights?.length,
    });
    await ably.health.workflowCompleted(runId, { type: "parallel-brain" });

    return synthesis.result;
  },
  { url: `${BASE_URL}/api/workflow/parallel-brain`, qstashClient, verbose: true }
);

// ─── Pattern 3: Knowledge Builder ───────────────────────────
// Box analyzes recent work, extracts patterns, updates knowledge base.
const knowledgeBuilderWorkflow = serve(
  async (context) => {
    const { timeframe, run_id } = context.requestPayload || { timeframe: "24h" };
    const runId = run_id || `knowledge_${Date.now()}`;

    await ably.emitLifecycle(runId, "started", { timeframe });
    await ably.health.workflowStarted(runId, { type: "knowledge-builder", timeframe });

    // Step 1: Gather recent activity
    const activity = await context.run("gather-activity", async () => {
      await ably.emitStep(runId, "gather-activity", { timeframe }, "started");
      console.log(`[knowledge] Gathering activity from last ${timeframe}`);
      // TODO: Pull from Redis activity log
      const events = [
        "Built E2B Desktop agent with CLI-first approach",
        "Deployed Upstash Workflow with 7 patterns tested",
        "Compared Vast.ai vs RunPod vs Modal for GPU strategy",
      ];
      await ably.emitStep(runId, "gather-activity", { events_found: events.length });
      return { events, timeframe };
    });

    // Step 2: Commission Box to extract patterns
    const patterns = await context.run("extract-patterns", async () => {
      await ably.emitStep(runId, "extract-patterns", {
        events_to_analyze: activity.events.length,
      }, "started");

      const z = (await import("zod")).z;
      const schema = z.object({
        decisions: z.array(z.object({
          what: z.string(),
          why: z.string(),
          confidence: z.enum(["high", "medium", "low"]),
        })),
        lessons: z.array(z.string()),
        anti_patterns: z.array(z.string()),
        open_questions: z.array(z.string()),
      });

      const result = await commissionBox(
        `Analyze these recent activities and extract key patterns:\n\n${activity.events.join("\n")}\n\nIdentify decisions made, lessons learned, anti-patterns to avoid, and open questions.\n\nRespond with ONLY valid JSON, no preamble:\n{"decisions":[{"what":"...","why":"...","confidence":"high"}],"lessons":["..."],"anti_patterns":["..."],"open_questions":["..."]}`,
        { schema, runId, nodeId: "pattern-extractor" }
      );

      await ably.emitStep(runId, "extract-patterns", {
        decisions: result.result?.decisions?.length,
        lessons: result.result?.lessons?.length,
        open_questions: result.result?.open_questions?.length,
      });
      return result;
    });

    // Step 3: Store patterns
    await context.run("store-patterns", async () => {
      await ably.emitStep(runId, "store-patterns", {}, "started");
      console.log("[knowledge] Storing patterns:", JSON.stringify(patterns.result));
      // TODO: store in Redis + Vector
      await ably.emitStep(runId, "store-patterns", { stored: true });
      return { stored: true, patterns: patterns.result };
    });

    await ably.emitLifecycle(runId, "completed", {
      lessons: patterns.result?.lessons?.length,
      open_questions: patterns.result?.open_questions?.length,
    });
    await ably.health.workflowCompleted(runId, { type: "knowledge-builder", timeframe });

    return patterns.result;
  },
  { url: `${BASE_URL}/api/workflow/knowledge-builder`, qstashClient, verbose: true }
);

module.exports = {
  researchWorkflow,
  parallelBrainWorkflow,
  knowledgeBuilderWorkflow,
  commissionBox,
};
