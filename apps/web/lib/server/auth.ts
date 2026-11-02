import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { loginPath } from "@/lib/auth-paths";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Sign-ups are disabled in Supabase, so every signed-in user is an admin. */
export type Admin = { id: string; email: string };

/**
 * The signed-in admin, or null. Verified with Supabase Auth (`getUser`), not just read from the
 * cookie. Memoized per request, so several components can call it.
 */
export const getAdmin = cache(async (): Promise<Admin | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;
  return { id: data.user.id, email: data.user.email };
});

/** For admin pages: the admin, or a redirect to /login that comes back to `next`. */
export async function requireAdmin(next?: string): Promise<Admin> {
  const admin = await getAdmin();
  if (!admin) redirect(loginPath(next));
  return admin;
}
