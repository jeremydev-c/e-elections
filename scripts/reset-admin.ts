/**
 * Sets a new password for an election-official (admin) account, creating
 * the account if it does not exist. Only the scrypt hash is stored.
 *
 * Run:  npm run reset-admin                       (random password, printed once)
 *       npm run reset-admin -- MyNewPassword123   (choose your own, min 10 chars)
 * Optional: ADMIN_USERNAME in .env.local (default "admin").
 */
import path from "node:path";
process.loadEnvFile(path.resolve(__dirname, "..", ".env.local"));

import mongoose from "mongoose";
import { connectDB } from "../src/lib/mongodb";
import { hashPassword } from "../src/lib/password";
import { randomToken } from "../src/lib/hashChain";
import { Admin } from "../src/models/Election";

async function main() {
  const username = (process.env.ADMIN_USERNAME ?? "admin").toLowerCase();
  const password = process.argv[2] ?? randomToken(9);
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");

  await connectDB();
  await Admin.updateOne(
    { username },
    { $set: { username, passwordHash: await hashPassword(password) } },
    { upsert: true }
  );
  console.log(`✔ Admin login → username: ${username}  password: ${password}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("✖ Reset failed:", (err as Error).message);
  await mongoose.disconnect();
  process.exit(1);
});
