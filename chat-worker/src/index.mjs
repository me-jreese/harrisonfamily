// The chat Worker entry (chat.md sections 5, 14.1 and 17): about 30 lines of wiring around @io-kit/chat/cloudflare.
//
//   - `ChatHub` is the Durable Object class the wrangler migration declares (v1, new_sqlite_classes). The kit's hub is
//     hibernating (tagged acceptWebSocket, a registered auto-response, one storage alarm and no timers). The R-18 detector,
//     shared/privacy-guard.mjs, is injected as its `contactGuard`.
//   - The default export is the Worker. The kit's `createChatWorker` checks the exact Origin, the kill switch, the io_id
//     session against the JWKS and the UAT list, then hands the hub a NEW Request that carries only x-chat-uid and
//     x-chat-exp (plus the upgrade handshake headers): never the Cookie. The hub object is created with
//     locationHint "wnam" on its first get().
//   - POST /chat/v1/admin/expunge {conv, seq} is the one other request the Worker answers, and only when the CHAT_ADMIN_TOKEN secret
//     is set (admin.mjs, expunge.mjs): it nulls one message's text and keeps its seq and sender.
//   - Every other request on the two routes goes on to CloudFront with fetch(request).
import { chatHubClass, createChatWorker } from "@io-kit/chat/cloudflare";
import { contactGuard, makeHandler } from "./common.mjs";
import { withExpunge } from "./expunge.mjs";

// The kit's hub plus the admin expunge route (HFY-TSK-337, expunge.mjs).
export const ChatHub = withExpunge(chatHubClass({ contactGuard }));

// Exported for the tests that run the shared R-18 vectors against the guard exactly as it is bundled here.
export { contactGuard };

const worker = createChatWorker();

export default { fetch: makeHandler(() => worker) };
