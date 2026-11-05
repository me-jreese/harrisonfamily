"""The shadow parity report (HFY-TSK-370): counts-only comparison of the shadow render with a legacy export.

``hfy-parity --legacy <dir> --shadow <dir-or-s3-prefix>`` lines up the files the render Lambda owns in the shadow output
(``render-shadow/`` in the private sync bucket) with the same files of a legacy export staged at the same moment, and
prints how many differ, by class and by rule. It never prints a key, an id, a name, a path or a value. Standard library only;
written for Python 3.9 or later (macOS' python3).

* ``rules``: the documented explained differences, and the redaction policy lists they read.
* ``compare``: the comparison; its result is plain counts.
* ``source``: reading a staged folder, and the read-only download of the shadow prefix.
* ``cli``: arguments, the report text and the exit codes.
"""
