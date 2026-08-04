#!/usr/bin/env python3
"""Local API for the native Mac app (Swift UI). Do not run manually unless debugging."""

import os
import sys

PORT = int(os.environ.get("SEEDPASS_COORDINATOR_PORT", "18765"))
HOST = "127.0.0.1"

if __name__ == "__main__":
    root = os.path.dirname(os.path.abspath(__file__))
    if root not in sys.path:
        sys.path.insert(0, root)
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        log_level="warning",
        access_log=False,
        loop="asyncio",
    )
