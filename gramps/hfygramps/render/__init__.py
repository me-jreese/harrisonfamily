"""The site renderer: the D-02-fixed ETL transforms and the search-index builder, as pure functions (HFY-TSK-229).

``render_site(objects) -> {s3_key: bytes}``. Nothing in this package opens a file, a SQLite database, a socket or an AWS
client. Standard library only, so it runs in CI's stock python3 (3.12 and later) and in Lambda.
"""

from .site import DEFAULT_GENERATED_AT, RenderReport, RenderResult, render, render_site

__all__ = ["DEFAULT_GENERATED_AT", "RenderReport", "RenderResult", "render", "render_site"]
