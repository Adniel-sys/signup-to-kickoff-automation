import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { IntakeForm } from "./intake-form";

export const metadata: Metadata = {
  title: "Start a project · Northpeak Studio",
  description: "Tell Northpeak Studio about your project and we'll set up your kickoff.",
};

export default function OnboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-12 sm:px-6 sm:py-20">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Northpeak Studio</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Start a project</h1>
        <p className="max-w-xl text-muted-foreground">
          A few details about you and what you need. It takes about two minutes, and we reply to every
          submission.
        </p>
      </header>
      <IntakeForm turnstileSiteKey={publicEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
    </main>
  );
}
