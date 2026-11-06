"""Media thumbnails in the render (HFY-TSK-393, D-38): the sidecar contract, the ``thumb`` field of media/index.json and
media/<handle>.json, and the sync renderer's re-render when hfy-graph-render changes the sidecar. Standard library only; the synthetic
tree is the only data, and no image is decoded here (the JPEG work is hfy-graph-render's, tested by graph/test/cloud-thumbs.test.mjs).
Run: python3 -m unittest discover gramps/tests/unit
"""

import json
import unittest

import render_lambda_support as sup
from hfygramps.render import thumbs

SHA_A = "a1b2c3d4" + "0" * 56
SHA_B = "e5f6a7b8" + "1" * 56


def sidecar(records):
    return (json.dumps({"version": 1, "thumbs": records}, sort_keys=True) + "\n").encode()


def published(rig):
    """(handle, checksum) of the first rendered media entry that has an original, from media/index.json."""

    index = json.loads(rig.site_files()["media/index.json"])
    for entry in index:
        if not entry["missing"]:
            return entry["handle"], entry["checksum"], index
    raise AssertionError("the synthetic tree has no media with an original")


class SidecarContract(unittest.TestCase):
    def test_keys_are_derived_from_the_handle_and_the_checksum(self):
        # pinned to the same values as graph/test/cloud-thumbs.test.mjs: the two languages must agree on the scheme
        self.assertEqual(thumbs.thumb_key("hndl_01", SHA_A, 320), "media/thumb/hndl_01-a1b2c3d4-320.jpg")
        self.assertEqual(thumbs.thumb_key("hndl_01", SHA_A, 800), "media/thumb/hndl_01-a1b2c3d4-800.jpg")
        self.assertEqual(thumbs.SIDECAR_KEY, "media/thumb/index.json")
        self.assertEqual(thumbs.SIZES, (320, 800))

    def test_field_shape(self):
        field = thumbs.thumb_field("hndl_01", SHA_A, {"checksum": SHA_A, "w": 4000, "h": 3000})
        self.assertEqual(field, {
            "s320": "media/thumb/hndl_01-a1b2c3d4-320.jpg", "s800": "media/thumb/hndl_01-a1b2c3d4-800.jpg", "w": 4000, "h": 3000,
        })

    def test_a_record_from_another_checksum_gives_no_field(self):
        self.assertIsNone(thumbs.thumb_field("hndl_01", SHA_B, {"checksum": SHA_A, "w": 10, "h": 10}))
        self.assertIsNone(thumbs.thumb_field("hndl_01", SHA_A, None))
        self.assertIsNone(thumbs.thumb_field("hndl_01", None, {"checksum": SHA_A, "w": 10, "h": 10}))
        self.assertIsNone(thumbs.thumb_field("../x", SHA_A, {"checksum": SHA_A, "w": 10, "h": 10}))

    def test_a_malformed_sidecar_reads_as_empty(self):
        for raw in (None, b"", b"not json", b"[]", b'{"version": 2, "thumbs": {}}', b'{"version": 1, "thumbs": []}', b"\xff\xfe"):
            self.assertEqual(thumbs.parse_sidecar(raw), {}, raw)

    def test_bad_records_are_dropped_and_good_ones_kept(self):
        raw = sidecar({
            "good": {"checksum": SHA_A, "w": 5, "h": 6},
            "bad_sum": {"checksum": "xyz", "w": 5, "h": 6},
            "bad_dim": {"checksum": SHA_A, "w": 0, "h": 6},
            "bad_type": {"checksum": SHA_A, "w": True, "h": 6},
            "../escape": {"checksum": SHA_A, "w": 5, "h": 6},
        })
        self.assertEqual(thumbs.parse_sidecar(raw), {"good": {"checksum": SHA_A, "w": 5, "h": 6}})


