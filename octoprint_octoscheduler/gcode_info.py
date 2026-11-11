# -*- coding: utf-8 -*-
"""
Extraction d'informations depuis un fichier G-code :
- durée d'impression estimée par le slicer (PrusaSlicer, OrcaSlicer, Bambu Studio,
  SuperSlicer, Cura, Simplify3D, ideaMaker...)
- miniature embarquée (PNG, JPG ou QOI -> converti en PNG)
"""

import base64
import re
import struct
import zlib

HEAD_BYTES = 4 * 1024 * 1024  # les miniatures sont en début de fichier
TAIL_BYTES = 128 * 1024  # PrusaSlicer écrit le temps estimé en fin de fichier

_DURATION_PART = re.compile(r"(\d+(?:\.\d+)?)\s*([dhms])", re.IGNORECASE)

_TIME_PATTERNS = [
    # PrusaSlicer / SuperSlicer / OrcaSlicer / Bambu Studio
    re.compile(r"^;\s*estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$", re.I),
    re.compile(r"^;\s*total estimated time\s*[:=]\s*(.+?)\s*$", re.I),
    re.compile(r"^;\s*model printing time\s*[:=]\s*([^;]+)", re.I),
    # Simplify3D : ";   Build time: 1 hours 23 minutes"
    re.compile(r"^;\s*Build time:\s*(.+)$", re.I),
]
_CURA_TIME = re.compile(r"^;\s*TIME:\s*(\d+(?:\.\d+)?)\s*$", re.I)
_IDEAMAKER_TIME = re.compile(r"^;\s*Print Time:\s*(\d+(?:\.\d+)?)\s*$", re.I)

_THUMB_BEGIN = re.compile(
    r"^;\s*(thumbnail(?:_(PNG|JPG|QOI))?|jpg)\s+begin\s+(\d+)x(\d+)\s+\d+", re.I
)
_THUMB_END = re.compile(r"^;\s*(thumbnail(?:_(PNG|JPG|QOI))?|jpg)\s+end", re.I)


def parse_duration(text):
    """'1d 2h 3m 4s' / '1 hours 23 minutes' -> secondes (float) ou None."""
    if not text:
        return None
    text = text.strip().lower()
    text = (
        text.replace("hours", "h")
        .replace("hour", "h")
        .replace("minutes", "m")
        .replace("minute", "m")
        .replace("seconds", "s")
        .replace("second", "s")
        .replace("days", "d")
        .replace("day", "d")
    )
    total = 0.0
    found = False
    for value, unit in _DURATION_PART.findall(text):
        found = True
        value = float(value)
        unit = unit.lower()
        total += value * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return total if found and total > 0 else None


def _read_lines(path):
    """Renvoie (lignes du début, lignes de fin) du fichier."""
    with open(path, "rb") as f:
        head = f.read(HEAD_BYTES)
        f.seek(0, 2)
        size = f.tell()
        tail = b""
        if size > len(head):
            f.seek(max(len(head), size - TAIL_BYTES))
            tail = f.read()
    head_lines = head.decode("utf-8", errors="replace").splitlines()
    tail_lines = tail.decode("utf-8", errors="replace").splitlines()
    return head_lines, tail_lines


def _find_time(lines):
    for line in lines:
        if not line.startswith(";"):
            continue
        m = _CURA_TIME.match(line) or _IDEAMAKER_TIME.match(line)
        if m:
            value = float(m.group(1))
            if value > 0:
                return value
            continue
        for pattern in _TIME_PATTERNS:
            m = pattern.match(line)
            if m:
                value = parse_duration(m.group(1))
                if value:
                    return value
    return None


