// HttpError, kept free of imports so the store view (records/index.js, sync/store.js) loads without the kit packages (HFY-TSK-274:
// the hfy-graph-render Lambda ships that view without hfy-api's dependencies). http.js re-exports it.
export class HttpError extends Error {
  /**
   * `details` (optional) is sent as the body's `details`: `{fields: [{field, code, suggest?}]}` on a 422, `{current}` on a 409, or
   * a SyncError's structured conflict description (src/sync/apply.js).
   */
  constructor(status, code, message, details, headers) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (headers !== undefined) this.headers = headers; // extra response headers, for example WWW-Authenticate on a 401 (HFY-TSK-172)
  }
}
