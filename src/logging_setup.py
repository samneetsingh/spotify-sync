import logging
import sys
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path


def setup_logging(level: str = "INFO", log_file: str | None = None, retention_days: int = 7) -> None:
    """
    Configure root logging with console + optional rotating file handler.
    """
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    formatter = logging.Formatter("%(asctime)s | %(levelname)s | %(name)s | %(message)s")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    root.addHandler(console)

    if log_file:
        path = Path(log_file).expanduser()
        path.parent.mkdir(parents=True, exist_ok=True)
        log = logging.getLogger(__name__)
        try:
            path.parent.chmod(0o700)
        except OSError:
            log.debug("Could not chmod log directory %s", path.parent)
        # Pre-create log file with restrictive permissions so rotating handler
        # does not leave world-readable logs.
        try:
            if not path.exists():
                path.touch(mode=0o600, exist_ok=True)
            path.chmod(0o600)
        except OSError:
            log.debug("Could not set permissions on log file %s", path)
        file_handler = TimedRotatingFileHandler(
            filename=str(path),
            when="midnight",
            interval=1,
            backupCount=retention_days,
            encoding="utf-8",
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
