import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SupervisorHttpHandler } from "./http-handler.js";
import {
  acquireUnixSocketLock,
  prepareUnixSocketBindingPath,
  prepareUnixSocketPath,
  publishUnixSocket,
  releaseUnixSocketLock,
  secureUnixSocket,
  type UnixSocketIdentity,
  unlinkUnixSocketIfSame,
} from "./local-security.js";

export type SupervisorHttpServerFaultPoint = "afterPrivateBindBeforePublish";

export interface SupervisorHttpServerStartOptions {
  readonly fault?: (point: SupervisorHttpServerFaultPoint) => void;
}

export interface SupervisorHttpServerHandle {
  readonly server: Server;
  readonly socketPath?: string;
  readonly origin?: string;
  close(): Promise<void>;
}

export async function startUnixSupervisorServer(
  socketPath: string,
  handler: SupervisorHttpHandler,
  options: SupervisorHttpServerStartOptions = {},
): Promise<SupervisorHttpServerHandle> {
  const lock = acquireUnixSocketLock(socketPath);
  const server = hardenedServer(handler);
  let preparedPath = lock.socketPath;
  let bindingPath: string | undefined;
  let socketIdentity: UnixSocketIdentity | undefined;
  try {
    preparedPath = await prepareUnixSocketPath(lock.socketPath, lock);
    bindingPath = await prepareUnixSocketBindingPath(lock);
    await listen(server, { path: bindingPath });
    socketIdentity = secureUnixSocket(bindingPath);
    options.fault?.("afterPrivateBindBeforePublish");
    publishUnixSocket(bindingPath, preparedPath, socketIdentity);
  } catch (error) {
    try {
      if (server.listening) await closeServer(server);
      else server.close();
    } finally {
      if (bindingPath !== undefined && socketIdentity !== undefined) {
        unlinkUnixSocketIfSame(bindingPath, socketIdentity);
      }
      if (socketIdentity !== undefined) unlinkUnixSocketIfSame(preparedPath, socketIdentity);
      releaseUnixSocketLock(lock);
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    server,
    socketPath: preparedPath,
    close: () => {
      closePromise ??= closeServer(server).finally(() => {
        if (bindingPath !== undefined && socketIdentity !== undefined) {
          unlinkUnixSocketIfSame(bindingPath, socketIdentity);
        }
        if (socketIdentity !== undefined) unlinkUnixSocketIfSame(preparedPath, socketIdentity);
        releaseUnixSocketLock(lock);
      });
      return closePromise;
    },
  });
}

export async function startLoopbackSupervisorServer(
  port: number,
  createHandler: (origin: string) => SupervisorHttpHandler,
): Promise<SupervisorHttpServerHandle> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Loopback port must be an integer from 0 to 65535");
  }
  let handler: SupervisorHttpHandler | undefined;
  const dispatch = (
    request: Parameters<SupervisorHttpHandler["handle"]>[0],
    response: Parameters<SupervisorHttpHandler["handle"]>[1],
  ) => {
    if (handler === undefined) {
      response.destroy();
      return;
    }
    void handler.handle(request, response);
  };
  const server = createServer(dispatch);
  handleExpectations(server, dispatch);
  harden(server);
  await listen(server, { host: "127.0.0.1", port });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await closeServer(server);
    throw new Error("Supervisor loopback server did not bind exactly to 127.0.0.1");
  }
  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  handler = createHandler(origin);
  return Object.freeze({ server, origin, close: () => closeServer(server) });
}

function hardenedServer(handler: SupervisorHttpHandler): Server {
  const dispatch = (
    request: Parameters<SupervisorHttpHandler["handle"]>[0],
    response: Parameters<SupervisorHttpHandler["handle"]>[1],
  ) => void handler.handle(request, response);
  const server = createServer(dispatch);
  handleExpectations(server, dispatch);
  harden(server);
  return server;
}

function handleExpectations(
  server: Server,
  dispatch: (
    request: Parameters<SupervisorHttpHandler["handle"]>[0],
    response: Parameters<SupervisorHttpHandler["handle"]>[1],
  ) => void,
): void {
  server.on("checkContinue", dispatch);
  server.on("checkExpectation", dispatch);
}

function harden(server: Server): void {
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
}

function listen(
  server: Server,
  options: { readonly path: string } | { readonly host: string; readonly port: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
