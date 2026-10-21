<p align="center">
  <img src="docs/screenshots/home.jpg" alt="E-ELECTIONS home page" width="820">
</p>

<h1 align="center">E-ELECTIONS</h1>
<p align="center"><b>Every Kenyan vote, counted in the open.</b><br>
A secure biometric digital voting and real-time tallying system for Kenya.</p>

---

## Why

Kenya's elections are slow, expensive and often disputed. Voters can only vote where they registered, counting takes days, and in 2017 the Supreme Court annulled the presidential result over how results were transmitted. The 2027 General Election budget is about **KSh 74.8 billion**.

E-ELECTIONS shows how voting could be **cheaper, faster, accessible from anywhere and verifiable by anyone**, while keeping every ballot secret.

> Built by Jeremy Gachiki Nduati (16, Kenya) as a Kenya Science and Engineering Fair (KSEF) 2027 project. This is a research prototype, not an IEBC system. See [Status](#status).

## How it works

1. **Identify.** The voter enters their National ID. Anyone who has already voted is stopped here.
2. **Verify.** Face recognition (five quality-checked camera frames, compared on 128-point face descriptors) **or** the device's fingerprint sensor through WebAuthn. The fingerprint never leaves the phone.
3. **Vote from anywhere.** The voter automatically gets the ballot for their own county, constituency and ward, plus the presidential race: six seats, as in a Kenyan general election.
4. **Sealed receipt.** The ballot is stored with no name or ID, chained to the previous ballot by SHA-256 and sealed with an HMAC. The voter gets an anonymous receipt code to check later.
5. **Live results.** Results are recomputed from the verified ledger and refresh every 3 seconds, by county, constituency and ward.

Feature phones are supported too: a `*2027#` **USSD** gateway (Africa's Talking protocol, SIM-bound plus a PIN) uses the same ballot pipeline.

| Verify your receipt | Live results and chain audit |
|---|---|
| <img src="docs/screenshots/verify-receipt.jpg" alt="Receipt verification" width="400"> | <img src="docs/screenshots/live-results.jpg" alt="Live results" width="400"> |

*Screenshots use fictional test data.*

## Security highlights

- **Tamper-evident ledger:** each ballot carries the SHA-256 hash of the one before it, plus a server HMAC seal whose key never touches the database. Change, delete or reorder one ballot and the chain breaks; rewriting the whole chain is caught by the seals.
- **One voter, one ballot:** the check-and-cast happens in a single atomic database transaction, so simultaneous attempts cannot slip a second ballot through.
- **Biometrics encrypted at rest:** face templates use AES-256-GCM, bound to the voter's ID, so encrypted faces cannot be swapped between records (Kenya Data Protection Act 2019 treats biometrics as sensitive data).
- **Strict face matching:** a distance threshold of 0.45 (stricter than the usual 0.6), consistency checks across frames, and a one-to-many check so lookalikes are rejected.
- **Ballot secrecy:** the ledger holds no names or IDs, and the time a person voted is stored only to the hour.
- **Web hardening:** CSRF protection, a Content-Security-Policy, rate limiting with lockouts against brute force, and a security audit log.

Full details: [SECURITY.md](SECURITY.md).

## Tested

| Test | Result |
|---|---|
| Automated security suite (`scripts/security-test.ts`) | **21 / 21 passed** |
| Simulated election: voters registered | 70 / 70 |
| Impostor face attempts rejected | 12 / 12 (0% false accepts) |
| Double-voting attempts blocked | 30 / 30 |
| Simultaneous duplicate ballots | 10 accepted of 30 submitted (1 per voter) |
| Receipts verified against the ledger | 70 / 70 |
| Average time to vote (lookup → face → ballot → cast) | ≈ 2 seconds of server time |

Simulated results use generated 128-point face descriptors; real camera tests are done with people separately. Raw results: [`scripts/e2e-results.json`](scripts/e2e-results.json).

## Tech stack

Next.js 16 (App Router), React 19, TypeScript, MongoDB with Mongoose, `@vladmandic/face-api` (face recognition in the browser), SimpleWebAuthn (fingerprint / passkeys), `jose` (sessions), Tailwind CSS, Recharts.

## Run it locally

Requirements: Node.js 20+ and a MongoDB database (MongoDB Atlas free tier works; transactions need a replica set, which Atlas provides).

```bash
git clone https://github.com/jeremydev-c/e-elections.git
cd e-elections
npm install
cp .env.example .env.local      # then fill in MONGODB_URI and SESSION_SECRET
npm run seed                    # demo regions, candidates and an admin account
npm run dev                     # http://localhost:3000
```

Run the security tests (no database needed):

```bash
npx tsx scripts/security-test.ts
```

Face recognition and fingerprints need a secure context: use `localhost`, or an HTTPS tunnel when testing on a phone.

## Project layout

```
src/app/          pages (vote, verify, ballot, results, register, setup) and API routes
src/lib/          hash chain, ledger, biometric vault, face maths, WebAuthn, rate limiting, audit log
src/models/       MongoDB models (Voter, Candidate, VoteLedger, Election, AuditLog)
scripts/          seeding, admin reset, security tests, end-to-end election test
public/models/    face-api model weights
data/             Kenya counties, constituencies and wards
```

## Status

E-ELECTIONS is a **prototype for research and demonstration**, built for KSEF 2027. It is not affiliated with or approved by the IEBC, and it should not be used for binding public elections without independent security audits, legal approval and a pilot programme. Small elections (school councils, clubs, associations) are the next step.

## Contributing and security reports

Ideas, issues and pull requests are welcome. If you find a security weakness, please read [SECURITY.md](SECURITY.md) and report it privately first.

## License

[GNU AGPL-3.0](LICENSE). You may use, study and modify E-ELECTIONS, but if you run a modified version as a service you must publish your source code too. Election software should stay open.

## Author

**Jeremy Gachiki Nduati**: self-taught developer from Kenya.
