import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/onboard/route";
import { RUN_ID, SUBMISSION_ID, validIntake } from "./fixtures";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const N8N_URL = "https://n8n.test/webhook/onboard";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type N8nHandler = (init: RequestInit | undefined) => Promise<Response>;

function mockFetch({
  turnstile = { success: true },
  n8n = async () => Response.json({ ok: true, duplicate: false, run_id: RUN_ID }, { status: 202 }),
}: {
  turnstile?: { success: boolean; "error-codes"?: string[] };
  n8n?: N8nHandler;
} = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SITEVERIFY_URL) return Response.json(turnstile);
    if (url === N8N_URL) return n8n(init);
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function n8nCalls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.filter(([url]) => String(url) === N8N_URL);
}

function onboardRequest(body: unknown): Request {
  return new Request("http://localhost/api/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Asserts the browser never sees the secret or anything n8n said. */
async function expectNoLeak(res: Response, ...forbidden: string[]) {
  const text = await res.clone().text();
  for (const value of [SECRET, ...forbidden]) expect(text).not.toContain(value);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/onboard", () => {
  it("verifies Turnstile, then forwards the payload to n8n with the secret header", async () => {
    const fetchMock = mockFetch();

    const res = await POST(onboardRequest(validIntake()));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, run_id: RUN_ID, duplicate: false });

    const [, verifyInit] = fetchMock.mock.calls[0]!;
    const verifyBody = verifyInit?.body as URLSearchParams;
    expect(verifyBody.get("secret")).toBe("test-turnstile-secret");
    expect(verifyBody.get("response")).toBe("XXXX.DUMMY.TOKEN.XXXX");
    expect(verifyBody.get("remoteip")).toBe("203.0.113.7");

    const calls = n8nCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const init = calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Onboard-Secret": SECRET,
      "ngrok-skip-browser-warning": "true",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const { turnstile_token, ...expectedPayload } = validIntake();
    expect(turnstile_token).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual(expectedPayload);
  });

  it("returns 400 with field errors for an invalid payload and does not call n8n", async () => {
    const fetchMock = mockFetch();

    const res = await POST(
      onboardRequest(validIntake({ contact_email: "nope", project_description: "short" })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "validation_failed" });
    expect(Object.keys(body.field_errors).sort()).toEqual(["contact_email", "project_description"]);
    expect(n8nCalls(fetchMock)).toHaveLength(0);
  });

  it("returns 400 for a body that is not JSON", async () => {
    const fetchMock = mockFetch();
    const res = await POST(onboardRequest("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_json" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 without calling Cloudflare when the Turnstile token is missing", async () => {
    const fetchMock = mockFetch();
    const res = await POST(onboardRequest(validIntake({ turnstile_token: "" })));
    expect(res.status).toBe(400);
    expect((await res.json()).field_errors).toHaveProperty("turnstile_token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 403 when Turnstile rejects the token and does not call n8n", async () => {
    const fetchMock = mockFetch({ turnstile: { success: false, "error-codes": ["invalid-input-response"] } });
    const res = await POST(onboardRequest(validIntake()));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "turnstile_failed" });
    expect(n8nCalls(fetchMock)).toHaveLength(0);
  });

  it("passes a duplicate through as success with duplicate: true", async () => {
    mockFetch({
      n8n: async () => Response.json({ ok: true, duplicate: true, run_id: RUN_ID }, { status: 200 }),
    });

    const res = await POST(onboardRequest(validIntake({ submission_id: SUBMISSION_ID })));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, run_id: RUN_ID, duplicate: true });
  });

  it("maps n8n 401 to a generic 502 without leaking details", async () => {
    const n8nBody = "Authorization data is wrong!";
    mockFetch({ n8n: async () => new Response(n8nBody, { status: 401 }) });

    const res = await POST(onboardRequest(validIntake()));

    expect(res.status).toBe(502);
    expect(await res.clone().json()).toMatchObject({ ok: false, error: "upstream_error" });
    await expectNoLeak(res, n8nBody);
  });

  it.each([
    ["500", () => new Response("Workflow could not be started!", { status: 500 })],
    ["200 without duplicate", () => Response.json({ ok: true, run_id: RUN_ID }, { status: 200 })],
    ["202 with a bad run_id", () => Response.json({ ok: true, duplicate: false, run_id: "x" }, { status: 202 })],
    ["non-JSON 202", () => new Response("<html>", { status: 202 })],
  ])("maps n8n %s to 502", async (_label, reply) => {
    mockFetch({ n8n: async () => reply() });
    const res = await POST(onboardRequest(validIntake()));
    expect(res.status).toBe(502);
    await expectNoLeak(res, "Workflow could not be started!");
  });

  it("returns 503 when n8n does not answer within 10s", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch({
      n8n: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError")),
          );
        }),
    });

    const pending = POST(onboardRequest(validIntake()));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(n8nCalls(fetchMock)[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      ok: false,
      error: "unavailable",
      message: expect.stringContaining("temporarily unavailable"),
    });
  });

  it("returns 503 when n8n is unreachable", async () => {
    mockFetch({ n8n: async () => Promise.reject(new TypeError("fetch failed")) });
    const res = await POST(onboardRequest(validIntake()));
    expect(res.status).toBe(503);
    await expectNoLeak(res, "fetch failed");
  });

  it("returns 503 when the ngrok tunnel is offline", async () => {
    mockFetch({
      n8n: async () =>
        new Response("ERR_NGROK_3200", { status: 404, headers: { "ngrok-error-code": "ERR_NGROK_3200" } }),
    });
    const res = await POST(onboardRequest(validIntake()));
    expect(res.status).toBe(503);
  });

  it("returns 503 when Cloudflare siteverify is unreachable", async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(onboardRequest(validIntake()));
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
