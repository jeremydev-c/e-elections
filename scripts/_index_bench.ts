import { FaceIndex } from "../src/lib/faceIndex";
let seed = 9;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const unit = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
async function main() {
  const index = new FaceIndex();
  const N = 1_000_000;
  const target = unit(Array.from({ length: 512 }, rand));
  for (let i = 0; i < N; i++) index.add(`v${i}`, i === 777_777 ? target : unit(Array.from({ length: 512 }, rand)));
  const probe = target.map((x) => x + rand() * 0.002);
  await index.nearestParallel(probe, 10);
  let t = performance.now(); const a = index.nearest(probe, 10); const one = performance.now() - t;
  t = performance.now(); const b = await index.nearestParallel(probe, 10); const par = performance.now() - t;
  console.log(`1M voters: one thread ${one.toFixed(0)} ms, all cores ${par.toFixed(0)} ms; same answer: ${a.map((x) => x.id).join() === b.map((x) => x.id).join()}; found planted face first: ${b[0].id === "v777777"}`);
  console.log(`projected 22.1M on this laptop: ${(par * 22.12 / 1000).toFixed(1)} s, ${(22_120_458 * 512 / 1e9).toFixed(1)} GB`);
}
main();
