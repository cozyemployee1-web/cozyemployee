// src/workflows/advanced.js
// Advanced patterns: sleep, waitForEvent, context.call, fan-out, retry, failure handling

const { serve } = require("@upstash/workflow/express");
const { Client } = require("@upstash/qstash");

const QSTASH_URL = process.env.QSTASH_URL || "http://127.0.0.1:8080";
const QSTASH_TOKEN = process.env.QSTASH_TOKEN || "eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=";
const BASE_URL = process.env.WORKFLOW_URL || "http://127.0.0.1:3002";

const qstashClient = new Client({ baseUrl: QSTASH_URL, token: QSTASH_TOKEN });

// ─── Pattern 1: Sleep Between Steps ────────────────────────
// Demonstrates delay between workflow steps
const sleepWorkflow = serve(
  async (context) => {
    const { message } = context.requestPayload;

    const step1 = await context.run("step-1", async () => {
      console.log("[sleep] Step 1:", message);
      return { started: new Date().toISOString() };
    });

    // Sleep for 5 seconds between steps
    await context.sleep("wait-5s", 5);

    const step2 = await context.run("step-2", async () => {
      console.log("[sleep] Step 2: after 5s delay");
      return { resumed: new Date().toISOString() };
    });

    // SleepUntil: wait until a specific time
    const futureTime = new Date(Date.now() + 3000); // 3s from now
    await context.sleepUntil("wait-until", futureTime);

    await context.run("step-3", async () => {
      console.log("[sleep] Step 3: after sleepUntil");
      return { completed: new Date().toISOString(), step1, step2 };
    });
  },
  { url: `${BASE_URL}/api/workflow/sleep`, qstashClient, verbose: true }
);

// ─── Pattern 2: Wait for External Event ────────────────────
// Workflow pauses until notified by external system
const waitForEventWorkflow = serve(
  async (context) => {
    const { taskId } = context.requestPayload;

    // Step 1: Start a task
    await context.run("start-task", async () => {
      console.log(`[event] Starting task ${taskId}`);
      return { taskId, status: "started" };
    });

    // Step 2: Wait for external notification (30s timeout)
    const { eventData, timeout } = await context.waitForEvent(
      "wait-for-completion",
      `task-${taskId}`,
      { timeout: "30s" }
    );

    if (timeout) {
      await context.run("handle-timeout", async () => {
        console.log(`[event] Task ${taskId} timed out`);
        return { status: "timeout" };
      });
      return;
    }

    // Step 3: Process the event data
    await context.run("process-result", async () => {
      console.log(`[event] Task ${taskId} completed:`, eventData);
      return { status: "completed", result: eventData };
    });
  },
  { url: `${BASE_URL}/api/workflow/wait-event`, qstashClient, verbose: true }
);

// ─── Pattern 3: context.call (HTTP to External Service) ────
// Makes HTTP calls that can exceed normal timeouts
const callWorkflow = serve(
  async (context) => {
    const { url } = context.requestPayload;

    // Call an external HTTP endpoint with retry
    const response = await context.call("fetch-data", {
      url: url || "https://httpbin.org/get",
      method: "GET",
      retries: 3,
      timeout: "30s",
    });

    await context.run("process-response", async () => {
      console.log(`[call] Response status: ${response.status}`);
      return {
        status: response.status,
        bodyKeys: Object.keys(response.body || {}),
      };
    });
  },
  { url: `${BASE_URL}/api/workflow/call`, qstashClient, verbose: true }
);

// ─── Pattern 4: Fan-Out (Process Multiple Items) ───────────
// Trigger multiple sub-workflows for parallel processing
const fanOutWorkflow = serve(
  async (context) => {
    const { items } = context.requestPayload;

    // Step 1: Process each item by publishing to QStash
    const results = await context.run("fan-out", async () => {
      console.log(`[fan-out] Processing ${items.length} items`);
      const messageIds = [];

      for (const item of items) {
        const result = await qstashClient.publishJSON({
          url: `${BASE_URL}/api/workflow/process-item`,
          body: { item },
        });
        messageIds.push(result.messageId);
      }

      return { dispatched: messageIds.length, messageIds };
    });

    // Step 2: Log completion
    await context.run("log", async () => {
      console.log(`[fan-out] Dispatched ${results.dispatched} items`);
      return { status: "dispatched", count: results.dispatched };
    });
  },
  { url: `${BASE_URL}/api/workflow/fan-out`, qstashClient, verbose: true }
);

