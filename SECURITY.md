# Security

E-ELECTIONS is election software, so it is built on the assumption that people will try to break it. This document explains the protections, their limits and how to report a problem.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private report instead: the **Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it and the impact. You'll get a reply as soon as possible, and credit if you'd like it.

## Threat model in brief

| Threat | Protection |
|---|---|
| Someone votes as another person | Two-step verification: National ID, then face (strict 1:1 match **and** 1:N lookalike check) or a WebAuthn fingerprint bound to the voter's own device |
| A photo, a phone screen or a pre-recorded video held up to the camera | **Active liveness check**: the server picks a random order of moves (turn left, turn right, blink) for every face scan, sealed in a 90-second, single-use token, and checks the camera frames itself: head turned the requested way, eyes shut, one person throughout. A passive anti-spoofing model scores every scan as well |
| A voter votes twice | ID check before verification, a second check at face login, and an atomic database transaction at the moment of casting |
| Ballots are changed, deleted or reordered in the database | SHA-256 hash chain from a genesis hash; anyone can verify it |
| An attacker rewrites the whole chain consistently | Every ballot and the chain head carry an HMAC seal using `LEDGER_SECRET`, a key kept outside the database |
| Stolen database exposes faces | Face templates and photos are encrypted with AES-256-GCM using `BIOMETRIC_KEY`, kept outside the database |
| Swapping one voter's encrypted face into another record | The voter's National ID is the authenticated data of each encrypted blob, so a swapped blob fails to decrypt |
| Linking a ballot to a voter | The ledger stores no name, ID or phone number; voting times are stored only to the hour; receipts are random codes |
| Brute-forcing PINs, IDs or face logins | Rate limiting with lockouts, plus audit-log entries for every failure |
| Cross-site request forgery and injected scripts | Same-origin checks on state-changing requests, a strict Content-Security-Policy, `X-Frame-Options: DENY`, body-size limits |
| Ballots for the wrong region | The server checks every selection against the voter's own county, constituency and ward |

## How the ledger works

