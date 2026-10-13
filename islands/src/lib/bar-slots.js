// The ordered slots of the top bar's end group (.hfy-bar__end), owned by the shell (HFY-TSK-138, review DL-13): bell, chat, gear,
// account, in that order, whatever order the islands arrive in. The gear and the account control are the shell's own and carry
// data-slot themselves; the bell and the chat entry belong to other islands (the inbox, the chat), which fill only their own slot:
//
//   const off = window.HFYBarSlots.fill("bell", (host) => { /* mount into host */ return () => { /* unmount */ }; });
//
// A slot nobody has filled renders nothing, so it takes no space. A filled slot is a display:contents host span (data-slot), and its
// content is the filler's to size (a 44px target, shell.css). The registry lives on window because the islands are separate bundles.
//
// Load-order contract: window.HFYBarSlots is created by the first barSlots() call, which the shell bundle makes when it executes. An
// island that runs before the shell must therefore not read window.HFYBarSlots directly: it must either run after the shell script or
// create-or-reuse the registry through this module's barSlots() (the shell then adopts it, fills made earlier included). Only the
// bell and chat get host spans: the gear and the account control carry data-slot themselves, so the .hfy-bar__end > * order holds.
// A throwing mount is caught by the shell (the slot stays empty); a rejected fill() or a replaced fill logs a console warning.
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
      if (!FILLABLE.includes(name) || typeof mount !== "function") {
        console.warn(`HFYBarSlots.fill: rejected (slot ${JSON.stringify(name)} must be one of ${FILLABLE.join(", ")}; mount must be a function)`);
        return () => {};
      }
      if (fillers.has(name)) console.warn(`HFYBarSlots.fill: the ${name} slot was already filled; the new fill replaces it`);
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
  if (!window.HFYBarSlots || typeof window.HFYBarSlots.fill !== "function") {
    if (window.HFYBarSlots) console.warn("HFYBarSlots: window.HFYBarSlots is malformed and is being replaced; fills made on it are dropped");
    window.HFYBarSlots = create();
  }
  return window.HFYBarSlots;
}
