"""Compatibility entry point for the code-native open-book icon exporter.
Uses an existing Node/Playwright/Chromium setup; installs nothing.
"""
import os
import subprocess
from pathlib import Path
subprocess.run([os.environ.get('NODE_EXECUTABLE', 'node'), str(Path(__file__).with_suffix('.mjs'))], check=True)
