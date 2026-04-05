import logging
import verboselogs
from rich.logging import RichHandler
from rich.console import Console
from rich.theme import Theme

# 1. Force all new loggers to be VerboseLoggers
logging.setLoggerClass(verboselogs.VerboseLogger)
verboselogs.install()

custom_theme = Theme({
    "logging.level.spam": "italic dim grey37",
    "logging.level.verbose": "italic grey50",
    "logging.level.debug": "grey70",
    "logging.level.info": "bright_blue",
    "logging.level.notice": "magenta",
    "logging.level.success": "bold green", 
    "logging.level.warning": "bold yellow",
    "logging.level.error": "bold red",
    "logging.level.critical": "bold white on red",
})

FORMAT = "%(name)-12s │ %(message)s"

# 2. Configure Root Logger
logging.basicConfig(
    level="SPAM", # Capture everything at root
    format=FORMAT,
    datefmt="[%X]",
    handlers=[
        RichHandler(
            level="SPAM", 
            console=Console(theme=custom_theme),
            rich_tracebacks=True, 
            markup=False, 
            show_path=True, 
        )
    ]
)

logging.getLogger().setLevel('INFO')

ytmd_logger = logging.getLogger("ytmd")
ytmd_logger.setLevel("SPAM")
ytmd_logger.propagate = True 

ytmd_logger = logging.getLogger("shellac")
ytmd_logger.setLevel("SPAM")

def get_logger(name: str) -> verboselogs.VerboseLogger:
    return logging.getLogger(f"ytmd.{name}")