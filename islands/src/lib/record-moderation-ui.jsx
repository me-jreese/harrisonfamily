// The record moderation controls on the person page (HFY-TSK-216; flags moderationV1 and moderationRecordsV1), the UI half of lib/record-moderation.js.
// Controls mount from the person page's two events only (hfy:person-rendered and hfy:lightbox-media; 11ty/js/person-page.js is not edited):
//   a "moderate story" control under each story (a record note), and a "moderate photo" control in the lightbox header for the photo shown.
// An admin sees a "hidden" badge on an item the records API reports as hidden. Every label is a text node; the server re-checks admin on every call.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.js";
import { ModerateControl } from "./moderation-ui.jsx";
import { COPY, applyAction, createRecordClient, hiddenSetOf, mediaTarget, mediarefTarget, noteTarget, photoRows, shownNotes, storyRows, targetKey } from "./record-moderation.js";

const client = createRecordClient(api);
const roots = new Map(); // host element -> React root

/** Renders `element` into `host`, replacing what an earlier call put there; a host that left the page lets its root go. */
function mount(host, element) {
  for (const [h, r] of roots) if (!h.isConnected) { r.unmount(); roots.delete(h); }
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  root.render(element);
}

/** The shared hidden set of the page: the controls read it and report changes to it. */
export function createState(initial) {
  let hidden = new Set(initial);
  const listeners = new Set();
  return {
    get: () => hidden,
    set(next) { hidden = next; listeners.forEach((l) => l(hidden)); },
    on(l) { listeners.add(l); return () => listeners.delete(l); },
  };
}

function useHidden(state) {
  const [hidden, setHidden] = useState(() => state.get());
  useEffect(() => state.on(setHidden), [state]);
  return hidden;
}

function StoryControl({ note, state }) {
  const hiddenSet = useHidden(state);
  const key = targetKey(noteTarget(note.handle));
  const hidden = hiddenSet.has(key);
  const onAct = async (input) => {
    await client.act(noteTarget(note.handle), input);
    state.set(applyAction(state.get(), key, input));
  };
  return (
    <>
      {hidden && <span className="hfy-mod__badge" data-hfy-record-badge="story">{COPY.badgeHiddenStory}</span>}
      <ModerateControl rows={storyRows({ hidden })} onAct={onAct} name={COPY.triggerStory} />
    </>
  );
}

function PhotoControl({ person, media, state }) {
  const hiddenSet = useHidden(state);
  const here = targetKey(mediarefTarget(person, media));
  const all = targetKey(mediaTarget(media));
  const hiddenHere = hiddenSet.has(here);
  const hiddenAll = hiddenSet.has(all);
  const onAct = async (input) => {
    const target = input.scope === "media" ? mediaTarget(media) : mediarefTarget(person, media);
    await client.act(target, input);
    state.set(applyAction(state.get(), targetKey(target), input));
  };
  return (
    <>
      {(hiddenHere || hiddenAll) && <span className="hfy-mod__badge" data-hfy-record-badge="photo">{COPY.badgeHiddenPhoto}</span>}
      <ModerateControl photo rows={photoRows({ hiddenHere, hiddenAll })} onAct={onAct} name={COPY.triggerPhoto} />
    </>
  );
}

/** The story elements the page drew for `person.notes`, and which mode drew them. */
function storyElements() {
  const cards = [...document.querySelectorAll("#person-stories-section .hfy-notes > .card")];
  if (cards.length > 0) return { mode: "island", els: cards };
  return { mode: "legacy", els: [...document.querySelectorAll("#person-stories-section .notes-panel > article.story")] };
}

/** Fills each story with its control. The notes island mounts after the page's first render, so the caller runs this again when the panel changes. */
export function mountStories(person, state) {
  const { mode, els } = storyElements();
  const notes = shownNotes(person?.notes, mode);
  els.forEach((el, i) => {
    const note = notes[i];
    if (!note || els.length !== notes.length) return; // a card with no matching note is never given a control
    let host = el.querySelector(":scope > .hfy-mod__story");
    if (!host) {
      host = document.createElement("div");
      host.className = "hfy-mod__story";
      host.setAttribute("data-hfy-record-story", note.handle);
      el.append(host);
    }
    mount(host, <StoryControl note={note} state={state} />);
  });
}

/** The control for the photo the lightbox shows now, in the lightbox header's actions. */
export function mountPhoto(person, detail, state) {
  const handle = detail?.media?.handle;
  const actions = document.querySelector(".lightbox-actions");
  if (!actions || typeof handle !== "string" || typeof person?.handle !== "string") return;
  let host = actions.querySelector(":scope > .hfy-mod__lightbox");
  if (!host) {
    host = document.createElement("span");
    host.className = "hfy-mod__lightbox";
    host.setAttribute("data-hfy-record-photo", "");
    actions.prepend(host);
  }
  mount(host, <PhotoControl key={handle} person={person.handle} media={handle} state={state} />);
}

export { hiddenSetOf };
