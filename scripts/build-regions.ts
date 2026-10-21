/**
 * Converts data/kenya-regions.csv (IEBC: 47 counties, 290 constituencies,
 * 1,450 wards) into src/data/regions.json used by the app.
 *
 * Run: npm run build:regions
 * Source: github.com/pkiage/data-Kenya-Counties-Constituencies-Wards
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type Ward = { code: string; name: string };
type Constituency = { code: string; name: string; wards: Ward[] };
type County = { code: string; name: string; constituencies: Constituency[] };

const root = path.resolve(__dirname, "..");
const csv = readFileSync(path.join(root, "data", "kenya-regions.csv"), "utf8");

const titleCase = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(^|[\s\-/'(])([a-z])/g, (_, p, c) => p + c.toUpperCase());

const counties = new Map<string, County>();
const constituencies = new Map<string, Constituency>();

const lines = csv.split(/\r?\n/).filter((l) => l.trim());
for (const line of lines.slice(1)) {
  const [countyId, countyName, constId, constName, wardId, wardName] = line.split(",");

  let county = counties.get(countyId);
  if (!county) {
    county = { code: countyId, name: titleCase(countyName), constituencies: [] };
    counties.set(countyId, county);
  }

  let constituency = constituencies.get(constId);
  if (!constituency) {
    constituency = { code: constId, name: titleCase(constName), wards: [] };
    constituencies.set(constId, constituency);
    county.constituencies.push(constituency);
  }

  constituency.wards.push({ code: wardId, name: titleCase(wardName) });
}

const result = [...counties.values()];
const wardCount = result.reduce(
  (n, c) => n + c.constituencies.reduce((m, k) => m + k.wards.length, 0),
  0
);

if (result.length !== 47 || constituencies.size !== 290 || wardCount !== 1450) {
  throw new Error(
    `Unexpected totals: ${result.length} counties, ${constituencies.size} constituencies, ${wardCount} wards`
  );
}

const outDir = path.join(root, "src", "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "regions.json"), JSON.stringify(result));
console.log(`✔ regions.json: ${result.length} counties, ${constituencies.size} constituencies, ${wardCount} wards`);
