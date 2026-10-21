# Security

E-ELECTIONS is election software, so it is built on the assumption that people will try to break it. This document explains the protections, their limits and how to report a problem.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private report instead: the **Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it and the impact. You'll get a reply as soon as possible, and credit if you'd like it.

## Threat model in brief

| Threat | Protection |
|---|---|
| Someone votes as another person | Two-step verification: National ID, then face (strict 1:1 match **and** 1:N lookalike check) or a WebAuthn fingerprint bound to the voter's own device |
| A photo, a phone screen or a pre-recorded video held up to the camera | **Active liveness check**: the server picks a random order of moves (turn left, turn right, blink) for every face login, sealed in a 90-second, single-use token; the face is only matched if the recorded moves are real, in that order, at human speed, and done by the same face |
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
2. The browser guides the voter through the moves, recording head yaw and eye aspect ratio about 15 times a second, plus one face descriptor during each move.
3. `POST /api/auth/voter/face` redeems the token and checks the evidence (`src/lib/liveness.ts`): every move present, in the issued order, starting from a frontal pose (so an angled photo fails), eyes going open → closed → open against the voter's own baseline, no move faster than a human can do it, and each move's descriptor close to the frontal reading (so one person can't do the moves while another's photo is matched).

Failures count towards the same lockout as failed face matches, and are written to the audit log as `LIVENESS_FAILED`.

## Biometrics

- Face recognition runs **in the browser** (face-api), producing 128-number descriptors from several quality-checked frames. Matching uses Euclidean distance with a threshold of 0.45, a consistency limit across frames, and an impostor margin over every other enrolled face.
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
- **certified liveness detection** (ISO/IEC 30107). The current check runs in the browser, so it stops photos, screens and replayed videos, but a determined attacker who rewrites the web page's code could send fabricated telemetry. Production systems verify liveness from the video itself on the server or in a certified SDK;
- protection against a compromised voter device (malware on the phone or browser);
- a distributed rate limiter (the current one is per server instance);
- operational procedures: key ceremonies, backups, observers and legal approval.

## Tests

```bash
npx tsx scripts/security-test.ts      # 33 offline checks: seals, tamper attacks, encryption, face decisions, liveness, CSRF
```

`scripts/e2e-election-test.ts` runs a full simulated election against a server on an isolated test database and writes [`scripts/e2e-results.json`](scripts/e2e-results.json).
