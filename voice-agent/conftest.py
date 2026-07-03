import os
import sys

# The worker modules are flat files in this directory; make them importable when
# pytest collects from voice-agent/tests/.
sys.path.insert(0, os.path.dirname(__file__))
