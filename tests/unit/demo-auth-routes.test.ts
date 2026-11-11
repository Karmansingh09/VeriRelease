/**
 * System Status & Demo Login API Routes Unit Test Suite
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../src/lib/prisma", () => ({
  prisma: {
    user: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from "../../src/lib/prisma";
import { GET as getSystemStatus } from "../../src/app/api/system/status/route";
import { POST as postDemoLogin } from "../../src/app/api/auth/demo-login/route";

describe("System Status & Demo Login API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENABLE_DEMO_AUTH;
  });

  it("GET /api/system/status returns non-secret capability flags", async () => {
    const res = await getSystemStatus();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.appName).toBe("VeriRelease");
    expect(typeof body.githubOAuthConfigured).toBe("boolean");
    expect(typeof body.demoAuthEnabled).toBe("boolean");
    expect(["openai", "demo"]).toContain(body.aiMode);
    expect(["sandbox", "live", "mock"]).toContain(body.paypalMode);

    // Must never leak secrets
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("PRIVATE_KEY");
  });

  it("POST /api/auth/demo-login creates signed session cookie for fixed demo client persona", async () => {
    vi.mocked(prisma.user.upsert).mockResolvedValueOnce({
      id: "usr_demo_client_verirelease",
      email: "alice.client@verirelease.demo",
      name: "Alice Chen (Demo Client)",
      role: "CLIENT",
      githubUsername: "alice-verirelease",
      isActive: true,
      tokenVersion: 1,
    } as never);

    const req = new NextRequest("http://localhost:3000/api/auth/demo-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ persona: "client" }),
    });

    const res = await postDemoLogin(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      user: { id: string; role: string; email: string };
      isDemoSession: boolean;
    };
    expect(body.isDemoSession).toBe(true);
    expect(body.user.id).toBe("usr_demo_client_verirelease");
    expect(body.user.role).toBe("CLIENT");

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("vr_session=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("POST /api/auth/demo-login rejects invalid persona values", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/demo-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ persona: "superadmin" }),
    });

    const res = await postDemoLogin(req);
    expect(res.status).toBe(400);
  });

  it("POST /api/auth/demo-login rejects cross-origin CSRF attempts with cookies", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/demo-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "vr_session=abc",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ persona: "client" }),
    });

    const res = await postDemoLogin(req);
    expect(res.status).toBe(403);
  });
});
