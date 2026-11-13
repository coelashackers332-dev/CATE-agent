// What happens when a booking is paid, whichever way the payment arrives ('sms' reply today, 'stripe' later).
import { emit } from './events.js';
import { store, findOrder, findMember, setOrderStatus } from './store.js';

export function createPayment({ messages, texts, baseUrl }) {
  // The trip page for this booking. CONTRACTS.md does not say who sets page.ref after the hold, so if no
  // page carries the ref yet, the member's latest page without one (made by text_options) is linked here.
  function tripLink(order) {
    const pages = [...store.pages];
    const entry = pages.find(([, page]) => page.ref === order.ref)
      ?? pages.findLast(([, page]) => page.ref == null && page.member_id === order.member_id);
    if (!entry) return '';
    entry[1].ref = order.ref;
    return `${baseUrl}/v/${entry[0]}`;
  }

  /** Idempotent: the first call for a held order marks it paid; repeats and unknown refs do nothing. */
  async function onPaid(ref, source) {
    const order = findOrder(ref);
    if (!order || order.status !== 'held' || store.paidEvents.has(ref)) return false;
    store.paidEvents.add(ref);
    setOrderStatus(ref, 'paid');

    const payer = (order.payer || 'Daniel').split(' ')[0];
    emit(store.activeCall?.id ?? null, 'system', {
      system: 'Payment', action: 'paid', ok: true, summary: `✓ ${payer} paid for ${ref} (${source})`,
    });

    // Text 2 goes to the traveller's number on file, with the same trip page link as text 1.
    const member = findMember(order.member_id);
    try {
      if (member) await messages.sendSms(member.phone, texts.bookedSms(order, member, tripLink(order)));
    } catch (err) {
      console.error(`[payment] text 2 for ${ref} not sent: ${err.message}`);   // the booking is still paid
    }
    store.activeCall?.session?.notify?.(`${payer} has paid for booking ${ref}`);
    return true;
  }

  return { onPaid };
}
