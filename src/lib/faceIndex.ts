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
 * Now: the server keeps one 512-number ArcFace average per voter in a flat Float32Array
 * (2 KB each, ~2 GB per million voters), searches the whole register exactly in
 * memory, and fetches only the K closest full templates. The vectors are unit length,
 * so the nearest by distance are also the most similar by cosine. Legacy 128-number
 * templates are not indexed (those voters must re-enrol).
 *
 * The index is built once, then catches up with new registrations every couple
 * of seconds. If voters are deleted or the database is reset, it rebuilds.
 */

const D = EMBEDDING_LENGTH;
/** How many of the closest faces are checked with the full template. */
export const NEAREST_K = 10;
const REFRESH_MS = 2_000;
const REBUILD_MS = 10 * 60_000;

/** Pure search structure (no database), so it can be tested offline. */
export class FaceIndex {
  private means = new Float32Array(1024 * D);
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
        const grown = new Float32Array(this.means.length * 2);
        grown.set(this.means);
        this.means = grown;
      }
      this.ids.push(id);
      this.rowOf.set(id, row);
    }
    this.means.set(mean, row * D);
  }

  /** The `k` enrolled faces whose averages are closest to `probe` (exact, whole register). */
  nearest(probe: ArrayLike<number>, k = NEAREST_K, excludeId?: string): { id: string; distance: number }[] {
    const best: { row: number; d2: number }[] = [];
    const m = this.means;
    for (let row = 0; row < this.ids.length; row++) {
      let d2 = 0;
      const base = row * D;
      for (let i = 0; i < D; i++) {
        const diff = m[base + i] - probe[i];
        d2 += diff * diff;
      }
      if (best.length === k && d2 >= best[k - 1].d2) continue;
      if (this.ids[row] === excludeId) continue;
      let at = best.length;
      while (at > 0 && best[at - 1].d2 > d2) at--;
      best.splice(at, 0, { row, d2 });
      if (best.length > k) best.pop();
    }
    return best.map((b) => ({ id: this.ids[b.row], distance: Math.sqrt(b.d2) }));
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

/** The up-to-date index for this server instance (concurrent callers share one build or refresh). */
export async function faceIndex(): Promise<FaceIndex> {
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
    await g._faceIndexJob;
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
export async function closestTemplates(probeMean: number[], excludeId?: string, k = NEAREST_K): Promise<FaceTemplateData[]> {
  const index = await faceIndex();
  const ids = index.nearest(probeMean, k, excludeId).map((n) => n.id);
  if (!ids.length) return [];
  const docs = await Voter.find({ _id: { $in: ids } }, { idNumber: 1, faceTemplate: 1 }).select("+faceTemplate").lean();
  return docs.flatMap((d) => decryptFaceTemplate(d.faceTemplate, d.idNumber) ?? []);
}

/** Is this voter's stored template from the current (512-number) engine? */
export function isCurrentTemplate(t: FaceTemplateData | null): t is FaceTemplateData {
  return !!t && t.mean.length === EMBEDDING_LENGTH;
}
