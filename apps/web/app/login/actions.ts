"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNextPath } from "@/lib/auth-paths";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export type LoginState = { error: string | null };

/** Email + password sign-in. Sign-ups are disabled in Supabase; only existing admins can log in. */
export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  if (!parsed.success) return { error: "Enter your email and password." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    console.warn("[login] sign-in failed", error.code ?? error.status);
    // Same message for a wrong password and an unknown email.
    return { error: "Invalid email or password." };
  }

  redirect(safeNextPath(parsed.data.next));
}
