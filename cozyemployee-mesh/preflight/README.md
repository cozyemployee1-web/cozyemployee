# Mesh Pre-flight Checklist

Run before any mesh conversation to verify all 10 boxes are operational.

## What It Tests

Each Box gets a 6-check suite run **inside the sandbox**, verifying every comms path the box needs to do its job:

| # | Test | What it proves |
|---|------|----------------|
| 1a | Redis write | Box can store conversation state |
| 1b | Redis read | Box can retrieve prior context |
| 1c | Vector upsert | Box can store knowledge semantically |
| 1d | Vector query | Box can recall similar past work |
| 1e | Search upsert | Box can index conversation content |
| 2 | Ably publish → `mesh:health` | Box can signal the ops dashboard in real-time |
| 3 | QStash reachability | Box can trigger follow-on durable jobs |
| 4 | Ops UI `/api/preflight-ack` | Box can reach the workflow server |
| 6 | Identity (full mode) | Box understands its personality and can describe its job |

All storage tests use the dedicated `MESH_*` endpoints — never Cozy's personal memory.
Tokens are injected via `attachHeaders` — never appear inside the sandbox.

## Usage

```bash
# Full preflight — all 10 boxes + identity test (~15 min)
npm run preflight

# Quick — skip identity test (~8 min)
npm run preflight:quick

# Single box
node preflight/preflight.js --box architect
node preflight/preflight.js --box manager

# JSON report only (pipe to file, CI, etc.)
npm run preflight:report > preflight-$(date +%Y%m%d).json
```

## Output

```
🔍 CozyEmployee Mesh — Pre-flight Checklist
==========================================

✅ manager         [8/8] (12.3s)
  ✓ redis_write
  ✓ redis_read
  ✓ vector_upsert
  ✓ vector_query
  ✓ search_upsert
  ✓ ably_publish
  ✓ qstash_reachable
  ✓ ops_ui
  💬 "system box (no personality)"

✅ architect       [9/9] (14.1s)
  ...
  💬 "I identify structural gaps, inconsistencies, and improvement opportunities in any system or plan."

❌ guardian        [7/9] (11.8s)
  ✓ redis_write
  ✗ vector_query     FAIL: Connection timeout
  ✗ search_upsert    FAIL: 401 Unauthorized
  ...
```

Results are also published to Ably `mesh:health` for the ops dashboard.

## When to Run

- **Before any mesh conversation** — especially after infrastructure changes
- **After rotating credentials** — verifies new tokens are correctly injected
- **After updating snapshots** — confirms packages still work in new snapshot
- **As a CI step** — `npm run preflight:report` returns exit code 1 on any failure
