#!/usr/bin/env python3
"""
Decision service for AresRPG combat bot.
Listens for fight states on stdin and returns the best action on stdout.
Uses Beam Search + Value Network for decision making.
"""

import json
import sys
from pathlib import Path

# Add the rl directory to the path so we can import from it
sys.path.insert(0, str(Path(__file__).parent))

from rl.beam_search import beam_search, BeamResult
from rl.bridge import AresBridge
from rl.policy import DEFAULT_POLICY, load_trained_policy
from rl.value import load_value_net
from rl.env import _obs_from_state
from rl.decide import decide_best_action_beam, decide_best_action_greedy, DecisionResult


class BridgeEnv:
    """Minimal environment wrapper for the bridge that exposes what beam_search needs."""

    def __init__(self, bridge: AresBridge, state: dict, actions: list):
        self.bridge = bridge
        self.state = state
        self.actions = actions

    @property
    def obs(self):
        """Get the observation vector for the current state."""
        return _obs_from_state(self.state)


def decide_best_action(bridge_state: dict, policy=None, value_net=None, mode="beam", depth=3) -> dict:
    """
    Decide the best action for a given bridge state.

    Args:
        bridge_state: The state dict from the bridge (output of bridge.state())
        policy: The policy to use for guidance (defaults to DEFAULT_POLICY)
        value_net: The value network for leaf evaluation (optional)
        mode: Decision mode - "beam", "greedy", or "lookahead"
        depth: Beam search depth (only used in beam mode)

    Returns:
        dict with keys:
        - best_action: The action dict to execute
        - best_action_idx: Index of the best action in the legal actions list
        - win_prob: Estimated win probability from this state
        - alternatives: List of alternative actions with their win probabilities
    """
    if policy is None:
        policy = DEFAULT_POLICY

    # Create a bridge connection if we don't have one
    # In practice, the caller should reuse an existing bridge connection
    bridge = AresBridge()

    try:
        # Set the bridge to the provided state
        # We need to restore the bridge to this state
        bridge_request = bridge.request({"op": "restore", "state": bridge_state})
        if not bridge_request.get("ok"):
            raise RuntimeError(f"Failed to restore bridge state: {bridge_request}")

        # Get the current state and actions from the bridge
        state = bridge_request["state"]
        actions = bridge_request["actions"]

        # If no actions or fight ended, return a safe default
        if not actions or state.get("ended"):
            return {
                "best_action": None,
                "best_action_idx": 0,
                "win_prob": 0.5,
                "alternatives": []
            }

        if mode == "beam":
            # Use beam search to find the best action
            result: DecisionResult = decide_best_action_beam(
                bridge_state=bridge_state,
                bridge=bridge,
                policy=policy,
                value_net=value_net,
                depth=depth,
                beam_width=5,
                branch_factor=3,
                n_alternatives=3
            )
        elif mode == "greedy":
            # Use greedy policy scoring
            result: DecisionResult = decide_best_action_greedy(
                bridge_state=bridge_state,
                bridge=bridge,
                policy=policy
            )
        else:
            # Default to beam search for unknown modes
            result: DecisionResult = decide_best_action_beam(
                bridge_state=bridge_state,
                bridge=bridge,
                policy=policy,
                value_net=value_net,
                depth=depth,
                beam_width=5,
                branch_factor=3,
                n_alternatives=3
            )

        # Format the result for return
        best_action_idx = result.best_action_idx
        best_action = result.best_action

        # Format alternatives
        alternatives = []
        for alt in result.alternatives:
            alternatives.append({
                "action": alt["action"],
                "action_idx": alt["action_idx"],
                "win_prob": alt["win_prob"]
            })

        return {
            "best_action": best_action,
            "best_action_idx": best_action_idx,
            "win_prob": result.win_prob,
            "alternatives": alternatives
        }

    finally:
        bridge.close()


def main():
    """Main entry point - reads JSON state from stdin, writes decision to stdout."""
    try:
        # Load policy and value net once at startup
        policy_path = Path("models/policy.json")
        policy = load_trained_policy(policy_path) if policy_path.exists() else DEFAULT_POLICY

        value_net_path = Path("models/value_net.pt")
        value_net = load_value_net(value_net_path) if value_net_path.exists() else None

        # Process each line of input
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue

            try:
                # Parse the input state
                input_data = json.loads(line)

                # Extract the bridge state and parameters
                if "state" not in input_data:
                    output = {"error": "Missing 'state' field in input"}
                else:
                    bridge_state = input_data["state"]
                    mode = input_data.get("mode", "beam")
                    depth = input_data.get("depth", 3)
                    # Get the decision
                    decision = decide_best_action(bridge_state, policy, value_net, mode, depth)
                    output = decision

                # Write the output as JSON
                print(json.dumps(output))
                sys.stdout.flush()

            except json.JSONDecodeError as e:
                output = {"error": f"Invalid JSON input: {e}"}
                print(json.dumps(output))
                sys.stdout.flush()
            except Exception as e:
                output = {"error": f"Decision error: {e}"}
                print(json.dumps(output))
                sys.stdout.flush()

    except Exception as e:
        # Startup error
        output = {"error": f"Failed to start decision service: {e}"}
        print(json.dumps(output))
        sys.stdout.flush()


if __name__ == "__main__":
    main()