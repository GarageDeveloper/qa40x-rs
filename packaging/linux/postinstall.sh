#!/bin/sh
# qa40x-rs post-install: apply the freshly installed QA40x udev rule without
# a reboot. Tolerates environments with no running udev (containers, chroots).
if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules 2>/dev/null || true
    udevadm trigger --subsystem-match=usb 2>/dev/null || true
fi
exit 0
