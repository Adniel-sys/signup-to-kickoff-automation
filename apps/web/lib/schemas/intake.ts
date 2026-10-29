import { z } from "zod";

/**
 * Intake form schema, shared by the /onboard form (client-side validation)
 * and /api/onboard (server-side validation). The server is the source of
 * truth; the client copy only gives faster inline errors.
 */

export const SERVICE_TIERS = ["starter", "growth", "enterprise"] as const;
export const BUDGET_RANGES = ["under_5k", "5k_15k", "15k_50k", "50k_plus"] as const;
export const TIMELINES = ["asap", "1_3_months", "3_6_months", "flexible"] as const;

const name = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(2, `${label} must be at least 2 characters`)
    .max(100, `${label} must be at most 100 characters`);

export const intakeSchema = z.object({
  company_name: name("Company name"),
  contact_name: name("Your name"),
  contact_email: z
    .string({ error: "Email is required" })
    .trim()
    .pipe(z.email("Enter a valid email address").max(254, "Email is too long")),
  service_tier: z.enum(SERVICE_TIERS, { error: "Choose a service tier" }),
  // The form sends "" for an empty input; normalize that to "not provided".
  website: z
    .string()
    .trim()
    .transform((value) => (value === "" ? undefined : value))
    .pipe(
      z
        .url({
          protocol: /^https?$/,
          hostname: z.regexes.domain,
          error: "Enter a full URL, e.g. https://example.com",
        })
        .max(2048, "URL is too long")
        .optional(),
    )
    .optional(),
  project_description: z
    .string({ error: "Project description is required" })
    .trim()
    .min(30, "Tell us a bit more (at least 30 characters)")
    .max(2000, "Keep it under 2000 characters"),
  budget_range: z.enum(BUDGET_RANGES, { error: "Choose a budget range" }),
  timeline: z.enum(TIMELINES, { error: "Choose a timeline" }),
  submission_id: z.uuid("Invalid submission id"),
  turnstile_token: z
    .string({ error: "Complete the verification check" })
    .min(1, "Complete the verification check")
    .max(2048),
});

/** What the form holds (before parsing). */
export type IntakeInput = z.input<typeof intakeSchema>;
/** What the schema produces (trimmed, empty website removed). */
export type Intake = z.output<typeof intakeSchema>;
export type IntakeField = keyof Intake;

/** The payload forwarded to n8n: the validated intake minus the Turnstile token. */
export type IntakePayload = Omit<Intake, "turnstile_token">;

export function toIntakePayload(intake: Intake): IntakePayload {
  const { turnstile_token, ...payload } = intake;
  return payload;
}
