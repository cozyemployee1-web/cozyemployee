# CozyEmployee

> *Because the best AI systems know when to think and when to just do.*

A decentralized, multi-personality AI agent architecture that separates **reasoning** from **execution** — and runs every conversation through a project management framework instead of just hoping the agents figure it out.

---

## What Is This?

CozyEmployee is a framework for building AI systems that work like a real team.

Most multi-agent systems are glorified for-loops — they iterate through a list of agents and hope the outputs stack up into something useful. CozyEmployee is different. It has:

- **A Manager** that runs every conversation through an 8-step project execution SOP
- **9 cognitive personalities** that reason from different angles, challenge each other, and privately disagree before going public
- **A durable conversation loop** backed by QStash — if anything crashes, it picks up exactly where it left off
- **Dedicated storage** per environment — mesh operations never pollute the system's working memory
- **A pre-flight checklist** that verifies every box can reach every service before conversations start
- **A real-time ops dashboard** showing every agent action, thought, and workflow event as it happens

---

## The Core Idea: Two Types of Nodes

CozyEmployee splits all work into two node types:

| Node Type | What It Does | When to Use |
|-----------|-------------|-------------|
| **DPN** (Deliberative Processing Node) | LLM-powered reasoning inside an Upstash Box | When you need judgment, creativity, or diagnosis |
| **REN** (Rapid Execution Node) | Deterministic QStash Workflow steps | When the correct action is unambiguous |

```
"Compare these three approaches"  →  DPN  (needs judgment)
"Store this result in Redis"      →  REN  (deterministic write)
"What went wrong here?"           →  DPN  (needs diagnosis)
"Trigger workflow every hour"     →  REN  (cron is pure logic)
"Route this message to 3 agents"  →  DPN  (Manager decides)
"Persist the Manager's notes"     →  REN  (Redis write)
```

**Not every step needs an LLM.** This insight is the foundation.

---

## The Mesh: Multi-Personality Conversations

The Mesh is CozyEmployee's conversation layer — the part you interact with directly.

When you send a message, the Mesh:

1. **Manager DPN** analyzes the message, applies the 8-step SOP, decides which personalities respond
2. **Selected personality DPNs** run in parallel — each in its own Box sandbox
3. **Reflection** — the Manager reads all responses and writes private notes per personality (what they agree with, what they privately disagree with but didn't say, what they'd say next)
4. **Next round** — private notes feed back into the agents so disagreements surface rather than fester
5. Loop until deliverables are synthesized, energy depletes, or you redirect

```
Your message
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  Upstash Workflow (durable — QStash-backed)         │
│                                                     │
│  Each round:                                        │
│  ┌──────────────────────┐                          │
│  │  Manager DPN         │  ← Box + OpenRouter       │
│  │  • Applies 8-step SOP│                          │
│  │  • Picks personalities│                         │
│  │  • Tracks deliverables│                         │
│  │  • Detects drift     │                          │
│  └──────────┬───────────┘                          │
│             │                                       │
│             ▼  (parallel fan-out)                   │
│  ┌──────────────────────────────────────────┐      │
│  │  Personality DPNs (each their own Box)   │      │
│  │  Architect │ Challenger │ Analyst │ …    │      │
│  └──────────────────────────────────────────┘      │
│             │                                       │
│             ▼  (fire-and-forget)                    │
│  Manager reflection → Redis → next round notes     │
└─────────────────────────────────────────────────────┘
```

---

## The Manager DPN

The Manager is a single Box that runs in two modes per round.

**Route mode** (start of round):
- Reads the conversation
- Applies the 8-Step SOP to decide who responds
- Tracks deliverables (`D1: "What are the risks?" — STATUS: ACTIVE`)
- Detects conversation drift (`on_task` / `drifting` / `circular`)
- Issues nudges, enforces rotation, triggers synthesis

**Reflect mode** (after agents respond, fire-and-forget):
- Reads what each personality said
- Writes structured private notes (agreements, unvoiced disagreements, confidence, next move)
- Stores notes in dedicated Redis
- Publishes to Ably thinking room so the ops dashboard shows inner monologue

One Box. One snapshot. Both roles.

---

## The 8-Step Project Execution SOP

Every routing and reflection decision the Manager makes runs through this framework:

