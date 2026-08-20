# Command latency

Every `senawa status` takes about four seconds. Driving a run from the terminal
means running it repeatedly, so this is most of what waiting on a run feels
like. Nothing had measured where the time goes, so this does.

All numbers are from one devcontainer against the `rpi-workflow` example's own
record, with one live agent working, so treat them as proportions rather than
absolutes. The proportions are lopsided enough that the noise does not matter.

## What a command costs

```text
senawa status                        4166 ms
  process start (bare node)            17 ms
  module load (whole CLI imported)    ~200 ms
  new SqliteAuthority                2470 ms
  new SqliteContextBroker             415 ms
  everything else                    ~1060 ms
```

Process start and module load are together about five per cent. Opening the
record is sixty per cent. Whatever the command was asked to do is almost
irrelevant beside opening the thing it reads.

## Where opening the record goes

`SqliteAuthority`'s constructor verifies the whole database and then loads it.
Broken down:

```text
new SqliteAuthority                  2470 ms
  verifyDatabase                     1539 ms
    fromCanonicalJson                 964 ms
    verifyAmendmentTables             386 ms
    verifyContextTables               132 ms
    verifyNormalizedSnapshot           30 ms
    quick_check                         3 ms
    foreign_key_check                   0 ms
    every other table check           ~15 ms
    verifyAssetBytes (all assets)       2 ms
  fromCanonicalJson, a second time    847 ms
  IncrementalCanonicalSnapshot         14 ms
```

Two things stand out.

**The state is parsed twice.** `verifyDatabase` builds an `InMemoryAuthority`
from the canonical JSON to check it, then the constructor immediately does it
again to keep. That is 1811 ms of the 2470 ms — seventy-three per cent of
opening the record — spent producing the same object twice and throwing one
away.

**Verification is not free and runs on every open.** `verifyDatabase` is an
integrity check over the entire database. It is also what `senawa integrity
check` is for, as a deliberate act. Paying it to read a status line is a choice
nobody made on purpose.

## The size that produces those numbers

```text
database file                        3.62 MiB
authority_state.canonical_json       0.47 MiB
context_authority_state.canonical_json 0.17 MiB
context_dispatches                        9 rows
context_submissions                      16 rows
runner_events                            24 rows
amendment_work_fences                     6 rows
agent_transcript_lines                   65 rows
```

Nine dispatches. Six amendment rows. This is a small record by any measure, and
opening it costs two and a half seconds.

`verifyAmendmentTables` spends 386 ms on six rows — sixty-four milliseconds per
row. Half a megabyte of JSON takes 964 ms to turn into an authority, where
`JSON.parse` alone would take single-digit milliseconds. The cost is not the
volume of data; it is the work done per item, and it is roughly two thousand
times what reading the bytes costs.

## How it scales

Opening four records of different sizes:

```text
  21 KiB state    233 ms
  57 KiB state    307 ms
  57 KiB state    298 ms
 482 KiB state   2209 ms
```

Close to linear in the size of the authority state, at roughly 4.5 ms per KiB
above a fixed base of about fifty milliseconds. That is about four and a half
seconds per megabyte, every time anything opens the record.

The consequence worth stating plainly: a run's own progress makes every
subsequent command slower, because the state a run accumulates is the state each
command re-reads and re-verifies from the beginning. The example run reached
half a megabyte in three phases.

## What follows from this

In the order the measurements justify:

* Parse the canonical state once per open. The second parse is thirty-five per
  cent of opening the record and produces a value identical to the first.
* Decide deliberately whether reading requires verifying. A reader that never
  writes does not obviously need to re-verify the whole database first, and
  there is already a command whose job is to verify on request.
* Look at `verifyAmendmentTables` before the others. Sixty-four milliseconds for
  one row is out of proportion with every other check, and the shape of that is
  usually a digest recomputed inside a loop.
* Nothing here points at process start, module loading, SQLite itself, or the
  assets. Those are measured and small, and are not worth touching.

## Method

`senawa status` was timed with `time` against the example's record. The phases
inside were measured by temporarily writing timings to stderr from
`verifyDatabase` and from the `SqliteAuthority` constructor, behind an
environment variable, then removing them. Scaling was measured by opening four
separate records and reporting the wall time of the constructor alone.

Repeating this needs the same instrumentation again. It was not kept, because a
timing hook that nothing reads is a thing to maintain rather than a measurement,
and the numbers above are the record.
