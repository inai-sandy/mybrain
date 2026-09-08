import { SetMetadata } from '@nestjs/common';

export const SESSION_ONLY = 'sessionOnly';
/**
 * Mark a route as reachable ONLY with the owner's browser session — an EMO device token is refused
 * even though it normally carries the owner's identity.
 *
 * This is what keeps a rotation honest (DEVICE-TOKEN-ROTATION). The device key is shared by every
 * prototype and one copy of it leaked; during the 30-day grace period the OLD key still signs in. If
 * the routes that read, rotate or revoke the device key accepted a device token, whoever holds the
 * leaked key could simply read the brand-new one out of `GET /auth/device-token` and the rotation
 * would buy nothing. Device keys manage nothing — only the owner, signed in on the site, does.
 */
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true);
