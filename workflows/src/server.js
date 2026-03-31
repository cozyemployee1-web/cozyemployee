// src/server.js
// Workflow Nerve Net — Full Server with Advanced Patterns

const express = require("express");
const { Client } = require("@upstash/qstash");

const hello = require("./workflows/hello");
const memorySync = require("./workflows/memory-sync");
const advanced = require("./workflows/advanced");
const boxBrain = require("./workflows/box-brain");
const ably = require("./ably");
const { meshConversationWorkflow } = require("../../cozyemployee-mesh/mesh-conversation");
const { runManagerReflect } = require("../../cozyemployee-mesh/manager");
const { verifyMeshStorage } = require("../../cozyemployee-mesh/mesh-storage");

const app = express();
app.use(express.json());

const BASE_URL = process.env.WORKFLOW_URL || "http://127.0.0.1:3002";

// ─── Dashboard ──────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

// ─── Health ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    qstash: process.env.QSTASH_URL || "production",
    ably: process.env.ABLY_API_KEY ? "connected" : "disabled (no ABLY_API_KEY)",
    workflows: [
      "/api/workflow/hello",
      "/api/workflow/memory-sync",
      "/api/workflow/sleep",
      "/api/workflow/wait-event",
      "/api/workflow/call",
      "/api/workflow/fan-out",
      "/api/workflow/process-item",
      "/api/workflow/retry",
      "/api/workflow/saga",
      "/api/workflow/research",
      "/api/workflow/parallel-brain",
      "/api/workflow/knowledge-builder",
      "/api/workflow/mesh-conversation",
    ],
  });
});

// ─── Mount All Workflows ────────────────────────────────────
app.use("/api/workflow/hello", hello.workflow);
app.use("/api/workflow/memory-sync", memorySync.workflow);
app.use("/api/workflow/sleep", advanced.sleepWorkflow);
app.use("/api/workflow/wait-event", advanced.waitForEventWorkflow);
app.use("/api/workflow/call", advanced.callWorkflow);
app.use("/api/workflow/fan-out", advanced.fanOutWorkflow);
app.use("/api/workflow/process-item", advanced.processItemWorkflow);
app.use("/api/workflow/retry", advanced.retryWorkflow);
app.use("/api/workflow/saga", advanced.sagaWorkflow);
app.use("/api/workflow/research", boxBrain.researchWorkflow);
app.use("/api/workflow/parallel-brain", boxBrain.parallelBrainWorkflow);
app.use("/api/workflow/knowledge-builder", boxBrain.knowledgeBuilderWorkflow);
app.use("/api/workflow/mesh-conversation", meshConversationWorkflow);

// ─── Trigger Endpoints ──────────────────────────────────────
const qstashClient = new Client({
  baseUrl: process.env.QSTASH_URL || "http://127.0.0.1:8080",
  token: process.env.QSTASH_TOKEN,
});

