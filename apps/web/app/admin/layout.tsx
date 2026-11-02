import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { getAdmin } from "@/lib/server/auth";
import { signOut } from "./actions";

export const metadata: Metadata = {
  title: "Admin · Northpeak Studio",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/admin" className="flex flex-col">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Northpeak Studio</span>
            <span className="font-semibold tracking-tight">Onboarding admin</span>
          </Link>
          {/* Reads the session, so it streams in without holding up the page. */}
          <Suspense>
            <AdminMenu />
          </Suspense>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-4 py-10 sm:px-6">{children}</main>
    </div>
  );
}

async function AdminMenu() {
  const admin = await getAdmin();
  if (!admin) return null;
  return (
    <div className="flex items-center gap-3">
      <span className="hidden text-sm text-muted-foreground sm:inline">{admin.email}</span>
      <form action={signOut}>
        <Button type="submit" variant="outline" size="sm">
          Sign out
        </Button>
      </form>
    </div>
  );
}
