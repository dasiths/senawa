import { test } from "@playwright/test";
import { controlOrigin } from "./support.js";

/**
 * Reports what the shared fixture had been through, and puts it back.
 *
 * Three full suite runs failed three different tests, each of which passed when
 * run alone. That is interference between tests, and the report said nothing
 * about it: a failure named an assertion and a screenshot, and the reader had to
 * reason backwards about what an earlier test might have done. Three fixes aimed
 * at the symptom were wrong for exactly that reason.
 *
 * The suite shares one service, one database, and two runs. A failure now
 * carries the mutations that produced it, and the session clock — the one
 * mutation that only ever moved forward — is reset so a test that expires a
 * session cannot expire every session after it.
 */
export function isolateSharedFixture(): void {
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      try {
        const response = await fetch(`${controlOrigin}/fixture-state`);
        await testInfo.attach("shared-fixture-state", {
          body: await response.text(),
          contentType: "application/json",
        });
      } catch (error) {
        await testInfo.attach("shared-fixture-state", {
          body: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
          contentType: "text/plain",
        });
      }
    }
    await fetch(`${controlOrigin}/reset-fixture`, { method: "POST" });
  });
}