function triggerRoute(path, workflowPath) {
  app.post(path, async (req, res) => {
    try {
      const result = await qstashClient.publishJSON({
        url: `${BASE_URL}${workflowPath}`,
        body: req.body || {},
      });
      res.json({ messageId: result.messageId, workflow: workflowPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

triggerRoute("/api/trigger/hello", "/api/workflow/hello");
triggerRoute("/api/trigger/memory-sync", "/api/workflow/memory-sync");
triggerRoute("/api/trigger/sleep", "/api/workflow/sleep");
triggerRoute("/api/trigger/wait-event", "/api/workflow/wait-event");
triggerRoute("/api/trigger/call", "/api/workflow/call");
triggerRoute("/api/trigger/fan-out", "/api/workflow/fan-out");
triggerRoute("/api/trigger/retry", "/api/workflow/retry");
triggerRoute("/api/trigger/saga", "/api/workflow/saga");
triggerRoute("/api/trigger/research", "/api/workflow/research");
triggerRoute("/api/trigger/parallel-brain", "/api/workflow/parallel-brain");
triggerRoute("/api/trigger/knowledge-builder", "/api/workflow/knowledge-builder");
triggerRoute("/api/trigger/mesh-conversation", "/api/workflow/mesh-conversation");

// ─── Static: Ops Dashboard ───────────────────────────────────
app.use(express.static("public"));

// ─── Preflight ACK ───────────────────────────────────────────
// Test 4 in the preflight suite — proves a Box can reach the ops server.
app.get("/api/preflight-ack", (req, res) => {
  res.json({
    ok: true,
    server: "workflow-nerve-net",
    ts: Date.now(),
    mesh: "cozyemployee",
    ably: !!process.env.ABLY_API_KEY,
    meshRedis: !!process.env.MESH_REDIS_REST_URL,
    meshVector: !!process.env.MESH_VECTOR_REST_URL,
  });
});

// ─── Preflight Streaming Endpoint ────────────────────────────
// Runs preflight boxes sequentially, streaming NDJSON results to the dashboard
// as each box completes. The ops dashboard reads the stream live.
app.get("/api/preflight", async (req, res) => {
  const { mode } = req.query; // "full" | "quick"
  const includeIdentity = mode === 'full';

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Lazily require to avoid circular dep at module load
  const { runPreflightForBox } = require('../../cozyemployee-mesh/preflight/preflight-runner');
  const { getAllPersonalities } = require('../../cozyemployee-mesh/personalities');
  const personalities = getAllPersonalities();

  const boxes = [
    { key: 'manager', prompt: null },
    ...personalities.map(p => ({ key: p.name.toLowerCase(), prompt: includeIdentity ? p.prompt : null })),
  ];

  let completed = 0;
  for (const { key, prompt } of boxes) {
    if (res.writableEnded) break;
    try {
      const result = await runPreflightForBox(key, prompt);
      res.write(JSON.stringify(result) + '\n');
      completed++;
      console.log(`[preflight] ${key} → ${result.ok ? '✅' : '❌'} (${result.durationMs}ms)`);
    } catch (err) {
      res.write(JSON.stringify({ box: key, ok: false, error: err.message, durationMs: 0, tests: {} }) + '\n');
    }
  }

  res.end();
});

// ─── Reflection Handler ──────────────────────────────────────
// Called by QStash fire-and-forget from the mesh agent system.
// ACK immediately so QStash doesn't retry on timeout; run reflection async.
// Note: reflection is now handled inline in mesh-conversation.js via runManagerReflect.
// This endpoint is kept as a manual trigger for debugging or external calls.
app.post("/api/reflect", (req, res) => {
  res.json({ queued: true });
  const { agentResponses, personalities, state } = req.body;
  runManagerReflect(agentResponses || [], personalities || [], state || {})
    .catch(err => console.error("[reflect] handler error:", err.message));
});

// ─── Ably: HITL Webhook Bridge ───────────────────────────────
// Ably fires this endpoint when an operator approves/rejects a tool call.
// This resumes the paused Upstash Workflow via QStash notify.
app.post("/ably/webhook", ably.webhookBridge(qstashClient, BASE_URL));

// Ably: Token endpoint for browser/client auth (never expose raw API key)
// /ably/token/global   — mesh-wide observer/operator token (for ops dashboard)
// /ably/token/:runId   — run-scoped token
app.get("/ably/token/:runId", async (req, res) => {
  const client = ably.getClient();
  if (!client) return res.status(503).json({ error: "Ably not configured" });

  try {
    const { runId } = req.params;
    const { role } = req.query; // "operator" | "observer"
    const isGlobal = runId === "global";

    let capabilities;
    if (isGlobal) {
      // Ops dashboard: full mesh visibility + approval publishing
      capabilities = role === "operator"
        ? {
            "workflow:*":       ["subscribe", "history"],
            "workflow:*:dpn:*": ["subscribe", "history"],
            "workflow:*:input": ["publish"],
            "mesh:health":      ["subscribe", "history"],
            "mesh:approvals":   ["subscribe", "publish", "history"],
          }
        : {
            "workflow:*":       ["subscribe", "history"],
            "workflow:*:dpn:*": ["subscribe", "history"],
            "mesh:health":      ["subscribe", "history"],
            "mesh:approvals":   ["subscribe", "history"],
          };
    } else {
      // Run-scoped token
      capabilities = role === "operator"
        ? {
            [`workflow:${runId}`]:       ["subscribe", "publish", "presence", "history"],
            [`workflow:${runId}:dpn:*`]: ["subscribe", "history"],
            [`workflow:${runId}:input`]: ["publish"],
            "mesh:approvals":            ["subscribe", "publish", "history"],
            "mesh:health":               ["subscribe", "history"],
          }
        : {
            [`workflow:${runId}`]:       ["subscribe", "history"],
            [`workflow:${runId}:dpn:*`]: ["subscribe", "history"],
            "mesh:health":               ["subscribe", "history"],
          };
    }

    const tokenRequest = await client.auth.createTokenRequest({
      clientId: req.query.clientId || `client_${Date.now()}`,
      capability: capabilities,
      ttl: 3600 * 1000, // 1 hour
    });

    res.json(tokenRequest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helper Endpoints (simulated services) ──────────────────

// Flaky service: fails N times then succeeds
let flakyCallCount = 0;
app.post("/api/flaky", (req, res) => {
  const { failCount } = req.body || { failCount: 2 };
  flakyCallCount++;
  if (flakyCallCount <= failCount) {
    console.log(`[flaky] Attempt ${flakyCallCount}: FAILING`);
    res.status(500).json({ error: "Service unavailable", attempt: flakyCallCount });
  } else {
    console.log(`[flaky] Attempt ${flakyCallCount}: SUCCESS`);
    flakyCallCount = 0;
    res.json({ success: true, attempt: flakyCallCount });
  }
});

// Ship service: randomly succeeds or fails
app.post("/api/ship", (req, res) => {
  const { orderId } = req.body;
  const success = Math.random() > 0.3; // 70% success
  console.log(`[ship] Order ${orderId}: ${success ? "SHIPPED" : "FAILED"}`);
  if (success) {
    res.json({ shipped: true, trackingId: `track-${orderId}` });
  } else {
    res.status(500).json({ error: "Shipping failed" });
  }
});

// Event notifier: wake up a waiting workflow
app.post("/api/notify/:eventId", async (req, res) => {
  try {
    const { Client } = require("@upstash/workflow");
    const notifyClient = new Client({ token: process.env.QSTASH_TOKEN });
    await notifyClient.notify({
      eventId: req.params.eventId,
      eventData: req.body,
    });
    res.json({ notified: true, eventId: req.params.eventId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  const ablyStatus = process.env.ABLY_API_KEY ? "✅ connected" : "⚠️  disabled (set ABLY_API_KEY)";
  const meshRedis = process.env.MESH_REDIS_REST_URL ? "✅ dedicated" : "⚠️  fallback to Cozy's Redis";
  const meshVector = process.env.MESH_VECTOR_REST_URL ? "✅ dedicated" : "⚠️  not configured";
  // Verify mesh storage async (logs result without blocking startup)
  verifyMeshStorage().catch(() => {});
  console.log(`\n🧠 Workflow Nerve Net on http://localhost:${PORT}`)
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`   QStash: ${process.env.QSTASH_URL || "production"}`);
  console.log(`   Ably:   ${ablyStatus}`);
  console.log(`   Mesh Redis:  ${meshRedis}`);
  console.log(`   Mesh Vector: ${meshVector}`);
  console.log(`\nWorkflows:`);
  console.log(`  POST /api/trigger/hello              Hello world`);
  console.log(`  POST /api/trigger/memory-sync        Memory sync`);
  console.log(`  POST /api/trigger/sleep              Sleep/delay pattern`);
  console.log(`  POST /api/trigger/wait-event         Wait for external event`);
  console.log(`  POST /api/trigger/call               HTTP call pattern`);
  console.log(`  POST /api/trigger/fan-out            Fan-out parallel`);
  console.log(`  POST /api/trigger/retry              Retry with backoff`);
  console.log(`  POST /api/trigger/saga               Saga/compensating actions`);
  console.log(`  POST /api/trigger/research           Research & store (DPN)`);
  console.log(`  POST /api/trigger/parallel-brain     3-expert parallel DPN`);
  console.log(`  POST /api/trigger/knowledge-builder  Pattern extraction (DPN)`);
  console.log(`  POST /api/trigger/mesh-conversation  Multi-personality mesh (CozyEmployee)`);
  console.log(`\nAbly:`);
  console.log(`  POST /ably/webhook                   HITL approval bridge`);
  console.log(`  GET  /ably/token/:runId              Browser auth token`);
  console.log(`\nHelpers:`);
  console.log(`  POST /api/notify/:eventId            Wake a waiting workflow`);
  console.log(`  POST /api/flaky                      Simulated flaky service`);
  console.log(`  POST /api/ship                       Simulated shipping\n`);
});
