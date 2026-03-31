// cozyemployee-mesh/box-env.js
//
// Builds the correct env + attachHeaders config for every Box commission.
//
// Per Upstash Box security docs:
//   env          → non-sensitive config. Visible to ALL code inside the container.
//   attachHeaders → credentials injected by the host proxy at the TLS layer.
//                   Tokens NEVER enter the container. Any code inside the box
//                   making HTTPS requests to matched hosts gets them silently.
//
// Split:
//   env:           URLs (non-secret), model name, QStash URL
//   attachHeaders: ALL tokens/keys (Redis, Vector, Search, OpenRouter, QStash)
//
// Why this matters for our boxes:
//   Box agents run LLM-generated code. If a prompt somehow caused the model
//   to run `import os; print(os.environ)`, tokens in env would be exposed.
//   With attachHeaders, there's nothing to leak — they never enter the container.
//
// Upstash REST API auth header: "Authorization: Bearer <token>"
// OpenRouter auth header:       "Authorization: Bearer <key>"
// QStash auth header:           "Authorization: Bearer <token>"

"use strict";

function meshBoxConfig(extras = {}) {
  const {
    // Non-sensitive: URLs go in env — SDKs need these to know where to connect
    MESH_REDIS_REST_URL:    redisUrl,
    MESH_VECTOR_REST_URL:   vectorUrl,
    MESH_SEARCH_REST_URL:   searchUrl,

    // Sensitive: tokens stay out of env — injected via attachHeaders
    MESH_REDIS_REST_TOKEN:  redisToken,
    MESH_VECTOR_REST_TOKEN: vectorToken,
    MESH_SEARCH_REST_TOKEN: searchToken,
    OPENROUTER_API_KEY:     openrouterKey,
    QSTASH_URL:             qstashUrl,
    QSTASH_TOKEN:           qstashToken,
  } = process.env;

  // ── env: non-sensitive config only ─────────────────────────────────────────
  // The Python upstash SDKs read UPSTASH_REDIS_REST_URL etc. for the endpoint.
  // Inside the Box these map to the mesh-specific instances, not Cozy's.
  const env = {
    // Upstash endpoint URLs (where to connect — not secret)
    UPSTASH_REDIS_REST_URL:  redisUrl,
    UPSTASH_VECTOR_REST_URL: vectorUrl,
    UPSTASH_SEARCH_REST_URL: searchUrl,

    // QStash URL (not secret — just which regional endpoint)
    QSTASH_URL: qstashUrl || 'https://qstash-us-east-1.upstash.io',

    // Spread any caller-provided non-sensitive overrides
    ...(extras.env || {}),
  };

  // Strip undefined/empty values
  Object.keys(env).forEach(k => {
    if (!env[k]) delete env[k];
  });

  // ── attachHeaders: all tokens injected at TLS layer ────────────────────────
  // Host patterns must be lowercase. Tokens never appear inside the container.
  const attachHeaders = {};

  // Upstash REST API uses: Authorization: Bearer <token>
  if (redisToken && redisUrl) {
    const host = redisUrl.replace('https://', '').replace(/\/$/, '');
    attachHeaders[host] = { Authorization: `Bearer ${redisToken}` };
  }

  if (vectorToken && vectorUrl) {
    const host = vectorUrl.replace('https://', '').replace(/\/$/, '');
    attachHeaders[host] = { Authorization: `Bearer ${vectorToken}` };
  }

  if (searchToken && searchUrl) {
    const host = searchUrl.replace('https://', '').replace(/\/$/, '');
    attachHeaders[host] = { Authorization: `Bearer ${searchToken}` };
  }

  // OpenRouter: Authorization: Bearer <key>
  if (openrouterKey) {
    attachHeaders['openrouter.ai'] = { Authorization: `Bearer ${openrouterKey}` };
  }

  // QStash: Authorization: Bearer <token>
  if (qstashToken) {
    attachHeaders['qstash-us-east-1.upstash.io'] = { Authorization: `Bearer ${qstashToken}` };
    attachHeaders['qstash.upstash.io'] = { Authorization: `Bearer ${qstashToken}` };
  }

  // Spread any caller-provided attachHeaders overrides
  Object.assign(attachHeaders, extras.attachHeaders || {});

  // ── Validation ─────────────────────────────────────────────────────────────
  const missingUrls = ['MESH_REDIS_REST_URL', 'MESH_VECTOR_REST_URL']
    .filter(k => !process.env[k]);
  const missingTokens = ['MESH_REDIS_REST_TOKEN', 'MESH_VECTOR_REST_TOKEN']
    .filter(k => !process.env[k]);

  if (missingUrls.length > 0) {
    console.error(`[box-env] ⚠️  Missing mesh URL vars: ${missingUrls.join(', ')}`);
  }
  if (missingTokens.length > 0) {
    console.error(`[box-env] ⚠️  Missing mesh token vars: ${missingTokens.join(', ')}`);
    console.error('[box-env] Box sandboxes will not have storage access!');
  }

  return { env, attachHeaders };
}

module.exports = { meshBoxConfig };
