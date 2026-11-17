# Known failures: root cause and remediation

Keep the application in a known, error-free state. Every failure seen in any run (CI, `npm run
pr-check`, a focused test, a manual check) is investigated to its root cause and remediated, whether
or not the current work caused it. A test is never skipped, loosened or deleted to make it pass
unless the investigation shows the test itself is wrong; that reasoning is recorded here.

One row per failure, added before its fix is pushed. Ids continue from the earlier record (O1–O274,
kept from development before the public release and not published; code comments and CHANGELOG
entries that cite an O-number refer to it), so new rows start at **O275**. Link the row's issue or PR where there is one.

Status: open → investigating → fixed (commit) / environment (what the host needs) / accepted (with reason).

| # | Failure | Seen | Status |
|---|---|---|---|
