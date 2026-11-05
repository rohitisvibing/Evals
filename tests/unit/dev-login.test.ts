import { describe, expect, it } from "vitest";
import { isDevLoginEnabled, devLoginEmail } from "@/lib/dev-login";

const local = { DEV_LOGIN: "1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };

describe("local login bypass guard", () => {
  it("is on only with the flag set and a local Supabase", () => {
    expect(isDevLoginEnabled(local)).toBe(true);
    expect(isDevLoginEnabled({ ...local, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })).toBe(true);
  });
  it("is off without the explicit flag", () => {
    expect(isDevLoginEnabled({ ...local, DEV_LOGIN: undefined })).toBe(false);
    expect(isDevLoginEnabled({ ...local, DEV_LOGIN: "true" })).toBe(false);
  });
  it("is off against any hosted Supabase project", () => {
    expect(isDevLoginEnabled({ ...local, NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co" })).toBe(false);
    expect(isDevLoginEnabled({ ...local, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1.evil.com" })).toBe(false);
    expect(isDevLoginEnabled({ ...local, NEXT_PUBLIC_SUPABASE_URL: "" })).toBe(false);
  });
  it("is off on Vercel even if misconfigured", () => {
    expect(isDevLoginEnabled({ ...local, VERCEL: "1" })).toBe(false);
  });
  it("uses a fixed local email by default", () => {
    expect(devLoginEmail({})).toBe("dev@localhost.test");
    expect(devLoginEmail({ DEV_LOGIN_EMAIL: "me@x.test" })).toBe("me@x.test");
  });
});
