"""Rewrite sqlite3 .dump unistr('...') calls without unistr (D1 rejects it).

Control characters become `|| char(N) ||` so each INSERT stays on one line.
"""
import re
import sys

UNISTR = re.compile(r"unistr\('((?:[^']|'')*)'\)")
ESCAPE = re.compile(r"\\(\\|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|\+[0-9a-fA-F]{6})")


def _decode_escape(m: re.Match) -> str:
    e = m.group(1)
    return "\\" if e == "\\" else chr(int(e[1:], 16))


def _to_sql(m: re.Match) -> str:
    text = ESCAPE.sub(_decode_escape, m.group(1))  # '' quoting is preserved as-is
    parts, buf = [], ""
    for ch in text:
        if ord(ch) < 32 or ord(ch) == 127:
            parts.append(f"'{buf}'")
            parts.append(f"char({ord(ch)})")
            buf = ""
        else:
            buf += ch
    parts.append(f"'{buf}'")
    return "(" + " || ".join(parts) + ")"


for line in sys.stdin:
    sys.stdout.write(UNISTR.sub(_to_sql, line))
