import type { Sha256 } from "@senawa/kernel";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationResourceReadError, type ConfigurationResourceReader } from "./contracts.js";
import {
  CONFIGURATION_RESOURCE_LIMITS,
  ConfigurationResourceValidationError,
  parseStrictJsonResource,
  readConfigurationTextResource,
  validateConfigurationResourcePath,
} from "./resources.js";

const sha256: Sha256 = { digest: (bytes) => bytes.byteLength.toString(16).padStart(64, "0") };

describe("v1alpha3 configuration resources", () => {
  it.each([
    ["prompt", "prompts/role.md"],
    ["schema", "schemas/task-input.schema.json"],
  ] as const)("accepts a confined %s path", (kind, path) => {
    expect(validateConfigurationResourcePath(kind, path)).toBe(path);
  });

  it.each([
    ["prompt", "/prompts/role.md"],
    ["prompt", "prompts/../role.md"],
    ["prompt", "prompts\\role.md"],
    ["prompt", "C:/prompts/role.md"],
    ["prompt", "https://example.test/role.md"],
    ["prompt", "prompts/%2e%2e/role.md"],
    ["prompt", "prompts/role.txt"],
    ["schema", "prompts/task.schema.json"],
    ["schema", "schemas/task.json"],
  ] as const)("rejects non-confined %s path %s before I/O", (kind, path) => {
    expect(() => validateConfigurationResourcePath(kind, path)).toThrow(
      ConfigurationResourceValidationError,
    );
  });

  it("accepts exact path and segment bounds and rejects one over", () => {
    const exactPath = `prompts/${Array(7).fill("a".repeat(128)).join("/")}/${"b".repeat(110)}.md`;
    expect(new TextEncoder().encode(exactPath)).toHaveLength(
      CONFIGURATION_RESOURCE_LIMITS.maxPathBytes,
    );
    expect(validateConfigurationResourcePath("prompt", exactPath)).toBe(exactPath);
    expect(() => validateConfigurationResourcePath("prompt", `${exactPath}x`)).toThrow(
      /byte limit/u,
    );

    const exactSegment = `prompts/${"a".repeat(125)}.md`;
    expect(validateConfigurationResourcePath("prompt", exactSegment)).toBe(exactSegment);
    expect(() =>
      validateConfigurationResourcePath("prompt", `prompts/${"a".repeat(126)}.md`),
    ).toThrow(/invalid segment/u);

    const exactSegments = `prompts/${Array(30).fill("a").join("/")}/a.md`;
    expect(exactSegments.split("/")).toHaveLength(CONFIGURATION_RESOURCE_LIMITS.maxPathSegments);
    expect(validateConfigurationResourcePath("prompt", exactSegments)).toBe(exactSegments);
    expect(() =>
      validateConfigurationResourcePath("prompt", `prompts/${Array(31).fill("a").join("/")}/a.md`),
    ).toThrow(/too many segments/u);
  });

  it("loads copied exact UTF-8 bytes and passes the kind-specific bound", async () => {
    const source = new TextEncoder().encode("Use ${{ input.request }}\n");
    const read = vi.fn(async () => source);
    const resource = await readConfigurationTextResource(
      { read },
      "prompt",
      "prompts/role.md",
      sha256,
    );
    source.fill(0);

    expect(read).toHaveBeenCalledWith({
      kind: "prompt",
      path: "prompts/role.md",
      maxBytes: CONFIGURATION_RESOURCE_LIMITS.maxPromptBytes,
    });
    expect(resource.utf8).toBe("Use ${{ input.request }}\n");
    expect(resource.byteLength).toBe(25);
  });

  it.each([
    [Uint8Array.of(0xc3, 0x28), "invalid-resource-utf8"],
    [new TextEncoder().encode("bad\0text"), "invalid-resource-utf8"],
  ] as const)("rejects invalid textual bytes", async (bytes, code) => {
    await expect(
      readConfigurationTextResource({ read: async () => bytes }, "prompt", "prompts/a.md", sha256),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    ["prompt", "prompts/exact.md", CONFIGURATION_RESOURCE_LIMITS.maxPromptBytes],
    ["schema", "schemas/exact.schema.json", CONFIGURATION_RESOURCE_LIMITS.maxSchemaBytes],
  ] as const)("accepts exact %s bytes and rejects one over", async (kind, path, maximum) => {
    await expect(
      readConfigurationTextResource(
        { read: async () => new TextEncoder().encode(" ".repeat(maximum)) },
        kind,
        path,
        sha256,
      ),
    ).resolves.toMatchObject({ byteLength: maximum });
    await expect(
      readConfigurationTextResource(
        { read: async () => new TextEncoder().encode(" ".repeat(maximum + 1)) },
        kind,
        path,
        sha256,
      ),
    ).rejects.toMatchObject({ code: "resource-read-failed", detail: "too-large" });
  });
  it("maps typed adapter failures without exposing adapter text", async () => {
    const reader: ConfigurationResourceReader = {
      read: async () => {
        throw new ConfigurationResourceReadError("symlink", "/host/secret/path");
      },
    };
    await expect(
      readConfigurationTextResource(reader, "schema", "schemas/a.schema.json", sha256),
    ).rejects.toMatchObject({ code: "resource-read-failed", detail: "symlink" });
  });

  it("parses exact JSON and rejects duplicate members at any depth", () => {
    expect(parseStrictJsonResource('{"$schema":"x","properties":{"ok":true}}').value).toEqual({
      $schema: "x",
      properties: { ok: true },
    });
    expect(() => parseStrictJsonResource('{"properties":{"x":1,"x":2}}')).toThrowError(
      expect.objectContaining({ code: "duplicate-json-member", detail: "/properties/x" }),
    );
    expect(() => parseStrictJsonResource("{} trailing")).toThrow(/trailing content/u);
  });
});
