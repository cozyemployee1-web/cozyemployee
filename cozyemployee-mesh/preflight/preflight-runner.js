// cozyemployee-mesh/preflight/preflight-runner.js
//
// Exports runPreflightForBox() so it can be called from:
//   - preflight.js (CLI runner)
//   - server.js /api/preflight (streaming HTTP endpoint for dashboard)
//
// Separated from the CLI entrypoint to avoid circular deps.

"use strict";

const { Box, Agent, BoxApiKey } = require("@upstash/box");
const { getSnapshot } = require("../snapshots");
const { meshBoxConfig } = require("../box-env");

const MODEL  = "openrouter/stepfun/step-3.5-flash:free";
const BASE_URL = process.env.WORKFLOW_URL || "http://localhost:3002";

const PF_TESTS = [
  'redis_write', 'redis_read',
  'vector_upsert', 'vector_query',
  'search_upsert',
  'ably_publish',
  'qstash_reachable',
  'ops_ui',
  'identity',
];

function buildPreflightScript(boxKey, personalityPrompt) {
  const ts = Date.now();
  const identityBlock = personalityPrompt ? `
try:
    r = httpx.post(
        "https://openrouter.ai/api/v1/chat/completions",
        json={"model":"openrouter/stepfun/step-3.5-flash:free","messages":[
            {"role":"system","content":${JSON.stringify(personalityPrompt)}},
            {"role":"user","content":"In exactly one sentence, describe your cognitive role in the CozyEmployee mesh team."}
        ],"max_tokens":100},
        timeout=30
    )
    if r.status_code == 200:
        identity = r.json()["choices"][0]["message"]["content"].strip()
        results["identity"] = {"ok": True, "description": identity}
    else:
        results["identity"] = {"ok": False, "error": f"HTTP {r.status_code}"}
except Exception as e:
    results["identity"] = {"ok": False, "error": str(e)}
` : `results["identity"] = {"ok": True, "description": "system box", "skipped": True}`;

  return `
import os, json, time, httpx
results = {}
run_id = "preflight_${boxKey}_${ts}"

# 1a Redis write
try:
    u = os.environ.get("UPSTASH_REDIS_REST_URL","")
    r = httpx.post(f"{u}/set/preflight:{run_id}", json=["pf-${ts}"])
    r.raise_for_status()
    results["redis_write"] = {"ok": True}
except Exception as e:
    results["redis_write"] = {"ok": False, "error": str(e)[:100]}

# 1b Redis read
try:
    u = os.environ.get("UPSTASH_REDIS_REST_URL","")
    r = httpx.get(f"{u}/get/preflight:{run_id}")
    r.raise_for_status()
    results["redis_read"] = {"ok": r.json().get("result") == "pf-${ts}"}
except Exception as e:
    results["redis_read"] = {"ok": False, "error": str(e)[:100]}

# 1c Vector upsert
try:
    u = os.environ.get("UPSTASH_VECTOR_REST_URL","")
    r = httpx.post(f"{u}/upsert", json={"id": f"pf-{run_id}", "data": "preflight test ${boxKey}", "metadata": {"source":"preflight","box":"${boxKey}"}})
    r.raise_for_status()
    results["vector_upsert"] = {"ok": True}
except Exception as e:
    results["vector_upsert"] = {"ok": False, "error": str(e)[:100]}

# 1d Vector query
try:
    u = os.environ.get("UPSTASH_VECTOR_REST_URL","")
    r = httpx.post(f"{u}/query", json={"data": "preflight test", "topK": 1, "includeMetadata": True})
    r.raise_for_status()
    results["vector_query"] = {"ok": True, "count": len(r.json().get("result",[]))}
except Exception as e:
    results["vector_query"] = {"ok": False, "error": str(e)[:100]}

# 1e Search upsert
try:
    u = os.environ.get("UPSTASH_SEARCH_REST_URL","")
    if u:
        r = httpx.post(f"{u}/upsert", json={"documents":[{"id":f"pf-{run_id}","content":"preflight search ${boxKey}","metadata":{"box":"${boxKey}"}}]})
        r.raise_for_status()
        results["search_upsert"] = {"ok": True}
    else:
        results["search_upsert"] = {"ok": False, "error": "UPSTASH_SEARCH_REST_URL not set"}
except Exception as e:
    results["search_upsert"] = {"ok": False, "error": str(e)[:100]}

# 2 Ably publish
try:
    r = httpx.post(
        "https://rest.ably.io/channels/mesh:health/messages",
        content=json.dumps({"name":"preflight","data":json.dumps({"box":"${boxKey}","ts":int(time.time())})}),
        headers={"Content-Type":"application/json"}
    )
    r.raise_for_status()
    results["ably_publish"] = {"ok": True}
except Exception as e:
    results["ably_publish"] = {"ok": False, "error": str(e)[:100]}

# 3 QStash
try:
    q = os.environ.get("QSTASH_URL","https://qstash-us-east-1.upstash.io")
    r = httpx.post(f"{q}/v2/publish/https://httpstat.us/200", json={"preflight":True}, headers={"Content-Type":"application/json"}, timeout=15)
    results["qstash_reachable"] = {"ok": r.status_code in [200,201,202], "status": r.status_code}
except Exception as e:
    results["qstash_reachable"] = {"ok": False, "error": str(e)[:100]}

# 4 Ops UI
try:
    r = httpx.get("${BASE_URL}/api/preflight-ack", timeout=10)
    results["ops_ui"] = {"ok": r.status_code == 200}
except Exception as e:
    results["ops_ui"] = {"ok": False, "error": str(e)[:100]}

# 6 Identity
${identityBlock}

# Cleanup
try:
    u = os.environ.get("UPSTASH_REDIS_REST_URL","")
    httpx.post(f"{u}/del/preflight:{run_id}")
except: pass

print(json.dumps({"box":"${boxKey}","run_id":run_id,"results":results}))
`.trim();
}

