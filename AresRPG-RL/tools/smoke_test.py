import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run directly with `python tools/smoke_test.py`
from rl.bridge import AresBridge
b=AresBridge()
try: print(b.request({"op":"ping"}))
finally: b.close()