| Step | Name | What happens |
|------|------|-------------|
| 1 | Mission Analysis | Identify primary goal + success criteria. 30% plan / 70% execute. |
| 2 | Initial Brief | Surface immediate actionable tasks before the full plan is ready. |
| 3 | Strategy Development | 5-factor analysis: Objectives, Competition/Risk, Environment, Resources, Timeline. |
| 4 | Resource Staging | Select personalities before nudge is finalized. Don't let coordination lag slow the team. |
| 5 | Information Validation | Check if previous nudges worked. If not, escalate. |
| 6 | Finalize Roadmap | Assign deliverable ownership per personality. Define "Definition of Done." |
| 7 | Project Kick-off | When starting or pivoting: Context → Objective → Execution → Logistics → Comms. |
| 8 | Monitoring & Alignment | Confirmation briefs each round. Did agents actually address the deliverable? |

---

## The 9 Personalities

Each personality is a distinct cognitive lens — not a character. The Manager selects 2-4 per round based on what the conversation needs, deliberately choosing contrast over consensus.

| Personality | Lens | Value |
|-------------|------|-------|
| **Architect** | Systematic, structure-focused | Finds gaps, proposes fixes, calls out vagueness |
| **Connector** | Stakeholder impact, empathetic | Who does this affect and how? |
| **Executor** | Results-oriented, delivery-focused | Cuts analysis paralysis, forces decisions |
| **Visionary** | Creative, non-obvious angles | Breaks conventional thinking |
| **Analyst** | Evidence-driven, assumption-spotting | "How do we know that?" |
| **Guardian** | Risk-aware, failure-mode hunter | What could go wrong, specifically |
| **Explorer** | Opportunity-focused, adjacent angles | What else could this be? |
| **Challenger** | Direct, accountability-focused | Names what others avoid, demands reasoning |
| **Synthesizer** | Integrative, convergence-focused | Closes loops, delivers final synthesis to human |

The Manager enforces rotation — no personality speaks 3+ times without 4 others going first. Circular loops get broken, not just nudged.

---

## Private Cognition

After every public response, the Manager writes private notes per personality:

```json
{
  "respondedTo": "the question about architecture risk",
  "myResponse": "flagged the single point of failure in the auth layer",
  "reasoning": "This is a deployment-blocking issue, not a nice-to-have",
  "agreements": ["Guardian's point about the token expiry window is correct"],
  "disagreements": ["Executor is wrong to deprioritize this — it'll block launch"],
  "openQuestions": ["Does the Synthesizer's Redis proposal handle the race condition?"],
  "confidence": 0.87,
  "nextMoveIfCalled": "push back on Executor's timeline with the specific failure scenario"
}
```

Unvoiced disagreements surface in the next round. Agents don't just react to the last message — they carry forward what they privately think.

---

## Infrastructure

### Stack

| Layer | Service | Purpose |
|-------|---------|---------|
| Agent compute | Upstash Box | Isolated sandboxes, one per personality per round |
| Durable workflow | Upstash Workflow + QStash | Conversation loop that survives crashes |
| Hot memory | Upstash Redis (dedicated) | Conversation history, private notes |
| Semantic memory | Upstash Vector (dedicated) | Past conversation recall, knowledge |
| Search | Upstash Search (dedicated) | Full-text conversation indexing |
| Real-time | Ably | Ops dashboard, thinking room, approvals |
| LLM | OpenRouter (`stepfun/step-3.5-flash:free`) | All agent reasoning |
| Model routing | Upstash Box `Agent.OpenCode` | Native OpenRouter integration |

### Storage Isolation

The mesh uses **dedicated** Upstash instances — completely separate from any system-level memory:

```
MESH_REDIS_REST_URL    →  cozyemployee-mesh Redis
MESH_VECTOR_REST_URL   →  cozyemployee-mesh Vector  
MESH_SEARCH_REST_URL   →  cozyemployee-mesh Search
```

Mesh operations never pollute the operator's working memory or the system's knowledge store.

### Box Security

Credentials are never injected into Box containers as env vars (visible to all code). Instead:

- **Non-sensitive** (endpoint URLs) → `env` block
- **All tokens and API keys** → `attachHeaders` (injected by TLS proxy at the host layer, never enters the container)

```javascript
Box.fromSnapshot(snapshotId, {
  env: {
    UPSTASH_REDIS_REST_URL: process.env.MESH_REDIS_REST_URL,  // not secret
  },
  attachHeaders: {
    'adequate-toad-71377.upstash.io': {
      Authorization: `Bearer ${redisToken}`,  // never inside container
    },
    'openrouter.ai': {
      Authorization: `Bearer ${openrouterKey}`,
    },
  },
});
```

