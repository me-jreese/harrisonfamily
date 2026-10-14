// Photo tag editor island (HFY-TSK-260, flag photoTagEdit; BRD2 R-31, D2-24): draw, move, resize and remove person tags on the person page's
// lightbox photo, through POST /api/changes. It listens to the same two events of the person page's mount points as the photo tags island
// (HFY-TSK-137) and edits nothing of the page's own markup:
//   hfy:person-rendered { personId, person, sections }   after every render: the person, for the names' roles
//   hfy:lightbox-media  { index, media, img, box }        whenever the lightbox shows an image: the toggle and, with it on, the editor
// A tag that saved now is put into media.tags and announced with `hfy:tags-edited` (the lightbox detail again), which the photo tags island redraws from.
// The member sees the toggle only when signed in and /api/me does not say editing is off; the server decides every write.
import "../photo-tag-edit.css";
import { showTagEditor } from "../lib/photo-tag-edit-ui.jsx";

let person = null;
document.addEventListener("hfy:person-rendered", (e) => { person = (e.detail && e.detail.person) || null; });
document.addEventListener("hfy:lightbox-media", (e) => { showTagEditor(e.detail, person); });
