// create-manager-snapshot.ts
// Creates the combined manager Box snapshot.
// Run: npx tsx cozyemployee-mesh/scripts/create-manager-snapshot.ts

import { Box } from '@upstash/box';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SNAPSHOTS_FILE = join(__dirname, '..', 'snapshots.json');

function loadSnapshots() {
  if (existsSync(SNAPSHOTS_FILE)) {
    try { return JSON.parse(readFileSync(SNAPSHOTS_FILE, 'utf-8')); } catch { return {}; }
  }
  return {};
}

async function main() {
  console.log('📦 Creating mesh-manager snapshot...');
  console.log('   (Replaces separate mesh-moderator + mesh-reflect)');

  const existing = loadSnapshots();
  const force = process.argv.includes('--force');

  if (existing['manager'] && !force) {
    console.log(`\n✅ Already snapshotted: ${existing['manager'].id}`);
    console.log('   Use --force to redo');
    return;
  }

  const box = await Box.create({ runtime: 'python', timeout: 600_000 });
  console.log(`✅ Box created: ${box.id}`);

  const packages = ['upstash-redis', 'upstash-vector'];
  console.log(`📥 Installing: ${packages.join(', ')}...`);
  const install = await box.exec.command(
    `pip install --quiet ${packages.join(' ')} 2>&1 | tail -3 && echo "DONE"`
  );
  if (!install.result?.includes('DONE')) {
    console.error('❌ Install failed:', install.result?.slice(-300));
    await box.delete();
    process.exit(1);
  }
  console.log('✅ Packages installed');

  // Write identity marker
  await box.exec.command(
    `echo '{"role":"manager","description":"Routes + reflects — SOP-driven","created":"${new Date().toISOString()}"}' > /workspace/home/.identity`
  );

  console.log('📸 Snapshotting...');
  const snapshot = await box.snapshot({ name: 'mesh-manager' });
  console.log(`✅ Snapshot: ${snapshot.id}`);

  await box.delete();
  console.log('🗑️  Box deleted');

  // Save to snapshots.json
  const updated = {
    ...existing,
    manager: {
      id: snapshot.id,
      name: 'mesh-manager',
      description: 'Routes conversations + writes private reflection notes (SOP-driven)',
      packages,
      createdAt: new Date().toISOString(),
      replaces: ['moderator', 'reflect'],
    },
  };
  writeFileSync(SNAPSHOTS_FILE, JSON.stringify(updated, null, 2));
  console.log(`\n💾 Saved to ${SNAPSHOTS_FILE}`);
  console.log(`\n Manager snapshot ID: ${snapshot.id}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
