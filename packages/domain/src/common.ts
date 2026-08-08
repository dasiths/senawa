import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const NonEmptyStringSchema = z.string().trim().min(1);
export const RelativePathSchema = NonEmptyStringSchema.refine(
  (value) => !value.startsWith("/") && !value.split(/[\\/]/u).includes(".."),
  "Expected a repository-relative path without parent traversal",
);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.string().datetime({ offset: true });

export type JsonObject = z.infer<typeof JsonObjectSchema>;

export function matchesPathPattern(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized.includes("*")) return path === normalized || path.startsWith(`${normalized}/`);
  const expression = normalized
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${expression}$`, "u").test(path);
}