### Box Snapshots

Each of the 10 boxes has its own named snapshot — pre-installed with `upstash-redis` and `upstash-vector` for immediate cold starts (~3-5s vs ~90s from scratch):

| Box | Snapshot | Packages |
|-----|----------|---------|
| manager | `mesh-manager` | upstash-redis, upstash-vector |
| architect | `mesh-personality-architect` | upstash-redis, upstash-vector |
| connector | `mesh-personality-connector` | upstash-redis, upstash-vector |
| executor | `mesh-personality-executor` | upstash-redis, upstash-vector |
| visionary | `mesh-personality-visionary` | upstash-redis, upstash-vector |
| analyst | `mesh-personality-analyst` | upstash-redis, upstash-vector, httpx |
| guardian | `mesh-personality-guardian` | upstash-redis, upstash-vector |
| explorer | `mesh-personality-explorer` | upstash-redis, upstash-vector |
| challenger | `mesh-personality-challenger` | upstash-redis, upstash-vector |
| synthesizer | `mesh-personality-synthesizer` | upstash-redis, upstash-vector |

Add packages to a specific personality without touching the others:
```bash
npx tsx cozyemployee-mesh/scripts/create-snapshots.ts --force-analyst
```

---

## Pre-flight Checklist

Before any mesh conversation, run the pre-flight suite to verify all 10 boxes can reach every service they need:

```bash
npm run preflight         # full suite — all 10 boxes + identity test (~15 min)
npm run preflight:quick   # skip identity test (~8 min)
node preflight/preflight.js --box architect   # single box
```

**9 tests per box, run inside the actual sandbox:**

| # | Test | Proves |
|---|------|--------|
| 1a | Redis write | Can store conversation state |
| 1b | Redis read | Full roundtrip confirmed |
| 1c | Vector upsert | Can store knowledge |
| 1d | Vector query | Can semantically recall |
| 1e | Search upsert | Can index for full-text |
| 2 | Ably publish | Can signal the ops dashboard |
| 3 | QStash reachability | Can trigger follow-on jobs |
| 4 | Ops UI ACK | Can reach the workflow server |
| 6 | Identity | Knows its role, can articulate it |

Results stream live to the ops dashboard and publish to `mesh:health` on Ably.

---

## Ops Dashboard

A real-time ops center for observing and controlling the mesh. Single HTML file, no build step required.

**Tabs:**

- **🚀 Dispatch** — trigger any workflow with a form UI
- **⚡ Ops** — live workflow cards, DPN activity stream, HITL approval queue, Chart.js metrics
- **🏢 Floor** — per-DPN "desk" view showing each personality's current activity
- **🔍 Pre-flight** — run the checklist, see per-box test results live as they stream in

The pre-flight tab auto-runs in quick mode on first open. Failed boxes expand automatically so you see exactly what broke without clicking.

---

## Conversation Flow: End-to-End

```
POST /api/trigger/mesh-conversation
{
  "message": "What are the biggest risks in our current architecture?",
  "sessionId": "session_abc",
  "channelId": "architecture-review",
  "maxRounds": 8
}
```

1. QStash delivers to `/api/workflow/mesh-conversation`
2. Workflow loads conversation history from Redis
3. **Round 1:** Manager DPN — applies SOP Step 1 (mission analysis), routes to 3-4 personalities
4. Personality boxes launch in parallel from their snapshots
5. Responses publish to Ably `mesh:{sessionId}` — UI receives them in real time
6. Manager Reflect runs async — private notes to Redis, inner monologue to `thinking:{sessionId}`
7. **Round 2:** Manager reads notes, surfaces a Challenger's unvoiced disagreement, routes to different personalities
8. Repeat until all deliverables synthesized or energy floor reached
9. Synthesizer delivers final synthesis to human
10. Workflow completes, `SUBMIT_CLEANUP` — QStash cleans up

Subscribe to `mesh:{sessionId}` on Ably to receive responses as they arrive.

---

## Drift Detection & Intervention

The Manager continuously monitors conversation health:

