import { accessSync, constants } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

export function resolveExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    assertExecutable(executable, platform);
    return executable;
  }
  const pathEnvironment = Reflect.get(environment, "PATH");
  const pathValue = typeof pathEnvironment === "string" ? pathEnvironment : "";
  const pathExtEnvironment = Reflect.get(environment, "PATHEXT");
  const pathExtValue =
    typeof pathExtEnvironment === "string" ? pathExtEnvironment : ".EXE;.CMD;.BAT;.COM";
  const extensions = platform === "win32" ? pathExtValue.split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(
        directory,
        platform === "win32" && extname(executable) === ""
          ? `${executable}${extension}`
          : executable,
      );
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  throw new Error(
    `Copilot CLI was not found on PATH. Set SENAWA_COPILOT_CLI to its absolute executable path.`,
  );
}

function assertExecutable(path: string, platform: NodeJS.Platform): void {
  if (!isExecutable(path, platform)) {
    throw new Error(`Copilot CLI is not executable at ${path}`);
  }
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
