// MODEL=scripted: a stand-in for the voice model. It ignores audio and plays the golden-path call
// (STACK.md §3, steps 1–7) by calling the real tools in order, so the tools, screens and payment can be
// run end to end without a phone or a model. The Nova driver (model/nova.js) implements the same
// startSession interface (CONTRACTS.md §5).
// ponytail: one fixed script, no branching. It is a test harness and a last-resort demo, not a dialogue engine.

const STEP_MS = Number(process.env.SCRIPT_STEP_MS ?? 1200);   // pause between lines so the projector is readable
const pause = () => new Promise((resolve) => setTimeout(resolve, STEP_MS));
const lines = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);

export function startSession({ call, runTool, emit }) {
  let closed = false;
  const say = (text) => emit(call.id, 'cate_said', { text });
  const hear = (text) => emit(call.id, 'caller_said', { text });

  /** Run a tool; a refusal ends the script with the tool's own plain-words error. */
  async function tool(name, args = {}) {
    const result = await runTool(name, args, call);
    if (result?.ok === false) throw new Error(result.error);
    return result;
  }

  async function play() {
    const script = [
      () => say("Hello, this is CATE, Cathay's personal booking service. To check it's you: where did you last fly with us?"),
      () => hear('Osaka, last May.'),
      async () => {
        const v = await tool('verify_caller', { answer: 'Osaka, last May' });
        if (!v.verified) throw new Error('verification did not pass');
        await tool('apply_profile');
        say('Thank you, Mr Wong. Which service would you like today: book a flight, change a booking, or a special request?');
      },
      () => hear('Book a flight. Osaka again, after Christmas, back before New Year.'),
      async () => {
        const found = await tool('find_flights', { to: 'Osaka', after: '2026-12-25', before: '2027-01-01' });
        call.scriptChoice = found.options[0].id;
        for (const line of [...lines(found.read_out), ...lines(found.return_flight)]) say(line);
        say(/trip page/.test(found.next) ? 'They are also on your trip page, in the email I just sent. Which one would you like?' : 'Shall I text these to you?');
        call.scriptSent = /trip page/.test(found.next);
      },
      async () => {
        if (call.scriptSent) return;
        hear('Yes, please.');
        await tool('text_options');
        say("I'm texting you now. Which one would you like?");
      },
      () => hear('The first one.'),
      async () => { say((await tool('choose_option', { option_id: call.scriptChoice })).confirm); say('Your membership has a window seat near the front and a vegetarian meal. Is that still right?'); },
      () => hear('Seat 21A this time, please. The meal is fine.'),
      async () => { say((await tool('set_preferences', { seat_ok: false, meal_ok: true, seat_number: '21A' })).confirm); say('On your Osaka trip we arranged a wheelchair to the gate. The same again?'); },
      () => hear('Yes, please.'),
      async () => { const a = await tool('set_assistance', { same_as_last_trip: true }); say(a.summary); say('Would you like any extra baggage?'); },
      () => hear('One extra bag.'),
      async () => { say((await tool('set_baggage', { extra_bags: 1 })).confirm); say('Is there anything else we should arrange for this trip?'); },
      () => hear("It's my wife's birthday on the 26th."),
      async () => {
        say((await tool('set_special_request', { request: "His wife's birthday on 26 December" })).confirm);
        const first = await tool('hold_booking', {});
        for (const line of lines(first.readback)) say(line);
      },
      () => hear('Yes.'),
      async () => {
        const held = await tool('hold_booking', { caller_confirmed: true });
        say(`Your booking is held. Your reference is ${held.ref_spoken}.`);
        if (held.sent_to) { say("The payment page is now open on your phone. I'll stay on the line."); return; }
        const sent = await tool('send_pay_link');
        say(`I've sent the pay request to ${sent.sent_to}. I'll stay on the line.`);
      },
    ];
    for (const step of script) {
      if (closed) return;
      await step();
      await pause();
    }
  }

  play().catch((err) => {
    if (!closed) say(`I'm sorry, I can't go on with this call: ${err.message}`);
  });

  return {
    audioIn() {},   // no audio in the scripted run
    notify(text) {
      if (closed) return;
      say(`${text}. Your booking is confirmed. I've texted you your booking and your needs card: show it to staff at the airport. Have a good trip, Mr Wong.`);
    },
    close() { closed = true; },
  };
}
