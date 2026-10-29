// node --test n8n/snippets/validate-enrichment.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildHaikuBodyExpression } from "./build-haiku-request.mjs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const CODE = read("./validate-enrichment.js");
const SCHEMA_FILE = JSON.parse(read("../prompts/intake-enrichment.schema.json"));
const SYSTEM_PROMPT = read("../prompts/intake-enrichment.system.md").trim();
const RETURN_LINE = "return $input.all().map((item) => ({ json: validateEnrichment(item.json) }));";

/** Runs the snippet the way an n8n Code node does: as a function body with $input. */
function runCodeNode(...responses) {
  const $input = { all: () => responses.map((json) => ({ json })) };
  return new Function("$input", CODE)($input).map((item) => item.json);
}

function snippetSchema() {
  assert.ok(CODE.includes(RETURN_LINE), "snippet must end with the n8n return line");
  return new Function(CODE.replace(RETURN_LINE, "return SCHEMA;"))();
}

const EMAIL_BODY = [
  "Hi Maya,",
  "Thank you for reaching out to Northpeak Studio about Harbor & Pine Dental. It was great to read about your two locations and your plan to give patients a faster, phone-friendly way to find you and book a visit.",
  "We understand the goal is a redesign of your current eight-page site, online booking that works with the Dentrix scheduler you already use, and local search visibility for both practices. It is also helpful to know your content and photos are ready, which lets us focus on design and build from the start.",
  "Someone from our team will be in touch shortly to schedule a kickoff call, where we will walk through your priorities, the booking setup and how we like to work together.",
  "We look forward to talking soon.",
  "The Northpeak Studio team",
].join("\n\n");

function analysis(overrides = {}) {
  return {
    summary:
      "Harbor & Pine Dental, a two-location practice, wants a mobile-friendly redesign of its 8-page site with online booking and local SEO. Budget is $15k-$50k with a 3-6 month timeline.",
    goals: ["Mobile-friendly redesign", "Online booking via Dentrix", "Local SEO for both locations"],
    risk_flags: [],
    risk_level: "low",
    risk_reason: "Scope, budget and timeline are clear and consistent with the growth tier.",
    welcome_email: { subject: "Your Harbor & Pine Dental website project", body: EMAIL_BODY },
    kickoff_agenda: ["Confirm page list and content", "Dentrix booking integration", "Local SEO setup per location"],
    ...overrides,
  };
}

function apiResponse(input, overrides = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "toolu_test", name: "record_intake_analysis", input }],
    usage: { input_tokens: 1200, output_tokens: 450 },
    ...overrides,
  };
}

