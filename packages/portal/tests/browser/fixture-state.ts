import { test } from "@playwright/test";
import { controlOrigin } from "./support.js";

/**
 * Attaches what the shared fixture had been through when a test failed.
 *
 * Three full suite runs failed three different tests, each of which passed when
 * run alone. That is interference between tests, and the report said nothing
 * about it: a failure named an assertion and a screenshot, and the reader had to
 * reason backwards about what an earlier test might have done. Three fixes aimed
 * at the symptom were wrong for exactly that reason.
 *
 * The suite shares one service, one database, and two runs. The fixture now
 * reports the mutations it has taken, so a failure carries the history that
 * produced it instead of inviting a guess.
 */
export function reportFixtureStateOnFailure(): void {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    try {
      const response = await fetch(`${controlOrigin}/fixture-state`);
      const body = await response.text();
      await testInfo.attach("shared-fixture-state", {
        body,
        contentType: "application/json",
      });
    } catch (error) {
      await testInfo.attach("shared-fixture-state", {
        body: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
        contentType: "text/plain",
      });
    }
  });
}
