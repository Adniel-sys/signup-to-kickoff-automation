import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_HOME, LOGIN_PATH, loginPath } from "@/lib/auth-paths";
import { publicEnv } from "@/lib/env";

/**
 * Refreshes the Supabase session cookie before admin pages render, and redirects early:
 * signed out on /admin → /login, signed in on /login → /admin. This is the optimistic check only.
 * Every admin page and /api/approve verifies the session again on the server (lib/server/auth.ts).
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          // Responses that set auth cookies must never be cached.
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    },
  );

  // Verifies the token and refreshes it when it is about to expire.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims.sub);
  const { pathname, search } = request.nextUrl;

  if (!signedIn && pathname.startsWith(ADMIN_HOME)) return redirectTo(loginPath(pathname + search), request, response);
  if (signedIn && pathname === LOGIN_PATH) return redirectTo(ADMIN_HOME, request, response);
  return response;
}

/** A redirect that keeps any cookies the refresh just set or cleared. */
function redirectTo(path: string, request: NextRequest, from: NextResponse): NextResponse {
  const redirect = NextResponse.redirect(new URL(path, request.url));
  for (const cookie of from.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}

export const config = {
  matcher: ["/admin/:path*", "/login", "/api/approve"],
};
