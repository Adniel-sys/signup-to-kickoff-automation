// n8n Code nodes: "Validate output" and "Validate output (retry)" (WF-01, Phase 3).
// Mode: Run Once for All Items. Language: JavaScript. Paste this whole file into both.
//
// Input:  the "Call Haiku" or "Call Haiku (retry)" HTTP Request output (Anthropic Messages
//         API response), or { error } when that node failed and "On Error" is set to Continue.
// Output: { valid: true, data, attempt, step_output }
//      or { valid: false, errors: [...], attempt, step_output }
//
// After validation, business rules are applied in code (see applyBusinessRules), so a hard
// rule never depends on the model following the prompt.
//
// SCHEMA must stay identical to n8n/prompts/intake-enrichment.schema.json
// (enforced by validate-enrichment.test.mjs). Plain JS only: no imports.

const TOOL_NAME = "record_intake_analysis";
// Node names this script reads; they must match the canvas exactly.
const RETRY_CALL_NODE = "Call Haiku (retry)";
const FIRST_VALIDATE_NODE = "Validate output";
const WEBHOOK_NODE = "Webhook";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "goals",
    "risk_flags",
    "risk_level",
    "risk_reason",
    "welcome_email",
    "kickoff_agenda",
  ],
  properties: {
    summary: {
      type: "string",
      minLength: 20,
      maxLength: 700,
      description: "2-3 sentences: who the client is, what they want, stated budget and timeline. Intake facts only.",
    },
    goals: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "string", minLength: 3, maxLength: 200 },
      description: "1-5 outcomes the client wants, as stated or directly implied.",
    },
    risk_flags: {
      type: "array",
      minItems: 0,
      maxItems: 5,
      items: { type: "string", minLength: 3, maxLength: 200 },
      description: "0-5 concrete concerns, each naming the intake fact behind it. Empty if none.",
    },
    risk_level: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "high if ANY high-risk condition in the rubric applies, even if the rest looks fine; otherwise medium or low.",
    },
    risk_reason: {
      type: "string",
      minLength: 10,
      maxLength: 300,
      description: "One sentence naming the condition behind risk_level (for high: which high-risk condition applies).",
    },
    welcome_email: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "body"],
      properties: {
        subject: { type: "string", minLength: 5, maxLength: 120 },
        body: {
          type: "string",
          minLength: 400,
          maxLength: 1600,
          description: 'Plain text, 120-180 words, signed "The Northpeak Studio team". No prices or dates.',
        },
      },
    },
    kickoff_agenda: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: { type: "string", minLength: 3, maxLength: 200 },
      description: "3-6 items for the first call, including open questions from risk_flags.",
    },
  },
};

/** Validates `value` against the subset of JSON Schema used by SCHEMA. */
function validate(schema, value, path, errors) {
  const at = path || "(root)";

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path ? path + "." : ""}${key}: is required`);
    }
    for (const key of Object.keys(value)) {
      const child = schema.properties && schema.properties[key];
      const childPath = path ? `${path}.${key}` : key;
      if (!child) {
        if (schema.additionalProperties === false) errors.push(`${childPath}: is not allowed`);
        continue;
      }
      validate(child, value[key], childPath, errors);
    }
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${at}: must be an array`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: must have at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}: must have at most ${schema.maxItems} item(s), got ${value.length}`);
    }
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${at}[${i}]`, errors));
    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${at}: must be a string`);
      return;
    }
    // Whitespace must not pad a string past minLength.
    const trimmed = value.trim().length;
    if (schema.minLength !== undefined && trimmed < schema.minLength) {
      errors.push(`${at}: must be at least ${schema.minLength} characters, got ${trimmed}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: must be at most ${schema.maxLength} characters, got ${value.length}`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${at}: must be one of ${schema.enum.join(", ")}, got ${JSON.stringify(value)}`);
    }
    return;
  }

  errors.push(`${at}: schema type ${JSON.stringify(schema.type)} is not supported by this validator`);
}

/** Pulls the forced tool call's input out of a Messages API response. */
function extractToolInput(response) {
  if (!response || typeof response !== "object") {
    return { errors: ["Empty response from the Anthropic API"] };
  }
  if (response.error) {
    const e = response.error;
    const message = typeof e === "string" ? e : e.message || JSON.stringify(e);
    return { errors: [`Anthropic API call failed: ${String(message).slice(0, 500)}`] };
  }
  if (response.stop_reason === "max_tokens") {
    return { errors: ["Response was cut off (stop_reason=max_tokens); raise max_tokens"] };
  }
  if (response.stop_reason === "refusal") {
    return { errors: ["Model declined to analyze this intake (stop_reason=refusal)"] };
  }

  const blocks = Array.isArray(response.content) ? response.content : [];
  const block = blocks.find((b) => b && b.type === "tool_use" && b.name === TOOL_NAME);
  if (!block) {
    return {
      errors: [`No ${TOOL_NAME} tool call in the response (stop_reason=${response.stop_reason})`],
    };
  }

  let input = block.input;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return { errors: [`${TOOL_NAME} input is not valid JSON`] };
    }
  }
  return { input };
}

/**
 * Deterministic rules that override the model. Haiku's own verdict is kept in
 * ai_risk_level, and every rule that changed it is listed in rule_overrides.
 */
function applyBusinessRules(data, intake) {
  const result = { ...data, ai_risk_level: data.risk_level, rule_overrides: [] };
  // Enterprise engagements always get the full review: never lower than high.
  if (intake.service_tier === "enterprise" && result.risk_level !== "high") {
    result.risk_level = "high";
    result.rule_overrides.push("enterprise_tier_high");
  }
  return result;
}

/** 2 when the input came from the retry call, otherwise 1. */
function currentAttempt() {
  return typeof $prevNode !== "undefined" && $prevNode && $prevNode.name === RETRY_CALL_NODE ? 2 : 1;
}

/** On the retry, the errors that sent us there; kept for the step's output. */
function firstAttemptErrors() {
  try {
    return $(FIRST_VALIDATE_NODE).first().json.errors || [];
  } catch {
    return [];
  }
}

function validateEnrichment(response) {
  const attempt = currentAttempt();
  const history = attempt > 1 ? { first_attempt_errors: firstAttemptErrors() } : {};
  const fail = (errors) => ({
    valid: false,
    errors,
    attempt,
    step_output: { errors, ai_attempts: attempt, ...history },
  });

  const extracted = extractToolInput(response);
  if (extracted.errors) return fail(extracted.errors);

  const errors = [];
  validate(SCHEMA, extracted.input, "", errors);
  if (errors.length > 0) return fail(errors);

  let intake;
  try {
    intake = $(WEBHOOK_NODE).first().json.body || {};
  } catch {
    return fail([`Could not read the intake from the ${WEBHOOK_NODE} node`]);
  }
  const data = applyBusinessRules(extracted.input, intake);
  return {
    valid: true,
    data,
    attempt,
    step_output: {
      summary: data.summary,
      risk_level: data.risk_level,
      ai_risk_level: data.ai_risk_level,
      rule_overrides: data.rule_overrides,
      ai_attempts: attempt,
      ...history,
    },
  };
}

return $input.all().map((item) => ({ json: validateEnrichment(item.json) }));
