from __future__ import annotations

from typing import Generator, Iterable, List, TypeVar

T = TypeVar("T")


def chunk_list(items: Iterable[T], size: int) -> Generator[List[T], None, None]:
    if size <= 0:
        raise ValueError("size must be positive")
    buffer: List[T] = []
    for item in items:
        buffer.append(item)
        if len(buffer) == size:
            yield buffer
            buffer = []
    if buffer:
        yield buffer
