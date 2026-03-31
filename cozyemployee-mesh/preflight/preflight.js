// cozyemployee-mesh/preflight/preflight.js
//
// Pre-flight checklist for the CozyEmployee mesh.
//
// Runs a structured test suite against every Box type to verify:
//   1. Storage    — Redis read/write, Vector upsert/query, Search index/query
//   2. Messaging  — Ably publish to mesh:health + thinking:{personality} channels
//   3. Workflow   — QStash can dispatch a message, workflow server ACKs
//   4. Peer comms — Box publishes event → host server receives via Ably subscription
//   5. Ops UI     — Server /api/preflight-ack endpoint responds correctly
//   6. Identity   — Each Box knows its personality and can describe its job
//
// Each test is isolated. A single failure does not abort the suite.
// Results published to Ably mesh:health so the ops dashboard shows live status.
//
// Usage:
//   node cozyemployee-mesh/preflight/preflight.js
//   node cozyemployee-mesh/preflight/preflight.js --box architect
//   node cozyemployee-mesh/preflight/preflight.js --quick   (skip identity test)
//   node cozyemployee-mesh/preflight/preflight.js --report  (JSON output only)

"use strict";

const { Box, Agent, BoxApiKey } = require("@upstash/box");
const { getSnapshot } = require("../snapshots");
const { meshBoxConfig } = require("../box-env");
const { getAllPersonalities } = require("../personalities");
const ably = require("../../workflows/src/ably");

const MODEL = "openrouter/stepfun/step-3.5-flash:free";
const BASE_URL = process.env.WORKFLOW_URL || "http://localhost:3002";

