import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { SignInButton } from "./SignInButton";
import { DevLoginButton } from "./DevLoginButton";
import { Metric } from "./Metric";
import { limits } from "@/lib/constants";

export function Mark() {
  // Two halves of one square: two judges reading the same evidence.
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <rect x="1" y="1" width="18" height="18" rx="4" fill="none" stroke="#000" strokeWidth="1.5" />
      <path d="M5 15 L15 5 L15 15 Z" fill="#000" />
    </svg>
  );
}

export function Header({ user, used }: { user: SessionUser | null; used: number | null }) {
  return (
    <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-line">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center gap-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Mark />
          <span className="hidden min-[400px]:inline">Observatory</span>
        </Link>
        <nav className="ml-auto flex items-center gap-0.5 sm:gap-3 text-[13px] whitespace-nowrap">
          <Link href="/benchmark" className="px-1.5 sm:px-2 py-1 rounded-md text-ink2 hover:text-ink">Benchmark</Link>
          <Link href="/evaluators" className="px-1.5 sm:px-2 py-1 rounded-md text-ink2 hover:text-ink">Evaluators</Link>
          {user?.isAdmin && <Link href="/admin" className="px-2 py-1 rounded-md text-ink2 hover:text-ink">Admin</Link>}
          {user ? (
            <>
              {used !== null && (
                <span className="hidden sm:inline-flex items-center gap-2 text-ink2 tabular">
                  <Metric k="quota" align="end">
                    {user.isAdmin ? "Unlimited" : `${used} / ${limits.monthlyQuestions}`}
                  </Metric>
                  {!user.isAdmin && <QuotaBar used={used} />}
                </span>
              )}
              <form action="/auth/signout" method="post">
                <button className="btn btn-sm" title={user.email ?? undefined}>Sign out</button>
              </form>
            </>
          ) : (
            <>
              <span className="hidden md:block"><DevLoginButton small /></span>
              <SignInButton next="/" label="Sign in" small />
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

function QuotaBar({ used }: { used: number }) {
  const pctUsed = Math.min(100, (used / limits.monthlyQuestions) * 100);
  return (
    <span className="w-14 h-1 rounded-full bg-neutral-bg overflow-hidden" aria-hidden>
      <span className="block h-full bg-black" style={{ width: `${pctUsed}%` }} />
    </span>
  );
}
