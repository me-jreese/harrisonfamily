// The ordered slots of the top bar's end group (.hfy-bar__end), owned by the shell (HFY-TSK-138, review DL-13): bell, chat, gear,
// account, in that order, whatever order the islands arrive in. The gear and the account control are the shell's own and carry
// data-slot themselves; the bell and the chat entry belong to other islands (the inbox, the chat), which fill only their own slot:
//
//   const off = window.HFYBarSlots.fill("bell", (host) => { /* mount into host */ return () => { /* unmount */ }; });
//
// A slot nobody has filled renders nothing, so it takes no space. A filled slot is a display:contents host span (data-slot), and its
// content is the filler's to size (a 44px target, shell.css). The registry lives on window because the islands are separate bundles.
export const SLOT_ORDER = ["bell", "chat", "gear", "account"];
export const FILLABLE = ["bell", "chat"];

function create() {
  const fillers = new Map();
  const subs = new Set();
  let version = 0;
  const emit = () => { version += 1; subs.forEach((f) => f()); };
  return {
    // fill(name, mount): mount(host) runs once the shell has put the slot's host element in the bar and may return a cleanup. A second
    // fill of the same slot replaces the first. Returns the function that withdraws this fill.
    fill(name, mount) {
      if (!FILLABLE.includes(name) || typeof mount !== "function") return () => {};
      const entry = { mount };
      fillers.set(name, entry);
      emit();
      return () => { if (fillers.get(name) === entry) { fillers.delete(name); emit(); } };
    },
    get: (name) => fillers.get(name),
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    snapshot: () => version,
  };
}

export function barSlots() {
  if (typeof window === "undefined") return create();
  if (!window.HFYBarSlots || typeof window.HFYBarSlots.fill !== "function") window.HFYBarSlots = create();
  return window.HFYBarSlots;
}
