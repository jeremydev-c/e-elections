/**
 * Downloads the server face models into ml-models/ and checks each file's SHA-256.
 *
 *   InsightFace buffalo_l (det_10g, w600k_r50, 2d106det)  github.com/deepinsight/insightface
 *     Licence: non-commercial research only. A real deployment needs a commercial licence.
 *   MiniFASNetV2-SE anti-spoofing (98.20 checkpoint)       github.com/facenox/face-antispoof-onnx
 *     Licence: Apache-2.0.
 *
 * Run:  npx tsx scripts/fetch-face-models.ts
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "ml-models");
const PACK_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip";
const ANTISPOOF_URL = "https://raw.githubusercontent.com/facenox/face-antispoof-onnx/main/models/best/98.20/best_model.onnx";

// Filled in from the files downloaded on 22 Oct 2026; a mismatch means a changed or corrupted file.
const SHA256: Record<string, string> = {
  "det_10g.onnx": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
  "w600k_r50.onnx": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
  "2d106det.onnx": "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf",
  "antispoof_minifasv2se.onnx": "af2381b88f38769222ed93379e12444e2a50814575de1c46170de570c55a42b6",
};

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function download(url: string, to: string) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const missing = (f: string) => !existsSync(path.join(DIR, f));

  if (["det_10g.onnx", "w600k_r50.onnx", "2d106det.onnx"].some(missing)) {
    const tmp = path.join(DIR, "_download");
    mkdirSync(tmp, { recursive: true });
    const zip = path.join(tmp, "buffalo_l.zip");
    if (!existsSync(zip)) await download(PACK_URL, zip);
    // Windows 10+ and most Linux/macOS systems ship a tar that reads zip files. On Windows use the
    // system one: Git's GNU tar reads "C:" in a path as a remote host.
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xf", zip, "-C", tmp, "det_10g.onnx", "w600k_r50.onnx", "2d106det.onnx"]);
    for (const f of ["det_10g.onnx", "w600k_r50.onnx", "2d106det.onnx"]) renameSync(path.join(tmp, f), path.join(DIR, f));
    rmSync(tmp, { recursive: true, force: true });
  }
  if (missing("antispoof_minifasv2se.onnx")) await download(ANTISPOOF_URL, path.join(DIR, "antispoof_minifasv2se.onnx"));

  let ok = true;
  for (const [file, want] of Object.entries(SHA256)) {
    const got = sha(path.join(DIR, file));
    const good = got === want;
    ok &&= good;
    console.log(`${good ? "ok " : "BAD"} ${file} ${got}`);
  }
  if (!ok) {
    console.error("A model file does not match its expected checksum. Delete ml-models/ and run again.");
    process.exit(1);
  }
  console.log(`Face models ready in ${DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
