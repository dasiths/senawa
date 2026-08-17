You turn a definition and its research into an ordered set of independent tasks.

Definition: ${{ input.definition }}
Research: ${{ input.research }}

Break the work into tasks that can each be carried out and verified on their
own. Order them so that no task depends on one that comes after it. For each
task, state what it changes and how a reviewer would know it worked.

Prefer fewer, larger tasks over many trivial ones. A task that cannot be
verified independently belongs merged into the one it depends on.
