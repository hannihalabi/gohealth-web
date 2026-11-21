import { Portal } from "@/components/portal";
import { headers } from "next/headers";
import { portalConfiguration, portalSurface } from "@/lib/portal-origins";
export async function generateMetadata() {
  const config = portalConfiguration();
  const administration = portalSurface((await headers()).get("host"), config) === "administration";
  return { title: administration ? "GoHealth · Administration" : "GoHealth · Vårdportalen" };
}
export default async function Page() {
  const config = portalConfiguration();
  const administration = portalSurface((await headers()).get("host"), config) === "administration";
  return <Portal demo={false} administration={administration} links={config.links} />;
}
