"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Shown when a dashboard query fails. The details stay in the server log. */
export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card role="alert">
      <CardHeader>
        <CardTitle>The dashboard couldn&apos;t load</CardTitle>
        <CardDescription>Supabase may be paused or unreachable. Try again in a moment.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" onClick={reset}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
