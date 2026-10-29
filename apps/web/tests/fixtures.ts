import type { IntakeInput } from "@/lib/schemas/intake";

export const SUBMISSION_ID = "3f6b2a52-8c1d-4e7a-9b0f-2d4c6e8a1b3c";
export const RUN_ID = "9a1c3e5f-7b2d-4f6a-8c0e-1d3f5a7b9c2e";

export function validIntake(overrides: Partial<IntakeInput> = {}): IntakeInput {
  return {
    company_name: "Acme Robotics",
    contact_name: "Jordan Lee",
    contact_email: "jordan@acme.example",
    service_tier: "growth",
    website: "https://acme.example",
    project_description: "We need a marketing site and a customer portal for our new product line.",
    budget_range: "15k_50k",
    timeline: "1_3_months",
    submission_id: SUBMISSION_ID,
    turnstile_token: "XXXX.DUMMY.TOKEN.XXXX",
    ...overrides,
  };
}
