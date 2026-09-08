import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * DEVICE-TOKEN-ROTATION — a device key manages nothing, least of all itself.
 *
 * The EMO device key is shared by every prototype and one copy of it leaked in a public firmware
 * repo. Rotation keeps the OLD key working for 30 days so the boards can be reflashed one at a time
 * — which means that for 30 days the LEAKED key still signs in. If it could reach the device-key
 * routes it would simply read its own replacement out of `GET /auth/device-token` and the rotation
 * would buy nothing at all. These three routes are session-only, and this is the lock on that.
 */
const owner = { id: 'u1', email: 'owner@example.com' };

function build() {
  const auth = {
    verifyToken: (t: string) => (t === 'good-cookie' ? owner : null),
    issueToken: () => 'refreshed-cookie',
    verifyDeviceToken: () => true, // the device key is valid — the routes must refuse it anyway
    deviceUser: () => owner,
  } as unknown as AuthService;
  return new AuthGuard(new Reflector(), auth);
}

const ctx = (handler: any, headers: any, cookies: any = {}) =>
  ({
    getHandler: () => handler,
    getClass: () => AuthController,
    switchToHttp: () => ({
      getRequest: () => ({ headers, cookies, method: 'GET', url: '/api/auth/device-token', path: '/api/auth/device-token' }),
      getResponse: () => ({ cookie: () => undefined }),
    }),
  }) as any;

const DEVICE_KEY_ROUTES = [
  AuthController.prototype.deviceToken,
  AuthController.prototype.regenerateDeviceToken,
  AuthController.prototype.revokePreviousDeviceToken,
];

describe('the device-key routes are session-only', () => {
  it('refuses a VALID device token on every device-key route', () => {
    const guard = build();
    for (const route of DEVICE_KEY_ROUTES) {
      expect(() => guard.canActivate(ctx(route, { 'x-device-token': 'a real device key' }))).toThrow(/sign in on the website/i);
    }
  });

  it('lets the owner’s browser session through', () => {
    const guard = build();
    for (const route of DEVICE_KEY_ROUTES) {
      expect(guard.canActivate(ctx(route, {}, { mb_session: 'good-cookie' }))).toBe(true);
    }
  });

  it('leaves every OTHER route reachable by the device, as before', () => {
    const guard = build();
    const ordinary = AuthController.prototype.me;
    const req: any = { headers: { 'x-device-token': 'a real device key' }, cookies: {}, method: 'POST', path: '/api/emo/capture' };
    const ok = guard.canActivate({
      getHandler: () => ordinary,
      getClass: () => AuthController,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ cookie: () => undefined }) }),
    } as any);
    expect(ok).toBe(true);
    expect(req.user).toEqual(owner);
  });
});
