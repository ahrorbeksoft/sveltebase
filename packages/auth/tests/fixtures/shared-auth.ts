import { createAuth } from '../../src/client/index.js';
export type User = { id: string; name: string };
export type Claims = { role?: string };
export const auth = createAuth<User, Claims>();
