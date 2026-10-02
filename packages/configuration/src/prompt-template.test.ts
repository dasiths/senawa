import { describe, expect, it } from "vitest";
import {
  canonicalPromptInputPaths,
  PROMPT_TEMPLATE_LIMITS,
  PromptTemplateError,
  parsePromptTemplate,
  validatePromptTemplateInputs,
} from "./prompt-template.js";

describe("v1 prompt templates", () => {
  it("extracts canonical distinct input paths while retaining repeated tokens", () => {
    const parsed = parsePromptTemplate(
      "Use ${{ input.request }} then ${{\tinput.plan.tasks }} and ${{ input.request }}.",
    );

    expect(parsed.inputPaths).toEqual(["/plan/tasks", "/request"]);
    expect(parsed.tokens.map(({ pointer }) => pointer)).toEqual([
      "/request",
      "/plan/tasks",
      "/request",
    ]);
    expect(validatePromptTemplateInputs(parsed, ["/request", "/plan/tasks"])).toEqual([
      "/plan/tasks",
      "/request",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.tokens)).toBe(true);
  });

  it.each([
    "${{ input }}",
    "${{ output.value }}",
    "${{ input.items[0] }}",
    "${{ input.value() }}",
    "${{ input.value || fallback }}",
    "${{ input.value\n}}",
    "${{ input.9value }}",
    "${{ input.value",
  ])("rejects forbidden token syntax %s", (template) => {
    expect(() => parsePromptTemplate(template)).toThrow(PromptTemplateError);
  });

  it("rejects stale, duplicate, and noncanonical declarations", () => {
    const parsed = parsePromptTemplate("${{ input.request }}");

    expect(() => validatePromptTemplateInputs(parsed, [])).toThrow(/exactly match/u);
    expect(() => validatePromptTemplateInputs(parsed, ["/request", "/unused"])).toThrow(
      /exactly match/u,
    );
    expect(() => canonicalPromptInputPaths(["/request", "/request"])).toThrow(/duplicated/u);
    expect(() => canonicalPromptInputPaths(["request"])).toThrow(/canonical JSON Pointer/u);
    expect(() => canonicalPromptInputPaths(["/bad~2escape"])).toThrow(/canonical JSON Pointer/u);
  });

  it("accepts the token bound and rejects one token over", () => {
    const token = "${{ input.value }}";
    expect(parsePromptTemplate(token.repeat(PROMPT_TEMPLATE_LIMITS.maxTokens)).tokens).toHaveLength(
      PROMPT_TEMPLATE_LIMITS.maxTokens,
    );
    expect(() => parsePromptTemplate(token.repeat(PROMPT_TEMPLATE_LIMITS.maxTokens + 1))).toThrow(
      /cannot contain more/u,
    );
  });
});
