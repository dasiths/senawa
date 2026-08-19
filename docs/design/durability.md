# Durability

Senawa keeps all authority in one SQLite database plus one content-addressed
asset directory. Both are local files. There is no server, no cache tier, and no
second writer.

`CURRENT_SCHEMA_VERSION` is `1`, declared in
[packages/storage-sqlite/src/index.ts](../../packages/storage-sqlite/src/index.ts).
Opening a database whose `user_version` exceeds that value throws
`UnsupportedSchemaVersionError` rather than proceeding against an unknown shape.

## Connection configuration

Every writable connection applies the same pragmas:

```text
busy_timeout      = configured, default 5000 ms
journal_mode      = WAL
synchronous       = FULL
wal_autocheckpoint= 16384 pages
foreign_keys      = ON
trusted_schema    = OFF
```

Read-only paths open with `readonly` and `fileMustExist`, then add
`query_only = ON`. The restore verification connection opens writable but
`query_only`, and sets `journal_mode = DELETE` so verifying a staged copy leaves
no WAL sidecar next to it.

`synchronous = FULL` with WAL is the durability choice that matters. A commit is
not acknowledged until the write-ahead log entry is on stable storage, which is
what lets the recovery guarantees below hold across a power loss rather than only
a process kill.

## Migrations

Migrations are ordered SQL files in
[packages/storage-sqlite/migrations](../../packages/storage-sqlite/migrations).
One exists:

| Version | File | Schema family |
|---------|------|---------------|
| 1 | `001-baseline.sql` | Every table: core authority, runner authority, immutable context, local control plane, amendments, capacity and workspaces, human authority, portal read revisions, remote delivery, phase dataflow, task frontier, phase output attempts, and agent transcripts |

Thirteen migrations preceded it. They were collapsed once v1 settled its protocol
identifiers, because a chain exists to carry an installed base forward and v1 has
none. The baseline was produced by applying the chain and dumping the result, so
it is the schema the chain built rather than a transcription of it, and it
carries the seed rows the runtime requires at startup.

Application is checked, not assumed. `loadMigrations` reads every file matching
`^\d{3}-[a-z0-9-]+\.sql$` in sorted order, computes its SHA-256 checksum, and
refuses a non-digest result. Each migration runs in its own immediate
transaction that re-reads `user_version`, skips anything at or below the locked
version, executes the SQL, inserts a `migration_metadata` row recording version,
name, and checksum, and sets `user_version`. Two concurrent openers therefore
cannot double-apply.

`verifyMigrationMetadata` compares the stored rows against the packaged
checksums in version order. A mismatch throws `SQLite migration metadata does not
match packaged migration checksums`. An edited or substituted migration file is
detected rather than silently accepted.

## Content addressing

Two things are content-addressed, in different places.

Authority records are content-addressed logically. Every kernel record carries a
digest over its own canonical content: `candidateDigest`, `closureDigest`,
`evaluationDigest`, `proposalDigest`, `attemptDigest`, `bindingDigest`, and so
on. Those digests live in SQLite columns and are how one record references
another. A reference either matches the exact content or does not match.

Asset bytes are content-addressed physically. `putAsset` computes the SHA-256 of
the bytes and stores them at:

```text
<assetDirectory>/sha256/<first two hex characters>/<full digest>
```

The write is staged and verified before it is visible:

* Bytes are written to `<assetDirectory>/.staging/<uuid>` opened `wx` with mode
  `0600`, then fsynced.
* The staged file is hard-linked to its final path, and the parent directory is
  fsynced. An `EEXIST` means the content already exists, and the existing bytes
  are verified against the descriptor rather than overwritten.
* The staging entry is unlinked and the staging directory is fsynced.
* The destination bytes are verified against the descriptor again.
* Only then does the `assets` row commit.

Bytes therefore exist on disk before any row can name them. The reverse order
would allow a committed descriptor to point at nothing.

Quotas are enforced inside the same transaction: a per-object ceiling of 256 MiB,
a default of 10,000 objects, and a default total of 1 GiB, from
`ASSET_SECURITY_LIMITS`.

The canonical JSON asset store, `SqliteCanonicalJsonAssetStore`, is a thin
adapter over the same mechanism. It canonicalizes a value, installs its bytes,
and returns a descriptor of content digest and byte length. That is how phase
outputs, evidence, and context payloads become addressable.

## Transaction boundaries

Every authority mutation follows one shape:

```text
BEGIN IMMEDIATE
  read the exact prior state
  validate or decide
  write records
COMMIT             (or ROLLBACK on any error)
```

