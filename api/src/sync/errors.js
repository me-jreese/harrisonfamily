// The failure type of the sync write path (HFY-TSK-243, HFY-TSK-245). It lives apart from apply.js so that the validator can throw it
// without importing the module that calls the validator.
import { HttpError } from "../http.js";

/** An applyBatch failure with an HTTP status and, for a conflict, the per-op detail. Routes pass it through errorResponse(). */
export class SyncError extends HttpError {
  constructor(status, code, message, details) {
    super(status, code, message, details);
    this.name = "SyncError";
  }
}
