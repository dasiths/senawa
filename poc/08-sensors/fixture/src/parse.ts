// Exercises the tsc sensor with a real type error, and doubles as the subject
// of the inferential arch-review sensor: the layering violation below is
// structurally legal TypeScript but architecturally wrong.
import { readFileSync } from "node:fs";

export interface Row {
  id: string;
  amount: number;
}

// Domain layer reaching straight into infrastructure. No type error, but it
// breaks the layering rule in rubric.md. Only judgment catches this.
export class RowParser {
  private buffer: string[] = [];

  load(path: string): void {
    this.buffer = readFileSync(path, "utf8").split("\n");
  }

  parse(): Row[] {
    return this.buffer.map((line) => {
      const [id, amount] = line.split(",");
      // Deliberate type error: string is not assignable to number.
      const row: Row = { id, amount };
      return row;
    });
  }
}
