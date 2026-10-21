/**
 * CLI wrapper around src/lib/seed.ts (the same code behind the /setup page).
 *
 * Run:              npm run seed
 * Re-open voting:   npm run seed -- --reset-votes   (wipes ballots, keeps voters)
 * Full reset:       npm run seed -- --reset         (also wipes every voter!)
 */
import path from "node:path";
process.loadEnvFile(path.resolve(__dirname, "..", ".env.local"));

import mongoose from "mongoose";
import { seedDatabase } from "../src/lib/seed";

const reset = process.argv.includes("--reset") ? "all" : process.argv.includes("--reset-votes") ? "votes" : "none";

seedDatabase({ reset })
  .then(async ({ log, admin, counts }) => {
    for (const line of log) console.log(`✔ ${line}`);
    if (admin) {
      console.log(`\n  Admin login → username: ${admin.username}  password: ${admin.password}`);
      console.log("  (save this password now, it will not be shown again)\n");
    }
    console.log(`Totals: ${counts.candidates} candidates · ${counts.voters} voters · ${counts.ballots} ballots`);
    await mongoose.disconnect();
  })
  .catch(async (err) => {
    console.error("✖ Seed failed:", err);
    await mongoose.disconnect();
    process.exit(1);
  });
