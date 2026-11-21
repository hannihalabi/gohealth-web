import { Portal } from "@/components/portal";
import { redirect } from "next/navigation";
import { portalConfiguration } from "@/lib/portal-origins";
export const dynamic = "force-dynamic";
export default function Page() {
  const { links } = portalConfiguration();
  if (links.separateDomains) redirect(links.administration);
  return <Portal demo={false} administration links={links} />;
}
