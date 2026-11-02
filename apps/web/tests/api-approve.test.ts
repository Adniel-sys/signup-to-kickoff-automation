import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/approve/route";
import type { RunStatus } from "@/lib/schemas/runs";
import { getAdmin } from "@/lib/server/auth";
import { getRunStatus } from "@/lib/server/runs";
import { RUN_ID } from "./fixtures";

// The session check and the Supabase read are mocked; the n8n call is real, with fetch stubbed.
vi.mock("@/lib/server/auth", () => ({ getAdmin: vi.fn() }));
vi.mock("@/lib/server/runs", () => ({ getRunStatus: vi.fn() }));

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const APPROVAL_URL = "https://n8n.test/webhook/approval";
const ADMIN = { id: "5b0c8f7e-2a4d-4e6f-9a1b-3c5d7e9f1a2b", email: "ops@northpeak.example" };

type N8nHandler = (init: RequestInit | undefined) => Promise<Response>;

function signedIn(admin: typeof ADMIN | null = ADMIN) {
  vi.mocked(getAdmin).mockResolvedValue(admin);
}

function runIs(status: RunStatus | null) {
  vi.mocked(getRunStatus).mockResolvedValue(status);
}

/** WF-02's success reply: it echoes the run id and the run's new status. */
const recorded = (status: "approved" | "rejected" = "approved") =>
  Response.json({ ok: true, run_id: RUN_ID, status });

function mockFetch(n8n: N8nHandler = async () => recorded()) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === APPROVAL_URL) return n8n(init);
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function approveRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Asserts the browser never sees the secret, the n8n URL, or anything n8n said. */
async function expectNoLeak(res: Response, ...forbidden: string[]) {
  const text = await res.clone().text();
  for (const value of [SECRET, APPROVAL_URL, ...forbidden]) expect(text).not.toContain(value);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  signedIn();
  runIs("awaiting_approval");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(getAdmin).mockReset();
  vi.mocked(getRunStatus).mockReset();
});

