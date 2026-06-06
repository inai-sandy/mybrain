import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Mark a route as accessible without authentication. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
