// test-box-brain.mjs
// Test Box as external brain for the Upstash nerve net

import { Box, Agent, BoxApiKey } from '@upstash/box';
import { z } from 'zod';

async function commissionBox(prompt, options = {}) {
  const box = await Box.create({
    runtime: options.runtime || 'python',
    agent: {
      provider: Agent.OpenCode,
      model: options.model || 'openrouter/stepfun/step-3.5-flash:free',
      apiKey: BoxApiKey.StoredKey,
    },
    timeout: 300000,
  });
  console.log(`  Box ${box.id} commissioned`);
  try {
    const result = await box.agent.run({ prompt, responseSchema: options.schema });
    return { boxId: box.id, result: result.result, cost: result.cost?.totalUsd || 0 };
  } finally {
    await box.delete();
    console.log(`  Box ${box.id} released`);
  }
}

// TEST 1: Research & Store
console.log('\n=== TEST 1: Research & Store ===');
const research = await commissionBox(
  'Research: Best practices for deploying vLLM on cloud GPUs with AWQ quantization. 3 key findings.',
  { schema: z.object({ findings: z.array(z.string()), confidence: z.enum(['high', 'medium', 'low']) }) }
);
console.log('Findings:', research.result.findings);
console.log('Confidence:', research.result.confidence);
console.log('Cost:', research.cost);

// TEST 2: Parallel Brain
console.log('\n=== TEST 2: Parallel Brain (3 experts) ===');
const problem = 'How to build a durable workflow system that survives server crashes?';

const [eng, arch, sec] = await Promise.all([
  commissionBox(`You are an engineer. ${problem} Give 3 practical points.`),
  commissionBox(`You are a systems architect. ${problem} Focus on architecture, 3 points.`),
  commissionBox(`You are a security expert. ${problem} Focus on security, 3 points.`),
]);

console.log('Engineer:', eng.result.slice(0, 100) + '...');
console.log('Architect:', arch.result.slice(0, 100) + '...');
console.log('Security:', sec.result.slice(0, 100) + '...');

const synthesis = await commissionBox(
  `Synthesize these 3 expert perspectives into 5 unified recommendations:\n\nEngineer: ${eng.result}\n\nArchitect: ${arch.result}\n\nSecurity: ${sec.result}`
);
console.log('\nSynthesis:', synthesis.result.slice(0, 200) + '...');

// TEST 3: Knowledge Builder
console.log('\n=== TEST 3: Knowledge Builder ===');
const patterns = await commissionBox(
  `Extract decisions and lessons from these activities:\n- Built E2B Desktop agent\n- Deployed Upstash Workflow with 7 patterns\n- Compared Vast.ai vs RunPod vs Modal\n- Found OpenRouter privacy blocks some models\n\nReturn JSON: {decisions: [{what, why}], lessons: [string]}`,
  { schema: z.object({ decisions: z.array(z.object({ what: z.string(), why: z.string() })), lessons: z.array(z.string()) }) }
);
console.log('Decisions:', JSON.stringify(patterns.result.decisions, null, 2));
console.log('Lessons:', patterns.result.lessons);

// TEST 4: Code Execution in Box
console.log('\n=== TEST 4: Code Execution ===');
const box4 = await Box.create({ runtime: 'python' });
await box4.files.write({ path: '/work/analyze.py', content: 'import json\ndata = {"model_accuracy": [0.85, 0.87, 0.91, 0.89, 0.93], "avg": 0.89}\nprint(json.dumps(data))' });
const run = await box4.exec.command('python3 /work/analyze.py');
console.log('Code output:', run.result);
await box4.delete();

console.log('\n✅ All 4 brain tests complete.');
