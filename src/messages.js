// Outgoing SMS and email. mode 'log' prints them to the console; 'live' sends SMS through Twilio.
import twilio from 'twilio';
import { config } from './config.js';
import { emit } from './events.js';
import { store } from './store.js';

const maskPhone = (n) => `***${String(n).slice(-4)}`;
const maskEmail = (a) => String(a).replace(/^(.).*@/, '$1***@');

// Events never carry phone numbers or email addresses, so the projector only sees that a message went out.
function report(action, ok, summary) {
  emit(store.activeCall?.id ?? null, 'system', { system: 'Messages', action, ok, summary });
}

export function createMessages({ mode = config.messages } = {}) {
  let client = null;

  return {
    async sendSms(to, body) {
      if (mode !== 'live') {
        console.log(`[SMS] to ${maskPhone(to)}\n${body}\n`);
        report('send_sms', true, '✓ text sent (printed, not sent to a phone)');
        return;
      }
      try {
        client ??= twilio(config.twilio.accountSid, config.twilio.authToken);
        await client.messages.create({ from: config.twilio.number, to, body });
      } catch (err) {
        report('send_sms', false, '✗ text not sent');
        throw new Error(`SMS to ${maskPhone(to)} failed: ${err.message}`);
      }
      report('send_sms', true, '✓ text sent');
    },

    async sendEmail(to, subject, html, text) {
      if (mode !== 'live') {
        console.log(`[EMAIL] to ${maskEmail(to)} | ${subject}\n${text ?? '(HTML only)'}\n`);
        report('send_email', true, '✓ email sent (printed, not sent to an inbox)');
        return;
      }
      report('send_email', false, '✗ email not sent');
      throw new Error('Live email is not set up yet. Use MESSAGES=log, or add an email sender to sendEmail in src/messages.js.');
    },
  };
}
