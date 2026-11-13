// Service credential between cathay.js and the mock Cathay systems: random per process, never leaves it.
// It keeps /mock-cathay closed to anything but our own adapter, even when the server is on the public internet.
// Production: the client credentials Cathay issues for its own APIs.
import { randomBytes } from 'node:crypto';

export const serviceKey = randomBytes(16).toString('base64url');
