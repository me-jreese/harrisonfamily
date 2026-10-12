// Island mounting helpers shared by every island (HFY-TSK-064 pattern; reuse in 065-068).
import { createRoot } from "react-dom/client";

/** Mount `Component` into every `[data-island="<name>"]` element; props come from its data-props JSON. */
export function mountIsland(name, Component) {
  document.querySelectorAll(`[data-island="${name}"]`).forEach((el) => {
    let props = {};
    try { props = JSON.parse(el.getAttribute("data-props") || "{}"); } catch { /* ignore */ }
    createRoot(el).render(<Component {...props} />);
  });
}

/** Mount `node` into a fresh host element created by `place(host)`. Returns the host. */
export function mountAt(place, node, id) {
  const host = document.createElement("div");
  if (id) host.id = id;
  place(host);
  createRoot(host).render(node);
  return host;
}
