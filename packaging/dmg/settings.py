# dmgbuild settings — styled DMG without AppleScript/Finder, so it works in
# the headless CI runner (Tauri's bundle_dmg.sh cannot).
#
#   dmgbuild -s packaging/dmg/settings.py -D app=<path/to/.app> \
#            "qa40x-rs Audio Analyzer" out.dmg
#
# Layout matches packaging/dmg/background.png (660x400 @2x): app icon left,
# /Applications right with the arrow between, README bottom-centre.
import os.path

# dmgbuild exec()s this file without __file__, so paths are relative to the
# invocation directory — always run dmgbuild from the repository root.
app = defines.get("app", "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/qa40x-rs Audio Analyzer.app")  # noqa: F821
here = "packaging/dmg"

files = [app, os.path.join(here, "README.txt")]
symlinks = {"Applications": "/Applications"}

background = os.path.join(here, "background.png")
window_rect = ((200, 120), (660, 400))
icon_size = 128
text_size = 12

icon_locations = {
    os.path.basename(app): (180, 170),
    "Applications": (480, 170),
    "README.txt": (330, 312),
}

format = "UDZO"  # compressed, read-only
