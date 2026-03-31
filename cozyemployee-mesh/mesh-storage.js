// cozyemployee-mesh/mesh-storage.js
//
// Dedicated storage clients for the CozyEmployee mesh.
//
// Uses MESH_* env vars pointing to isolated Upstash instances:
//   MESH_REDIS_REST_URL / MESH_REDIS_REST_TOKEN    → cozyemployee-mesh Redis
//   MESH_VECTOR_REST_URL / MESH_VECTOR_REST_TOKEN  → cozyemployee-mesh Vector
//   MESH_SEARCH_REST_URL / MESH_SEARCH_REST_TOKEN  → cozyemployee-mesh Search
//
// Provisioned 2026-03-31 via Upstash Developer API.
// Kept separate from Cozy's personal memory (UPSTASH_REDIS_REST_URL etc.)
// so mesh operations never pollute the agent's own working memory.

"use strict";

const { Redis } = require("@upstash/redis");
const { Index } = require("@upstash/vector");

// ─── Redis ────────────────────────────────────────────────────────────────────
// Used for: conversation history, manager private notes, agent state per session
let _redis = null;
function getMeshRedis() {
  if (_redis) return _redis;

  const url = process.env.MESH_REDIS_REST_URL;
  const token = process.env.MESH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // Hard error — no silent fallback to Cozy's personal memory
    throw new Error(
      '[mesh-storage] MESH_REDIS_REST_URL / MESH_REDIS_REST_TOKEN not set. ' +
      'Add these to .env — mesh will NOT fall back to UPSTASH_REDIS_REST_* ' +
      'to prevent polluting Cozy\'s working memory.'
    );
  }

  _redis = new Redis({ url, token });
  return _redis;
}

// ─── Vector ───────────────────────────────────────────────────────────────────
// Used for: semantic search over past conversations, personality knowledge store
let _vector = null;
function getMeshVector() {
  if (_vector) return _vector;

  const url = process.env.MESH_VECTOR_REST_URL;
  const token = process.env.MESH_VECTOR_REST_TOKEN;

  if (!url || !token) {
    console.error('[mesh-storage] MESH_VECTOR_REST_URL / MESH_VECTOR_REST_TOKEN not set');
    return null;
  }

  _vector = new Index({ url, token });
  return _vector;
}

// ─── Search ───────────────────────────────────────────────────────────────────
// Used for: full-text search over conversation history and document content
// Note: Upstash Search uses a different client (@upstash/search)
let _search = null;
function getMeshSearch() {
  if (_search) return _search;

  const url = process.env.MESH_SEARCH_REST_URL;
  const token = process.env.MESH_SEARCH_REST_TOKEN;

  if (!url || !token) {
    console.error('[mesh-storage] MESH_SEARCH_REST_URL / MESH_SEARCH_REST_TOKEN not set');
    return null;
  }

  // @upstash/search client (different from Redis/Vector)
  try {
    const { SearchClient } = require("@upstash/search");
    _search = new SearchClient({ url, token });
  } catch (err) {
    console.warn('[mesh-storage] @upstash/search not installed, search unavailable');
    console.warn('[mesh-storage] Run: npm install @upstash/search in cozyemployee-mesh/');
  }

  return _search;
}

// ─── Key helpers ─────────────────────────────────────────────────────────────
// Namespaced key builders to keep mesh data organized
const keys = {
  // Conversation history per session
  history: (sessionId) => `mesh:history:${sessionId}`,

  // Manager's private notes per personality per channel
  notes: (channelId, personalityName) => `manager:notes:${channelId}:${personalityName}`,

  // Active session state (energy, round, deliverables)
  sessionState: (sessionId) => `mesh:state:${sessionId}`,

  // Personality participation counts per session
  participation: (sessionId) => `mesh:participation:${sessionId}`,
};

// ─── Verify connectivity on startup ──────────────────────────────────────────
async function verifyMeshStorage() {
  const redis = getMeshRedis();
  try {
    await redis.set('mesh:healthcheck', Date.now(), { ex: 60 });
    const val = await redis.get('mesh:healthcheck');
    console.log(`[mesh-storage] ✅ Redis OK — ${process.env.MESH_REDIS_REST_URL?.split('.')[0]?.replace('https://', '')}`);
  } catch (err) {
    console.error(`[mesh-storage] ❌ Redis FAILED:`, err.message);
  }

  const vector = getMeshVector();
  if (vector) {
    try {
      const info = await vector.info();
      console.log(`[mesh-storage] ✅ Vector OK — ${info.vectorCount || 0} vectors, dimension=${info.dimension}`);
    } catch (err) {
      console.error(`[mesh-storage] ❌ Vector FAILED:`, err.message);
    }
  }
}

module.exports = { getMeshRedis, getMeshVector, getMeshSearch, keys, verifyMeshStorage };
