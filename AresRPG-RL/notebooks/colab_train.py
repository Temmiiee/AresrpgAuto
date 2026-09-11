# Optional Colab helper.
# Run cells from docs/COLAB.md first.

import os
os.environ.setdefault("ARES_RPG_ROOT", "/content/aresrpg")

from rl.env import AresFightEnv

env = AresFightEnv()
obs, info = env.reset()
print("Observation shape:", obs.shape)
print("Legal actions:", int(env.action_masks().sum()))
env.close()
print("Environment bootstrap OK.")
