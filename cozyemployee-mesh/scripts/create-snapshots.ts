// cozyemployee-mesh/scripts/create-snapshots.ts
//
// Creates one Box per personality (+ moderator + reflect), installs any
// personality-specific packages, snapshots it, and saves all snapshot IDs
// to snapshots.json so the mesh code can use Box.fromSnapshot() for fast
// cold starts instead of spinning up a fresh box every time.
//
// Run: npx tsx cozyemployee-mesh/scripts/create-snapshots.ts
//
// Each box:
//   1. Creates a fresh Box with runtime=python
//   2. Installs base packages (all boxes share these)
//   3. Installs personality-specific packages if any
//   4. Snapshots the box with a human-readable name
//   5. Deletes the ephemeral box
//   6. Saves snapshot ID to snapshots.json

import { Box } from '@upstash/box';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SNAPSHOTS_FILE = join(__dirname, '..', 'snapshots.json');

// ─── Box definitions ──────────────────────────────────────────────────────────
// name: human-readable (stored as snapshot name in Box API)
// key:  key in snapshots.json (used to look up in mesh code)
// packages: personality-specific pip packages to install on top of base
const BOX_DEFINITIONS = [
  // ── System boxes ──────────────────────────────────────────────────────
  {
    key: 'moderator',
    name: 'mesh-moderator',
    description: 'Routes conversations, tracks deliverables, detects drift',
    packages: [], // Base only — moderator uses Agent.OpenCode natively
  },
  {
    key: 'reflect',
    name: 'mesh-reflect',
    description: 'Private cognition engine — structured reflection notes',
    packages: [], // Base only
  },

  // ── 9 Personality boxes ────────────────────────────────────────────────
  {
    key: 'architect',
    name: 'mesh-personality-architect',
    description: 'Systematic, principled, improvement-oriented',
    packages: [], // Future: static analysis tools, schema validators
  },
  {
    key: 'connector',
    name: 'mesh-personality-connector',
    description: 'Stakeholder-focused, empathetic, relationship-aware',
    packages: [], // Future: NLP sentiment tools
  },
  {
    key: 'executor',
    name: 'mesh-personality-executor',
    description: 'Results-oriented, pragmatic, delivery-focused',
    packages: [], // Future: project management API clients
  },
  {
    key: 'visionary',
    name: 'mesh-personality-visionary',
    description: 'Creative, original, differentiation-focused',
    packages: [], // Future: generative tools, image/concept APIs
  },
  {
    key: 'analyst',
    name: 'mesh-personality-analyst',
    description: 'Evidence-driven, assumption-spotting, research-focused',
    packages: [
      // Analyst benefits from data tools for evidence gathering
      'httpx',       // HTTP client for evidence fetching (already on Box but explicit)
    ],
  },
  {
    key: 'guardian',
    name: 'mesh-personality-guardian',
    description: 'Risk-aware, security-focused, failure-mode hunter',
    packages: [], // Future: security scanning tools, CVE checkers
  },
  {
    key: 'explorer',
    name: 'mesh-personality-explorer',
    description: 'Opportunity-focused, possibility-scanner, energetic',
    packages: [], // Future: trend APIs, market data clients
  },
  {
    key: 'challenger',
    name: 'mesh-personality-challenger',
    description: 'Direct, accountability-focused, confrontation-comfortable',
    packages: [], // Base only
  },
  {
    key: 'synthesizer',
    name: 'mesh-personality-synthesizer',
    description: 'Integrative, convergence-focused, pattern-seeing',
    packages: [], // Base only — synthesis is pure reasoning
  },
];

// ─── Base packages installed on ALL boxes ─────────────────────────────────────
// These are pre-installed on Box (verified 2026-03-30):
//   pydantic-ai 1.73.0, openai 2.30.0, httpx 0.28.1, logfire-api 4.31.0
// We install additional Upstash SDKs so personalities can access memory if needed.
const BASE_PACKAGES = [
  'upstash-redis',    // Hot cache access (read personality state, store results)
  'upstash-vector',   // Semantic search (personality can recall past work)
];

