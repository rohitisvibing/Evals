import { describe, expect, it } from "vitest";
import { isAdminUser, parseAdminEmails } from "@/lib/admin";
import { currentMonthKey, quotaResetsAt } from "@/lib/quota";

describe("admin allowlist", () => {
  const list = parseAdminEmails(" Admin@Example.com, ,not-an-email, ops@example.com ");
  it("parses and lowercases", () => expect([...list]).toEqual(["admin@example.com", "ops@example.com"]));
  it("requires a verified, allowlisted email", () => {
    expect(isAdminUser({ email: "ADMIN@example.com", app_metadata: { provider: "google" } }, list)).toBe(true);
    expect(isAdminUser({ email: "admin@example.com", email_confirmed_at: "2026-01-01" }, list)).toBe(true);
    expect(isAdminUser({ email: "admin@example.com", app_metadata: { provider: "email" } }, list)).toBe(false);
    expect(isAdminUser({ email: "someone@example.com", app_metadata: { provider: "google" } }, list)).toBe(false);
    expect(isAdminUser({ email: null }, list)).toBe(false);
    expect(isAdminUser({ email: "admin@example.com", app_metadata: { provider: "google" } }, new Set())).toBe(false);
  });
});

describe("UTC month boundaries", () => {
  it("resets at 00:00 UTC on the first of next month", () => {
    expect(quotaResetsAt(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(quotaResetsAt(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("month key uses UTC, not local time", () => {
    expect(currentMonthKey(new Date("2026-11-01T00:30:00+05:30"))).toBe("2026-10-01");
  });
});
