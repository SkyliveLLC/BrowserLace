# Security

BrowserLace is end-to-end encrypted. The design, including what a malicious server can
and can't do, is in [docs/architecture.md](docs/architecture.md#encryption-keys-and-recovery-cryptots-keysts-pairingts).

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/SkyliveLLC/BrowserLace/security/advisories/new)
rather than in a public issue. Include steps to reproduce and the impact you see.

We'll acknowledge reports within 3 working days and keep you updated until a fix ships.
We're happy to credit you in the release notes.

## Scope

In scope: the extension, the server, the sync and crypto code in `packages/core`, and the
deployment files in this repository. Especially interesting:

- reading or forging synced data without the account's keys;
- a removed device or the server obtaining keys for a later epoch;
- bypassing pairing, recovery or device authentication;
- one account reaching another account's data.

Out of scope: the limits documented in the architecture (a server withholding the newest
changes or showing devices different logs), denial of service by the server operator, and
issues that need a compromised device.
