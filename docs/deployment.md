# Configuration and deployment

## 1. Supabase project

1. Create a project at supabase.com (Free tier). Note the **project ref**, **URL**, **anon key** and **service-role key** (Settings → API).
2. Apply migrations:
   ```bash
   pnpm exec supabase login
   pnpm exec supabase link --project-ref <ref>
   pnpm exec supabase db push        # applies supabase/migrations/*, incl. the private `documents` bucket and policies
   ```
3. Authentication → URL configuration:
   - **Site URL:** `https://<your-vercel-domain>`
   - **Redirect URLs:** `https://<your-vercel-domain>/auth/callback` and `http://localhost:3000/auth/callback`
4. Optional: Settings → Billing → keep the **spend cap on** if you upgrade to Pro.

## 2. Google OAuth client

1. In Google Cloud Console, go to APIs & Services → Credentials → **Create OAuth client ID** → *Web application*.
2. Set **Authorized JavaScript origins** to `https://<your-vercel-domain>` (plus `http://localhost:3000` for local use).
3. Set **Authorized redirect URI** to `https://<project-ref>.supabase.co/auth/v1/callback`. This is the *Supabase* callback, not the app's.
4. Configure the OAuth consent screen (scopes: `openid`, `email`, `profile`).
5. In Supabase, go to Authentication → Providers → **Google**, enable it, and paste the client ID and secret.
6. For the local stack, export `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `..._SECRET` before `pnpm db:start`. Also add `http://127.0.0.1:54321/auth/v1/callback` as an authorized redirect URI.

## 3. Provider keys

| Variable | Where | Notes |
|---|---|---|
| `TYPESAFE_API_KEY` | console.typesafe.ai/keys | Set usage alerts in the TypeSafe console |
| `OPENROUTER_API_KEY` | openrouter.ai/keys | Set a credit limit on the key. Buy $10 of credits to raise free-model limits to 1,000/day (needed for the full benchmark) |

## 4. Vercel

```bash
npm i -g vercel && vercel login
vercel link
# Public
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add NEXT_PUBLIC_SITE_URL production          # https://<your-vercel-domain>
# Server-only secrets
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add TYPESAFE_API_KEY production
vercel env add OPENROUTER_API_KEY production
vercel env add ADMIN_EMAILS production                  # e.g. you@gmail.com
vercel env add IP_HASH_SALT production                  # random string
vercel env add JEV_MODEL production                     # jev-1.14.0
vercel env add JUDGE_MODEL production                   # google/gemma-4-31b-it:free
vercel env add EMBEDDING_MODEL production               # baai/bge-m3
vercel --prod
```

Never prefix secrets with `NEXT_PUBLIC_`.

## 5. Seed and run the benchmark against the hosted project

```bash
# .env.local pointing at the hosted project (URL + service-role key + provider keys)
pnpm golden:verify
pnpm bench:seed                       # uploads + embeds the two public benchmark PDFs
pnpm bench --layers retrieval --notes "retrieval: lexical/vector/hybrid"
pnpm bench --layers decision,e2e --strategies lexical,vector,hybrid --max-judge-calls 500 \
  --notes "golden.v1 full run"
```

The integration tests and `scripts/smoke-http.ts` refuse to run against a non-local Supabase URL.

## 6. Post-deploy verification checklist

- [ ] Signed-out visitors can view `/` and `/benchmark`; `/api/evaluate` returns 401.
- [ ] Google sign-in round-trips to `/evaluate`.
- [ ] Uploading a PDF indexes it; a second user cannot see or download it.
- [ ] A claim on a benchmark document shows Jev and the judge side by side, with a trace.
- [ ] The usage meter increments; the 11th question in a month returns "quota exceeded" with the reset date.
- [ ] The allowlisted admin sees "Admin: exempt" and the Admin page; other users get 404 on `/admin`.
- [ ] Admin page shows provider calls, latency and costs, with no claim or document text.
