import { describe, expect, it } from "vitest";
import { intakeSchema, toIntakePayload } from "@/lib/schemas/intake";
import { validIntake } from "./fixtures";

function fieldErrors(input: unknown) {
  const result = intakeSchema.safeParse(input);
  if (result.success) throw new Error("expected validation to fail");
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("intakeSchema", () => {
  it("accepts a valid intake", () => {
    expect(intakeSchema.safeParse(validIntake()).success).toBe(true);
  });

  it("trims text fields", () => {
    const parsed = intakeSchema.parse(
      validIntake({ company_name: "  Acme  ", contact_email: " jordan@acme.example " }),
    );
    expect(parsed.company_name).toBe("Acme");
    expect(parsed.contact_email).toBe("jordan@acme.example");
  });

  it.each([
    ["company_name", "A"],
    ["company_name", "   A   "],
    ["company_name", "x".repeat(101)],
    ["contact_name", ""],
    ["contact_email", "not-an-email"],
    ["service_tier", "platinum"],
    ["website", "acme.example"],
    ["website", "ftp://acme.example"],
    ["project_description", "Too short."],
    ["project_description", "x".repeat(2001)],
    ["budget_range", "1m_plus"],
    ["timeline", "someday"],
    ["submission_id", "not-a-uuid"],
    ["turnstile_token", ""],
  ] as const)("rejects invalid %s (%j)", (field, value) => {
    expect(fieldErrors(validIntake({ [field]: value }))).toContain(field);
  });

  it("checks length after trimming the description", () => {
    expect(fieldErrors(validIntake({ project_description: `   ${"x".repeat(29)}   ` }))).toContain(
      "project_description",
    );
  });

  it.each([undefined, "", "   "])("treats website %j as not provided", (website) => {
    const parsed = intakeSchema.parse(validIntake({ website }));
    expect(parsed.website).toBeUndefined();
  });

  it("requires every mandatory field", () => {
    expect(fieldErrors({}).sort()).toEqual(
      [
        "budget_range",
        "company_name",
        "contact_email",
        "contact_name",
        "project_description",
        "service_tier",
        "submission_id",
        "timeline",
        "turnstile_token",
      ].sort(),
    );
  });
});

describe("toIntakePayload", () => {
  it("drops the Turnstile token and keeps everything else", () => {
    const intake = intakeSchema.parse(validIntake());
    const { turnstile_token, ...expected } = intake;
    const payload = toIntakePayload(intake);
    expect(turnstile_token).not.toBe("");
    expect(payload).not.toHaveProperty("turnstile_token");
    expect(payload).toEqual(expected);
  });
});
