# BMG PMS: CI/CD pipeline

```
 push / pull request ──► CI ──────────────────────────────────────────────┐
                          ├ checks: lint · db:check (module boundaries,      │
                          │   re-run safety, property isolation, locks) ·    │
                          │   npm audit · secret scan · production build     │
                          ├ tests: 15 suites in parallel                     │
                          └ e2e: real app + PostgREST + browser, 4 widths    │
 pull request ──► Preview: pr-<n> site on the staging database               │
 main green ──► Deploy ──► staging (automatic) ──► production targets ──► release tag
                                                   (approval each)
 every night ──► Nightly: the whole CI on main
 weekly ──► Dependabot pull requests (go through CI like any change)
```

| Workflow | File | Runs |
|---|---|---|
| CI | `.github/workflows/ci.yml` | every push and pull request |
| E2E (browser) | `.github/workflows/e2e.yml` | from CI when screens or migrations change, always on main; by hand |
| Preview | `.github/workflows/preview.yml` | pull requests that change the app |
| Deploy | `.github/workflows/deploy.yml` + `deploy-target.yml` | after CI is green on main; by hand to redeploy or roll back |
| Nightly | `.github/workflows/nightly.yml` | 02:00 Dar es Salaam |

Each deploy target runs, in order: settings check → database reachable → migrations in **one transaction**
(all or nothing) → **isolation report must be empty** → Edge Functions → build with that target's public keys →
publish to Netlify → smoke test (site answers and says BMG PMS; Supabase API answers). Any step failing stops
that target; production is never touched if staging failed.

## One-time setup (about 30 minutes)

1. **Netlify.** Create two sites, e.g. `bmg-pms-staging` and `bmg-pms` (production). In each: Site configuration →
   Build & deploy → **Stop builds** (the pipeline builds and publishes; Netlify only hosts). Copy each **Site ID**.
   User settings → Applications → **New access token** → `NETLIFY_AUTH_TOKEN`.
2. **Supabase.** Two projects: `bmg-pms-staging` and `bmg-pms-prod`. For each note the project ref, URL, anon key and
   the database connection string (session pooler). Account → Access tokens → `SUPABASE_ACCESS_TOKEN`.
3. **GitHub → Settings → Environments.** Create three:

   | Environment | Protection | Secrets | Variables |
   |---|---|---|---|
   | `staging` | Deployment branches: `main` | `SUPABASE_DB_URL`, `SUPABASE_ACCESS_TOKEN`, `NETLIFY_AUTH_TOKEN` | `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NETLIFY_SITE_ID`, `APP_URL` |
   | `production` | Required reviewers: you + one more; branches: `main`; wait timer 5 min (optional) | same names, production values | same names, production values |
   | `preview` | none | `NETLIFY_AUTH_TOKEN` | staging's `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `NETLIFY_SITE_ID` |

   The anon key is public by design (it is in every browser); it is a variable, not a secret. The `service_role` key is
   never needed by the pipeline or the app.
4. **Branch protection** (Settings → Branches → `main`): require a pull request, 1 approval, **review from Code
   Owners**, status checks `checks` and `tests` (all matrix entries) passing, branches up to date, and no force pushes.
   Edit `.github/CODEOWNERS` with your GitHub usernames.
5. Push to `main`. Watch Actions → Deploy: staging goes out, production waits for approval.

## A property on its own database

All properties share one database by default; migration 21 and the isolation tests keep their data apart. If a
property must have its own database (contract, data residency, size), create a Supabase project and Netlify site for
it, add a GitHub Environment named e.g. `prod-pumzika` with its values, and set the repository variable
`PRODUCTION_TARGETS` to `["production","prod-pumzika"]`. Every release then goes to each target one after the
other, each with its own approval, checks and smoke test. The code is identical; only the data is separate.

## Day to day

- **Change something:** branch → commit → pull request. CI runs; a preview link appears in the pull request.
- **Database change:** add `supabase/migrations/NN_what_it_does.sql` starting with `-- module: <module>` (see
  `supabase/modules.json`). Run `npm run db:check`; if it says the module locks differ and that is intended, run
  `npm run db:lock` and commit `supabase/schema/`. The pull request then shows exactly which module's objects changed.
- **Release:** merge the pull request. Staging updates; approve production in Actions. A `release-YYYYMMDD-HHMM` tag
  marks what went live.
- **Roll back the app:** Actions → Deploy → Run workflow → `ref` = the previous release tag. Database migrations only
  go forward: fix forward with a new migration (each file is safe to re-run), or restore with Supabase
  point-in-time recovery for data mistakes.
- **Hotfix:** branch from `main`, pull request, merge; same pipeline, nothing skipped.

## Running the same checks locally

```bash
npm ci
npm run lint
npm run db:check      # module boundaries, re-run safety, isolation, lock files
npm test              # all 15 suites
```
