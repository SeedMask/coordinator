"""Camera QR scanner for desktop coordinator (signed JSON or kaspa: address)."""

from __future__ import annotations

import json
import threading
import tkinter as tk
from tkinter import ttk
from typing import Callable

BG = "#0f1419"
FG = "#e7ecf3"
MUTED = "#8b9cb3"
ACCENT = "#49c5b6"
PANEL = "#1a2332"


def _cv2_available() -> tuple[bool, str]:
    try:
        import cv2  # noqa: F401

        return True, ""
    except ImportError:
        return False, "Install camera support: pip install opencv-python-headless"


def _validate_signed_payload(text: str) -> str:
    text = text.strip()
    obj = json.loads(text)
    if not isinstance(obj, dict):
        raise ValueError("QR must contain JSON object")
    if "signatures" not in obj and "signature_script" not in str(obj):
        raise ValueError("Not a signed transaction QR (missing signatures)")
    return text


def _validate_address_payload(text: str, *, coin: str | None = None) -> str:
    from .tx_pipeline import parse_payee_qr_text, validate_address

    addr = parse_payee_qr_text(text, coin=coin)
    return validate_address(addr, coin=coin)


def open_qr_scanner(
    parent: tk.Misc,
    *,
    title: str,
    hint: str,
    mode: str,
    on_success: Callable[[str], None],
    on_error: Callable[[str], None] | None = None,
) -> None:
    """Open a modal window; reads Mac/webcam until a QR is decoded."""
    ok, err = _cv2_available()
    if not ok:
        if on_error:
            on_error(err)
        return

    import cv2
    from PIL import Image, ImageTk

    win = tk.Toplevel(parent)
    win.title(title)
    win.configure(bg=BG)
    win.transient(parent)
    win.grab_set()
    win.geometry("520x520")

    tk.Label(win, text=hint, bg=BG, fg=MUTED, wraplength=480, justify=tk.LEFT).pack(
        padx=12, pady=(12, 6), anchor=tk.W
    )
    preview = tk.Label(win, bg="#000", width=480, height=360)
    preview.pack(padx=12, pady=6)
    status = tk.StringVar(value="Starting camera…")
    tk.Label(win, textvariable=status, bg=BG, fg=ACCENT).pack(padx=12, pady=4)

    stop = threading.Event()
    found = threading.Event()
    photo_holder: list = []

    def close():
        stop.set()
        found.set()
        try:
            win.grab_release()
        except tk.TclError:
            pass
        win.destroy()

    btn_row = tk.Frame(win, bg=BG)
    btn_row.pack(pady=8)
    tk.Button(btn_row, text="Cancel", command=close, bg=PANEL, fg=FG).pack(side=tk.LEFT, padx=6)

    def apply_result(raw: str):
        try:
            if mode == "signed":
                cleaned = _validate_signed_payload(raw)
            elif mode == "address":
                cleaned = _validate_address_payload(raw)
            else:
                cleaned = raw.strip()
        except (json.JSONDecodeError, ValueError) as e:
            status.set(f"Wrong QR: {e} — try again")
            return
        close()
        on_success(cleaned)

    def camera_loop():
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            win.after(0, lambda: status.set("Could not open camera"))
            return
        detector = cv2.QRCodeDetector()
        win.after(0, lambda: status.set("Point at QR on SeedMask screen…"))

        while not stop.is_set():
            ok_frame, frame = cap.read()
            if not ok_frame:
                continue
            data, _points, _ = detector.detectAndDecode(frame)
            if data and not found.is_set():
                found.set()
                win.after(0, lambda d=data: (status.set("QR found!"), apply_result(d)))
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(rgb)
            img.thumbnail((480, 360))
            photo = ImageTk.PhotoImage(img)

            def update_preview(p=photo):
                if stop.is_set():
                    return
                photo_holder.clear()
                photo_holder.append(p)
                preview.configure(image=p)

            win.after(0, update_preview)
            if found.is_set():
                break
            import time

            time.sleep(0.04)
        cap.release()

    threading.Thread(target=camera_loop, daemon=True).start()
    win.protocol("WM_DELETE_WINDOW", close)
