import type {
  WorkerExecutionPort,
  WorkerHostResolverPort,
  WorkerModelCatalogEntry,
  WorkerModelCatalogPort,
  WorkerPreflightRequest,
  WorkerSessionPlan,
  WorkerSessionPort,
} from "@senawa/application";
import type { WorkerHostIdentity, WorkerHostKind } from "@senawa/domain";

type ResolvableWorkerHost = WorkerExecutionPort &
  Partial<WorkerSessionPort> &
  Partial<WorkerModelCatalogPort> & { shutdown?: () => Promise<void> };

export type WorkerHostFactory = () => ResolvableWorkerHost;

export class LazyWorkerHostResolver implements WorkerHostResolverPort {
  private readonly hosts = new Map<WorkerHostKind, ResolvableWorkerHost>();

  constructor(private readonly factories: Partial<Record<WorkerHostKind, WorkerHostFactory>>) {}

  async resolve(identity: WorkerHostIdentity): Promise<WorkerExecutionPort> {
    return this.host(identity.kind);
  }

  async preflight(
    identity: WorkerHostIdentity,
    requests: readonly WorkerPreflightRequest[],
  ): Promise<readonly WorkerSessionPlan[]> {
    const host = this.host(identity.kind);
    const describe = host.describe?.bind(host);
    const negotiate = host.negotiate?.bind(host);
    if (describe === undefined || negotiate === undefined) {
      throw new Error(`Worker host ${identity.kind} does not support readiness preflight`);
    }
    const descriptor = await describe();
    if (descriptor.name !== identity.adapter || descriptor.version !== identity.adapterVersion) {
      throw new Error(
        `Worker host ${identity.kind} resolved ${descriptor.name}@${descriptor.version}, expected ${identity.adapter}@${identity.adapterVersion}`,
      );
    }
    const catalog = host.listModels === undefined ? undefined : await host.listModels();
    const plans: WorkerSessionPlan[] = [];
    for (const request of requests) {
      try {
        plans.push(await negotiate(request));
      } catch (error) {
        throw new Error(preflightFailure(request, catalog, error), { cause: error });
      }
    }
    return plans;
  }

  async listModels(identity: WorkerHostIdentity): Promise<readonly WorkerModelCatalogEntry[]> {
    const host = this.host(identity.kind);
    if (host.listModels === undefined) {
      throw new Error(`Worker host ${identity.kind} does not provide model discovery`);
    }
    return (await host.listModels()).slice(0, 100);
  }

  async shutdown(): Promise<void> {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(hosts.map((host) => host.shutdown?.()));
  }

  private host(kind: WorkerHostKind): ResolvableWorkerHost {
    const current = this.hosts.get(kind);
    if (current !== undefined) return current;
    const factory = this.factories[kind];
    if (factory === undefined) throw new Error(`Worker host ${kind} is not configured`);
    const created = factory();
    this.hosts.set(kind, created);
    return created;
  }
}

function preflightFailure(
  request: WorkerPreflightRequest,
  catalog: readonly WorkerModelCatalogEntry[] | undefined,
  error: unknown,
): string {
  const requested = request.requestedModel;
  const available =
    catalog
      ?.map((model) => model.id)
      .slice(0, 20)
      .join(", ") || "unavailable";
  const model = catalog?.find((candidate) => candidate.id === requested.id);
  const effort =
    requested.effort === undefined
      ? "default"
      : `${requested.effort} (${requested.effortMode ?? "required"})`;
  const supportedEfforts = model?.supportedEfforts.join(", ") || "unavailable";
  const detail = error instanceof Error ? error.message : String(error);
  return `Worker preflight failed for role ${request.role}: requested model ${requested.id}, effort ${effort}; selectable models: ${available}; supported efforts: ${supportedEfforts}; ${detail}`;
}
