## What changes

<!-- One or two sentences: the user-visible effect. -->

## Checklist

- [ ] `npm run check` and `npm test` pass.
- [ ] New or changed Apple requests are covered by a test using `fakeApi` or `withContract`, so they are checked against Apple's schema.
- [ ] Writes respect `readOnly`, `allowedAppIds` and ownership checks, and preview with `--execute` when they change prices, availability, team access, signing or many items at once.
- [ ] Help in `src/help.ts` is updated, and `npm run docs` was run.
- [ ] `CHANGELOG.md` has an entry; breaking changes are marked.
- [ ] No credentials, real issuer IDs or customer data in code, tests or this description.