Each ballot is serialised deterministically (sequence number, receipt code, sorted selections, county, timestamp and the previous ballot's hash), then:

```
currentHash = SHA-256(canonical ballot)
seal        = HMAC-SHA-256(LEDGER_SECRET, currentHash)
```

The first ballot links to a fixed genesis hash. Verifying the ledger means recomputing every hash and seal in order: one changed character anywhere breaks every link after it. Voters can check that their own receipt is in the chain, and the results page can run a full chain audit.

## Liveness (anti-spoofing)

1. `POST /api/auth/voter/liveness` issues a challenge: one of 6 random orders of *turn left, turn right, blink*, inside a signed token (90-second lifetime, bound to the voter's ID, usable once).
2. The browser (MediaPipe Face Landmarker) guides the voter and captures three frontal frames, then one frame at the peak of each move. It only guides: nothing it measures is trusted.
3. `POST /api/auth/voter/face` redeems the token and checks the frames on the server (`src/lib/faceScan.ts`): exactly one clear, well-lit face in every frame; the frontal frames are one person; each turn frame shows the head turned the requested way (nose position between the eyes, from the detector's 5 keypoints); the blink frame shows the eyes shut (eye opening from 106 landmarks, below 60% of this voter's own open eyes); every move frame is the same person as the frontal frames.
4. A passive anti-spoofing model (MiniFASNetV2-SE, Apache-2.0) scores the frontal frames for printed photos and screens. Its score is recorded on every scan; it only blocks scans when `FACE_ANTISPOOF=enforce`, because it has not yet been calibrated on real phone and laptop cameras (on recompressed video it flags real faces).

Failures count towards the same lockout as failed face matches, and are written to the audit log as `LIVENESS_FAILED`.

## Biometrics

- Face recognition runs **on the server** (`src/lib/faceEngine.ts`, ONNX Runtime): SCRFD-10GF finds the face and 5 keypoints, a similarity transform aligns it to the standard 112×112 ArcFace template, and ArcFace ResNet-50 (WebFace600K) produces a 512-number identity vector. A template is the average of three frontal frames plus the frames themselves. Matching uses cosine similarity: at least 0.40 to the claimed voter, and no other voter within 0.08 of that.
- The three frontal frames are each read twice, as taken and mirrored, and the two vectors averaged (flip averaging): on LFW this raised true accepts at the threshold from 98.90% to 99.07% with no impostor closer.
- Templates learn: a login at least 0.60 similar adds that scan to the voter's template (at most 4 learned frames, the most redundant one replaced), so the template copes with new lighting, glasses or a haircut. Learned frames only count towards the "closest frame" half of the score; the registration average always makes up the other half and never changes, so the template cannot drift to someone else (tested in `scripts/security-test.ts`).
- Measured on LFW (`scripts/benchmark-lfw.ts`, official 10-fold protocol): 99.85% verification accuracy; the most similar impostor pair of 3,000 scored 0.242, so the 0.40 threshold has a wide margin. InsightFace reports 90.3% true accepts on African faces at a one-in-a-million false-accept rate for this model, against 69.5% for the small mobile model.
- **1:N checks use an in-memory face index** (`src/lib/faceIndex.ts`). The server keeps each voter's average face vector in memory as 8-bit numbers (512 bytes per voter), searches the **entire** register on all CPU cores at once (worker threads sharing the memory), then decrypts only the 10 closest full templates and compares them exactly. One million voters: about 0.2 s and 0.5 GB on a laptop. Logins search the index as it is while it refreshes in the background; registrations wait for it to be fully up to date. This is used to block one face registering under two IDs and to reject a login when another voter matches as well as the claimed one. There is no cap on register size; the index catches up with new registrations every 2 seconds and rebuilds itself if voters are deleted. The vectors live only in server memory, never in the database unencrypted.
- Fingerprints use **WebAuthn**: the fingerprint stays on the voter's device, and the server only sees a signed challenge.
- Biometric data is "sensitive personal data" under Kenya's Data Protection Act 2019. Any real deployment needs informed consent (parental consent for minors), a data-protection impact assessment and registration with the Office of the Data Protection Commissioner.

## Keys and configuration

Set these in `.env.local` (never commit it; see `.env.example`):

- `SESSION_SECRET`: signs session cookies (32+ random characters)
- `LEDGER_SECRET`: HMAC key for ballot seals
- `BIOMETRIC_KEY`: AES-256-GCM key for face data
- `APP_ORIGIN`: pins the WebAuthn origin in production instead of trusting the `Host` header

Changing `LEDGER_SECRET` or `BIOMETRIC_KEY` after an election has started makes existing seals or faces unreadable.

## Known limitations

This is a prototype. Before any binding election it would need:

- an **independent security audit** and penetration test;
- **certified liveness detection** (ISO/IEC 30107). The moves are now checked by the server from the frames, which stops photos, screens and replayed videos held to the camera. But nothing proves the frames came from a real camera at that moment: an attacker who can generate convincing frames of the victim (for example a deepfake doing the moves) could send them directly. Certified systems add capture attestation and light-reflection challenges (the screen flashes random colours that must show up on the face);
- **licensed face models**: the InsightFace detection and recognition weights are free for non-commercial research only (fine for this project); a real deployment needs a commercial licence or models trained on licensed data;
- calibrating the passive anti-spoofing model on real voters' cameras before enforcing it;
- protection against a compromised voter device (malware on the phone or browser);
- a distributed rate limiter and liveness-token store (the current ones are per server instance);
- for a national register (22 million), the face index split across a few servers: one laptop-class server would need about 11 GB and 4-5 s per search;
- operational procedures: key ceremonies, backups, observers and legal approval.

## Tests

```bash
npx tsx scripts/security-test.ts      # 34 offline checks: seals, tamper attacks, encryption, face decisions, template learning, 8-bit index, liveness tokens, CSRF
LFW_DIR=... npx tsx scripts/face-engine-test.ts   # 13 checks on real photos: every way a face scan must be refused, real matching
LFW_DIR=... npx tsx scripts/benchmark-lfw.ts      # accuracy on the LFW benchmark
```

`scripts/e2e-election-test.ts` runs a full simulated election against a server on an isolated test database and writes [`scripts/e2e-results.json`](scripts/e2e-results.json).