describe("POST /api/approve", () => {
  it("forwards the decision to the fixed WF-02 URL with the secret header", async () => {
    const fetchMock = mockFetch();

    const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve", note: "  Looks good  " }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, run_id: RUN_ID, decision: "approve", status: "approved" });
    expect(getRunStatus).toHaveBeenCalledWith(RUN_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(APPROVAL_URL);
    expect(init!.method).toBe("POST");
    expect(init!.headers).toEqual({
      "Content-Type": "application/json",
      "X-Onboard-Secret": SECRET,
      "ngrok-skip-browser-warning": "true",
    });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    // decided_by comes from the session, never from the browser.
    expect(JSON.parse(String(init!.body))).toEqual({
      run_id: RUN_ID,
      decision: "approve",
      decided_by: ADMIN.email,
      note: "Looks good",
    });
  });

  it("returns the rejected status for a rejection", async () => {
    mockFetch(async () => recorded("rejected"));
    const res = await POST(approveRequest({ run_id: RUN_ID, decision: "reject", note: "Budget far below scope" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, run_id: RUN_ID, decision: "reject", status: "rejected" });
  });

  it("sends note: null when an approval has no note", async () => {
    const fetchMock = mockFetch();
    await POST(approveRequest({ run_id: RUN_ID, decision: "approve", note: "   " }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toMatchObject({ note: null });
  });

  it("ignores a decided_by sent by the browser", async () => {
    const fetchMock = mockFetch(async () => recorded("rejected"));
    await POST(approveRequest({ run_id: RUN_ID, decision: "reject", note: "Out of scope", decided_by: "ceo@evil.example" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).decided_by).toBe(ADMIN.email);
  });

  describe("session", () => {
    it("returns 401 without a session and touches nothing", async () => {
      signedIn(null);
      const fetchMock = mockFetch();

      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ ok: false, error: "unauthorized" });
      expect(getRunStatus).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns 403 for a cross-origin POST, even with a session", async () => {
      const fetchMock = mockFetch();
      const res = await POST(
        approveRequest({ run_id: RUN_ID, decision: "approve" }, { Origin: "https://evil.example" }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: "forbidden" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("body validation", () => {
    it("returns 400 for a body that is not JSON", async () => {
      const res = await POST(approveRequest("{not json"));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: "invalid_json" });
    });

    it.each([
      ["a missing run_id", { decision: "approve" }, "run_id"],
      ["a run_id that is not a uuid", { run_id: "42", decision: "approve" }, "run_id"],
      ["an unknown decision", { run_id: RUN_ID, decision: "maybe" }, "decision"],
      ["a reject without a note", { run_id: RUN_ID, decision: "reject" }, "note"],
      ["a reject with a blank note", { run_id: RUN_ID, decision: "reject", note: "  " }, "note"],
      ["a note over 500 characters", { run_id: RUN_ID, decision: "approve", note: "x".repeat(501) }, "note"],
    ])("returns 400 for %s", async (_label, body, field) => {
      const fetchMock = mockFetch();

      const res = await POST(approveRequest(body));

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toMatchObject({ ok: false, error: "validation_failed" });
      expect(Object.keys(json.field_errors)).toEqual([field]);
      expect(getRunStatus).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("run pre-check", () => {
    it("returns 404 for an unknown run", async () => {
      runIs(null);
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, error: "not_found" });
    });

    it.each(["approved", "rejected", "enriching", "provisioning"] as const)(
      "returns 409 when the run is %s, without calling n8n",
      async (status) => {
        runIs(status);
        const fetchMock = mockFetch();

        const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));

        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ ok: false, error: "not_waiting" });
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it("returns 503 when the run can't be read", async () => {
      vi.mocked(getRunStatus).mockRejectedValue(new Error("connection refused"));
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      expect(res.status).toBe(503);
      await expectNoLeak(res, "connection refused");
    });
  });

  describe("n8n replies", () => {
    it("maps n8n 409 (decided in the meantime) to 409 not_waiting", async () => {
      const n8nBody = JSON.stringify({ ok: false, error: "not_awaiting_approval" });
      mockFetch(async () => new Response(n8nBody, { status: 409 }));
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      expect(res.status).toBe(409);
      expect(await res.clone().json()).toMatchObject({ ok: false, error: "not_waiting" });
      await expectNoLeak(res, "not_awaiting_approval");
    });

    it("maps n8n 400 to 400 invalid_decision without leaking details", async () => {
      const n8nBody = JSON.stringify({ ok: false, error: "invalid_request", errors: ["decided_by is required"] });
      mockFetch(async () => new Response(n8nBody, { status: 400 }));
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      expect(res.status).toBe(400);
      expect(await res.clone().json()).toMatchObject({ ok: false, error: "invalid_decision" });
      await expectNoLeak(res, "decided_by is required");
    });

    it.each([
      ["401", 401, "Authorization is required!"],
      ["403 (wrong secret)", 403, "Authorization data is wrong!"],
      ["404 (WF-02 not active)", 404, 'The requested webhook "POST approval" is not registered.'],
      ["500", 500, "Internal error"],
      ["502", 502, "Bad gateway"],
    ])("maps n8n %s to 502 without leaking details", async (_label, status, n8nBody) => {
      mockFetch(async () => new Response(n8nBody, { status }));
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      expect(res.status).toBe(502);
      expect(await res.clone().json()).toMatchObject({ ok: false, error: "upstream_error" });
      await expectNoLeak(res, n8nBody);
    });

    it.each([
      ["not JSON", "Workflow was started"],
      ["a body without status", JSON.stringify({ ok: true, run_id: RUN_ID })],
      ["another run's id", JSON.stringify({ ok: true, run_id: "11111111-1111-4111-8111-111111111111", status: "approved" })],
      ["a status that is not a decision", JSON.stringify({ ok: true, run_id: RUN_ID, status: "awaiting_approval" })],
    ])("treats a 200 with %s as 502", async (_label, n8nBody) => {
      mockFetch(async () => new Response(n8nBody, { status: 200 }));
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ ok: false, error: "upstream_error" });
    });

    it("returns 503 when n8n does not answer within 10s", async () => {
      vi.useFakeTimers();
      const fetchMock = mockFetch(
        (init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted", "AbortError")),
            );
          }),
      );

      const pending = POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, error: "unavailable" });
    });

    it("returns 503 when n8n is unreachable", async () => {
      mockFetch(async () => Promise.reject(new TypeError("fetch failed")));
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      expect(res.status).toBe(503);
      await expectNoLeak(res, "fetch failed");
    });

    it("returns 503 when the ngrok tunnel is offline", async () => {
      mockFetch(
        async () =>
          new Response("ERR_NGROK_3200", { status: 404, headers: { "ngrok-error-code": "ERR_NGROK_3200" } }),
      );
      const res = await POST(approveRequest({ run_id: RUN_ID, decision: "approve" }));
      // An offline tunnel is "try again", not an n8n error, even though ngrok says 404.
      expect(res.status).toBe(503);
    });
  });
});
