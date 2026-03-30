// src/workflows/box-brain.js
// Box as External Brain — Workflow commissions Box to research, analyze, store knowledge.
// Pattern: QStash → Workflow → Box → Redis/Vector → Workflow

const { serve } = require("@upstash/workflow/express");
const { Client } = require("@upstash/qstash");

const QSTASH_URL = process.env.QSTASH_URL || "http://127.0.0.1:8080";
const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
const BASE_URL = process.env.WORKFLOW_URL || "http://127.0.0.1:3002";

const qstashClient = new Client({ baseUrl: QSTASH_URL, token: QSTASH_TOKEN });

// ─── Helper: Commission a Box ───────────────────────────────
async function commissionBox(prompt, options = {}) {
  const { Box, Agent, BoxApiKey } = await import("@upstash/box");

  const box = await Box.create({
    runtime: options.runtime || "python",
    agent: {
      provider: Agent.OpenCode,
      model: options.model || "openrouter/stepfun/step-3.5-flash:free",
      apiKey: BoxApiKey.StoredKey,
    },
    timeout: options.timeout || 300000,
    env: options.env || {},
  });

  console.log(`[box] Commissioned: ${box.id}`);

  try {
    const result = await box.agent.run({
      prompt,
      responseSchema: options.schema,
    });
    console.log(`[box] Result received from ${box.id}`);
    return { boxId: box.id, result: result.result, cost: result.cost };
  } finally {
    await box.delete();
    console.log(`[box] Released: ${box.id}`);
  }
}

// ─── Pattern 1: Research & Store ────────────────────────────
// Workflow commissions Box to research a topic, then stores results.
const researchWorkflow = serve(
  async (context) => {
    const { topic } = context.requestPayload;

    // Step 1: Commission Box to research
    const research = await context.run("commission-research", async () => {
      const z = (await import("zod")).z;
      const schema = z.object({
        summary: z.string(),
        key_findings: z.array(z.string()),
        assumptions: z.array(z.string()),
        confidence: z.enum(["high", "medium", "low"]),
      });

      return await commissionBox(
        `Research the following topic and provide structured findings:\n\n${topic}\n\nBe specific and technical. Include assumptions you're making.`,
        { schema }
      );
    });

    // Step 2: Store in Redis (hot cache)
    await context.run("store-redis", async () => {
      console.log(`[research] Storing in Redis: ${topic}`);
      // TODO: redis.set(`research:${topic}`, JSON.stringify(research.result))
      return { stored: true, key: `research:${topic}` };
    });

    // Step 3: Store in Vector (semantic search)
    await context.run("store-vector", async () => {
      console.log(`[research] Storing in Vector: ${topic}`);
      // TODO: index.upsert({ id: topic, data: research.result.summary, metadata: {...} })
      return { stored: true, id: topic };
    });

    // Step 4: Report
    const report = await context.run("report", async () => {
      const r = {
        topic,
        findings: research.result.key_findings.length,
        confidence: research.result.confidence,
        boxCost: research.cost,
      };
      console.log("[research] Report:", JSON.stringify(r));
      return r;
    });

    return report;
  },
  { url: `${BASE_URL}/api/workflow/research`, qstashClient, verbose: true }
);

// ─── Pattern 2: Parallel Brain — Multiple Boxes ─────────────
// Commission 3 Boxes to solve the same problem, compare results.
const parallelBrainWorkflow = serve(
  async (context) => {
    const { problem } = context.requestPayload;

    // Step 1: Commission 3 Boxes with different prompts
    const results = await context.run("parallel-brain", async () => {
      console.log(`[parallel] Commissioning 3 brains for: ${problem}`);

      const [brain1, brain2, brain3] = await Promise.all([
        commissionBox(
          `You are a pragmatic engineer. Solve this problem concisely:\n\n${problem}\n\nFocus on practical implementation.`,
          { model: "openrouter/stepfun/step-3.5-flash:free" }
        ),
        commissionBox(
          `You are a systems architect. Solve this problem with focus on scalability:\n\n${problem}\n\nFocus on architecture and trade-offs.`,
          { model: "openrouter/stepfun/step-3.5-flash:free" }
        ),
        commissionBox(
          `You are a security expert. Solve this problem with focus on security:\n\n${problem}\n\nFocus on vulnerabilities and hardening.`,
          { model: "openrouter/stepfun/step-3.5-flash:free" }
        ),
      ]);

      return { brain1, brain2, brain3 };
    });

    // Step 2: Synthesize results with a 4th Box
    const synthesis = await context.run("synthesize", async () => {
      const z = (await import("zod")).z;
      const schema = z.object({
        best_approach: z.string(),
        combined_insights: z.array(z.string()),
        risks: z.array(z.string()),
      });

      return await commissionBox(
        `Three experts analyzed this problem:\n\nEngineer: ${results.brain1.result}\n\nArchitect: ${results.brain2.result}\n\nSecurity: ${results.brain3.result}\n\nSynthesize their perspectives into a unified approach.`,
        { schema }
      );
    });

    // Step 3: Store the synthesis
    await context.run("store-synthesis", async () => {
      console.log("[parallel] Storing synthesis");
      return { stored: true, approach: synthesis.result.best_approach };
    });

    return synthesis.result;
  },
  { url: `${BASE_URL}/api/workflow/parallel-brain`, qstashClient, verbose: true }
);

// ─── Pattern 3: Knowledge Builder ───────────────────────────
// Box analyzes recent work, extracts patterns, updates knowledge base.
const knowledgeBuilderWorkflow = serve(
  async (context) => {
    const { timeframe } = context.requestPayload || { timeframe: "24h" };

    // Step 1: Gather recent activity
    const activity = await context.run("gather-activity", async () => {
      console.log(`[knowledge] Gathering activity from last ${timeframe}`);
      // TODO: Pull from Redis activity log
      return {
        events: [
          "Built E2B Desktop agent with CLI-first approach",
          "Deployed Upstash Workflow with 7 patterns tested",
          "Compared Vast.ai vs RunPod vs Modal for GPU strategy",
        ],
        timeframe,
      };
    });

    // Step 2: Commission Box to extract patterns
    const patterns = await context.run("extract-patterns", async () => {
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

      return await commissionBox(
        `Analyze these recent activities and extract key patterns:\n\n${activity.events.join("\n")}\n\nIdentify decisions made, lessons learned, anti-patterns to avoid, and open questions.`,
        { schema }
      );
    });

    // Step 3: Store patterns
    await context.run("store-patterns", async () => {
      console.log("[knowledge] Storing patterns:", JSON.stringify(patterns.result));
      return { stored: true, patterns: patterns.result };
    });

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
