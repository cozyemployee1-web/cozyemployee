// src/ably.js
// CozyEmployee Ably Realtime Layer
//
// This module is the human-facing surface of the CozyEmployee mesh.
// It bridges the internal Upstash/QStash backend to real-time observers:
// operators, dashboards, and human approvers.
//
// Products used:
//   Pub/Sub      — per-workflow event channels + webhook bridge
//   AI Transport — DPN token streaming + tool call visibility
//   Spaces       — operator presence and floor awareness
//   LiveObjects  — mesh health counters + workflow status board
//
// Usage:
//   const ably = require('./ably');
//
//   // In any workflow step, emit a step event:
//   await ably.emitStep(runId, 'research', { topic, status: 'started' });
//
//   // Stream a DPN's LLM output token by token:
//   const stream = await callLLM(prompt);
//   await ably.streamDPN(runId, nodeId, stream);
//
//   // Pause for human approval (pairs with Upstash waitForEvent):
//   await ably.requestApproval(runId, toolCallId, { tool, args, context });
//
//   // Record mesh health (called by RENs):
//   await ably.health.workflowStarted(runId);
//   await ably.health.workflowCompleted(runId, summary);
//   await ably.health.dpnCalled(nodeId);

"use strict";

const Ably = require("ably");

// ─── Client singleton ────────────────────────────────────────────────────────

let _rest = null;

function getClient() {
  if (!_rest) {
    const key = process.env.ABLY_API_KEY;
    if (!key) {
      console.warn("[ably] ABLY_API_KEY not set — realtime layer disabled");
      return null;
    }
    _rest = new Ably.Rest({ key });
  }
  return _rest;
}

// ─── Channel helpers ─────────────────────────────────────────────────────────

// Per-run event channel (AI Transport pattern)
function workflowChannel(runId) {
  const client = getClient();
  if (!client) return null;
  return client.channels.get(`workflow:${runId}`);
}

// Per-DPN token stream within a run
function dpnChannel(runId, nodeId) {
  const client = getClient();
  if (!client) return null;
  return client.channels.get(`workflow:${runId}:dpn:${nodeId}`);
}

// Mesh-wide health (LiveObjects + status board)
function healthChannel() {
  const client = getClient();
  if (!client) return null;
  return client.channels.get("mesh:health");
}

// Pending approvals board
function approvalsChannel() {
  const client = getClient();
  if (!client) return null;
  return client.channels.get("mesh:approvals");
}

// ─── no-op guard ─────────────────────────────────────────────────────────────
// If Ably is not configured, all calls silently succeed rather than crashing
// workflows. This lets you develop and test without an Ably key.

