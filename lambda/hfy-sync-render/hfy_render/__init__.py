"""hfy-sync-render: the site renderer's Lambda engine (HFY-TSK-176, BRD2 section 11).

Everything here is plain Python over small ports (a table, two buckets, a metrics sink, a clock), so the whole pass is tested
with in-memory fakes. ``aws.py`` holds the boto3 adapters and is the only module that imports boto3.
"""

RENDERER_VERSION = "render-lambda/1"
