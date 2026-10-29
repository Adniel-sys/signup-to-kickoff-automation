import "server-only";
import { z } from "zod";
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);

  try {
    const res = await fetch(`${serverEnv.N8N_BASE_URL}/webhook/onboard`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Onboard-Secret": serverEnv.ONBOARD_WEBHOOK_SECRET,
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });

    // ngrok answers for an offline tunnel itself (e.g. ERR_NGROK_3200): n8n is unreachable.
    const ngrokError = res.headers.get("ngrok-error-code");
    if (ngrokError) return { kind: "unavailable", detail: `ngrok ${ngrokError}` };

    const text = await res.text();
    const json = parseJson(text);

    if (res.status === 202) {
      const accepted = acceptedSchema.safeParse(json);
      if (accepted.success) return { kind: "accepted", runId: accepted.data.run_id };
    } else if (res.status === 200) {
      const duplicate = duplicateSchema.safeParse(json);
      if (duplicate.success) return { kind: "duplicate", runId: duplicate.data.run_id };
    }
    return { kind: "upstream_error", detail: `HTTP ${res.status}: ${text.slice(0, 500)}` };
  } catch (error) {
    const detail = controller.signal.aborted
      ? `timed out after ${N8N_TIMEOUT_MS}ms`
      : `unreachable: ${error instanceof Error ? error.message : String(error)}`;
    return { kind: "unavailable", detail };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