function noop(label) {
  return async (...args) => {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[ably:noop] ${label}`);
    }
  };
}

// ─── Pub/Sub: Workflow Event Streaming ───────────────────────────────────────

/**
 * Emit a workflow step event to the run's Ably channel.
 * Operators watching this run see every step in real time.
 *
 * @param {string} runId     - Unique workflow run ID
 * @param {string} stepName  - Name of the step (e.g. "decompose", "store-vector")
 * @param {object} data      - Step payload (status, result, etc.)
 * @param {string} [status]  - "started" | "completed" | "failed"
 */
async function emitStep(runId, stepName, data = {}, status = "completed") {
  const ch = workflowChannel(runId);
  if (!ch) return;

  try {
    await ch.publish({
      name: "step",
      data: {
        run_id: runId,
        step: stepName,
        status,
        ts: Date.now(),
        ...data,
      },
    });
  } catch (err) {
    console.error(`[ably] emitStep failed for ${runId}/${stepName}:`, err.message);
  }
}

/**
 * Emit a workflow lifecycle event (started / completed / failed).
 *
 * @param {string} runId
 * @param {"started"|"completed"|"failed"} lifecycle
 * @param {object} [meta]
 */
async function emitLifecycle(runId, lifecycle, meta = {}) {
  const ch = workflowChannel(runId);
  if (!ch) return;

  try {
    await ch.publish({
      name: `workflow.${lifecycle}`,
      data: { run_id: runId, ts: Date.now(), ...meta },
    });
  } catch (err) {
    console.error(`[ably] emitLifecycle failed for ${runId}:`, err.message);
  }
}

// ─── AI Transport: DPN Token Streaming ───────────────────────────────────────

/**
 * Publish a DPN tool call event so observers see what the agent is doing.
 * Maps to Ably AI Transport "tool_call" pattern.
 *
 * @param {string} runId
 * @param {string} nodeId     - DPN identifier (e.g. "engineer", "architect")
 * @param {string} toolName   - Name of the tool being invoked
 * @param {object} args       - Tool arguments
 * @param {string} toolCallId - Unique ID for correlating call + result
 */
async function emitToolCall(runId, nodeId, toolName, args, toolCallId) {
  const ch = dpnChannel(runId, nodeId);
  if (!ch) return;

  try {
    await ch.publish({
      name: "tool_call",
      data: { name: toolName, args },
      extras: {
        headers: { responseId: runId, toolCallId },
      },
    });
  } catch (err) {
    console.error(`[ably] emitToolCall failed:`, err.message);
  }
}

/**
 * Publish a DPN tool result.
 *
 * @param {string} runId
 * @param {string} nodeId
 * @param {string} toolName
 * @param {*}      result
 * @param {string} toolCallId
 */
async function emitToolResult(runId, nodeId, toolName, result, toolCallId) {
  const ch = dpnChannel(runId, nodeId);
  if (!ch) return;

  try {
    await ch.publish({
      name: "tool_result",
      data: { name: toolName, result },
      extras: {
        headers: { responseId: runId, toolCallId },
      },
    });
  } catch (err) {
    console.error(`[ably] emitToolResult failed:`, err.message);
  }
}

/**
 * Stream LLM tokens from a DPN to its channel (message-per-response pattern).
 * Each token is appended; observers see the response build character by character.
 *
 * Pass an async iterable of token chunks (strings or { text } objects).
 *
 * @param {string}          runId
 * @param {string}          nodeId
 * @param {AsyncIterable}   tokenStream   - async iterable of token chunks
 * @returns {string}                      - full assembled response text
 */
async function streamDPN(runId, nodeId, tokenStream) {
  const ch = dpnChannel(runId, nodeId);
  let fullText = "";

  for await (const chunk of tokenStream) {
    const delta = typeof chunk === "string" ? chunk : chunk.text || chunk.delta || "";
    fullText += delta;

    if (ch) {
      try {
        await ch.publish({
          name: "token",
          data: { delta },
          extras: { headers: { responseId: `${runId}:${nodeId}` } },
        });
      } catch (err) {
        console.error(`[ably] streamDPN token publish failed:`, err.message);
      }
    }
  }

  // Signal completion
  if (ch) {
    try {
      await ch.publish({
        name: "dpn.complete",
        data: { run_id: runId, node_id: nodeId, full_text: fullText },
        extras: { headers: { responseId: `${runId}:${nodeId}` } },
      });
    } catch (err) {
      console.error(`[ably] streamDPN complete publish failed:`, err.message);
    }
  }

  return fullText;
}

/**
 * Convenience: publish a DPN's final result as a single message
 * (for Box agents that return a full result, not a stream).
 *
 * @param {string} runId
 * @param {string} nodeId
 * @param {*}      result
 * @param {object} [meta]
 */
async function emitDPNResult(runId, nodeId, result, meta = {}) {
  const ch = dpnChannel(runId, nodeId);
  if (!ch) return;

  try {
    await ch.publish({
      name: "dpn.result",
      data: { run_id: runId, node_id: nodeId, result, ...meta },
    });
  } catch (err) {
    console.error(`[ably] emitDPNResult failed:`, err.message);
  }
}

// ─── AI Transport: Human-in-the-Loop ────────────────────────────────────────

/**
 * Publish a human approval request.
 * The workflow should call Upstash waitForEvent after this, keyed on runId.
 * An operator approves/rejects via the ops dashboard, which sends the event
 * back to QStash to resume the workflow.
 *
 * @param {string} runId
 * @param {string} toolCallId   - unique ID for this decision
 * @param {object} request      - { tool, args, context, risk_level }
 */
async function requestApproval(runId, toolCallId, request) {
  const ch = approvalsChannel();
  const wch = workflowChannel(runId);

  const payload = {
    run_id: runId,
    tool_call_id: toolCallId,
    tool: request.tool,
    args: request.args,
    context: request.context || "",
    risk_level: request.risk_level || "medium",
    requested_at: new Date().toISOString(),
  };

  try {
    // Publish to global approvals board (ops dashboard sees all pending)
    if (ch) {
      await ch.publish({
        name: "approval-request",
        data: payload,
        extras: { headers: { toolCallId } },
      });
    }

    // Also publish to the workflow's own channel (scoped view)
    if (wch) {
      await wch.publish({
        name: "approval-request",
        data: payload,
        extras: { headers: { toolCallId } },
      });
    }
  } catch (err) {
    console.error(`[ably] requestApproval failed:`, err.message);
  }
}

// ─── Mesh Health (LiveObjects via REST publish) ───────────────────────────────
//
// LiveObjects (LiveCounter, LiveMap) require the realtime SDK for direct
// manipulation. Since the workflow server is a serverless-style HTTP process,
// we instead publish named events to the mesh:health channel that a persistent
// LiveObjects agent (or the ops dashboard SDK) can apply. This is the
// "inband objects" pattern from Ably docs — Pub/Sub subscribers receive the
// same operations.
//
// Alternatively, a thin Node.js daemon (ably-health-agent.js) can hold the
// realtime connection and apply LiveObject operations when it receives these
// health events.

const health = {
  /**
   * Signal that a workflow run has started.
   * Increments active_workflows counter.
   */
  async workflowStarted(runId, meta = {}) {
    const ch = healthChannel();
    if (!ch) return;
    try {
      await ch.publish({
        name: "workflow.started",
        data: { run_id: runId, ts: Date.now(), ...meta },
      });
    } catch (err) {
      console.error("[ably] health.workflowStarted failed:", err.message);
    }
  },

  /**
   * Signal that a workflow run completed.
   * Decrements active_workflows, increments completed_today.
   */
  async workflowCompleted(runId, summary = {}) {
    const ch = healthChannel();
    if (!ch) return;
    try {
      await ch.publish({
        name: "workflow.completed",
        data: { run_id: runId, ts: Date.now(), ...summary },
      });
    } catch (err) {
      console.error("[ably] health.workflowCompleted failed:", err.message);
    }
  },

  /**
   * Signal a workflow step failed.
   * Increments failed_steps counter.
   */
  async stepFailed(runId, stepName, error) {
    const ch = healthChannel();
    if (!ch) return;
    try {
      await ch.publish({
        name: "step.failed",
        data: { run_id: runId, step: stepName, error: String(error), ts: Date.now() },
      });
    } catch (err) {
      console.error("[ably] health.stepFailed failed:", err.message);
    }
  },

  /**
   * Signal a DPN (Box agent) was commissioned.
   * Increments dpn_calls_today counter.
   */
  async dpnCalled(runId, nodeId, model) {
    const ch = healthChannel();
    if (!ch) return;
    try {
      await ch.publish({
        name: "dpn.called",
        data: { run_id: runId, node_id: nodeId, model, ts: Date.now() },
      });
    } catch (err) {
      console.error("[ably] health.dpnCalled failed:", err.message);
    }
  },

  /**
   * Signal a DPN completed its work.
   */
  async dpnCompleted(runId, nodeId, cost = null) {
    const ch = healthChannel();
    if (!ch) return;
    try {
      await ch.publish({
        name: "dpn.completed",
        data: { run_id: runId, node_id: nodeId, cost, ts: Date.now() },
      });
    } catch (err) {
      console.error("[ably] health.dpnCompleted failed:", err.message);
    }
  },

  /**
   * Signal an approval is pending.
   * Increments pending_approvals counter on the ops dashboard.
   */
  async approvalPending(runId, toolCallId) {
    const ch = healthChannel();
    if (!ch) return;
    try {
      await ch.publish({
        name: "approval.pending",
        data: { run_id: runId, tool_call_id: toolCallId, ts: Date.now() },
      });
    } catch (err) {
      console.error("[ably] health.approvalPending failed:", err.message);
    }
  },

  /**
   * Signal an approval was resolved (approved or rejected).
   * Decrements pending_approvals counter.
   */
  async approvalResolved(runId, toolCallId, approved) {
    const ch = healthChannel();
    if (!ch) return;
    try {
      await ch.publish({
        name: "approval.resolved",
        data: { run_id: runId, tool_call_id: toolCallId, approved, ts: Date.now() },
      });
    } catch (err) {
      console.error("[ably] health.approvalResolved failed:", err.message);
    }
  },
};

// ─── Webhook bridge ──────────────────────────────────────────────────────────

/**
 * Express middleware that accepts inbound Ably webhook events and routes
 * them to QStash to resume waiting workflows (e.g. HITL approvals).
 *
 * Mount at: POST /ably/webhook
 *
 * Example: operator approves a tool call → Ably webhook fires here →
 *          this publishes the QStash resume event → workflow continues.
 */
function webhookBridge(qstashClient, baseUrl) {
  return async (req, res) => {
    const events = req.body?.items || [req.body];

    for (const event of events) {
      const { name, data } = event?.messages?.[0] || event || {};

      if (name === "approval-response") {
        const { run_id, tool_call_id, approved, approved_by } = data || {};
        if (!run_id || !tool_call_id) continue;

        try {
          // Resume the waiting Upstash workflow via QStash notify
          await qstashClient.publishJSON({
            url: `${baseUrl}/api/workflow/resume`,
            body: {
              type: "approval-response",
              run_id,
              tool_call_id,
              approved,
              approved_by,
              ts: Date.now(),
            },
          });

          await health.approvalResolved(run_id, tool_call_id, approved);
          console.log(`[ably:webhook] Approval resolved: ${run_id}/${tool_call_id} → ${approved}`);
        } catch (err) {
          console.error("[ably:webhook] Failed to resume workflow:", err.message);
        }
      }
    }

    res.json({ ok: true });
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
/**
 * Publish to an arbitrary named Ably channel.
 * Used by the mesh conversation system for per-session message feeds
 * and per-personality thinking room streams.
 *
 * @param {string} channelName - e.g. "mesh:session_abc" or "thinking-Architect"
 * @param {string} eventName   - e.g. "message" | "reflection"
 * @param {object} data
 */
async function emitToChannel(channelName, eventName, data = {}) {
  const client = getClient();
  if (!client) return;
  try {
    const ch = client.channels.get(channelName);
    await ch.publish(eventName, { ...data, ts: Date.now() });
  } catch (err) {
    console.error(`[ably] emitToChannel failed for ${channelName}/${eventName}:`, err.message);
  }
}

  // Core
  getClient,
  workflowChannel,
  dpnChannel,
  healthChannel,
  approvalsChannel,

  // Pub/Sub: workflow events
  emitStep,
  emitLifecycle,

  // AI Transport: DPN observability
  emitToolCall,
  emitToolResult,
  streamDPN,
  emitDPNResult,

  // AI Transport: HITL
  requestApproval,

  // Mesh health
  health,

  // Webhook bridge (express middleware)
  webhookBridge,

  // Generic channel publish (for mesh conversation events)
  emitToChannel,
};
