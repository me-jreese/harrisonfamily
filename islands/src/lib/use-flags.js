// The feature flags once resolved ({} until then, or when feature-flags.js is missing). Shared by the islands that read a flag at run time
// (review.jsx, editor.jsx); `undefined` while the answer is on its way, so a caller can keep its skeleton.
import { useEffect, useState } from "react";

export function useFlags() {
  const [flags, setFlags] = useState(undefined);
  useEffect(() => {
    let live = true;
    const resolve = window.HFYFeatureFlags?.resolveFlags;
    Promise.resolve(typeof resolve === "function" ? resolve() : {}).then(
      (f) => { if (live) setFlags(f && typeof f === "object" ? f : {}); },
      () => { if (live) setFlags({}); },
    );
    return () => { live = false; };
  }, []);
  return flags;
}
