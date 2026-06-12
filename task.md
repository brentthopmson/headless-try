# Task: Debug Duplicate Rows and Re-authenticate Sheets API

## Status
- [x] Fix FAILED rows re-processing in `route.js`.
- [x] Add detailed debug logging to `route.js` and `routeHelper.js` to trace duplicate/wrong row issues.
- [ ] Create `generate-auth-url.js` to generate OAuth2 URL for user verification.
- [ ] Run `generate-auth-url.js` and provide the URI to the user.
- [ ] User to visit URI and provide code.
- [ ] Exchange code for token (if asked).
- [ ] Verify if Sheets API works without fallback (resolving `invalid_grant`).
- [ ] Monitor duplicate row issue after re-auth.
