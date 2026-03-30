# CozyEmployee

> *Because the best AI systems know when to think and when to just do.*

A decentralized agentic architecture that separates **reasoning** from **execution** to build resilient, scalable, cost-efficient AI systems.

## The Problem

Most AI agent systems have two failure modes:

1. **Everything goes through the LLM.** Every step — routing, storing, logging — costs tokens and adds latency. Simple operations that should take milliseconds wait behind a reasoning model.

2. **A central controller orchestrates everything.** If it fails, everything stops. If it's slow, everything waits. It's a single point of failure and a bottleneck.

## The Solution: Dual-Network Architecture

CozyEmployee splits processing into two specialized networks:

| Node Type | What It Does | When to Use |
|-----------|-------------|-------------|
| **DPN** (Deliberative Processing Node) | LLM-powered reasoning, analysis, creative tasks | When you need judgment, understanding, or creativity |
| **REN** (Rapid Execution Node) | Deterministic execution, API calls, data operations | When the correct action is unambiguous |

```
"Compare these three approaches"  →  DPN (needs judgment)
"Store this result in Redis"      →  REN (deterministic write)
"What went wrong here?"           →  DPN (needs diagnosis)
"Trigger workflow every hour"     →  REN (cron is pure logic)
"Design an API for this feature"  →  DPN (creative, ambiguous)
"Sync data between two systems"   →  REN (diff and copy)
```

**Not every step needs an LLM.** This insight is the foundation of CozyEmployee.

## Architecture

```
External Stimulus (user request, event, schedule)
    │
    ▼
┌─────────────────────────────────────────────┐
│  REN: Ingress Router                        │
│  • Classify request type                    │
│  • Route to appropriate processing path     │
│  • No LLM — pure logic                      │
└──────────────────┬──────────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
          ▼                 ▼
    ┌───────────┐    ┌───────────┐
    │    DPN    │    │    REN    │
    │ Reasoning │    │ Execution │
    │ • Analyze │    │ • API call│
    │ • Decide  │    │ • Transform│
    │ • Create  │    │ • Store   │
    └─────┬─────┘    └─────┬─────┘
          │                 │
          └────────┬────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  Shared Memory Layer                        │
│  • Redis: hot cache, queues, state          │
│  • Vector: semantic search, knowledge       │
│  • Both networks read/write freely          │
└─────────────────────────────────────────────┘
```

### Key Principles

1. **No central controller.** Mesh topology. Nodes coordinate through messages, not commands.
2. **Separate reasoning from execution.** LLMs only when you need judgment.
3. **Shared memory, private execution.** Knowledge lives in the shared layer. Processing in isolated nodes.
4. **SOPs as code.** Operating procedures are version-controlled workflow files.
5. **Fail small, recover fast.** Per-step retries, not global restarts.
6. **Pay for what you use.** Serverless infrastructure. Idle nodes cost nothing.
7. **Progressive escalation.** Start cheap. Escalate only when needed.

## Memory Architecture

| Tier | System | Latency | Purpose |
|------|--------|---------|---------|
| **Hot** | Redis | ~5ms | Session state, queues, rate limits |
| **Semantic** | Vector DB | ~50ms | Knowledge recall, pattern matching |
| **Procedural** | Workflow files | N/A | SOPs, operating procedures |

All nodes share the same memory. No private state. If a node dies, its knowledge persists.

## Communication Patterns

### Sequential Chain (Pipeline)
```
REN₁ → REN₂ → DPN → REN₃
```

### Fan-Out (Parallel)
```
        ┌→ DPN₁ (security) ──┐
Trigger ─┼→ DPN₂ (performance)├→ REN (synthesize)
        └→ DPN₃ (architecture)┘
```

### Event-Driven (Pub/Sub)
```
Node A publishes event → All subscribers react independently
```

### Request-Reply (Choreography)
```
REN₁ sends command → Node B processes → B sends reply → REN₁ continues
```

## Resilience