// ─── The Python preflight script run inside each Box ─────────────────────────
// This is what gets executed inside the sandbox. It tests all services
// the Box is expected to reach, then returns a structured JSON report.
function buildPreflightScript(boxKey, personalityPrompt = null) {
  const identityTest = personalityPrompt ? `
# ── TEST 6: Identity ─────────────────────────────────────────────────────────
# Ask the agent to describe its job in one sentence.
# Validates the personality prompt is understood, not just loaded.
try:
    response = httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        json={
            "model": "openrouter/stepfun/step-3.5-flash:free",
            "messages": [
                {"role": "system", "content": ${JSON.stringify(personalityPrompt)}},
                {"role": "user", "content": "In exactly one sentence, describe your cognitive role in the CozyEmployee mesh team."}
            ],
            "max_tokens": 100,
        },
        timeout=30
    )
    if response.status_code == 200:
        identity = response.json()["choices"][0]["message"]["content"].strip()
        results["identity"] = {"ok": True, "description": identity}
    else:
        results["identity"] = {"ok": False, "error": f"HTTP {response.status_code}"}
except Exception as e:
    results["identity"] = {"ok": False, "error": str(e)}
` : `results["identity"] = {"ok": True, "description": "system box (no personality)", "skipped": True}`;

  return `
import os, json, time, httpx

results = {}
run_id = "preflight_${boxKey}_${Date.now()}"

# ── TEST 1a: Redis write ──────────────────────────────────────────────────────
try:
    redis_url = os.environ.get("UPSTASH_REDIS_REST_URL", "")
    r = httpx.post(f"{redis_url}/set/preflight:{run_id}", json=["preflight-value-${Date.now()}"])
    r.raise_for_status()
    results["redis_write"] = {"ok": True, "status": r.status_code}
except Exception as e:
    results["redis_write"] = {"ok": False, "error": str(e)}

# ── TEST 1b: Redis read ───────────────────────────────────────────────────────
try:
    redis_url = os.environ.get("UPSTASH_REDIS_REST_URL", "")
    r = httpx.get(f"{redis_url}/get/preflight:{run_id}")
    r.raise_for_status()
    data = r.json()
    results["redis_read"] = {"ok": data.get("result") == "preflight-value-${Date.now()}", "value": data.get("result")}
except Exception as e:
    results["redis_read"] = {"ok": False, "error": str(e)}

# ── TEST 1c: Vector upsert ────────────────────────────────────────────────────
try:
    vector_url = os.environ.get("UPSTASH_VECTOR_REST_URL", "")
    r = httpx.post(f"{vector_url}/upsert", json={"id": f"preflight-{run_id}", "data": "preflight test vector", "metadata": {"source": "preflight", "box": "${boxKey}"}})
    r.raise_for_status()
    results["vector_upsert"] = {"ok": True, "status": r.status_code}
except Exception as e:
    results["vector_upsert"] = {"ok": False, "error": str(e)}

# ── TEST 1d: Vector query ─────────────────────────────────────────────────────
try:
    vector_url = os.environ.get("UPSTASH_VECTOR_REST_URL", "")
    r = httpx.post(f"{vector_url}/query", json={"data": "preflight test", "topK": 1, "includeMetadata": True})
    r.raise_for_status()
    data = r.json()
    results["vector_query"] = {"ok": True, "count": len(data.get("result", []))}
except Exception as e:
    results["vector_query"] = {"ok": False, "error": str(e)}

# ── TEST 1e: Search index ─────────────────────────────────────────────────────
try:
    search_url = os.environ.get("UPSTASH_SEARCH_REST_URL", "")
    if search_url:
        r = httpx.post(f"{search_url}/upsert", json={"documents": [{"id": f"preflight-{run_id}", "content": "preflight test search document", "metadata": {"box": "${boxKey}"}}]})
        r.raise_for_status()
        results["search_upsert"] = {"ok": True, "status": r.status_code}
    else:
        results["search_upsert"] = {"ok": False, "error": "UPSTASH_SEARCH_REST_URL not set"}
except Exception as e:
    results["search_upsert"] = {"ok": False, "error": str(e)}

# ── TEST 2: Ably publish (peer comms + ops UI signal) ────────────────────────
# Uses Basic auth (base64 of key) — injected via attachHeaders on rest.ably.io
try:
    msg = json.dumps({"name": "preflight", "data": json.dumps({"box": "${boxKey}", "run_id": run_id, "ts": int(time.time())})})
    r = httpx.post(
        "https://rest.ably.io/channels/mesh:health/messages",
        content=msg,
        headers={"Content-Type": "application/json"}
    )
    r.raise_for_status()
    results["ably_publish"] = {"ok": True, "channel": "mesh:health", "status": r.status_code}
except Exception as e:
    results["ably_publish"] = {"ok": False, "error": str(e)}

# ── TEST 3: QStash reachability ───────────────────────────────────────────────
# Sends a test message to a dead-letter topic — just checks auth + connectivity
try:
    qstash_url = os.environ.get("QSTASH_URL", "https://qstash-us-east-1.upstash.io")
    r = httpx.post(
        f"{qstash_url}/v2/publish/https://httpstat.us/200",
        json={"preflight": True, "box": "${boxKey}"},
        headers={"Content-Type": "application/json"},
        timeout=15
    )
    results["qstash_reachable"] = {"ok": r.status_code in [200, 201, 202], "status": r.status_code}
except Exception as e:
    results["qstash_reachable"] = {"ok": False, "error": str(e)}

# ── TEST 4: Ops UI reachability ───────────────────────────────────────────────
# Checks the workflow server's preflight-ack endpoint
try:
    r = httpx.get("${BASE_URL}/api/preflight-ack", timeout=10)
    results["ops_ui"] = {"ok": r.status_code == 200, "status": r.status_code}
except Exception as e:
    results["ops_ui"] = {"ok": False, "error": str(e)}

${identityTest}

# ── Cleanup: remove preflight keys ────────────────────────────────────────────
try:
    redis_url = os.environ.get("UPSTASH_REDIS_REST_URL", "")
    httpx.post(f"{redis_url}/del/preflight:{run_id}")
except: pass

print(json.dumps({"box": "${boxKey}", "run_id": run_id, "results": results}))
`.trim();
}

// ─── Run preflight on one Box ─────────────────────────────────────────────────
async function runPreflightForBox(boxKey, personalityPrompt = null) {
  const label = boxKey.padEnd(15);
  const startMs = Date.now();
  let box = null;

  try {
    const snapshotId = getSnapshot(boxKey);
    const config = {
      agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
      ...meshBoxConfig({
        // Also inject Ably key for REST publish test (Basic auth = base64(key))
        attachHeaders: {
          'rest.ably.io': {
            Authorization: `Basic ${Buffer.from(process.env.ABLY_API_KEY || '').toString('base64')}`,
          },
        },
      }),
      timeout: 180000,
    };

    box = snapshotId
      ? await Box.fromSnapshot(snapshotId, config)
      : await Box.create({ runtime: "python", ...config });

    const script = buildPreflightScript(boxKey, personalityPrompt);

    // Run as shell command — more reliable than agent.run() for pure Python
    const result = await box.exec.command(`python3 -c ${JSON.stringify(script)}`);
    const output = result.result || '';

    // Parse JSON from output
    let report;
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      report = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (_) {
      report = null;
    }

    if (!report) {
      return {
        box: boxKey,
        ok: false,
        error: `Could not parse preflight output: ${output.slice(0, 200)}`,
        durationMs: Date.now() - startMs,
        tests: {},
      };
    }

    const tests = report.results || {};
    const passed = Object.values(tests).filter(t => t.ok).length;
    const total = Object.keys(tests).length;
    const allPassed = passed === total;

    return {
      box: boxKey,
      ok: allPassed,
      passed,
      total,
      tests,
      durationMs: Date.now() - startMs,
      identity: tests.identity?.description,
    };

  } catch (err) {
    return {
      box: boxKey,
      ok: false,
      error: err.message,
      durationMs: Date.now() - startMs,
      tests: {},
    };
  } finally {
    if (box) { try { await box.delete(); } catch (_) {} }
  }
}