`BEGIN IMMEDIATE` takes the write lock at statement one rather than upgrading
later, so two writers conflict immediately instead of after doing work. Every
mutation method wraps its body in `try` and calls `ROLLBACK` when
`database.inTransaction` is still true.

Three consequences follow.

A kernel decision and the records it produced commit together. A receipt never
becomes durable without the facts it was derived from.

Idempotency is a read inside the transaction, not a lock outside it. A replayed
insert compares the stored canonical row against the new one and returns
`replayed` when they match, or throws a conflict when they differ. The phase
output acceptance path in
[packages/storage-sqlite/src/index.ts](../../packages/storage-sqlite/src/index.ts)
is a direct example: a publication already accepted by a different closure is
refused, an identical acceptance is skipped, and the method reports `created` or
`replayed`.

Compare-and-swap is expressible. Plan import records an evaluation against an
expected prior evaluation digest and returns `conflict` when another evaluator
won.

## Crash recovery guarantees

Recovery is asserted at named points rather than hoped for. `SqliteFaultPoint`
and `SupervisorFaultPoint` enumerate every position where a test can kill the
process:

* Command path: `before-command-commit`, `after-command-commit-before-ack`,
  `after-command-execution`, `after-queued-commit-before-ack`,
  `after-claim-commit-before-execute`,
  `after-command-submit-before-terminal-ack`, `before-terminal-commit`,
  `after-terminal-commit-before-ack`.
* Asset path: `after-asset-stage`, `after-asset-install`,
  `before-asset-descriptor-commit`, `after-asset-descriptor-commit-before-ack`.
* Amendment path: `after-amendment-fences`, `after-amendment-application`.
* Paging: `after-receipt-page-metadata-read`, `after-event-page-metadata-read`.
* Restore: `after-restore-asset-partial-create`,
  `after-restore-database-partial-create`, `after-restore-assets-publish`,
  `after-restore-database-publish`.

The guarantees these establish:

* A command either has a committed terminal receipt or does not. A crash after
  commit but before acknowledgement is resolved by re-reading the receipt on
  retry, because submission is idempotent by command identity.
* A crash between queue and execution leaves a `claimed` row whose lease expires.
  The next owner takes a higher fence and drives the command to terminal. The
  previous owner cannot commit afterwards.
* An effect is never committed without a persisted intent, and an intent whose
  outcome is unknown stays in the reconcilable set until inspection or settlement
  resolves it.
* An asset descriptor never names absent bytes, because installation precedes
  the descriptor commit and verification happens on both sides.
* A partially created restore leaves the live database and asset directory
  untouched. Restore writes to `.restore.partial-<uuid>` and
  `.publish.partial-<uuid>` paths and publishes by hard link, and the cleanup
  path removes only objects whose device and inode still match the ones this
  invocation created.

What recovery does not do is repair. `senawa repair plan` permits only restoring
a verified backup to a fresh state root. It refuses evidence deletion, history
truncation, digest recalculation, accounting rewrite, synthetic outcomes, and
in-place restore. See the [CLI reference](../reference/cli.md).

## Backup

`SqliteAuthority.backup` produces a self-describing bundle:

* Asserts the destination does not overlap the live database or asset directory.
* Creates a `.partial-<uuid>` directory.
* Runs `wal_checkpoint(PASSIVE)`, then the SQLite online backup API into
  `authority.db`, then fsyncs it.
* Opens the copy read-only and runs full verification, including asset bytes.
* Copies the asset set.
* Writes `manifest.json` describing format `senawa-sqlite-backup`, version 1, the
  database relative path, byte length and digest, and every asset descriptor.

The CLI composes that with the SDK session store. `backupSupervisorState` in
[apps/senawa/src/state-backup.ts](../../apps/senawa/src/state-backup.ts) runs
inside a quiescence proof: it asserts the service is drained, stops the SDK
client, asserts drained again, writes `sqlite/` and `sdk/` subtrees, writes a
`senawa-supervisor-state` version 1 manifest listing every file with byte length
and digest, verifies the partial bundle, publishes it atomically, and verifies
the published bundle again.

A repeated request with the same request identity returns the already verified
result. Any other existing destination is refused.

Bounds are explicit: at most 10,000 files, 10,000 directories, 1 GiB per file,
1 GiB total, a 4 MiB manifest, 1,024-byte paths, and 256 path segments.

## Restore

`restoreSqliteAuthority` verifies before it writes anything:

* The backup root and its `assets` directory must be real directories, not
  symbolic links.
