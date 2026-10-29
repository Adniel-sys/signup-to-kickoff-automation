import { intakeSchema, type Intake, type IntakeField } from "@/lib/schemas/intake";
import { onboardResponseSchema } from "@/lib/schemas/onboard-response";

const NETWORK_MESSAGE = "We couldn't reach our servers. Check your connection and try again.";
const UNEXPECTED_MESSAGE = "Something went wrong on our side. Please try again shortly.";

export type FieldErrorList = { field: IntakeField; message: string }[];

export type SubmitOutcome =
  | { kind: "success"; runId: string; duplicate: boolean }
  | { kind: "failed"; message: string; fieldErrors: FieldErrorList };

/** POSTs the intake to /api/onboard and normalises every response shape. */
export async function submitIntake(intake: Intake): Promise<SubmitOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intake),
    });
  } catch {
    return failed(NETWORK_MESSAGE);
  }

  const json: unknown = await res.json().catch(() => undefined);
  const parsed = onboardResponseSchema.safeParse(json);
  if (!parsed.success) return failed(UNEXPECTED_MESSAGE);

  const data = parsed.data;
  if (data.ok) return { kind: "success", runId: data.run_id, duplicate: data.duplicate };
  return failed(data.message, toFieldErrors(data.field_errors));
}

function failed(message: string, fieldErrors: FieldErrorList = []): SubmitOutcome {
  return { kind: "failed", message, fieldErrors };
}

function toFieldErrors(fieldErrors: Record<string, string[]> | undefined): FieldErrorList {
  if (!fieldErrors) return [];
  return Object.entries(fieldErrors).flatMap(([field, messages]) =>
    isIntakeField(field) && messages[0] ? [{ field, message: messages[0] }] : [],
  );
}

function isIntakeField(field: string): field is IntakeField {
  return field in intakeSchema.shape;
}
