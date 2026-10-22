import os from "node:os";
import { Worker } from "node:worker_threads";
import { connectDB } from "@/lib/mongodb";
import { decryptFaceTemplate, type FaceTemplateData } from "@/lib/biometricVault";
import { EMBEDDING_LENGTH } from "@/lib/faceMath";
import { Voter } from "@/models/Voter";

/**
 * In-memory index of every enrolled face, for the 1:N checks
 * (registration: "is this face already registered?"; login: "does this face
 * match another voter as well as the claimed one?").
 *
 * Before: every check downloaded and decrypted ALL templates (capped at 5,000),
 * so each login cost ~21 KB per voter of database traffic.
 * Now: the server keeps one 512-number ArcFace average per voter in memory, stored as
 * 8-bit numbers (512 bytes each: ~0.5 GB per million voters, ~11 GB for Kenya's whole
 * register, a quarter of 32-bit floats), searches the whole register in memory, and
 * fetches only the K closest full templates, which are then compared exactly. The
 * vectors are unit length, so the most similar by dot product are the nearest. Legacy
 * 128-number templates are not indexed (those voters must re-enrol).
 *
 * Large registers are searched on every CPU core at once: the vectors sit in shared
 * memory and each worker thread scans one slice (searchParallel).
 *
 * The index is built once, then catches up with new registrations every couple
 * of seconds. If voters are deleted or the database is reset, it rebuilds.
 */

const D = EMBEDDING_LENGTH;
/** How many of the closest faces are checked with the full template. */
export const NEAREST_K = 10;
const REFRESH_MS = 2_000;
const REBUILD_MS = 10 * 60_000;

/** Below this many voters one thread is fastest; above it the search is split across cores. */
const PARALLEL_FROM = 100_000;