* `authority.db` byte length and digest must match the manifest.
* The database opens read-only and passes full verification.
* The asset descriptors read from the database must equal the manifest's asset
  list exactly.

Only then does it stage. Assets are copied into an asset partial directory, the
database is copied with `COPYFILE_EXCL`, fsynced, verified again through a
separate verification connection, copied once more to a publication partial, and
published by `linkSync` into place after re-asserting that the destinations are
still fresh.

Every created path is captured with its device and inode. Failure cleanup removes
only paths whose identity still matches, so a concurrent process that replaced a
path does not lose its file to Senawa's rollback.

Publication uses pathname-based Node filesystem APIs. That means it cannot
prevent a hostile process from swapping an ancestor directory between the final
identity check and the path-based create. Descriptor-relative publication is not
part of the v1 contract, and the [CLI reference](../reference/cli.md) states the
same limit.

## Integrity verification

`checkSqliteAuthorityIntegrity` opens the live database read-only and query-only
and runs `verifyDatabase`, which performs:

* `quick_check(1)` and `foreign_key_check`.
* Migration metadata comparison against packaged checksums.
* Rehydration of the canonical authority singleton through
  `InMemoryAuthority.fromCanonicalJson`, which reparses and revalidates the
  entire authority state.
* Cross-checks of the normalized projections against that canonical state.
* Per-family verification of context, phase dataflow, task frontier, amendment,
  parallel workspace, human authority, portal revision, supervisor, and remote
  delivery tables.
* Byte verification of every asset against its descriptor.

The report is deliberately narrow. `SqliteIntegrityReport` contains a format, a
version, an overall status, and one check per category from
`SQLITE_INTEGRITY_CATEGORIES`: `storage`, `structure`, `migrations`,
`canonical-authority`, `normalized-projections`, `context-and-runner`,
`amendments`, `workspaces`, `human-authority`, `portal`, `supervisor`,
`remote-delivery`, `assets`. Each check is `passed`, `failed`, or `not-checked`
with a stable code.

The categories are ordered, and a failure marks earlier categories `passed`, the
failing one `failed`, and later ones `not-checked`. A reader learns how far
verification got without learning anything about the contents. No SQL rows,
canonical payloads, internal paths, stack traces, or exception text appear in the
report.

`checkSqliteAuthorityBackupIntegrity` verifies a bundle without touching the
live database. It refuses a symbolic link or non-directory source, copies the
bundle into a temporary directory with `errorOnExist`, verifies the copy, and
removes the temporary tree.

## How this is proven

* Migration application, checksum verification, and version refusal: [packages/storage-sqlite/tests/storage-sqlite.test.ts](../../packages/storage-sqlite/tests/storage-sqlite.test.ts).
* Transaction boundaries, idempotent replay, and conflict detection: [packages/storage-sqlite/tests/storage-sqlite.test.ts](../../packages/storage-sqlite/tests/storage-sqlite.test.ts)
  and [packages/testing/src/authority-port-conformance.test.ts](../../packages/testing/src/authority-port-conformance.test.ts).
* Fault-point crash recovery convergence: [packages/supervisor/src/command-queue.test.ts](../../packages/supervisor/src/command-queue.test.ts)
  and [packages/supervisor/src/service.test.ts](../../packages/supervisor/src/service.test.ts).
* Content-addressed asset staging, verification, and quotas: [packages/storage-sqlite/tests/storage-sqlite.test.ts](../../packages/storage-sqlite/tests/storage-sqlite.test.ts).
* Integrity report categories, ordering, and information limits: [packages/storage-sqlite/tests/integrity-report.test.ts](../../packages/storage-sqlite/tests/integrity-report.test.ts).
* Backup creation, verification, restore, and refusal paths: [apps/senawa/src/state-backup.test.ts](../../apps/senawa/src/state-backup.test.ts)
  and [apps/senawa/src/maintenance.test.ts](../../apps/senawa/src/maintenance.test.ts).
* Operational maintenance commands end to end: [apps/senawa/src/operational-maintenance.test.ts](../../apps/senawa/src/operational-maintenance.test.ts).
* Human authority and remote delivery table verification: [packages/storage-sqlite/tests/human-authority.test.ts](../../packages/storage-sqlite/tests/human-authority.test.ts)
  and [packages/storage-sqlite/tests/remote-delivery.test.ts](../../packages/storage-sqlite/tests/remote-delivery.test.ts).
* Packaged migration inventory in an installed package: [scripts/test-packaging.mjs](../../scripts/test-packaging.mjs).
