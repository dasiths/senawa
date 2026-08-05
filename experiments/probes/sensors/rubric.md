# Architecture rubric for the `arch-review` inferential sensor

The layering rules for this codebase, outermost to innermost:
`api`, `application`, `domain`, `infrastructure`.

Dependency direction and type errors are already checked by deterministic
sensors. **Do not re-check them.** Judge only what a tool cannot settle:

1. **Right layer, not merely legal layer.** A type can be syntactically fine
   and still sit in the wrong layer for its responsibility.
2. **Persistence ignorance.** Domain types must not perform or assume I/O,
   including through method shapes or naming, even with no forbidden import.
3. **Abstraction worth its weight.** Flag abstractions that add ceremony
   without buying anything.

Report findings against the rule number they break. A sensor reports; it does
not adjudicate. Do not decide whether a violation is acceptable.
