#!/usr/bin/env python3
"""Compatibility entrypoint; schema and document checks share the Node implementation."""
from pathlib import Path
import subprocess

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    raise SystemExit(subprocess.call(['node', str(root / 'scripts' / 'validate-specs.js')], cwd=root))
