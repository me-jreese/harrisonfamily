// The one NotifyApi for every notify surface (settings, bell, /me/inbox/): @io-kit/notify's fetch client over the same-origin API
// (/api/notifications/*, inbox routes included, 0.6.0) with the session cookie. With authV2 and a signed-out edge session every call can
// only answer 401 (a console error on each visit), so it is answered locally with that same 401 and not sent (HFY-TSK-069, D-11).
import { createFetchNotifyApi } from "@io-kit/notify";
import { edgeSignedOut, signedOutResponse } from "./api.js";

export const notifyApi = createFetchNotifyApi("/api", async (url, init) => ((await edgeSignedOut()) ? signedOutResponse() : fetch(url, { ...init, credentials: "include" })));