// ─── Load existing snapshots ──────────────────────────────────────────────────
function loadSnapshots(): Record<string, { id: string; name: string; createdAt: string }> {
  if (existsSync(SNAPSHOTS_FILE)) {
    try {
      return JSON.parse(readFileSync(SNAPSHOTS_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveSnapshots(snapshots: Record<string, any>) {
  writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snapshots, null, 2));
  console.log(`\n💾 Saved to ${SNAPSHOTS_FILE}`);
}

// ─── Create one snapshot ──────────────────────────────────────────────────────
async function createSnapshot(
  def: typeof BOX_DEFINITIONS[0],
  existingSnapshots: Record<string, any>
): Promise<{ key: string; snapshotId: string } | null> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📦 ${def.key.toUpperCase()} — ${def.description}`);
  console.log(`   Name: ${def.name}`);

  // Skip if already snapshotted (can force re-run with --force flag)
  const forceRedo = process.argv.includes('--force') || process.argv.includes(`--force-${def.key}`);
  if (existingSnapshots[def.key] && !forceRedo) {
    console.log(`   ✅ Already snapshotted: ${existingSnapshots[def.key].id} — skipping`);
    console.log(`      Use --force or --force-${def.key} to redo`);
    return null;
  }

  let box: Box | null = null;
  try {
    // Step 1: Create fresh box
    console.log(`   🏗️  Creating box...`);
    const start = Date.now();
    box = await Box.create({ runtime: 'python', timeout: 600_000 });
    console.log(`   ✅ Box created: ${box.id} (${Date.now() - start}ms)`);

    // Step 2: Install base packages
    const allPackages = [...BASE_PACKAGES, ...def.packages].filter(Boolean);
    if (allPackages.length > 0) {
      console.log(`   📥 Installing: ${allPackages.join(', ')}...`);
      const installStart = Date.now();
      const installResult = await box.exec.command(
        `pip install --quiet ${allPackages.join(' ')} 2>&1 | tail -3 && python -c "import upstash_redis; print('upstash_redis OK')" && echo "INSTALL_DONE"`
      );
      const installOutput = installResult.result || '';
      if (!installOutput.includes('INSTALL_DONE')) {
        console.error(`   ❌ Install failed:\n${installOutput.slice(-500)}`);
        await box.delete();
        return null;
      }
      console.log(`   ✅ Packages installed (${Date.now() - installStart}ms)`);
    } else {
      console.log(`   ℹ️  No additional packages (using Box defaults)`);
      // Still verify base Box is healthy
      const healthCheck = await box.exec.command('python --version && echo "HEALTH_OK"');
      if (!healthCheck.result?.includes('HEALTH_OK')) {
        console.error(`   ❌ Health check failed`);
        await box.delete();
        return null;
      }
    }

    // Step 3: Write a personality marker file so we can verify snapshot identity
    await box.exec.command(
      `echo '{"personality":"${def.key}","name":"${def.name}","created":"${new Date().toISOString()}"}' > /workspace/home/.personality`
    );

    // Step 4: Create snapshot
    console.log(`   📸 Snapshotting...`);
    const snapStart = Date.now();
    const snapshot = await box.snapshot({ name: def.name });
    console.log(`   ✅ Snapshot created: ${snapshot.id} (${Date.now() - snapStart}ms)`);

    return { key: def.key, snapshotId: snapshot.id };

  } catch (err: any) {
    console.error(`   ❌ Error: ${err.message}`);
    return null;
  } finally {
    if (box) {
      try {
        await box.delete();
        console.log(`   🗑️  Box deleted`);
      } catch (e: any) {
        console.warn(`   ⚠️  Box delete failed: ${e.message}`);
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🧠 CozyEmployee Mesh — Snapshot Creator');
  console.log('=======================================');
  console.log(`Creating snapshots for ${BOX_DEFINITIONS.length} boxes`);
  console.log(`(${BASE_PACKAGES.join(', ')} installed on all)\n`);

  const existing = loadSnapshots();
  const results: Record<string, any> = { ...existing };
  let created = 0;
  let skipped = 0;
  let failed = 0;

  // Run sequentially to avoid hitting Box concurrent limits (10 max)
  // Sequential also makes logs readable
  for (const def of BOX_DEFINITIONS) {
    const result = await createSnapshot(def, existing);

    if (result === null) {
      if (existing[def.key]) {
        skipped++;
      } else {
        failed++;
      }
    } else {
      results[def.key] = {
        id: result.snapshotId,
        name: def.name,
        description: def.description,
        packages: [...BASE_PACKAGES, ...def.packages],
        createdAt: new Date().toISOString(),
      };
      created++;
    }

    // Save after each successful snapshot (don't lose progress)
    if (result !== null) {
      saveSnapshots(results);
    }
  }

  // Final save
  saveSnapshots(results);

  console.log('\n=======================================');
  console.log(`✅ Created: ${created}`);
  console.log(`⏭️  Skipped: ${skipped} (already exist)`);
  console.log(`❌ Failed:  ${failed}`);
  console.log('\nSnapshot IDs:');
  for (const [key, val] of Object.entries(results)) {
    console.log(`  ${key.padEnd(15)} → ${val.id}`);
  }
  console.log('\nNext: The mesh code will auto-load these from snapshots.json');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
