"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { submitDecision } from "@/lib/approve-client";
import { approveRequestSchema, NOTE_MAX, type Decision } from "@/lib/schemas/approve";

export function DecisionPanel({ runId }: { runId: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<Decision | null>(null);
  const [sent, setSent] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  // State updates land on the next render; the ref blocks a fast double-click immediately.
  const inFlight = useRef(false);

  async function decide(decision: Decision) {
    // One decision per page: a second click must never send a second decision.
    if (inFlight.current || sent) return;
    setError(null);
    setNoteError(null);

    const input = { run_id: runId, decision, note: note.trim() || undefined };
    const check = approveRequestSchema.safeParse(input);
    if (!check.success) {
      setNoteError(check.error.issues.find((issue) => issue.path[0] === "note")?.message ?? null);
      return;
    }

    inFlight.current = true;
    setPending(decision);
    const outcome = await submitDecision(input);
    setPending(null);
    if (outcome.kind === "success") {
      // n8n has already recorded the decision when /api/approve answers 200.
      setSent(decision);
      router.refresh();
      return;
    }
    inFlight.current = false;
    setError(outcome.message);
    setNoteError(outcome.noteError);
    // Someone else (or the timeout) decided first: show the run's real state.
    if (outcome.code === "not_waiting") router.refresh();
  }

  const locked = pending !== null || sent !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decision</CardTitle>
        <CardDescription>
          Approving starts provisioning. Rejecting ends the run; the note is saved as the reason.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Field data-invalid={noteError ? true : undefined}>
          <FieldLabel htmlFor="decision-note">Note</FieldLabel>
          <Textarea
            id="decision-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={NOTE_MAX}
            rows={3}
            disabled={locked}
            aria-invalid={noteError ? true : undefined}
          />
          <FieldDescription>Optional when approving, required when rejecting.</FieldDescription>
          {noteError ? <FieldError>{noteError}</FieldError> : null}
        </Field>
      </CardContent>
      <CardFooter className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p role={sent ? "status" : "alert"} className={sent ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {sent ? `${sent === "approve" ? "Approved" : "Rejected"}. Updating the run…` : error}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="destructive" disabled={locked} onClick={() => decide("reject")}>
            {pending === "reject" ? "Rejecting…" : "Reject"}
          </Button>
          <Button type="button" disabled={locked} onClick={() => decide("approve")}>
            {pending === "approve" ? "Approving…" : "Approve"}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
