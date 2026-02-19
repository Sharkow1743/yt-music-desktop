import logging
import verboselogs
from rich.logging import RichHandler
from rich.console import Console
from rich.theme import Theme

# 1. Initialize verboselogs to register custom levels (SPAM, VERBOSE, etc.)
verboselogs.install()

# 2. Configure the Rich Console and Theme
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

# 3. Setup basic configuration
logging.basicConfig(
    level="INFO",  # Default level for all other loggers
    format=FORMAT,
    datefmt="[%X]",
    handlers=[
        RichHandler(
            level="SPAM",  # Allow the handler to process SPAM and above
            console=Console(theme=custom_theme),
            rich_tracebacks=True, 
            markup=False, 
            show_path=True, 
        )
    ]
)

# 4. Enable low-level logging specifically for the 'ytmd' hierarchy
logging.getLogger("ytmd").setLevel(verboselogs.SPAM)

def get_logger(name: str):
    # Use dots for hierarchy: 'ytmd.submodule'
    return verboselogs.VerboseLogger(f"ytmd.{name.replace('/', '.')}")