"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Controller, useForm, type Control } from "react-hook-form";
import { Turnstile, type TurnstileHandle } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { submitIntake } from "@/lib/onboard-client";
import {
  intakeSchema,
  type BUDGET_RANGES,
  type Intake,
  type IntakeInput,
  type SERVICE_TIERS,
  type TIMELINES,
} from "@/lib/schemas/intake";

const SERVICE_TIER_OPTIONS: Record<(typeof SERVICE_TIERS)[number], string> = {
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
};

const BUDGET_OPTIONS: Record<(typeof BUDGET_RANGES)[number], string> = {
  under_5k: "Under $5k",
  "5k_15k": "$5k – $15k",
  "15k_50k": "$15k – $50k",
  "50k_plus": "$50k+",
};

const TIMELINE_OPTIONS: Record<(typeof TIMELINES)[number], string> = {
  asap: "As soon as possible",
  "1_3_months": "1–3 months",
  "3_6_months": "3–6 months",
  flexible: "Flexible",
};

type IntakeControl = Control<IntakeInput, unknown, Intake>;

export function IntakeForm({ turnstileSiteKey }: { turnstileSiteKey: string }) {
  const [runId, setRunId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileHandle>(null);

  const form = useForm<IntakeInput, unknown, Intake>({
    resolver: zodResolver(intakeSchema),
    mode: "onTouched",
    defaultValues: {
      company_name: "",
      contact_name: "",
      contact_email: "",
      website: "",
      project_description: "",
      submission_id: "",
      turnstile_token: "",
    },
  });

  // One submission_id per form load, reused on every retry so n8n can dedupe.
  useEffect(() => {
    if (!form.getValues("submission_id")) form.setValue("submission_id", crypto.randomUUID());
  }, [form]);

  async function onSubmit(values: Intake) {
    setFormError(null);
    const outcome = await submitIntake(values);
    if (outcome.kind === "success") {
      // A duplicate is a retry of a submission we already have: same confirmation.
      setRunId(outcome.runId);
      return;
    }
    // The server consumed the Turnstile token; fetch a fresh one for the retry.
    form.setValue("turnstile_token", "");
    turnstileRef.current?.reset();
    for (const { field, message } of outcome.fieldErrors) form.setError(field, { message });
    setFormError(outcome.message);
  }

  if (runId) return <Confirmation runId={runId} />;

  const { isSubmitting } = form.formState;

  return (
    <Card>
      <form noValidate onSubmit={(event) => form.handleSubmit(onSubmit)(event)} aria-busy={isSubmitting}>
        <CardContent className="flex flex-col gap-8">
          <FieldSet>
            <FieldLegend>About you</FieldLegend>
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <TextField control={form.control} name="company_name" label="Company name" autoComplete="organization" />
              <TextField control={form.control} name="contact_name" label="Your name" autoComplete="name" />
              <TextField
                control={form.control}
                name="contact_email"
                label="Work email"
                type="email"
                autoComplete="email"
                inputMode="email"
              />
              <TextField
                control={form.control}
                name="website"
                label="Website"
                optional
                type="url"
                autoComplete="url"
                inputMode="url"
                placeholder="https://"
              />
            </FieldGroup>
          </FieldSet>

          <FieldSet>
            <FieldLegend>Your project</FieldLegend>
            <FieldGroup className="grid gap-5 sm:grid-cols-3">
              <SelectField control={form.control} name="service_tier" label="Service tier" options={SERVICE_TIER_OPTIONS} />
              <SelectField control={form.control} name="budget_range" label="Budget" options={BUDGET_OPTIONS} />
              <SelectField control={form.control} name="timeline" label="Timeline" options={TIMELINE_OPTIONS} />
            </FieldGroup>
            <Controller
              control={form.control}
              name="project_description"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={field.name}>What are you looking to build?</FieldLabel>
                  <Textarea
                    {...field}
                    id={field.name}
                    rows={6}
                    maxLength={2000}
                    aria-invalid={fieldState.invalid}
                    placeholder="Goals, audience, must-haves, and anything we should know."
                  />
                  <FieldDescription>
                    {field.value.trim().length}/2000 characters · at least 30
                  </FieldDescription>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />
          </FieldSet>

          <Controller
            control={form.control}
            name="turnstile_token"
            render={({ fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <Turnstile
                  ref={turnstileRef}
                  siteKey={turnstileSiteKey}
                  onToken={(token) =>
                    form.setValue("turnstile_token", token, { shouldValidate: token !== "" })
                  }
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
        </CardContent>

        <CardFooter className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
          <Button type="submit" size="lg" disabled={isSubmitting} className="sm:min-w-40">
            {isSubmitting ? "Sending…" : "Submit project"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

type TextFieldName = "company_name" | "contact_name" | "contact_email" | "website";

function TextField({
  control,
  name,
  label,
  optional = false,
  ...inputProps
}: {
  control: IntakeControl;
  name: TextFieldName;
  label: string;
  optional?: boolean;
} & Pick<ComponentProps<"input">, "type" | "autoComplete" | "inputMode" | "placeholder">) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>
            {label}
            {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
          </FieldLabel>
          <Input
            {...field}
            value={field.value ?? ""}
            id={name}
            aria-invalid={fieldState.invalid}
            {...inputProps}
          />
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

type SelectFieldName = "service_tier" | "budget_range" | "timeline";

function SelectField({
  control,
  name,
  label,
  options,
}: {
  control: IntakeControl;
  name: SelectFieldName;
  label: string;
  options: Record<string, string>;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Select name={field.name} value={field.value ?? ""} onValueChange={field.onChange}>
            <SelectTrigger
              ref={field.ref}
              id={name}
              onBlur={field.onBlur}
              aria-invalid={fieldState.invalid}
              className="w-full"
            >
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(options).map(([value, text]) => (
                <SelectItem key={value} value={value}>
                  {text}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

function Confirmation({ runId }: { runId: string }) {
  return (
    <Card role="status">
      <CardHeader>
        <CardTitle className="text-xl">Thanks, we have your project.</CardTitle>
        <CardDescription>
          Our team will review the details and reach out by email to schedule a kickoff.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Your reference</p>
        <p className="mt-1 font-mono text-sm break-all">{runId}</p>
      </CardContent>
    </Card>
  );
}
