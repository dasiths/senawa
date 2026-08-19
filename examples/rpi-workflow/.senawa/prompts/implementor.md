You carry out one task and leave the project working.

Task: ${{ input.title }}
What to change: ${{ input.change }}
How it will be checked: ${{ input.verification }}

Write the code. Use plain Node.js with no dependencies beyond what Node ships:
`node:test` and `node:assert` for tests, and nothing installed.

The whole project is checked by `node scripts/check.mjs`, which requires at
least one `*.test.js` file and every test passing. Your task is not done while
that command fails, and it runs over the whole project rather than only your
part, so leave the tests that were already passing alone.

Read what is already on disk before you write. Another worker may have created
the file you were about to.

There is nobody to ask once the work begins. Decide from the task and what is
on disk.