def _find_thumbnails(lines):
    """Liste de (format, largeur, hauteur, bytes)."""
    thumbs = []
    current = None
    data = []
    for line in lines:
        if current is None:
            if not line.startswith(";"):
                # On s'arrête au premier mouvement réel : les miniatures sont avant
                if line.startswith(("G0", "G1")) and thumbs:
                    break
                continue
            m = _THUMB_BEGIN.match(line)
            if m:
                fmt = (m.group(2) or ("JPG" if m.group(1).lower() == "jpg" else "PNG")).upper()
                current = (fmt, int(m.group(3)), int(m.group(4)))
                data = []
        else:
            if _THUMB_END.match(line):
                try:
                    raw = base64.b64decode("".join(data))
                    thumbs.append((current[0], current[1], current[2], raw))
                except Exception:
                    pass
                current = None
            else:
                data.append(line.lstrip(";").strip())
    return thumbs


def extract_info(path):
    """Renvoie {"estimated_time": float|None, "thumbnail": (mime, bytes)|None}."""
    head, tail = _read_lines(path)

    estimated = _find_time(tail[::-1]) or _find_time(head)

    thumbnail = None
    thumbs = _find_thumbnails(head)
    if thumbs:
        # Priorité aux formats affichables nativement, puis à la plus grande taille
        def score(t):
            fmt_rank = {"PNG": 2, "JPG": 2, "QOI": 1}.get(t[0], 0)
            return (fmt_rank, t[1] * t[2])

        for fmt, _w, _h, raw in sorted(thumbs, key=score, reverse=True):
            try:
                if fmt == "PNG" and raw.startswith(b"\x89PNG"):
                    thumbnail = ("image/png", raw)
                elif fmt == "JPG" and raw.startswith(b"\xff\xd8"):
                    thumbnail = ("image/jpeg", raw)
                elif fmt == "QOI":
                    thumbnail = ("image/png", qoi_to_png(raw))
                else:
                    continue
                break
            except Exception:
                continue

    return {"estimated_time": estimated, "thumbnail": thumbnail}


# --------------------------------------------------------------------------- QOI


def _qoi_decode(data):
    if data[:4] != b"qoif":
        raise ValueError("not a QOI image")
    width, height, channels, _colorspace = struct.unpack(">IIBB", data[4:14])
    if width * height > 4096 * 4096:
        raise ValueError("QOI image too large")
    pixels = bytearray(width * height * 4)
    index = [(0, 0, 0, 0)] * 64
    r, g, b, a = 0, 0, 0, 255
    p = 14
    run = 0
    end = len(data) - 8
    for px in range(0, len(pixels), 4):
        if run > 0:
            run -= 1
        elif p < end:
            b1 = data[p]
            p += 1
            if b1 == 0xFE:
                r, g, b = data[p], data[p + 1], data[p + 2]
                p += 3
            elif b1 == 0xFF:
                r, g, b, a = data[p], data[p + 1], data[p + 2], data[p + 3]
                p += 4
            elif (b1 & 0xC0) == 0x00:
                r, g, b, a = index[b1]
            elif (b1 & 0xC0) == 0x40:
                r = (r + ((b1 >> 4) & 0x03) - 2) & 0xFF
                g = (g + ((b1 >> 2) & 0x03) - 2) & 0xFF
                b = (b + (b1 & 0x03) - 2) & 0xFF
            elif (b1 & 0xC0) == 0x80:
                b2 = data[p]
                p += 1
                vg = (b1 & 0x3F) - 32
                r = (r + vg - 8 + ((b2 >> 4) & 0x0F)) & 0xFF
                g = (g + vg) & 0xFF
                b = (b + vg - 8 + (b2 & 0x0F)) & 0xFF
            else:
                run = b1 & 0x3F
            index[(r * 3 + g * 5 + b * 7 + a * 11) % 64] = (r, g, b, a)
        pixels[px : px + 4] = bytes((r, g, b, a))
    return width, height, bytes(pixels)


def _png_encode_rgba(width, height, pixels):
    def chunk(tag, payload):
        c = struct.pack(">I", len(payload)) + tag + payload
        return c + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    stride = width * 4
    raw = b"".join(
        b"\x00" + pixels[y * stride : (y + 1) * stride] for y in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def qoi_to_png(data):
    return _png_encode_rgba(*_qoi_decode(data))
