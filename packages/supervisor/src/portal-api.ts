import type {
  PortalAllowanceReview,
  PortalArtifactContent,
  PortalArtifactMetadata,
  PortalArtifactPage,
  PortalDeliveryPage,
  PortalEventWindow,
  PortalGraphEdgePage,
  PortalGraphNodePage,
  PortalGraphSummary,
  PortalHumanNeedPage,
  PortalImmutableRecord,
  PortalIntegrationPage,
  PortalQuestionPage,
  PortalQuestionRecord,
  PortalReceiptWindow,
  PortalRecordKind,
  PortalRepositoryPage,
  PortalRunOverview,
  PortalRunPage,
  PortalWorkspacePage,
} from "@senawa/protocol";

export interface PortalArtifactDownload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly digest: string;
}

export interface PortalQueryPort {
  listRepositories(after?: string, limit?: number): PortalRepositoryPage;
  listRuns(repositoryId: string, after?: string, limit?: number): PortalRunPage;
  getRunOverview(repositoryId: string, runId: string): PortalRunOverview | undefined;
  getGraphSummary(repositoryId: string, runId: string): PortalGraphSummary | undefined;
  listDeliveryRecords(
    repositoryId: string,
    runId: string,
    after?: number,
    limit?: number,
  ): PortalDeliveryPage;
  listGraphNodes(
    repositoryId: string,
    runId: string,
    graphRevision: string,
    after?: number,
    limit?: number,
  ): PortalGraphNodePage;
  listGraphEdges(
    repositoryId: string,
    runId: string,
    graphRevision: string,
    after?: number,
    limit?: number,
  ): PortalGraphEdgePage;
  getImmutableRecord(
    repositoryId: string,
    runId: string,
    kind: PortalRecordKind,
    digest: string,
  ): PortalImmutableRecord | undefined;
  getAllowanceReview(
    repositoryId: string,
    runId: string,
    escalationCommandId: string,
  ): PortalAllowanceReview | undefined;
  listHumanNeeds(
    repositoryId: string,
    runId: string,
    after?: string,
    limit?: number,
  ): PortalHumanNeedPage;
  listQuestions(
    repositoryId: string,
    runId: string,
    after?: string,
    limit?: number,
  ): PortalQuestionPage;
  getQuestion(
    repositoryId: string,
    runId: string,
    submissionId: string,
  ): PortalQuestionRecord | undefined;
  listArtifacts(
    repositoryId: string,
    runId: string,
    after?: string,
    limit?: number,
  ): PortalArtifactPage;
  getArtifact(
    repositoryId: string,
    runId: string,
    artifactId: string,
  ): PortalArtifactMetadata | undefined;
  readArtifactContent(
    repositoryId: string,
    runId: string,
    artifactId: string,
    offset: number,
    length: number,
  ): PortalArtifactContent | undefined;
  downloadArtifact(
    repositoryId: string,
    runId: string,
    artifactId: string,
  ): PortalArtifactDownload | undefined;
  listWorkspaces(
    repositoryId: string,
    runId: string,
    after?: string,
    limit?: number,
  ): PortalWorkspacePage;
  listIntegrations(
    repositoryId: string,
    runId: string,
    after?: string,
    limit?: number,
  ): PortalIntegrationPage;
  listReceiptWindow(
    repositoryId: string,
    runId: string,
    query?: { readonly after?: number; readonly before?: number; readonly limit?: number },
  ): PortalReceiptWindow;
  listEventWindow(
    repositoryId: string,
    runId: string,
    query?: { readonly after?: number; readonly before?: number; readonly limit?: number },
  ): PortalEventWindow;
}

export class PortalApiError extends Error {
  readonly status: number;
  readonly code: "not-found" | "invalid-request" | "service-unavailable";

  constructor(code: PortalApiError["code"], status: number, message: string) {
    super(message);
    this.name = "PortalApiError";
    this.code = code;
    this.status = status;
  }
}

export class PortalApi {
  readonly query: PortalQueryPort;

  constructor(query: PortalQueryPort) {
    this.query = query;
  }

  required<Value>(value: Value | undefined, subject: string): Value {
    if (value === undefined) throw new PortalApiError("not-found", 404, `${subject} was not found`);
    return value;
  }
}
