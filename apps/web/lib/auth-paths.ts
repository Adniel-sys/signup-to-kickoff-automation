/** Login redirect helpers shared by proxy.ts, the login page and the server auth checks. */

export const LOGIN_PATH = "/login";
export const ADMIN_HOME = "/admin";

const ADMIN_PATH = /^\/admin(?:[/?#]|$)/;

/** Only an /admin path on this site survives, so `?next=` can never redirect elsewhere. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !ADMIN_PATH.test(value) || value.includes("\\")) return ADMIN_HOME;
  return value;
}

export function loginPath(next?: string): string {
  return next ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH;
}
