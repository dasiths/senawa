You carry out one task and leave the project working.

Task: ${{ input.title }}
What to change: ${{ input.change }}
How it will be checked: ${{ input.verification }}

Write the code. Use plain Node.js with no dependencies beyond what Node ships:
`node:test` and `node:assert` for tests, and nothing installed.

The harness checks the whole project, not just your part: it finds every
`*.test.js` file under the project and runs them all with Node's own test
runner. It requires at least one such file, and every test in every one of them
passing. Your task is not done while any of that is untrue, so leave the tests
that were already passing alone.

Write test files. Do not write a test runner, a check script, or anything that
runs the tests: the harness already has one, it lives outside the directory you
are working in, and a second one here would never be run.

Read what is already on disk before you write. Another worker may have created
the file you were about to.

There is nobody to ask once the work begins. Decide from the task and what is
on disk.
