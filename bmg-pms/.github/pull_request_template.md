## What changes

## Modules touched
<!-- CI lists them under "Database changes in this pull request". One module per migration where possible. -->

## Checklist
- [ ] New migration starts with `-- module: <name>` (and `-- also: …` if it changes another module)
- [ ] `npm run db:lock` run and `supabase/schema/` committed if the database changed
- [ ] New property tables have `property_id` (required), row level security, and no link to another property's rows (`npm run db:check` enforces this)
- [ ] Tests added or updated; `npm test` passes
- [ ] Tried on the preview site (link in the bot comment)
