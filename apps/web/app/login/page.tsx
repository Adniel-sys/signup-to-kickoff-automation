import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · Northpeak Studio",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-8 px-4 py-12 sm:px-6 sm:py-20">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Northpeak Studio</p>
        <h1 className="text-3xl font-semibold tracking-tight">Admin sign in</h1>
        <p className="text-muted-foreground">For the Northpeak team. Use the account you were given.</p>
      </header>
      {/* The form reads ?next= from the URL, which is request data. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
