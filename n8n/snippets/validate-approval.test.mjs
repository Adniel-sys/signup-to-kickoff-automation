// node --test n8n/snippets/validate-approval.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const CODE = readFileSync(new URL("./validate-approval.js", import.meta.url), "utf8");
const RUN_ID = "3f2b8c1e-6d4a-4b7e-9c2d-1a5e8f7b6c4d";

/** Runs the snippet the way an n8n Code node does, with one Webhook item carrying `body`. */
function validate(body) {
  const $input = { all: () => [{ json: { headers: {}, body } }] };
  const [item] = new Function("$input", CODE)($input);
  return item.json;
}

const approve = (overrides = {}) => ({
  run_id: RUN_ID,
  decision: "approve",
  decided_by: "ops@northpeak.example",
  note: null,
  ...overrides,
});

describe("Validate request (WF-02)", () => {
  it("accepts an approval without a note", () => {
    assert.deepEqual(validate(approve()), {
      valid: true,
      run_id: RUN_ID,
      decision: "approve",
      decided_by: "ops@northpeak.example",
      note: null,
    });
  });

  it("accepts a rejection with a note, trimmed", () => {
    const result = validate(approve({ decision: "reject", note: "  Budget far below scope  " }));
    assert.equal(result.valid, true);
    assert.equal(result.note, "Budget far below scope");
  });

  it("turns a missing or blank approval note into null", () => {
    assert.equal(validate(approve({ note: undefined })).note, null);
    assert.equal(validate(approve({ note: "   " })).note, null);
  });

  it("normalises the run_id to lower case", () => {
    assert.equal(validate(approve({ run_id: RUN_ID.toUpperCase() })).run_id, RUN_ID);
  });

  const invalid = [
    ["no body", undefined, "body must be a JSON object"],
    ["an array body", [], "body must be a JSON object"],
    ["a missing run_id", approve({ run_id: undefined }), "run_id must be a uuid"],
    ["a run_id that is not a uuid", approve({ run_id: "42" }), "run_id must be a uuid"],
    ["SQL in the run_id", approve({ run_id: `${RUN_ID}' or '1'='1` }), "run_id must be a uuid"],
    ["an unknown decision", approve({ decision: "maybe" }), "decision must be approve or reject"],
    ["a missing decided_by", approve({ decided_by: undefined }), "decided_by is required"],
    ["a blank decided_by", approve({ decided_by: "  " }), "decided_by is required"],
    ["a long decided_by", approve({ decided_by: "x".repeat(321) }), "decided_by must be at most 320 characters"],
    ["a note that is not a string", approve({ note: 42 }), "note must be a string or null"],
    ["a note over 500 characters", approve({ note: "x".repeat(501) }), "note must be at most 500 characters"],
    ["a rejection without a note", approve({ decision: "reject" }), "a rejection needs a note"],
    ["a rejection with a blank note", approve({ decision: "reject", note: "   " }), "a rejection needs a note"],
    ["a rejection with a 2-character note", approve({ decision: "reject", note: "no" }), "a rejection needs a note"],
  ];

  for (const [label, body, error] of invalid) {
    it(`rejects ${label}`, () => {
      const result = validate(body);
      assert.equal(result.valid, false);
      assert.ok(result.errors.includes(error), `errors were: ${JSON.stringify(result.errors)}`);
    });
  }

  it("reports every problem at once", () => {
    assert.deepEqual(validate({ decision: "reject" }).errors, [
      "run_id must be a uuid",
      "decided_by is required",
      "a rejection needs a note",
    ]);
  });
});
