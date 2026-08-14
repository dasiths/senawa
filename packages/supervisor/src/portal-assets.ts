export interface PortalAsset {
  readonly name: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface PortalAssetSource {
  shell(): PortalAsset | undefined;
  asset(name: string): PortalAsset | undefined;
}

export const PORTAL_CONTENT_SECURITY_POLICY =
  "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'none'";