- **Automatic retries** — Failed steps retry with exponential backoff. Only the failed step retries, not the whole workflow.
- **Compensating actions** — Saga pattern for business operations. If shipping fails, refund payment and release inventory.
- **Event-based recovery** — Nodes publish state as events. Crashed nodes reconstruct from the event log.
- **Graceful degradation** — If a DPN is unavailable, queue requests or fall back to simpler heuristics.

## Use Cases

1. **Self-Healing Knowledge System** — Automatically detect and repair memory inconsistencies across distributed storage.
2. **Multi-Perspective Analysis** — Fan-out to 3 expert DPNs, synthesize better answers than any single model.
3. **Progressive Research** — Check cache first, escalate to expensive models only when needed.
4. **Automated Code Review** — Parallel review by security, performance, and architecture experts.
5. **Cost-Optimized Inference** — Automatically route tasks to the cheapest model that meets quality requirements.

## Reference Implementation

The reference implementation uses the [Upstash](https://upstash.com) serverless stack:

| Component | Service | Role |
|-----------|---------|------|
| Message Bus | QStash | Reliable messaging, scheduling, retries |
| REN | QStash Workflow | Durable multi-step execution |
| DPN | Upstash Box | Sandboxed AI agent containers |
| Hot Memory | Upstash Redis | Caching, queues, state |
| Semantic Memory | Upstash Vector | Similarity search, knowledge |
| Scheduling | QStash Cron | Time-based triggers |
| Event Bus | QStash Topics | Fan-out messaging |

### Quick Start

```bash
# Install dependencies
npm install @upstash/workflow @upstash/qstash @upstash/box zod

# Start local QStash dev server
docker run -d -p 8080:8080 public.ecr.aws/upstash/qstash:latest qstash dev

# Run tests
npm test
```

### Example: Research Workflow

```javascript
// REN triggers → DPN researches → REN stores
const researchWorkflow = serve(async (context) => {
  const { topic } = context.requestPayload;

  // REN: gather existing knowledge
  const existing = await context.run("check-cache", async () => {
    return redis.get(`research:${topic}`);
  });

  // DPN: commission Box agent for research
  const research = await context.run("research", async () => {
    const box = await Box.create({
      runtime: "python",
      agent: {
        provider: Agent.OpenCode,
        model: "openrouter/stepfun/step-3.5-flash:free",
        apiKey: BoxApiKey.StoredKey,
      },
    });
    const result = await box.agent.run({
      prompt: `Research: ${topic}`,
      responseSchema: z.object({
        findings: z.array(z.string()),
        confidence: z.enum(["high", "medium", "low"]),
      }),
    });
    await box.delete();
    return result;
  });

  // REN: store results
  await context.run("store", async () => {
    redis.setex(`research:${topic}`, 86400, JSON.stringify(research.result));
    vector.upsert({ id: topic, data: research.result.findings.join(" "), metadata: { confidence: research.result.confidence } });
  });
});
```

## Comparison

| Architecture | Central Control | LLM Dependency | Resilience | Cost Model |
|-------------|----------------|----------------|------------|------------|
| Monolith | Yes | N/A | Low | Fixed |
| Microservices | Partial | N/A | Medium | Fixed |
| LangChain Agent | Yes (single) | High | Low | Per-token |
| AutoGen Swarm | Yes (group chat) | High | Medium | Per-token |
| **CozyEmployee** | **No (mesh)** | **Selective** | **High** | **Per-use** |

## Getting Started

1. **Read the architecture document** — `docs/architecture.md`
2. **Explore the examples** — `examples/` directory
3. **Set up the stack** — Follow the Quick Start above
4. **Build your first REN** — A simple deterministic workflow
5. **Add a DPN** — Commission your first Box agent
6. **Connect them** — Build your first DPN → REN chain

## License

MIT

---

*CozyEmployee is an architecture, not a product. It can be implemented with any serverless stack that provides reliable messaging, durable workflows, shared memory, and sandboxed execution.*
