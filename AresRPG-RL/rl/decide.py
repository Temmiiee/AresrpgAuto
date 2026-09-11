"""Decision making utilities for AresRPG combat.

Provides functions to decide the best action for a given fight state
using Beam Search + Value Network or other methods.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .bridge import AresBridge
    from .policy import Policy
    from .value import ValueNet

from .beam_search import beam_search, BeamResult
from .env import _obs_from_state
from .policy import DEFAULT_POLICY
from .scored_decide import choose_action_index


@dataclass
class DecisionResult:
    """Result of a decision query."""
    best_action: dict | None      # The action dict to execute
    best_action_idx: int          # Index of the best action in legal actions
    win_prob: float               # Estimated win probability from this state
    alternatives: list[dict]      # Alternative actions with their win probs
    # alternatives: [{"action": dict, "action_idx": int, "win_prob": float}, ...]


class DecisionEnv:
    """Minimal environment wrapper for decision making."""

    def __init__(self, bridge: AresBridge, state: dict, actions: list):
        self.bridge = bridge
        self.state = state
        self.actions = actions

    @property
    def obs(self) -> np.ndarray:
        """Get the observation vector for current state."""
        return _obs_from_state(self.state)


def decide_best_action_beam(
    bridge_state: dict,
    bridge: AresBridge,
    policy: Policy | None = None,
    value_net: ValueNet | None = None,
    depth: int = 3,
    beam_width: int = 5,
    branch_factor: int = 3,
    n_alternatives: int = 3
) -> DecisionResult:
    """
    Decide the best action using Beam Search + Value Network.

    Args:
        bridge_state: The current fight state from the bridge
        bridge: An initialized AresBridge connection
        policy: The policy to use for guidance (defaults to DEFAULT_POLICY)
        value_net: The value network for leaf evaluation (optional)
        depth: Beam search depth in player decisions
        beam_width: Number of nodes to keep per level
        branch_factor: Number of actions to consider per node
        n_alternatives: Number of alternative actions to return

    Returns:
        DecisionResult with the best action and related information
    """
    if policy is None:
        policy = DEFAULT_POLICY

    # Set the bridge to the provided state
    restore_result = bridge.request({"op": "restore", "state": bridge_state})
    if not restore_result.get("ok"):
        raise RuntimeError(f"Failed to restore bridge state: {restore_result}")

    # Get the current state and actions from the bridge
    state = restore_result["state"]
    actions = restore_result["actions"]

    # If no actions or fight ended, return a safe default
    if not actions or state.get("ended"):
        return DecisionResult(
            best_action=None,
            best_action_idx=0,
            win_prob=0.5,
            alternatives=[]
        )

    # Create our environment wrapper
    env = DecisionEnv(bridge, state, actions)

    # Use beam search to find the best action
    result: BeamResult = beam_search(
        env,
        policy=policy,
        value_net=value_net,
        depth=depth,
        beam_width=beam_width,
        branch_factor=branch_factor,
        n_alternatives=n_alternatives
    )

    # Format the result
    best_action_idx = result.best_action_idx
    best_action = env.actions[best_action_idx] if best_action_idx < len(env.actions) else None

    # Format alternatives
    alternatives = []
    for alt in result.alternatives:
        try:
            alt_idx = env.actions.index(alt["action"])
        except ValueError:
            alt_idx = 0  # Fallback if action not found
        alternatives.append({
            "action": alt["action"],
            "action_idx": alt_idx,
            "win_prob": alt["win_prob"]
        })

    return DecisionResult(
        best_action=best_action,
        best_action_idx=best_action_idx,
        win_prob=result.win_prob,
        alternatives=alternatives
    )


def decide_best_action_greedy(
    bridge_state: dict,
    bridge: AresBridge,
    policy: Policy | None = None
) -> DecisionResult:
    """
    Decide the best action using greedy policy scoring (fastest).

    Args:
        bridge_state: The current fight state from the bridge
        bridge: An initialized AresBridge connection
        policy: The policy to use for scoring (defaults to DEFAULT_POLICY)

    Returns:
        DecisionResult with the best action and related information
    """
    if policy is None:
        policy = DEFAULT_POLICY

    # Set the bridge to the provided state
    restore_result = bridge.request({"op": "restore", "state": bridge_state})
    if not restore_result.get("ok"):
        raise RuntimeError(f"Failed to restore bridge state: {restore_result}")

    # Get the current state and actions from the bridge
    state = restore_result["state"]
    actions = restore_result["actions"]

    # If no actions or fight ended, return a safe default
    if not actions or state.get("ended"):
        return DecisionResult(
            best_action=None,
            best_action_idx=0,
            win_prob=0.5,
            alternatives=[]
        )

    # Use greedy policy scoring
    # Create a mock env object that scored_decide expects
    class MockEnv:
        def __init__(self, actions, state):
            self.actions = actions
            self.state = state

    best_idx = choose_action_index(
        MockEnv(actions, state),
        policy
    )

    best_action = actions[best_idx] if best_idx < len(actions) else None

    return DecisionResult(
        best_action=best_action,
        best_action_idx=best_idx,
        win_prob=0.5,  # Greedy doesn't provide win probability
        alternatives=[]  # Could compute alternatives but keeping it simple for now
    )