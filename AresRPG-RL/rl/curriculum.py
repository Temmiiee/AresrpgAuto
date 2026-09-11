from collections import deque
from stable_baselines3.common.callbacks import BaseCallback

class CurriculumCallback(BaseCallback):
    """Starts ScenarioGenerator at a lower difficulty (weaker/fewer enemies -- see
    ScenarioGenerator's EASY_RATIO/TARGET_RATIO) and raises it toward 1.0 whenever the
    last `window` completed episodes cleared `target` win rate, per docs/DESIGN_NOTES.md's
    curriculum plan ("increase difficulty when the agent reaches a target success rate").

    Difficulty lives on the ScenarioGenerator inside each worker process, not in the
    saved model -- it resets to `start` on --resume unless overridden with
    --curriculum-start.
    """
    def __init__(self, start=0.2, step=0.2, target=0.5, window=100, verbose=0):
        super().__init__(verbose)
        self.difficulty = start
        self.step = step
        self.target = target
        self.window = window
        self.recent_wins = deque(maxlen=window)

    def _on_training_start(self):
        self.training_env.env_method("set_difficulty", self.difficulty)
        print(f"[curriculum] starting at difficulty {self.difficulty:.2f}")

    def _on_step(self):
        for info in self.locals.get("infos", []):
            if "win" in info:
                self.recent_wins.append(info["win"])
        if len(self.recent_wins) == self.window and self.difficulty < 1.0:
            win_rate = sum(self.recent_wins) / self.window
            if win_rate >= self.target:
                self.difficulty = min(1.0, self.difficulty + self.step)
                self.training_env.env_method("set_difficulty", self.difficulty)
                self.recent_wins.clear()
                print(f"[curriculum] win rate {win_rate:.2f} >= target {self.target:.2f} "
                      f"over {self.window} episodes -> difficulty {self.difficulty:.2f}")
        return True
