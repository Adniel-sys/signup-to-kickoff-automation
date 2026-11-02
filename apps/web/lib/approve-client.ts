import { approveResponseSchema, type ApproveErrorCode, type Decision } from "@/lib/schemas/approve";

const NETWORK_MESSAGE = "We couldn't reach the server. Check your connection and try again.";
const UNEXPECTED_MESSAGE = "Something went wrong. Reload the page and try again.";

export type DecisionOutcome =
  | { kind: "success" }
  | { kind: "failed"; code: ApproveErrorCode | null; message: string; noteError: string | null };

/** POSTs a decision to /api/approve and normalises every response shape. */
export async function submitDecision(input: {
  run_id: string;
  decision: Decision;
  note?: string;
}): Promise<DecisionOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return failed(null, NETWORK_MESSAGE);
  }

  const json: unknown = await res.json().catch(() => undefined);
  const parsed = approveResponseSchema.safeParse(json);
  if (!parsed.success) return failed(null, UNEXPECTED_MESSAGE);

  const data = parsed.data;
  if (data.ok) return { kind: "success" };
  return failed(data.error, data.message, data.field_errors?.note?.[0] ?? null);
}

function failed(code: ApproveErrorCode | null, message: string, noteError: string | null = null): DecisionOutcome {
  return { kind: "failed", code, message, noteError };
}
