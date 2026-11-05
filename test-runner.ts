#!/usr/bin/env bun

import { spawn } from "bun";

const testCommands = {
  "contacts": "bun test tests/integration/contacts-simple.test.ts --preload ./tests/setup.ts",
  "messages": "bun test tests/integration/messages.test.ts --preload ./tests/setup.ts", 
  "mail": "bun test tests/integration/mail.test.ts --preload ./tests/setup.ts",
  "maps": "bun test tests/integration/maps.test.ts --preload ./tests/setup.ts",
  "web-search": "bun test tests/integration/web-search.test.ts --preload ./tests/setup.ts",
  "mcp": "bun test tests/mcp/handlers.test.ts --preload ./tests/setup.ts",
  "all": "bun test tests/**/*.test.ts --preload ./tests/setup.ts"
};

async function runTest(testName: string) {
  const command = testCommands[testName as keyof typeof testCommands];
  
  if (!command) {
    console.error(`❌ Unknown test: ${testName}`);
    console.log("Available tests:", Object.keys(testCommands).join(", "));
    process.exit(1);
  }

  console.log(`🧪 Running ${testName} tests...`);
  console.log(`Command: ${command}\n`);

  try {
    const result = spawn(command.split(" "), {
      stdio: ["inherit", "inherit", "inherit"],
    });

    const exitCode = await result.exited;
    
    if (exitCode === 0) {
      console.log(`\n✅ ${testName} tests completed successfully!`);
    } else {
      console.log(`\n⚠️  ${testName} tests completed with issues (exit code: ${exitCode})`);
    }
    
    return exitCode;
  } catch (error) {
    console.error(`\n❌ Error running ${testName} tests:`, error);
    return 1;
  }
}

// Get test name from command line arguments
const testName = process.argv[2] || "all";

console.log("🍎 Apple MCP Test Runner");
console.log("=" .repeat(50));

runTest(testName).then(exitCode => {
  process.exit(exitCode);
});