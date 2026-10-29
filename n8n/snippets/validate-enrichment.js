// n8n Code node: "Validate output" (WF-01, Phase 3).
// Mode: Run Once for All Items. Language: JavaScript. Paste this whole file.
//
// Input:  the "Call Haiku" HTTP Request output (Anthropic Messages API response),
//         or { error } when that node failed and "On Error" is set to Continue.
// Output: { valid: true, data } or { valid: false, errors: [...] }
//
// SCHEMA must stay identical to n8n/prompts/intake-enrichment.schema.json
// (enforced by validate-enrichment.test.mjs). Plain JS only: no imports.

const TOOL_NAME = "record_intake_analysis";

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
      description: "Highest rubric level that matches.",
    },
    risk_reason: {
      type: "string",
      minLength: 10,
      maxLength: 300,
      description: "One sentence: the main reason for risk_level.",
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

function validateEnrichment(response) {
  const extracted = extractToolInput(response);
  if (extracted.errors) return { valid: false, errors: extracted.errors };

  const errors = [];
  validate(SCHEMA, extracted.input, "", errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, data: extracted.input };
}

return $input.all().map((item) => ({ json: validateEnrichment(item.json) }));
