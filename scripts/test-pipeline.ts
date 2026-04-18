import 'dotenv/config';
import { runPipeline } from '../src/lib/pipeline.js';

/**
 * Clean entry point for testing the pipeline locally.
 * Ensure your .env file contains:
 * - DATABASE_URL
 * - GITHUB_TOKENS (comma-separated list)
 */
async function main() {
  const testUser = process.argv[2] || "torvalds";

  console.log("==========================================");
  console.log("🚀 LOCAL TEST PIPELINE START");
  console.log("User:", testUser);
  console.log("==========================================");

  try {
    // Stage 1: Run the full pipeline (Scrape -> Compute -> Aggregate)
    await runPipeline(testUser);
    
    console.log("\n✅ ALL STAGES COMPLETED SUCCESSFULLY");
  } catch (err: any) {
    console.error("\n❌ PIPELINE FAILED");
    
    // In ESM, sometimes errors don't stringify well, 
    // we use JSON.stringify or specifically log the message and stack
    if (err instanceof Error) {
      console.error("Message:", err.message);
      console.error("Stack Trace:");
      console.error(err.stack);
    } else {
      console.error("Unknown Error Object:", JSON.stringify(err, null, 2));
    }
    
    process.exit(1);
  }
}

main().catch((fatal) => {
  console.error("FATAL UNCAUGHT ERROR:", fatal);
  process.exit(1);
});
