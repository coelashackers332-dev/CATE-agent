// Reads .env (if present) and the environment once. Everything else imports `config`.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '8080')),
  baseUrl: env('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/$/, ''),
  adminSecret: env('ADMIN_SECRET') || randomBytes(12).toString('base64url'),
  demoMode: env('DEMO_MODE', '1') === '1',
  demoCallerNumber: env('DEMO_CALLER_NUMBER'),
  danielPhone: env('DANIEL_PHONE'),
  danielEmail: env('DANIEL_EMAIL'),
  messages: env('MESSAGES', 'log'),   // log | live
  payment: env('PAYMENT', 'sms'),     // sms | stripe
  model: env('MODEL', 'scripted'),    // scripted | nova
  twilio: {
    authToken: env('TWILIO_AUTH_TOKEN'),
    accountSid: env('TWILIO_ACCOUNT_SID'),
    number: env('TWILIO_NUMBER'),
  },
};
