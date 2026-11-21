import { notFound } from "next/navigation";
import { Portal } from "@/components/portal";
export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.DEMO_ENABLED !== "true") notFound();
  return <Portal demo administration />;
}
