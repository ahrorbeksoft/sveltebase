import { base64urlDecode } from '../index.js';
import type { GoogleData } from './types.js';

/** Decodes an ID-token payload without verifying it. Never use this for authentication. */
export function decodeCredentials<T = GoogleData>(credential: string): T {
  const parts = credential.split('.');
  if (parts.length !== 3)
    throw new Error('Invalid token status: JWT must have 3 parts');
  return JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1]))) as T;
}
