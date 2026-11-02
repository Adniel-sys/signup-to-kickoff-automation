// n8n Code node: "Validate request" (WF-02 Approval Gate, entry 2, Phase 4).
// Mode: Run Once for All Items. Language: JavaScript. Paste this whole file.
//
// Input:  the Webhook item; the request body is at $json.body.
// Output: { valid: true, run_id, decision, decided_by, note }
//      or { valid: false, errors: [...] }
//
// Defense in depth: /api/approve validates the same rules first (apps/web/lib/schemas/approve.ts),
// so a failure here means a caller other than the website, or the two drifted apart.
// Plain JS only: no imports.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS = ["approve", "reject"];
const NOTE_MIN_FOR_REJECT = 3;
const NOTE_MAX = 500;
const DECIDED_BY_MAX = 320;

function validateApproval(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, errors: ["body must be a JSON object"] };
  }

  const errors = [];
  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  if (!UUID.test(runId)) errors.push("run_id must be a uuid");

  if (!DECISIONS.includes(body.decision)) errors.push("decision must be approve or reject");

  const decidedBy = typeof body.decided_by === "string" ? body.decided_by.trim() : "";
  if (!decidedBy) errors.push("decided_by is required");
  else if (decidedBy.length > DECIDED_BY_MAX) errors.push(`decided_by must be at most ${DECIDED_BY_MAX} characters`);

  let note = null;
  if (typeof body.note === "string") note = body.note.trim() || null;
  else if (body.note !== null && body.note !== undefined) errors.push("note must be a string or null");
  if (note && note.length > NOTE_MAX) errors.push(`note must be at most ${NOTE_MAX} characters`);
  if (body.decision === "reject" && (note ?? "").length < NOTE_MIN_FOR_REJECT) {
    errors.push("a rejection needs a note");
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, run_id: runId.toLowerCase(), decision: body.decision, decided_by: decidedBy, note };
}

return $input.all().map((item) => ({ json: validateApproval(item.json.body) }));
