import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const SENAWA_DIRECTORY = ".senawa";
export const SENAWA_SKILL_PATH = ".agents/skills/senawa/SKILL.md";

export async function findRepositoryRoot(startPath: string): Promise<string> {
  let current = resolve(startPath);
  while (true) {
    try {
      await access(resolve(current, SENAWA_DIRECTORY));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`No ${SENAWA_DIRECTORY} directory found from ${resolve(startPath)}`);
      }
      current = parent;
    }
  }
}