// Sub-workflow: processes a single item
const processItemWorkflow = serve(
  async (context) => {
    const { item } = context.requestPayload;

    await context.run("process", async () => {
      console.log(`[item] Processing: ${JSON.stringify(item)}`);
      // Simulate work
      return { processed: true, item, timestamp: new Date().toISOString() };
    });
  },
  { url: `${BASE_URL}/api/workflow/process-item`, qstashClient, verbose: true }
);

// ─── Pattern 5: Retry with Custom Logic ────────────────────
// Demonstrates retry with exponential backoff
const retryWorkflow = serve(
  async (context) => {
    const { failCount } = context.requestPayload;

    let attempt = 0;

    const result = await context.call("unreliable-service", {
      url: `${BASE_URL}/api/flaky`,
      method: "POST",
      body: JSON.stringify({ failCount: failCount || 2 }),
      headers: { "content-type": "application/json" },
      retries: 5,
    });

    await context.run("log-result", async () => {
      console.log(`[retry] Final result: ${JSON.stringify(result.body)}`);
      return result.body;
    });
  },
  { url: `${BASE_URL}/api/workflow/retry`, qstashClient, verbose: true }
);

// ─── Pattern 6: Failure Handling (Compensating Actions) ────
// If a step fails, run compensating actions
const sagaWorkflow = serve(
  async (context) => {
    const { orderId } = context.requestPayload;

    // Step 1: Reserve inventory
    const reservation = await context.run("reserve-inventory", async () => {
      console.log(`[saga] Reserving inventory for order ${orderId}`);
      return { orderId, reserved: true, inventoryId: `inv-${orderId}` };
    });

    // Step 2: Charge payment
    const payment = await context.run("charge-payment", async () => {
      console.log(`[saga] Charging payment for order ${orderId}`);
      return { orderId, charged: true, paymentId: `pay-${orderId}` };
    });

    // Step 3: Ship order (this might fail)
    const shipping = await context.call("ship-order", {
      url: `${BASE_URL}/api/ship`,
      method: "POST",
      body: JSON.stringify({ orderId }),
      headers: { "content-type": "application/json" },
      retries: 2,
      timeout: "10s",
    });

    if (shipping.status !== 200) {
      // Compensating actions
      await context.run("refund-payment", async () => {
        console.log(`[saga] Refunding payment for failed order ${orderId}`);
        return { refunded: true, paymentId: payment.paymentId };
      });

      await context.run("release-inventory", async () => {
        console.log(`[saga] Releasing inventory for failed order ${orderId}`);
        return { released: true, inventoryId: reservation.inventoryId };
      });

      return;
    }

    await context.run("confirm", async () => {
      console.log(`[saga] Order ${orderId} completed successfully`);
      return { status: "completed", orderId };
    });
  },
  { url: `${BASE_URL}/api/workflow/saga`, qstashClient, verbose: true }
);

// ─── Pattern 7: Scheduled/Delayed Workflow ─────────────────
// Trigger a workflow to run at a specific time
async function scheduleDelayedWorkflow(payload, delaySeconds) {
  const result = await qstashClient.publishJSON({
    url: `${BASE_URL}/api/workflow/hello`,
    body: payload,
    delay: `${delaySeconds}s`,
  });
  return result;
}

module.exports = {
  sleepWorkflow,
  waitForEventWorkflow,
  callWorkflow,
  fanOutWorkflow,
  processItemWorkflow,
  retryWorkflow,
  sagaWorkflow,
  scheduleDelayedWorkflow,
};
