from stable_baselines3.common.callbacks import BaseCallback

class CollapseGuardCallback(BaseCallback):
    """Stops training if entropy_loss pins at exact 0.0 for `patience` consecutive
    updates -- the signature of the policy's masked categorical distribution saturating
    to a float32 one-hot (softmax underflow once the logit gap gets large enough).
    Observed in every configuration tried so far (random init at ent_coef .01/.02/.05,
    and BC-warm-started -- see docs/ROADMAP.md) and it never recovers on its own once it
    happens: clip_fraction/approx_kl pin at exact 0.0 too (the policy stops changing
    entirely) while value_loss keeps moving normally, so training just burns compute in a
    dead state for however many steps are left. Without this, that cost real wall-clock
    hours across this project's early runs before anyone noticed.
    """
    def __init__(self, patience=10, verbose=0):
        super().__init__(verbose)
        self.patience = patience
        self.collapsed_count = 0
        self._stop = False

    def _on_rollout_start(self):
        entropy = self.model.logger.name_to_value.get("train/entropy_loss")
        self.collapsed_count = self.collapsed_count + 1 if entropy == 0.0 else 0
        if self.collapsed_count >= self.patience and not self._stop:
            self._stop = True
            print(f"[collapse-guard] entropy_loss pinned at exact 0.0 for {self.patience} "
                  "consecutive updates -- the policy has saturated to a degenerate "
                  "distribution and it won't recover on its own. Stopping early (the last "
                  "checkpoint is still on disk if --checkpoint-freq was enabled).")

    def _on_step(self):
        return not self._stop