| State | Description | Energy decay | Action |
|-------|-------------|-------------|--------|
| `on_task` | Team working toward deliverables | -0.05/round | Let it run |
| `drifting` | Off-topic, not addressing asks | -0.15/round | Tier 1 redirect |
| `circular` | Same points restated, nothing new | Drops to 0.1 | Immediate rotation |

**Three intervention tiers:**

- **Tier 1** — Soft redirect: rotate in contrasting personalities, specific nudge
- **Tier 2** — Synthesis checkpoint: Synthesizer summarizes for human, requests direction
- **Tier 3** — Hard pause: stop generation, final synthesis, wait for human input

---

## Repository Structure

```
cozyemployee-mesh/
├── personalities.js          # 9 cognitive DPN personalities
├── manager.js                # Manager DPN (routes + reflects, SOP-driven)
├── agent.js                  # Personality DPN runner (parallel fan-out)
├── reflect.js                # Legacy reflect module (delegates to manager)
├── mesh-conversation.js      # Upstash Workflow — the durable conversation loop
├── mesh-storage.js           # Dedicated storage clients (MESH_* env vars)
├── box-env.js                # env + attachHeaders builder for Box commissions
├── snapshots.js              # Snapshot ID registry loader
├── snapshots.json            # Box snapshot IDs (generated by create-snapshots)
├── package.json              # npm scripts for preflight + snapshot management
├── preflight/
│   ├── preflight.js          # CLI entrypoint
│   ├── preflight-runner.js   # Shared runner (used by CLI + server)
│   └── README.md             # Preflight documentation
└── scripts/
    ├── create-snapshots.ts   # Creates + snapshots all 10 boxes
    └── create-manager-snapshot.ts  # Recreates just the manager box

workflows/
├── src/
│   ├── server.js             # Express server + all workflow endpoints
│   ├── ably.js               # Ably realtime layer
│   └── workflows/
│       ├── box-brain.js      # Research, parallel-brain, knowledge-builder
│       ├── advanced.js       # Sleep, wait-event, call, fan-out, retry, saga
│       ├── hello.js          # Hello world
│       └── memory-sync.js    # Memory sync
└── public/
    └── index.html            # Ops dashboard (Alpine.js + Chart.js + xterm.js)
```

---

## Comparison

| Architecture | Orchestration | LLM Usage | Resilience | Private Cognition | SOP-Driven |
|-------------|--------------|-----------|------------|------------------|------------|
| LangChain Agent | Central | All steps | Low | ✗ | ✗ |
| AutoGen | Group chat | All steps | Medium | ✗ | ✗ |
| CrewAI | Role-based | All steps | Low | ✗ | ✗ |
| bot-communicator | Browser hook | All steps | None (browser) | ✓ | ✗ |
| **CozyEmployee** | **Mesh + Manager** | **Selective** | **High (durable)** | **✓** | **✓** |

---

## Quick Start

```bash
git clone https://github.com/cozyemployee1-web/cozyemployee.git
cd cozyemployee

# Install workflow server dependencies
cd workflows && npm install

# Set environment variables (.env)
MESH_REDIS_REST_URL=...
MESH_REDIS_REST_TOKEN=...
MESH_VECTOR_REST_URL=...
MESH_VECTOR_REST_TOKEN=...
MESH_SEARCH_REST_URL=...
MESH_SEARCH_REST_TOKEN=...
QSTASH_TOKEN=...
QSTASH_URL=https://qstash-us-east-1.upstash.io
ABLY_API_KEY=...
OPENROUTER_API_KEY=...
UPSTASH_BOX_API_KEY=...
WORKFLOW_URL=https://your-public-url.example.com  # must be publicly reachable by QStash

# Create Box snapshots (one-time, ~15 min)
cd ../cozyemployee-mesh && npm install
npx tsx scripts/create-snapshots.ts

# Start the workflow server
cd ../workflows
node src/server.js

# Open the ops dashboard
open http://localhost:3002/dashboard

# Run pre-flight to verify all boxes
cd ../cozyemployee-mesh
npm run preflight:quick

# Send a mesh conversation
curl -X POST http://localhost:3002/api/trigger/mesh-conversation \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What are the biggest risks in our architecture?",
    "sessionId": "test-001",
    "channelId": "general",
    "maxRounds": 6
  }'
```

---

## License

MIT

---

*CozyEmployee is an architecture, not a product. The reference implementation uses Upstash + Ably + OpenRouter, but the patterns apply to any stack with reliable messaging, durable workflows, isolated compute, and shared memory.*
