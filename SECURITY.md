# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's
private vulnerability reporting:
<https://github.com/chrisswanson/archer/security/advisories/new>. Include the Archer version
(`archer --version`), the platform, and the steps that show the problem. Only the maintainers see
the report. You should get an answer within a week.

## Supported versions

Fixes go into the latest release. Archer runs as a local service on your machine; the reviewed
platform is Linux with `/proc` mounted.

## What is already known

- [`docs/security/known-limits.md`](docs/security/known-limits.md): limits Archer keeps on purpose,
  what an attacker needs and what they get.
- [`docs/security/advisories.md`](docs/security/advisories.md): the policy for dependency
  advisories (how fast each severity is decided and fixed) and one dated decision per advisory.