describe("validate-enrichment.js", () => {
  it("embeds exactly the schema from n8n/prompts", () => {
    assert.deepEqual(snippetSchema(), SCHEMA_FILE);
  });

  it("supports every keyword the schema uses", () => {
    const supported = new Set([
      "type", "properties", "required", "additionalProperties", "items",
      "minItems", "maxItems", "minLength", "maxLength", "enum", "description",
    ]);
    const walk = (node) => {
      for (const [key, value] of Object.entries(node)) {
        assert.ok(supported.has(key), `unsupported schema keyword: ${key}`);
        if (key === "properties") Object.values(value).forEach(walk);
        if (key === "items") walk(value);
      }
    };
    walk(SCHEMA_FILE);
  });

  it("accepts a valid tool call and returns its input", () => {
    const input = analysis();
    assert.deepEqual(runCodeNode(apiResponse(input)), [{ valid: true, data: input }]);
  });

  it("accepts a tool input delivered as a JSON string", () => {
    const [result] = runCodeNode(apiResponse(JSON.stringify(analysis())));
    assert.equal(result.valid, true);
  });

  const invalidCases = [
    ["missing field", (a) => { delete a.risk_reason; }, "risk_reason: is required"],
    ["extra field", (a) => { a.price = "$3000"; }, "price: is not allowed"],
    ["extra nested field", (a) => { a.welcome_email.cc = "x"; }, "welcome_email.cc: is not allowed"],
    ["bad enum", (a) => { a.risk_level = "critical"; }, "risk_level: must be one of low, medium, high"],
    ["wrong type", (a) => { a.goals = "grow"; }, "goals: must be an array"],
    ["too many goals", (a) => { a.goals = ["a1", "b2", "c3", "d4", "e5", "f6"]; }, "goals: must have at most 5"],
    ["no goals", (a) => { a.goals = []; }, "goals: must have at least 1"],
    ["agenda too short", (a) => { a.kickoff_agenda = ["One item", "Two items"]; }, "kickoff_agenda: must have at least 3"],
    ["too many flags", (a) => { a.risk_flags = Array(6).fill("A flag"); }, "risk_flags: must have at most 5"],
    ["non-string item", (a) => { a.goals = ["Valid goal", 42]; }, "goals[1]: must be a string"],
    ["email too short", (a) => { a.welcome_email.body = "Hi, thanks!"; }, "welcome_email.body: must be at least 400"],
    ["whitespace summary", (a) => { a.summary = " ".repeat(50); }, "summary: must be at least 20"],
    ["null email", (a) => { a.welcome_email = null; }, "welcome_email: must be an object"],
  ];

  for (const [name, mutate, expected] of invalidCases) {
    it(`rejects ${name}`, () => {
      const input = analysis();
      mutate(input);
      const [result] = runCodeNode(apiResponse(input));
      assert.equal(result.valid, false);
      assert.ok(
        result.errors.some((error) => error.startsWith(expected)),
        `expected an error starting with "${expected}", got ${JSON.stringify(result.errors)}`,
      );
    });
  }

  it("reports every error, not just the first", () => {
    const [result] = runCodeNode(apiResponse(analysis({ risk_level: "x", goals: [] })));
    assert.equal(result.errors.length, 2);
  });

  for (const [name, response, expected] of [
    ["a truncated response", apiResponse(analysis(), { stop_reason: "max_tokens" }), "Response was cut off"],
    ["a refusal", apiResponse(analysis(), { stop_reason: "refusal" }), "Model declined"],
    ["a text-only reply", apiResponse(null, { stop_reason: "end_turn", content: [{ type: "text", text: "Hi" }] }), "No record_intake_analysis tool call"],
    ["a different tool", apiResponse(null, { content: [{ type: "tool_use", name: "other", input: {} }] }), "No record_intake_analysis tool call"],
    ["an API error body", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "Anthropic API call failed: Overloaded"],
    ["an n8n continue-on-fail item", { error: { message: "Request failed with status code 401" } }, "Anthropic API call failed: Request failed with status code 401"],
    ["an empty item", null, "Empty response"],
  ]) {
    it(`fails cleanly on ${name}`, () => {
      const [result] = runCodeNode(response);
      assert.equal(result.valid, false);
      assert.ok(result.errors[0].startsWith(expected), JSON.stringify(result.errors));
    });
  }
});

describe("build-haiku-request.mjs", () => {
  const expression = buildHaikuBodyExpression();
  const sample = JSON.parse(read("../samples/intake-high.json"));

  function evaluate() {
    assert.ok(expression.startsWith("{{ ") && expression.endsWith(" }}"));
    const $ = (node) => {
      assert.equal(node, "Webhook");
      return { first: () => ({ json: { body: sample } }) };
    };
    return JSON.parse(new Function("$", `return ${expression.slice(3, -3)}`)($));
  }

  it("has no {{ or }} inside the expression", () => {
    const inner = expression.slice(3, -3);
    assert.equal(inner.includes("{{"), false);
    assert.equal(inner.includes("}}"), false);
  });

  it("builds the request the runbook describes", () => {
    const request = evaluate();
    assert.equal(request.model, "claude-haiku-4-5");
    assert.equal(request.max_tokens, 1500);
    assert.equal(request.temperature, 0.2);
    assert.equal(request.system, SYSTEM_PROMPT);
    assert.deepEqual(request.tool_choice, { type: "tool", name: "record_intake_analysis" });
    assert.equal(request.tools.length, 1);
    assert.equal(request.tools[0].name, "record_intake_analysis");
    assert.deepEqual(request.tools[0].input_schema, SCHEMA_FILE);
  });

  it("wraps the intake in <intake> tags that the intake cannot close", () => {
    const { content } = evaluate().messages[0];
    assert.ok(content.startsWith("<intake>\n") && content.endsWith("\n</intake>"));
    const inner = content.slice("<intake>\n".length, -"\n</intake>".length);
    assert.equal(inner.includes("<"), false);
    const intake = JSON.parse(inner);
    assert.equal(intake.project_description, sample.project_description);
    assert.equal(intake.contact_email, undefined);
    assert.equal(intake.submission_id, undefined);
  });

  it("sends website as null when the intake has none", () => {
    const withoutWebsite = { ...sample };
    delete withoutWebsite.website;
    const $ = () => ({ first: () => ({ json: { body: withoutWebsite } }) });
    const request = JSON.parse(new Function("$", `return ${expression.slice(3, -3)}`)($));
    const intake = JSON.parse(request.messages[0].content.slice(9, -10));
    assert.equal(intake.website, null);
  });
});
