// src/server.js
// Workflow Nerve Net — Full Server with Advanced Patterns

const express = require("express");
const { Client } = require("@upstash/qstash");

const hello = require("./workflows/hello");
const memorySync = require("./workflows/memory-sync");
const advanced = require("./workflows/advanced");
const boxBrain = require("./workflows/box-brain");

const app = express();
app.use(express.json());

const BASE_URL = process.env.WORKFLOW_URL || "http://127.0.0.1:3002";

// ─── Health ─────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    qstash: process.env.QSTASH_URL || "production",
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
  console.log(`\n🧠 Workflow Nerve Net on http://localhost:${PORT}`);
  console.log(`   QStash: ${process.env.QSTASH_URL || "production"}`);
  console.log(`\nWorkflows:`);
  console.log(`  POST /api/trigger/hello         Hello world`);
  console.log(`  POST /api/trigger/memory-sync    Memory sync`);
  console.log(`  POST /api/trigger/sleep          Sleep/delay pattern`);
  console.log(`  POST /api/trigger/wait-event     Wait for external event`);
  console.log(`  POST /api/trigger/call           HTTP call pattern`);
  console.log(`  POST /api/trigger/fan-out        Fan-out parallel`);
  console.log(`  POST /api/trigger/retry          Retry with backoff`);
  console.log(`  POST /api/trigger/saga           Saga/compensating actions`);
  console.log(`\nHelpers:`);
  console.log(`  POST /api/notify/:eventId        Wake a waiting workflow`);
  console.log(`  POST /api/flaky                  Simulated flaky service`);
  console.log(`  POST /api/ship                   Simulated shipping\n`);
});
