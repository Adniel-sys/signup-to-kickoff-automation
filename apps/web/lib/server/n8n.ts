import "server-only";
import { z } from "zod";
import type { Decision } from "@/lib/schemas/approve";
import type { IntakePayload } from "@/lib/schemas/intake";
import { serverEnv } from "@/lib/server/env";

export const N8N_TIMEOUT_MS = 10_000;

/** WF-01 responses, per docs/api-contract.md. Anything else is an upstream error. */
const acceptedSchema = z.object({
  ok: z.literal(true),
  duplicate: z.literal(false),
  run_id: z.uuid(),
});

const duplicateSchema = z.object({
  ok: z.literal(true),
  duplicate: z.literal(true),
  run_id: z.uuid(),
});

export type N8nResult =
  | { kind: "accepted"; runId: string }
  | { kind: "duplicate"; runId: string }
  | { kind: "upstream_error"; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * Forwards a validated intake to n8n WF-01. `detail` is for server logs only;
 * it must never be sent to the browser.
 */
export async function forwardToN8n(payload: IntakePayload): Promise<N8nResult> {
  const reply = await postToN8n(`${serverEnv.N8N_BASE_URL}/webhook/onboard`, payload);
  if (reply.kind === "unavailable") return reply;

  const json = parseJson(reply.text);
  if (reply.status === 202) {
    const accepted = acceptedSchema.safeParse(json);
    if (accepted.success) return { kind: "accepted", runId: accepted.data.run_id };
  } else if (reply.status === 200) {
    const duplicate = duplicateSchema.safeParse(json);
    if (duplicate.success) return { kind: "duplicate", runId: duplicate.data.run_id };
  }
  return { kind: "upstream_error", detail: describe(reply) };
}

/** Body WF-02 `Approval Gate`'s webhook (entry 2) receives. See docs/api-contract.md. */
export type DecisionBody = { run_id: string; decision: Decision; decided_by: string; note: string | null };

/** WF-02's 200 reply: the run's status after the decision was recorded. */
const recordedSchema = z.object({
  ok: z.literal(true),
  run_id: z.uuid(),
  status: z.enum(["approved", "rejected"]),
});

export type DecisionResult =
  | { kind: "recorded"; status: z.infer<typeof recordedSchema>["status"] }
  | { kind: "not_waiting"; detail: string }
  | { kind: "invalid"; detail: string }
  | { kind: "upstream_error"; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * Sends an admin's decision to n8n WF-02, which records it only if the run is still awaiting
 * approval. The URL is fixed, so nothing from the database decides where the secret goes.
 */
export async function sendDecisionToN8n(body: DecisionBody): Promise<DecisionResult> {
  const reply = await postToN8n(`${serverEnv.N8N_BASE_URL}/webhook/approval`, body);
  if (reply.kind === "unavailable") return reply;

  if (reply.status === 200) {
    const recorded = recordedSchema.safeParse(parseJson(reply.text));
    if (recorded.success && recorded.data.run_id === body.run_id) {
      return { kind: "recorded", status: recorded.data.status };
    }
  } else if (reply.status === 409) {
    return { kind: "not_waiting", detail: describe(reply) };
  } else if (reply.status === 400) {
    return { kind: "invalid", detail: describe(reply) };
  }
  return { kind: "upstream_error", detail: describe(reply) };
}

type N8nReply =
  | { kind: "response"; status: number; text: string }
  | { kind: "unavailable"; detail: string };

/** POSTs JSON to n8n with the shared secret and a 10 s timeout. */
async function postToN8n(url: string, body: unknown): Promise<N8nReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Onboard-Secret": serverEnv.ONBOARD_WEBHOOK_SECRET,
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    // ngrok answers for an offline tunnel itself (e.g. ERR_NGROK_3200): n8n is unreachable.
    const ngrokError = res.headers.get("ngrok-error-code");
    if (ngrokError) return { kind: "unavailable", detail: `ngrok ${ngrokError}` };

    return { kind: "response", status: res.status, text: await res.text() };
  } catch (error) {
    const detail = controller.signal.aborted
      ? `timed out after ${N8N_TIMEOUT_MS}ms`
      : `unreachable: ${error instanceof Error ? error.message : String(error)}`;
    return { kind: "unavailable", detail };
  } finally {
    clearTimeout(timer);
  }
}

function describe(reply: { status: number; text: string }): string {
  return `HTTP ${reply.status}: ${reply.text.slice(0, 500)}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
