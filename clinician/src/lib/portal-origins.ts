export type PortalLinks = {
  clinical: string;
  administration: string;
  activation: string;
  separateDomains: boolean;
};
export const localPortalLinks: PortalLinks = {
  clinical: "/",
  administration: "/admin",
  activation: "/activate",
  separateDomains: false,
};
type Environment = { APP_ORIGIN?: string; ADMIN_ORIGIN?: string };
function configuredOrigin(value: string) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) throw new Error("Invalid portal origin configuration");
  return url;
}
export function portalConfiguration(environment: Environment = {
  APP_ORIGIN: process.env.APP_ORIGIN,
  ADMIN_ORIGIN: process.env.ADMIN_ORIGIN,
}) {
  const clinical = configuredOrigin(environment.APP_ORIGIN || "http://127.0.0.1:3040");
  const administration = configuredOrigin(environment.ADMIN_ORIGIN || clinical.origin);
  const separateDomains = clinical.origin !== administration.origin;
  // A Host header cannot distinguish two protocols on the same host.
  if (separateDomains && clinical.host === administration.host)
    throw new Error("Portal hosts must be distinct");
  return {
    clinical,
    administration,
    links: {
      clinical: clinical.origin + "/",
      administration: administration.origin + (separateDomains ? "/" : "/admin"),
      activation: administration.origin + "/activate",
      separateDomains,
    } satisfies PortalLinks,
  };
}
type Configuration = ReturnType<typeof portalConfiguration>;
export function portalSurface(host: string | null, config: Configuration) {
  const normalized = host?.toLowerCase();
  if (normalized === config.clinical.host)
    return config.links.separateDomains ? "clinical" : "shared";
  if (normalized === config.administration.host) return "administration";
  return "unknown";
}
export function surfaceAllowsPath(host: string | null, path: string, config: Configuration) {
  const surface = portalSurface(host, config);
  if (surface === "unknown") return false;
  if (surface === "shared") return true;
  if (path === "/api/admin" || path === "/api/activation")
    return surface === "administration";
  if (path === "/api/clinical" || path.startsWith("/api/clinical/"))
    return surface === "clinical";
  return true;
}
export function allowsPortalWrite(
  host: string | null, origin: string | null, path: string, config: Configuration,
) {
  if (!surfaceAllowsPath(host, path, config)) return false;
  const expected = portalSurface(host, config) === "administration"
    ? config.administration.origin : config.clinical.origin;
  // Bind the full Origin to this host, rather than allowing either sibling origin.
  return origin === expected;
}
