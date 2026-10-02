import type { PortalHumanNeed } from "@senawa/protocol";

export const QUESTION_OVERDUE_MS = 60_000;
export const PORTAL_TITLE = "Senawa Portal";
const ATTENTION_TITLE_PREFIX = "\u25cf Answer needed \u2014 ";
/** Display ceiling so a long-abandoned question can never grow an unbounded label. */
const MAX_ELAPSED_HOURS = 99;

export interface QuestionAttention {
  readonly need: PortalHumanNeed;
  readonly waitedMs: number;
  readonly label: string;
  readonly overdue: boolean;
}

/** The oldest unanswered question, ordered deterministically for a stable banner. */
export function pendingQuestionNeed(
  needs: readonly PortalHumanNeed[],
): PortalHumanNeed | undefined {
  return needs
    .filter((need) => need.kind === "question")
    .toSorted((left, right) =>
      left.createdAt === right.createdAt
        ? compareCodeUnits(left.needId, right.needId)
        : compareCodeUnits(left.createdAt, right.createdAt),
    )
    .at(0);
}

/** Code-unit ordering so the banner never depends on the viewer's locale. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function questionAttention(
  need: PortalHumanNeed | undefined,
  now: number,
): QuestionAttention | undefined {
  if (need === undefined) return undefined;
  const waitedMs = waited(need.createdAt, now);
  return Object.freeze({
    need,
    waitedMs,
    label: elapsedLabel(waitedMs),
    overdue: waitedMs >= QUESTION_OVERDUE_MS,
  });
}

export function elapsedLabel(waitedMs: number): string {
  const seconds = Math.floor(Math.max(0, waitedMs) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  if (hours > MAX_ELAPSED_HOURS) return `Waiting over ${MAX_ELAPSED_HOURS}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `Waiting ${hours}h ${pad(minutes)}m ${pad(remainder)}s`;
  if (minutes > 0) return `Waiting ${minutes}m ${pad(remainder)}s`;
  return `Waiting ${remainder}s`;
}

export function attentionTitle(pending: boolean): string {
  return pending ? `${ATTENTION_TITLE_PREFIX}${PORTAL_TITLE}` : PORTAL_TITLE;
}

function waited(createdAt: string, now: number): number {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, now - parsed);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
