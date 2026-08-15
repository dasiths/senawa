import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(packageRoot, "src");
const svgNamespace = ["ht", "tp://www.w3.org/2000/svg"].join("");
const svgNamespaceFiles = ["graph-diagram.ts"];
const forbidden = [
  "inner" + "HTML",
  "outer" + "HTML",
  "insertAdjacent" + "HTML",
  "src" + "doc",
  "ev" + "al(",
  "new " + "Function",
  ".sty" + "le",
  "service" + "Worker",
];

describe("portal static hostile-rendering policy", () => {
  it("keeps production browser sources free of active-content sinks", () => {
    const files = readdirSync(sourceRoot)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(sourceRoot, name));
    const findings: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbidden)
        if (content.includes(pattern)) findings.push(`${file}: ${pattern}`);
      if (content.includes(svgNamespace) && !svgNamespaceFiles.includes(basename(file)))
        findings.push(`${file}: unexpected namespace literal`);
      if (/https?:\/\//u.test(content.split(svgNamespace).join("")))
        findings.push(`${file}: external network literal`);
    }
    const shell = readFileSync(resolve(packageRoot, "index.html"), "utf8");
    expect(shell).not.toMatch(/<style|\sstyle=|\son[a-z]+=/iu);
    expect(shell.match(/<script/giu)).toHaveLength(1);
    expect(shell).toMatch(/<script type="module" src="\/src\/main\.ts"><\/script>/u);
    expect(findings).toEqual([]);
  });
});
