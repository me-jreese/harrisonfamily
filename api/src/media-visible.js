// Is a Media object visible to members as a comment subject (HFY-TSK-387-0I, D-35, D-37)? A `media:<gramps_id>` thread is exactly as visible as the
// Media itself, and the person gallery's rules decide that: the cloud store holds only non-private objects (private Media and MediaRefs never reach it;
// a withdrawn head is a tombstone), and a Media is reachable only through a non-private MediaRef of a non-private Person. A Media that exists but that
// no gallery shows, a withdrawn one and one that does not exist are the same answer: false. A failed store read throws; the caller never reads it as open.
import { backrefs, byGrampsId, get } from "./records/index.js";

const lookups = { byGrampsId, backrefs, get };

/** True when a live Media with `grampsId` is public and a live, non-private Person lists it in a non-private MediaRef. `deps` is for tests. */
export async function isMediaPublished(ctx, grampsId, deps = lookups) {
  if (typeof grampsId !== "string" || grampsId === "") return false;
  for (const { handle } of await deps.byGrampsId(ctx, "Media", grampsId)) {
    const media = await deps.get(ctx, "Media", handle);
    if (!media || media.obj.private === true) continue;
    for (const key of await deps.backrefs(ctx, `Media:${handle}`)) {
      if (!key.startsWith("Person:")) continue;
      const person = await deps.get(ctx, "Person", key.slice(7));
      const list = Array.isArray(person?.obj?.media_list) ? person.obj.media_list : [];
      if (person && person.obj.private !== true && list.some((r) => r?.ref === handle && r.private !== true)) return true;
    }
  }
  return false;
}
