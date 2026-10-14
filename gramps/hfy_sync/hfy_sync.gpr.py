#
# Gramps - a GTK+/GNOME based genealogy program
#
# harrisonfamily.us website sync addon (HFY-PLN-002, sync.md section 8). Private use.
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# Registers the tool: Tools > Family Tree Processing > Website sync...
# and the command line  Gramps -O <tree> -a tool -p name=hfy_sync,action=status
#
# The version here must equal hfygramps/addon/consts.py ADDON_VERSION (a unit test checks it).
register(
    TOOL,
    id="hfy_sync",
    name=_("Website sync..."),
    description=_("Keeps this family tree and the harrisonfamily.us website in step. Nothing private leaves this computer."),
    version="0.1.0",
    gramps_target_version="6.0",
    status=STABLE,
    fname="hfy_sync_tool.py",
    authors=["harrisonfamily.us"],
    category=TOOL_DBPROC,
    toolclass="HfySyncTool",
    optionclass="HfySyncOptions",
    tool_modes=[TOOL_MODE_GUI, TOOL_MODE_CLI],
)
