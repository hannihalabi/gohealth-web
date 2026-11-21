import { z } from "zod";

export const pipelineRequest = z
  .object({ action: z.literal("pipeline"), organizationId: z.uuid() })
  .strict();
export const pipelineDecision = z
  .discriminatedUnion("kind", [
    z.object({
      action: z.literal("pipelineDecision"),
      organizationId: z.uuid(),
      kind: z.literal("signup"),
      id: z.uuid(),
      decision: z.enum(["approve", "reject"]),
      revision: z.number().int().positive(),
      identityAttested: z.boolean().default(false),
    }).strict(),
    z.object({
      action: z.literal("pipelineDecision"),
      organizationId: z.uuid(),
      kind: z.literal("application"),
      id: z.uuid(),
      decision: z.enum(["handled", "dismissed"]),
      revision: z.number().int().positive(),
      identityAttested: z.boolean().default(false),
    }).strict(),
  ]);
export type PipelineDecision = z.infer<typeof pipelineDecision>;
export type PipelineSignup = {
  id: string;
  display_name: string;
  identity_label: string;
  created_at: string;
  revision: number;
};
export type PipelineApplication = {
  id: string;
  name: string;
  email: string;
  message: string | null;
  created_at: string;
  revision: number;
};
export type PipelineData = {
  registered: number;
  signupTotal: number;
  signups: PipelineSignup[];
  applicationTotal: number;
  applications: PipelineApplication[];
  weeks: { week: string; registered: number }[];
};
