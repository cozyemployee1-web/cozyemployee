// src/workflows/memory-sync.js
// Memory Sync workflow — pull local → check cloud → diff → sync → report.
// Exported as a serve() router for production, and as raw steps for dev testing.

const { serve } = require("@upstash/workflow/express");

// ─── Step Logic (testable independently) ────────────────────
const steps = {
  "pull-local": (type) => {
    console.log("[memory-sync] Step 1: Pulling local memory state");
    // TODO: Query libSQL for recent entities
    return {
      entities: ["entity-1", "entity-2"],
      lastSync: new Date().toISOString(),
      type,
    };
  },

  "check-cloud": () => {
    console.log("[memory-sync] Step 2: Checking cloud memory");
    // TODO: Query Cozy Memory for cloud state
    return {
      entities: ["entity-1", "entity-3"],
      lastSync: new Date().toISOString(),
    };
  },

  diff: (localState, cloudState) => {
    console.log("[memory-sync] Step 3: Computing diff");
    const localIds = new Set(localState.entities);
    const cloudIds = new Set(cloudState.entities);
    return {
      toCloud: localState.entities.filter((id) => !cloudIds.has(id)),
      fromCloud: cloudState.entities.filter((id) => !localIds.has(id)),
    };
  },

  "sync-to-cloud": (gaps) => {
    console.log(`[memory-sync] Step 4: Syncing ${gaps.toCloud.length} entities to cloud`);
    // TODO: Push to Cozy Memory
    return { synced: gaps.toCloud.length };
  },

  "sync-from-cloud": (gaps) => {
    console.log(`[memory-sync] Step 5: Syncing ${gaps.fromCloud.length} entities from cloud`);
    // TODO: Pull from Cozy Memory to libSQL
    return { synced: gaps.fromCloud.length };
  },

  report: (gaps, localState) => {
    const r = {
      timestamp: new Date().toISOString(),
      type: localState.type,
      toCloud: gaps.toCloud.length,
      fromCloud: gaps.fromCloud.length,
      total: localState.entities.length,
    };
    console.log("[memory-sync] Report:", JSON.stringify(r));
    return r;
  },
};

// ─── Run all steps sequentially (for dev testing) ───────────
function runDev(type = "full") {
  const localState = steps["pull-local"](type);
  const cloudState = steps["check-cloud"]();
  const gaps = steps.diff(localState, cloudState);
  steps["sync-to-cloud"](gaps);
  steps["sync-from-cloud"](gaps);
  const report = steps.report(gaps, localState);
  console.log("[memory-sync] Dev result:", report);
  return report;
}

// ─── Workflow definition (for production with QStash) ───────
const workflow = serve(
  async (context) => {
    const { type } = context.requestPayload || { type: "full" };

    const localState = await context.run("pull-local", async () => steps["pull-local"](type));
    const cloudState = await context.run("check-cloud", async () => steps["check-cloud"]());
    const gaps = await context.run("diff", async () => steps.diff(localState, cloudState));
    await context.run("sync-to-cloud", async () => steps["sync-to-cloud"](gaps));
    await context.run("sync-from-cloud", async () => steps["sync-from-cloud"](gaps));
    await context.run("report", async () => steps.report(gaps, localState));
  },
  {
    url: process.env.MEMORY_SYNC_URL || "https://your-app.com/api/workflow/memory-sync",
    verbose: true,
  }
);

module.exports = { workflow, steps, runDev };
