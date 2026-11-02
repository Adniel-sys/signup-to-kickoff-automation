import { z } from "zod";
import {
  approveRequestSchema,
  type ApproveError,
  type ApproveErrorCode,
  type ApproveSuccess,
} from "@/lib/schemas/approve";
import { getAdmin } from "@/lib/server/auth";
import { sendDecisionToN8n } from "@/lib/server/n8n";
import { getRunStatus } from "@/lib/server/runs";
import type { RunStatus } from "@/lib/schemas/runs";

const MESSAGES: Record<ApproveErrorCode, string> = {
  unauthorized: "Your session has expired. Sign in again.",
  forbidden: "This request was blocked.",
  invalid_json: "The request could not be read. Reload the page and try again.",
  validation_failed: "Please fix the highlighted fields.",
  not_found: "This run doesn't exist.",
  not_waiting: "This run is no longer waiting for a decision. Reload to see its current status.",
  invalid_decision: "The workflow refused this decision as invalid. Reload the page and try again.",
  upstream_error: "The decision couldn't be delivered to the workflow. Try again shortly.",
  unavailable: "The workflow is temporarily unreachable. Try again in a few minutes.",
};

/**
 * POST /api/approve: admin session → validate → pre-check the run → n8n WF-02 records the decision.
 * The website never writes the decision itself. Contract: docs/api-contract.md.
 */
export async function POST(request: Request): Promise<Response> {
  const admin = await getAdmin();
  if (!admin) return error(401, "unauthorized");
  if (!isSameOrigin(request)) {
    console.warn("[approve] cross-origin request blocked", request.headers.get("origin"));
    return error(403, "forbidden");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error(400, "invalid_json");
  }

  const parsed = approveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(400, "validation_failed", z.flattenError(parsed.error).fieldErrors);
  }
  const { run_id, decision, note } = parsed.data;

  // A fast, clear 409 for runs already decided. WF-02 re-checks atomically, so this is not the guard.
  let status: RunStatus | null;
  try {
    status = await getRunStatus(run_id);
  } catch (lookupError) {
    console.error("[approve] run lookup failed", lookupError);
    return error(503, "unavailable");
  }
  if (!status) return error(404, "not_found");
  if (status !== "awaiting_approval") return error(409, "not_waiting");

  const result = await sendDecisionToN8n({ run_id, decision, decided_by: admin.email, note: note ?? null });
  switch (result.kind) {
    case "recorded":
      return success({ ok: true, run_id, decision, status: result.status });
    case "not_waiting":
      console.warn("[approve] n8n says the run is not awaiting approval", result.detail);
      return error(409, "not_waiting");
    case "invalid":
      console.error("[approve] n8n refused the decision as invalid", result.detail);
      return error(400, "invalid_decision");
    case "upstream_error":
      console.error("[approve] n8n error", result.detail);
      return error(502, "upstream_error");
    case "unavailable":
      console.error("[approve] n8n unavailable", result.detail);
      return error(503, "unavailable");
  }
}

/** Browsers send Origin on every POST; a mismatch means another site is posting with our cookie. */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}

function success(body: ApproveSuccess): Response {
  return Response.json(body, { status: 200 });
}

function error(
  status: number,
  code: ApproveErrorCode,
  fieldErrors?: Record<string, string[] | undefined>,
): Response {
  const body: ApproveError = { ok: false, error: code, message: MESSAGES[code] };
  if (fieldErrors) body.field_errors = compact(fieldErrors);
  return Response.json(body, { status });
}

function compact(fieldErrors: Record<string, string[] | undefined>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(fieldErrors).filter((entry): entry is [string, string[]] => entry[1] !== undefined),
  );
}
