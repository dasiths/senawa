import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalStringify } from "@senawa/protocol";
import { assertSecretSafePositiveProjection } from "@senawa/reporting";
import type { PortalAsset, PortalAssetSource } from "@senawa/supervisor";

const MANIFEST_VERSION = "senawa.dev/portal-assets/v1";
const PACKAGED_MANIFEST_PATH = fileURLToPath(
  new URL("../dist/portal/manifest.json", import.meta.url),
);
export const MAX_PORTAL_STATIC_BYTES = 64 * 1024 * 1024;
export const MAX_PORTAL_MANIFEST_BYTES = 1024 * 1024;
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".woff2", "font/woff2"],
]);

interface PortalManifestEntry {
  readonly name: string;
  readonly path: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly contentType: string;
}

interface PortalManifest {
  readonly apiVersion: typeof MANIFEST_VERSION;
  readonly shell: string;
  readonly assets: readonly PortalManifestEntry[];
}

export interface PortalManifestReadHooks {
  readonly afterInitialStat?: (path: string) => void;
}

export function loadPortalAssetSource(
  manifestPath: string,
  readHooks: PortalManifestReadHooks = {},
): PortalAssetSource {
  const absoluteManifest = requireRegularUnsymlinkedPath(resolve(manifestPath));
  const root = dirname(absoluteManifest);
  if (realpathSync(root) !== root) throw new Error("Portal asset root must be canonical");
  const manifestText = readBoundedManifest(absoluteManifest, readHooks);
  assertSecretSafePositiveProjection(manifestText, "Portal package inventory");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error("Portal asset manifest must contain canonical JSON");
  }
  if (canonicalStringify(parsed) !== manifestText) {
    throw new Error("Portal asset manifest must use canonical JSON encoding");
  }
  const manifest = decodeManifest(parsed);
  const assets = new Map<string, PortalAsset>();
  const paths = new Set<string>();
  for (const entry of manifest.assets) {
    if (assets.has(entry.name) || paths.has(entry.path)) {
      throw new Error("Portal asset manifest entries must be unique");
    }
    const expectedContentType = contentTypeFor(entry.path);
    if (entry.contentType !== expectedContentType) {
      throw new Error("Portal asset manifest content type does not match its extension");
    }
    const path = resolve(root, entry.path);
    if (!isWithinRoot(root, path)) throw new Error("Portal asset path escapes its canonical root");
    requireNoSymlinkPath(root, path);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("Portal assets must be unique regular files");
    }
    const bytes = Uint8Array.from(readFileSync(path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== entry.byteLength || digest !== entry.digest) {
      throw new Error("Portal asset bytes do not match the generated manifest");
    }
    assets.set(
      entry.name,
      Object.freeze({
        name: entry.name,
        digest,
        byteLength: bytes.byteLength,
        contentType: entry.contentType,
        bytes,
      }),
    );
    paths.add(entry.path);
  }
  const shell = assets.get(manifest.shell);
  if (shell === undefined || shell.contentType !== "text/html; charset=utf-8") {
    throw new Error("Portal asset manifest shell must name one verified HTML entry");
  }
  return Object.freeze({
    shell: () => shell,
    asset: (name: string) => (name === manifest.shell ? undefined : assets.get(name)),
  });
}

export function optionalPortalAssetSource(
  environment: NodeJS.ProcessEnv,
): PortalAssetSource | undefined {
  const configuredPath = environment.SENAWA_PORTAL_MANIFEST;
  const manifestPath =
    configuredPath === undefined || configuredPath.length === 0
      ? PACKAGED_MANIFEST_PATH
      : configuredPath;
  try {
    return loadPortalAssetSource(manifestPath);
  } catch {
    return undefined;
  }
}

