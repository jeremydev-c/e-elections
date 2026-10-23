/**
 * Voter card checks (offline, no database):  npx tsx scripts/card-test.ts
 * Card numbers, the signed QR token and the per-card security pattern.
 */
import path from "node:path";
process.loadEnvFile(path.resolve(__dirname, "..", ".env.local"));

import { cardNumber, cardNumberWellFormed, cardToken, initialsName, readCardToken } from "../src/lib/voterCard";
import { guilloche } from "../src/lib/guilloche";

let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
}

const a = "65f0c2a1b3d4e5f6a7b8c9d0";
const b = "65f0c2a1b3d4e5f6a7b8c9d1";

const n1 = cardNumber(a, 1);
check("Card number has the KE27-XXXX-XXXX-C shape", /^KE27-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]$/.test(n1), n1);
check("Same voter and serial always give the same number", cardNumber(a, 1) === n1);
check("Reissued card gets a new number", cardNumber(a, 2) !== n1);
check("Check character accepts a real number", cardNumberWellFormed(n1));
const typo = n1.slice(0, 5) + (n1[5] === "7" ? "8" : "7") + n1.slice(6);
check("Check character catches a mistyped number", !cardNumberWellFormed(typo), typo);

const tok = cardToken(a, 1);
check("Token reads back to the same voter and serial", readCardToken(tok)?.voterId === a && readCardToken(tok)?.serial === 1, `${tok.length} chars`);
check("Token with another voter's id is rejected", readCardToken(tok.replace(a, b)) === null);
check("Token with a changed serial is rejected", readCardToken(tok.replace(".1.", ".2.")) === null);
check("Made-up token is rejected", readCardToken(`1.${a}.1.AAAAAAAAAAAAAAAAAAAAAA`) === null);
check("Token holds no name or National ID", !/[A-Z][a-z]+ [A-Z]/.test(tok) && !/\b\d{7,8}\b/.test(tok));

const g1 = guilloche(n1, 856, 540, "front");
const g2 = guilloche(cardNumber(b, 1), 856, 540, "front");
check("Pattern is the same every time for one card", JSON.stringify(g1) === JSON.stringify(guilloche(n1, 856, 540, "front")));
check("Two cards get different patterns", g1.rosettes[0].d !== g2.rosettes[0].d);

check("Initials keep the surname", initialsName("Achieng Wanjiru Otieno") === "A. W. Otieno", initialsName("Achieng Wanjiru Otieno"));

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
