// src/workflows/hello.js
// Hello World workflow — proves the QStash → Workflow → Step cycle.
// Exported as a serve() router for production, and as raw steps for dev testing.

const { serve } = require("@upstash/workflow/express");

// ─── Step Logic (testable independently) ────────────────────
const steps = {
  greet: (name) => {
    console.log(`[hello] Step 1: greet ${name}`);
    return { message: `Hello, ${name}! The workflow is working.` };
  },

  log: (greeting) => {
    console.log(`[hello] Step 2: ${greeting.message}`);
    return { logged: true, timestamp: new Date().toISOString() };
  },

  summarize: (greeting) => {
    console.log(`[hello] Step 3: summarize`);
    return { status: "complete", steps: 3, greeting: greeting.message };
  },
};

// ─── Run all steps sequentially (for dev testing) ───────────
function runDev(name) {
  const greeting = steps.greet(name);
  const logEntry = steps.log(greeting);
  const summary = steps.summarize(greeting);
  console.log("[hello] Dev result:", summary);
  return { greeting, logEntry, summary };
}

// ─── Workflow definition (for production with QStash) ───────
const workflow = serve(
  async (context) => {
    const { name } = context.requestPayload;

    const greeting = await context.run("greet", async () => steps.greet(name));
    await context.run("log", async () => steps.log(greeting));
    await context.run("summarize", async () => steps.summarize(greeting));
  },
  {
    url: process.env.HELLO_WORKFLOW_URL || "https://your-app.com/api/workflow/hello",
    verbose: true,
  }
);

module.exports = { workflow, steps, runDev };