function decodeManifest(value: unknown): PortalManifest {
  const object = exactObject(value, "manifest", ["apiVersion", "shell", "assets"]);
  if (object.apiVersion !== MANIFEST_VERSION)
    throw new Error("Portal asset manifest version is invalid");
  const shell = assetName(object.shell, "manifest shell");
  if (!Array.isArray(object.assets) || object.assets.length === 0 || object.assets.length > 64) {
    throw new Error("Portal asset manifest must contain 1-64 assets");
  }
  const assets = object.assets.map((value, index): PortalManifestEntry => {
    const entry = exactObject(value, `manifest asset ${index}`, [
      "name",
      "path",
      "digest",
      "byteLength",
      "contentType",
    ]);
    const name = assetName(entry.name, `manifest asset ${index} name`);
    const path = relativeAssetPath(entry.path, `manifest asset ${index} path`);
    if (typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/u.test(entry.digest)) {
      throw new Error("Portal asset manifest digest is invalid");
    }
    if (
      typeof entry.byteLength !== "number" ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > 16_777_216
    ) {
      throw new Error("Portal asset manifest byte length is invalid");
    }
    if (typeof entry.contentType !== "string") {
      throw new Error("Portal asset manifest content type is invalid");
    }
    return Object.freeze({
      name,
      path,
      digest: entry.digest,
      byteLength: entry.byteLength,
      contentType: entry.contentType,
    });
  });
  const totalBytes = assets.reduce((total, entry) => total + entry.byteLength, 0);
  if (totalBytes > MAX_PORTAL_STATIC_BYTES) {
    throw new Error("Portal asset manifest aggregate byte length is invalid");
  }
  return Object.freeze({ apiVersion: MANIFEST_VERSION, shell, assets: Object.freeze(assets) });
}

function exactObject(
  value: unknown,
  subject: string,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`);
  }
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !fields.includes(field))
  ) {
    throw new Error(`${subject} fields are invalid`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assetName(value: unknown, subject: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) {
    throw new Error(`${subject} is invalid`);
  }
  return value;
}

function relativeAssetPath(value: unknown, subject: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`${subject} is invalid`);
  }
  return value;
}

function contentTypeFor(path: string): string {
  const extension = [...CONTENT_TYPES.keys()].find((candidate) => path.endsWith(candidate));
  const contentType = extension === undefined ? undefined : CONTENT_TYPES.get(extension);
  if (contentType === undefined) throw new Error("Portal asset type is not allowed");
  return contentType;
}

function requireRegularUnsymlinkedPath(path: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("Portal asset manifest must be a unique regular file");
  }
  if (realpathSync(path) !== path) throw new Error("Portal asset manifest path must be canonical");
  return path;
}

function readBoundedManifest(path: string, hooks: PortalManifestReadHooks): string {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const initial = fstatSync(descriptor);
    if (!initial.isFile() || initial.nlink !== 1 || initial.size > MAX_PORTAL_MANIFEST_BYTES) {
      throw new Error("Portal asset manifest exceeds its byte limit");
    }
    hooks.afterInitialStat?.(path);
    const bytes = Buffer.allocUnsafe(MAX_PORTAL_MANIFEST_BYTES + 1);
    let total = 0;
    while (total <= MAX_PORTAL_MANIFEST_BYTES) {
      const count = readSync(descriptor, bytes, total, bytes.byteLength - total, null);
      if (count === 0) {
        const final = fstatSync(descriptor);
        if (!final.isFile() || final.nlink !== 1 || final.size !== total) {
          throw new Error("Portal asset manifest changed while it was read");
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
      }
      total += count;
    }
    throw new Error("Portal asset manifest exceeds its byte limit");
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Portal asset manifest must contain valid UTF-8", { cause: error });
    }
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function requireNoSymlinkPath(root: string, path: string): void {
  const relativePath = relative(root, path);
  let current = root;
  for (const component of relativePath.split(sep)) {
    current = resolve(current, component);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error("Portal asset paths must not contain symlinks");
  }
  if (realpathSync(path) !== path) throw new Error("Portal asset path must be canonical");
}

function isWithinRoot(root: string, path: string): boolean {
  const value = relative(root, path);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