class RenderedFiles(unittest.TestCase):
    def test_no_sidecar_leaves_the_site_byte_identical(self):
        rig = sup.Rig("live")
        rig.run()
        for body in rig.site_files().values():
            self.assertNotIn(b'"thumb"', body)

    def test_a_current_record_adds_thumb_to_the_index_and_the_media_file(self):
        rig = sup.Rig("live")
        rig.run()
        handle, checksum, _ = published(rig)
        rig.site.objects[thumbs.SIDECAR_KEY] = sidecar({handle: {"checksum": checksum, "w": 640, "h": 480}})
        before = len(rig.site.puts)
        out = rig.run()  # the store did not move: the changed sidecar alone makes the pass due
        self.assertEqual(out["status"], "rendered")
        self.assertEqual(sorted(rig.site.puts[before:]), sorted(["media/index.json", f"media/{handle}.json"]))
        expected = {
            "s320": f"media/thumb/{handle}-{checksum[:8]}-320.jpg", "s800": f"media/thumb/{handle}-{checksum[:8]}-800.jpg", "w": 640, "h": 480,
        }
        files = rig.site_files()
        entry = [e for e in json.loads(files["media/index.json"]) if e["handle"] == handle][0]
        self.assertEqual(entry["thumb"], expected)
        self.assertEqual(json.loads(files[f"media/{handle}.json"])["thumb"], expected)
        others = [e for e in json.loads(files["media/index.json"]) if e["handle"] != handle]
        self.assertTrue(others and all("thumb" not in e for e in others))
        # nothing else moved, and the pass is idempotent
        self.assertEqual(rig.run()["status"], "skipped")
        self.assertEqual(rig.state()["rendered_seq"], rig.table.head_seq())

    def test_a_record_from_a_replaced_original_adds_no_thumb(self):
        rig = sup.Rig("live")
        rig.run()
        handle, checksum, _ = published(rig)
        rig.site.objects[thumbs.SIDECAR_KEY] = sidecar({handle: {"checksum": SHA_B, "w": 640, "h": 480}})
        rig.run()
        self.assertNotIn("thumb", json.loads(rig.site_files()[f"media/{handle}.json"]))

    def test_removing_the_sidecar_removes_the_field_again(self):
        rig = sup.Rig("live")
        rig.run()
        handle, checksum, _ = published(rig)
        rig.site.objects[thumbs.SIDECAR_KEY] = sidecar({handle: {"checksum": checksum, "w": 64, "h": 48}})
        rig.run()
        self.assertIn("thumb", json.loads(rig.site_files()[f"media/{handle}.json"]))
        del rig.site.objects[thumbs.SIDECAR_KEY]
        self.assertEqual(rig.run()["status"], "rendered")
        self.assertNotIn("thumb", json.loads(rig.site_files()[f"media/{handle}.json"]))

    def test_the_renderer_never_deletes_or_claims_the_thumbnails_and_the_sidecar(self):
        rig = sup.Rig("live")
        rig.run()
        handle, checksum, _ = published(rig)
        jpg = thumbs.thumb_key(handle, checksum, 320)
        rig.site.objects[jpg] = b"jpeg bytes"
        rig.site.objects[thumbs.SIDECAR_KEY] = sidecar({handle: {"checksum": checksum, "w": 64, "h": 48}})
        rig.run()
        rig.run({"reconcile": True})
        rig.run({"prune_foreign": True})
        self.assertEqual(rig.site.objects[jpg], b"jpeg bytes")
        self.assertIn(thumbs.SIDECAR_KEY, rig.site.objects)
        self.assertEqual([k for k in rig.site.deletes if k.startswith("media/thumb/")], [])
        self.assertTrue(all(not k.startswith("media/thumb/") for k in (rig.manifest("live") or {})))

    def test_an_unreadable_sidecar_fails_the_pass_instead_of_dropping_every_thumb(self):
        rig = sup.Rig("live")
        rig.run()

        def boom(key):
            raise OSError("injected read failure")

        rig.site.get = boom
        with self.assertRaises(Exception):
            rig.run()


if __name__ == "__main__":
    unittest.main()