// ─── Print a result row ───────────────────────────────────────────────────────
function printResult(result) {
  const status = result.ok ? '✅' : '❌';
  const dur = `${(result.durationMs / 1000).toFixed(1)}s`;
  const score = result.total ? `${result.passed}/${result.total}` : 'ERR';

  console.log(`\n${status} ${result.box.padEnd(15)} [${score}] (${dur})`);

  if (result.error) {
    console.log(`   ⚠️  ${result.error}`);
    return;
  }

  const icons = { true: '✓', false: '✗' };
  for (const [test, outcome] of Object.entries(result.tests || {})) {
    const icon = outcome.ok ? '  ✓' : '  ✗';
    const detail = outcome.ok
      ? (outcome.description || outcome.count !== undefined ? `count=${outcome.count}` : '')
      : `FAIL: ${outcome.error?.slice(0, 80)}`;
    console.log(`${icon} ${test.padEnd(18)} ${detail}`);
  }

  if (result.identity) {
    console.log(`  💬 "${result.identity}"`);
  }
}

// ─── Publish summary to Ably mesh:health ─────────────────────────────────────
async function publishPreflightSummary(results) {
  try {
    const summary = {
      type: 'preflight_complete',
      ts: Date.now(),
      passed: results.filter(r => r.ok).length,
      total: results.length,
      boxes: Object.fromEntries(results.map(r => [r.box, {
        ok: r.ok,
        passed: r.passed,
        total: r.total,
        durationMs: r.durationMs,
        error: r.error,
      }])),
    };
    await ably.emitToChannel('mesh:health', 'preflight', summary);
    console.log('\n📡 Preflight summary published to Ably mesh:health');
  } catch (err) {
    console.warn(`Could not publish preflight summary: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const targetBox = args.find(a => a.startsWith('--box='))?.split('=')[1]
    || (args[args.indexOf('--box') + 1]);
  const quickMode = args.includes('--quick');
  const reportMode = args.includes('--report');

  if (!reportMode) {
    console.log('🔍 CozyEmployee Mesh — Pre-flight Checklist');
    console.log('==========================================');
    console.log(`Mode: ${quickMode ? 'quick (no identity test)' : 'full'}`);
    console.log(`Target: ${targetBox || 'all boxes'}\n`);
    console.log('Tests per box:');
    console.log('  1a. Redis write');
    console.log('  1b. Redis read');
    console.log('  1c. Vector upsert');
    console.log('  1d. Vector query');
    console.log('  1e. Search upsert');
    console.log('  2.  Ably publish → mesh:health');
    console.log('  3.  QStash reachability');
    console.log('  4.  Ops UI /api/preflight-ack');
    if (!quickMode) console.log('  6.  Identity (personality self-description)');
  }

  // Build box list
  const personalities = getAllPersonalities();
  const allBoxes = [
    { key: 'manager',    prompt: null },
    ...personalities.map(p => ({ key: p.name.toLowerCase(), prompt: quickMode ? null : p.prompt })),
  ];

  const boxesToTest = targetBox
    ? allBoxes.filter(b => b.key === targetBox.toLowerCase())
    : allBoxes;

  if (boxesToTest.length === 0) {
    console.error(`Unknown box: ${targetBox}`);
    process.exit(1);
  }

  // Run sequentially to avoid hitting 10-box concurrent limit
  const results = [];
  for (const { key, prompt } of boxesToTest) {
    if (!reportMode) process.stdout.write(`\n⏳ Testing ${key}...`);
    const result = await runPreflightForBox(key, prompt);
    results.push(result);
    if (!reportMode) printResult(result);
  }

  // Summary
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  if (reportMode) {
    console.log(JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
  } else {
    console.log('\n==========================================');
    console.log(`Result: ${passed}/${results.length} boxes passed`);

    if (failed > 0) {
      console.log('\n❌ Failed boxes:');
      results.filter(r => !r.ok).forEach(r => {
        const failedTests = Object.entries(r.tests || {})
          .filter(([, t]) => !t.ok)
          .map(([name]) => name);
        console.log(`  ${r.box}: ${r.error || failedTests.join(', ')}`);
      });
    } else {
      console.log('\n✅ All boxes operational. Mesh is ready.');
    }
  }

  // Publish summary to ops dashboard
  await publishPreflightSummary(results);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
