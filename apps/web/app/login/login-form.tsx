"use client";

import { useSearchParams } from "next/navigation";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { signIn, type LoginState } from "./actions";

const INITIAL_STATE: LoginState = { error: null };

export function LoginForm() {
  const next = useSearchParams().get("next") ?? "";
  const [state, formAction, pending] = useActionState(signIn, INITIAL_STATE);

  return (
    <Card>
      <form action={formAction}>
        <CardContent>
          <input type="hidden" name="next" value={next} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input id="email" name="email" type="email" autoComplete="username" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-6 flex flex-col items-stretch gap-3">
          <p role="alert" className="text-sm text-destructive empty:hidden">
            {state.error}
          </p>
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
