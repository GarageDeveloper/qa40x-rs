#!/bin/sh
# qa40x-rs post-remove: the package manager has removed the udev rule file;
# reload so the permissions actually revert. Same tolerance as postinstall.
if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger --subsystem-match=usb 2>/dev/null || true
fi
exit 0
