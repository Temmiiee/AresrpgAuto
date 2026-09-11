# Contributing / development rules

1. Never silently reimplement AresRPG combat rules.
2. Pin or record the AresRPG commit used for experiments.
3. Every benchmark must state the simulator commit.
4. Separate training scenarios from held-out evaluation scenarios.
5. Do not commit model checkpoints to normal Git history.
6. Keep generated datasets/versioned artifacts outside source when large.
7. Add a smoke test for bridge changes.
8. Measure simulator throughput before optimizing the neural network.
