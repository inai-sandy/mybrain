# DEVICE-TOKEN-ROTATION — rotate the EMO device token without locking every device out

Filed as a file, not a Linear issue: the Linear workspace has hit its free issue limit. This path is
the issue id everywhere ship.sh, the branch and the sign-off would name one.

## Why (a real incident, 2026-09-08)

The firmware repo `github.com/inai-sandy/emo-device` was **public**, and it carries the shared EMO
device token as a plaintext literal in several boards' build files (capsule, watch, k10, and locally
pendant). The repo is private again as of today, but the token must be treated as **exposed** and
rotated.

Today's code makes that impossible to do safely. `api/src/auth/auth.service.ts` keeps ONE token in
the Setting `emo.device.token`; `regenerateDeviceToken()` overwrites it, so the moment the owner taps
Regenerate every device still running the old firmware is locked out. He has several prototypes
(pendant, capsule, watch, K10) and can only reflash them one at a time — pendant first.

## Build (one issue, one ship)

1. **Two live tokens with a grace period.** `emo.device.token` stays the current one. Add
   `emo.device.token.prev` and `emo.device.token.prev.until` (ISO). `verifyDeviceToken()` accepts
   either, compares against **both** candidates in constant time with no early return that leaks
   which one matched, and refuses `prev` once `prev.until` has passed. Default grace: **30 days**.
2. **Rotation that locks nobody out.** `regenerateDeviceToken()` moves the current token to `prev`,
   sets `prev.until = now + 30 days`, mints the new current and returns it. A separate revoke clears
   `prev` at once — that is the last step of the rotation.
3. **Tell the owner when it is safe to revoke.** Record `emo.device.token.prev.lastseen` and
   `emo.device.token.prev.count` whenever a request authenticates with the PREVIOUS token, and log
   one info line per such request with the route, so he can see which prototype is still on the old
   firmware. **No token value is ever logged, not even partially.**
4. **Settings → EMO → Device token shows:** the current token masked with Show/Copy exactly as today,
   a **Rotate** button with a plain-English warning of what happens, and — while a previous token is
   still live — a line "the old key was last used <when> (N requests). Revoke it once every device is
   updated." with a **Revoke now** button.
5. **A device key manages nothing, least of all itself.** The three device-key routes are
   `@SessionOnly()` — the global guard refuses `X-Device-Token` on them. Without this the whole
   feature is theatre: for 30 days the LEAKED key still signs in, so it could just read its own
   replacement out of `GET /auth/device-token`. Found by the code reviewer on this diff.
6. **Rotating twice in a row is refused unless the owner insists.** A second rotation would push the
   first old key out of the grace window on the spot — the exact lockout this exists to prevent. The
   server says so plainly; `{force:true}` (a second, different warning in the UI) is the owner
   deliberately accepting it after a fresh leak.
7. Locking tests, in `api/src/auth/auth.service.spec.ts`, `api/src/auth/device-key-routes.spec.ts`
   and `web/src/pages/SettingsDeviceToken.test.tsx`.

Nothing else about auth changes (cookies, sessions, the owner identity). No firmware in any sibling
tree is touched.

## Acceptance (WHEN / MUST)

- WHEN a device presents the CURRENT token, it MUST authenticate.
- WHEN a device presents the PREVIOUS token before `prev.until`, it MUST authenticate.
- WHEN a device presents the PREVIOUS token after `prev.until`, it MUST be refused.
- WHEN a device presents an unknown token, it MUST be refused.
- WHEN the owner rotates, the old token MUST keep working and `prev.until` MUST be set 30 days out.
- WHEN the owner revokes, the previous token MUST stop working immediately.
- WHEN the PREVIOUS token is used, `prev.lastseen` and `prev.count` MUST update; when the CURRENT
  token is used, they MUST NOT.
- WHEN anything about device auth is logged, no log line MUST contain any part of a token value.
- WHEN a request carries a valid device token, the three device-key routes MUST refuse it; every
  other device route MUST still accept it.
- WHEN the owner rotates while a previous key is still live, it MUST be refused with a plain reason
  unless he forces it.
- The existing device-auth specs MUST stay green; `tsc` clean in `api/` and `web/`.
