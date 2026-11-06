// Photo tag editor island (HFY-TSK-260 flag photoTagEdit; HFY-TSK-388-0G pass 2 swaps the editor for the kit's, @io-kit/media/tags): tag people on the person
// page's lightbox photo, through POST /api/changes behind the HFY tag ports. It listens to the lightbox event of the person page's mount points and edits nothing of
// the page's own markup:
//   hfy:lightbox-media  { index, media, img, box }   whenever the lightbox shows an image: the toggle and, with it on, the editor
// A tag that saved is put into media.tags and announced with `hfy:tags-edited`, which the photo tags island redraws from.
import { showTagEditor } from "../lib/person-tag-editor.jsx";

document.addEventListener("hfy:lightbox-media", (e) => { showTagEditor(e.detail); });