async function runPreflightForBox(boxKey, personalityPrompt = null) {
  const start = Date.now();
  let box = null;

  try {
    const snapshotId = getSnapshot(boxKey);

    // Build config: URLs in env, tokens + Ably key in attachHeaders
    const ablyKey = process.env.ABLY_API_KEY || '';
    const baseConfig = meshBoxConfig({
      attachHeaders: {
        'rest.ably.io': {
          Authorization: `Basic ${Buffer.from(ablyKey).toString('base64')}`,
        },
        'openrouter.ai': {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ''}`,
        },
      },
    });

    const boxConfig = {
      agent: { provider: Agent.OpenCode, model: MODEL, apiKey: BoxApiKey.StoredKey },
      ...baseConfig,
      timeout: 200000,
    };

    box = snapshotId
      ? await Box.fromSnapshot(snapshotId, boxConfig)
      : await Box.create({ runtime: "python", ...boxConfig });

    const script = buildPreflightScript(boxKey, personalityPrompt);
    const result = await box.exec.command(`python3 -c ${JSON.stringify(script)}`);
    const output = result.result || '';

    let report;
    try {
      const m = output.match(/\{[\s\S]*\}/);
      report = m ? JSON.parse(m[0]) : null;
    } catch (_) { report = null; }

    if (!report) {
      return { box: boxKey, ok: false, error: `Parse failed: ${output.slice(0,200)}`, durationMs: Date.now() - start, tests: {} };
    }

    const tests = report.results || {};
    const passed = Object.values(tests).filter(t => t.ok).length;
    const total  = Object.keys(tests).length;

    return {
      box: boxKey,
      ok: passed === total,
      passed, total, tests,
      durationMs: Date.now() - start,
      identity: tests.identity?.description || null,
    };

  } catch (err) {
    return { box: boxKey, ok: false, error: err.message, durationMs: Date.now() - start, tests: {} };
  } finally {
    if (box) { try { await box.delete(); } catch (_) {} }
  }
}

module.exports = { runPreflightForBox };
