// Prints the n8n Expression for the "Call Haiku" HTTP Request node's JSON body,
// with the system prompt and tool schema inlined from n8n/prompts/.
//
//   node n8n/snippets/build-haiku-request.mjs | clip      (Windows)
//   node n8n/snippets/build-haiku-request.mjs | pbcopy    (macOS)
//
// Paste the output into: Body → JSON, after switching that field to Expression mode.
// Re-run and re-paste whenever the prompt or schema changes.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MODEL = "claude-haiku-4-5";
const TOOL_NAME = "record_intake_analysis";
const TOOL_DESCRIPTION =
  "Record the structured analysis of one Northpeak Studio project intake. Call exactly once.";
const MAX_TOKENS = 2000;

// Keywords strict tool use rejects (400). The full limits stay in the schema file and
// are enforced by validate-enrichment.js; minItems is allowed only as 0 or 1.
const STRICT_UNSUPPORTED = ["minLength", "maxLength", "maxItems"];

// Intake fields sent to the model. contact_email and submission_id are left out on purpose.
const INTAKE_FIELDS = [
  "company_name",
  "contact_name",
  "service_tier",
  "website",
  "project_description",
  "budget_range",
  "timeline",
];

/** The canonical schema minus the keywords strict mode doesn't support. */
export function toStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toStrictSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const strict = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRICT_UNSUPPORTED.includes(key)) continue;
    if (key === "minItems" && value > 1) continue;
    // properties maps names to schemas; recurse into each value, keep the names.
    strict[key] =
      key === "properties"
        ? Object.fromEntries(Object.entries(value).map(([name, s]) => [name, toStrictSchema(s)]))
        : toStrictSchema(value);
  }
  return strict;
}

export function buildHaikuBodyExpression() {
  const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
  const system = read("../prompts/intake-enrichment.system.md").trim();
  const schema = toStrictSchema(JSON.parse(read("../prompts/intake-enrichment.schema.json")));

  const body = "$('Webhook').first().json.body";
  const intake = INTAKE_FIELDS.map((field) =>
    field === "website"
      ? `    website: ${body}.website ?? null,`
      : `    ${field}: ${body}.${field},`,
  ).join("\n");

  // Indented so no "}}" or "{{" appears inside: n8n would read it as the end of the expression.
  const inputSchema = JSON.stringify(schema, null, 2).replace(/\n/g, "\n    ");

  // "<" is escaped inside the JSON so intake text can never close the <intake> tag.
  return `{{ JSON.stringify({
  model: ${JSON.stringify(MODEL)},
  max_tokens: ${MAX_TOKENS},
  temperature: 0.2,
  system: ${JSON.stringify(system)},
  tools: [{
    name: ${JSON.stringify(TOOL_NAME)},
    description: ${JSON.stringify(TOOL_DESCRIPTION)},
    strict: true,
    input_schema: ${inputSchema}
  }],
  tool_choice: { type: "tool", name: ${JSON.stringify(TOOL_NAME)} },
  messages: [{
    role: "user",
    content: "<intake>\\n" + JSON.stringify({
${intake}
    }, null, 2).replace(/</g, "\\\\u003c") + "\\n</intake>"
  }]
}) }}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(buildHaikuBodyExpression() + "\n");
}
