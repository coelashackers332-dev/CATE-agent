// MODEL=echo: plays the caller's own voice back half a second later. Tests the phone audio path end to end
// (Twilio or the laptop bridge) before the voice model is wired in. No tools, no screens.
const DELAY_MS = 500;

export function startSession({ sendAudio }) {
  let closed = false;
  return {
    audioIn(pcm) {
      const copy = pcm.slice();
      setTimeout(() => { if (!closed) sendAudio(copy); }, DELAY_MS);
    },
    notify() {},
    close() { closed = true; },
  };
}
