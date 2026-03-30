// src/test.js
// Quick smoke test for all workflows.

const hello = require("./workflows/hello");
const memorySync = require("./workflows/memory-sync");

console.log("🧪 Running workflow tests...\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

// Hello workflow tests
test("hello.steps.greet returns message", () => {
  const result = hello.steps.greet("Test");
  if (!result.message.includes("Test")) throw new Error("Name not in greeting");
});

test("hello.steps.log returns timestamp", () => {
  const result = hello.steps.log({ message: "test" });
  if (!result.logged) throw new Error("Not logged");
  if (!result.timestamp) throw new Error("No timestamp");
});

test("hello.steps.summarize returns complete", () => {
  const result = hello.steps.summarize({ message: "test" });
  if (result.status !== "complete") throw new Error("Not complete");
  if (result.steps !== 3) throw new Error("Wrong step count");
});

test("hello.runDev returns all results", () => {
  const result = hello.runDev("Tester");
  if (!result.greeting.message.includes("Tester")) throw new Error("Name missing");
  if (!result.summary.status === "complete") throw new Error("Not complete");
});

// Memory sync tests
test("memory-sync.steps.pull-local returns entities", () => {
  const result = memorySync.steps["pull-local"]("full");
  if (!Array.isArray(result.entities)) throw new Error("No entities");
});

test("memory-sync.steps.diff computes gaps", () => {
  const local = { entities: ["a", "b"] };
  const cloud = { entities: ["b", "c"] };
  const gaps = memorySync.steps.diff(local, cloud);
  if (!gaps.toCloud.includes("a")) throw new Error("Missing toCloud");
  if (!gaps.fromCloud.includes("c")) throw new Error("Missing fromCloud");
});

test("memory-sync.runDev returns report", () => {
  const result = memorySync.runDev("full");
  if (!result.timestamp) throw new Error("No timestamp");
  if (result.type !== "full") throw new Error("Wrong type");
});

// Summary
console.log(`\n📊 ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