/** 8-bit quantisation of a unit vector: each number (between -1 and 1) to -127..127. */
function quantise(v: ArrayLike<number>, out: Int8Array | Int32Array, at = 0) {
  for (let i = 0; i < D; i++) out[at + i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
}

type Hit = { row: number; dot: number };

/**
 * The k rows of `m` (rows from..to) with the largest dot product with `q`, best first.
 * Whole-number maths: as fast as 32-bit floats in JavaScript, on a quarter of the memory.
 * (Also the body of the worker threads below, so keep it self-contained.)
 */
function scanRows(m: Int8Array, q: Int32Array, from: number, to: number, k: number, skip: number): Hit[] {
  const dim = q.length;
  const best: Hit[] = [];
  for (let row = from; row < to; row++) {
    let dot = 0;
    const base = row * dim;
    for (let i = 0; i < dim; i++) dot = (dot + m[base + i] * q[i]) | 0;
    if ((best.length === k && dot <= best[k - 1].dot) || row === skip) continue;
    let at = best.length;
    while (at > 0 && best[at - 1].dot < dot) at--;
    best.splice(at, 0, { row, dot });
    if (best.length > k) best.pop();
  }
  return best;
}

// ---------------------------------------------------------------- worker threads

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const scanRows = ${scanRows.toString()};
parentPort.on("message", ({ job, buffer, from, to, q, k, skip }) => {
  parentPort.postMessage({ job, hits: scanRows(new Int8Array(buffer), q, from, to, k, skip) });
});`;

type Pool = { workers: Worker[]; next: number; waiting: Map<number, (hits: Hit[]) => void> };
const gPool = globalThis as unknown as { _faceSearchPool?: Pool };

function pool(): Pool {
  if (gPool._faceSearchPool) return gPool._faceSearchPool;
  const size = Math.max(2, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1));
  const p: Pool = { workers: [], next: 1, waiting: new Map() };
  for (let i = 0; i < size; i++) {
    const w = new Worker(WORKER_SOURCE, { eval: true });
    w.unref(); // never keep the server (or a test script) alive
    w.on("message", ({ job, hits }: { job: number; hits: Hit[] }) => {
      p.waiting.get(job)?.(hits);
      p.waiting.delete(job);
    });
    p.workers.push(w);
  }
  return (gPool._faceSearchPool = p);
}

/** Pure search structure (no database), so it can be tested offline. */
export class FaceIndex {
  // Shared memory, so worker threads can search it without copying.
  private means = new Int8Array(new SharedArrayBuffer(1024 * D));
  private ids: string[] = [];
  private rowOf = new Map<string, number>();

  get size() {
    return this.ids.length;
  }

  has(id: string) {
    return this.rowOf.has(id);
  }

  add(id: string, mean: ArrayLike<number>) {
    if (mean.length !== D) return;
    let row = this.rowOf.get(id);
    if (row === undefined) {
      row = this.ids.length;
      if ((row + 1) * D > this.means.length) {
        const grown = new Int8Array(new SharedArrayBuffer(this.means.length * 2));
        grown.set(this.means);
        this.means = grown;
      }
      this.ids.push(id);
      this.rowOf.set(id, row);
    }
    quantise(mean, this.means, row * D);
  }

  /**
   * The `k` enrolled faces whose averages are most similar to `probe`, searching the whole
   * register. `similarity` is the 8-bit estimate of the cosine similarity (within ~0.01);
   * callers re-check the few candidates exactly against their full templates.
   */
  nearest(probe: ArrayLike<number>, k = NEAREST_K, excludeId?: string): { id: string; similarity: number }[] {
    const q = new Int32Array(D);
    quantise(probe, q);
    return this.named(scanRows(this.means, q, 0, this.ids.length, k, this.skipRow(excludeId)));
  }

  /** The same search, split across all CPU cores (worth it from ~100,000 voters). */
  async nearestParallel(probe: ArrayLike<number>, k = NEAREST_K, excludeId?: string) {
    if (this.ids.length < PARALLEL_FROM) return this.nearest(probe, k, excludeId);
    const q = new Int32Array(D);
    quantise(probe, q);
    const p = pool();
    const n = this.ids.length;
    const slice = Math.ceil(n / p.workers.length);
    const skip = this.skipRow(excludeId);
    const parts = await Promise.all(
      p.workers.map(
        (w, i) =>
          new Promise<Hit[]>((resolve) => {
            const job = p.next++;
            p.waiting.set(job, resolve);
            w.postMessage({ job, buffer: this.means.buffer, from: i * slice, to: Math.min(n, (i + 1) * slice), q, k, skip });
          })
      )
    );
    const merged = parts.flat().sort((a, b) => b.dot - a.dot).slice(0, k);
    return this.named(merged);
  }

  private skipRow(excludeId?: string) {
    return excludeId === undefined ? -1 : (this.rowOf.get(excludeId) ?? -1);
  }

  private named(hits: Hit[]) {
    return hits.map((b) => ({ id: this.ids[b.row], similarity: b.dot / (127 * 127) }));
  }
}

// ---------------------------------------------------------------- server singleton

type State = {
  index: FaceIndex;
  /** Voters scanned (with or without a face) and the oldest voter's id: a cheap fingerprint of the collection. */
  scanned: number;
  oldestId: string;
  watermark: Date;
  checkedAt: number;
  builtAt: number;
};

const g = globalThis as unknown as { _faceIndex?: State; _faceIndexJob?: Promise<void> };

async function scan(state: State, filter: Record<string, unknown>) {
  const cursor = Voter.find(filter, { idNumber: 1, faceTemplate: 1, createdAt: 1 })
    .select("+faceTemplate")
    .sort({ createdAt: 1 })
    .lean()
    .cursor({ batchSize: 2000 });
  for await (const v of cursor) {
    const id = String(v._id);
    const created = v.createdAt ? new Date(v.createdAt) : state.watermark;
    if (created > state.watermark) state.watermark = created;
    state.scanned += 1;
    const t = decryptFaceTemplate(v.faceTemplate, v.idNumber);
    if (t) state.index.add(id, t.mean);
  }
}

async function fingerprint() {
  const [count, oldest] = await Promise.all([
    Voter.estimatedDocumentCount(),
    Voter.findOne({}, { _id: 1 }).sort({ _id: 1 }).lean(),
  ]);
  return { count, oldestId: oldest ? String(oldest._id) : "" };
}

async function rebuild(): Promise<State> {
  const state: State = { index: new FaceIndex(), scanned: 0, oldestId: "", watermark: new Date(0), checkedAt: Date.now(), builtAt: Date.now() };
  await scan(state, {});
  state.oldestId = (await fingerprint()).oldestId;
  return state;
}

async function refresh(state: State): Promise<State> {
  await scan(state, { createdAt: { $gt: state.watermark } });
  const fp = await fingerprint();
  state.checkedAt = Date.now();
  // Deleted voters, a reset database, or a registration missed in the same millisecond: start again.
  if (fp.count !== state.scanned || fp.oldestId !== state.oldestId) return rebuild();
  return state;
}

/**
 * The index for this server instance (concurrent callers share one build or refresh).
 * With `fresh`, waits for it to catch up with the database first: registration does this,
 * because its duplicate-face check must see every voter. Logins don't wait: they search the
 * index as it is (at most a couple of seconds behind) while it refreshes in the background,
 * which saves several database round trips per login.
 */
export async function faceIndex({ fresh = false } = {}): Promise<FaceIndex> {
  await connectDB();
  const now = Date.now();
  const state = g._faceIndex;
  const stale = !state || now - state.builtAt > REBUILD_MS || now - state.checkedAt > REFRESH_MS;
  if (stale) {
    g._faceIndexJob ??= (async () => {
      try {
        const s = g._faceIndex;
        g._faceIndex = !s || Date.now() - s.builtAt > REBUILD_MS ? await rebuild() : await refresh(s);
      } finally {
        g._faceIndexJob = undefined;
      }
    })();
    if (fresh || !state) await g._faceIndexJob;
    else g._faceIndexJob.catch((err) => console.error("Face index refresh failed:", (err as Error).message));
  }
  return g._faceIndex!.index;
}

/**
 * Make a voter registered by this server searchable straight away. The next
 * refresh also picks it up from the database (counting it once), and other
 * server instances catch up within a couple of seconds.
 */
export function indexVoter(voterId: string, mean: number[]) {
  g._faceIndex?.index.add(voterId, mean);
}

/** Full templates of the K enrolled faces closest to `probeMean` (optionally leaving one voter out). */
export async function closestTemplates(
  probeMean: number[],
  { excludeId, fresh = false, k = NEAREST_K }: { excludeId?: string; fresh?: boolean; k?: number } = {}
): Promise<FaceTemplateData[]> {
  const index = await faceIndex({ fresh });
  const ids = (await index.nearestParallel(probeMean, k, excludeId)).map((n) => n.id);
  if (!ids.length) return [];
  const docs = await Voter.find({ _id: { $in: ids } }, { idNumber: 1, faceTemplate: 1 }).select("+faceTemplate").lean();
  return docs.flatMap((d) => decryptFaceTemplate(d.faceTemplate, d.idNumber) ?? []);
}

/** Is this voter's stored template from the current (512-number) engine? */
export function isCurrentTemplate(t: FaceTemplateData | null): t is FaceTemplateData {
  return !!t && t.mean.length === EMBEDDING_LENGTH;
}
