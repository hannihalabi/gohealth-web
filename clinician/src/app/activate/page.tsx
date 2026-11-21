import { Activation } from "@/components/activation";
import { PasswordRecovery } from "@/components/password-recovery";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { portalConfiguration, portalSurface } from "@/lib/portal-origins";
export const dynamic = "force-dynamic";
export const metadata = { title: "GoHealth · Aktivera din åtkomst" };
export default async function Page({ searchParams }: {
  searchParams: Promise<{
    code?: string | string[];
    sb_flow_id?: string | string[];
    reset?: string | string[];
    error_code?: string | string[];
  }>;
}) {
  const config = portalConfiguration();
  const { code, sb_flow_id: flowId, reset, error_code: errorCode } = await searchParams;
  const invalidEmailLink = errorCode === "otp_expired";
  if (config.links.separateDomains && portalSurface((await headers()).get("host"), config) !== "administration") {
    const target = new URL(config.links.activation);
    if (invalidEmailLink) {
      target.searchParams.set("error_code", "otp_expired");
    } else {
      if (typeof code === "string" && code.length <= 2048) target.searchParams.set("code", code);
      if (typeof flowId === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(flowId)) target.searchParams.set("sb_flow_id", flowId);
      if (reset === "1" || reset === "link" || reset === "change") target.searchParams.set("reset", reset);
    }
    redirect(target.toString());
  }
  if (invalidEmailLink || reset === "link" || (reset === "1" && !code)) {
    return <PasswordRecovery account={null} loading={false} links={config.links}
      invalidEmailLink={invalidEmailLink} openLink={!invalidEmailLink && reset === "link"} />;
  }
  return <Activation links={config.links} />;
}
