"use server";

import { redirect } from "next/navigation";
import { LOGIN_PATH } from "@/lib/auth-paths";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect(LOGIN_PATH);
}
