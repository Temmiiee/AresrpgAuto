from .env import _int

def move_toward_nearest(actions, state, enemies):
    """Index of whichever move_to action lands closest (grid manhattan distance) to any of
    `enemies`, or None if there's no move_to action or no enemy to approach. Shared by
    rl/heuristic.py and rl/scored_decide.py -- both fall back to this exact same
    "nothing worth attacking this decision, so approach" behavior when no attack/support
    action scores."""
    moves = [(i, a) for i, a in enumerate(actions) if a["type"] == "move_to"]
    if not moves or not enemies:
        return None
    gw = state["board"]["grid_w"]
    def dist(ia):
        dest = _int(ia[1]["path"][-1])
        dx, dy = dest % gw, dest // gw
        return min(abs(dx - e["cell"] % gw) + abs(dy - e["cell"] // gw) for e in enemies)
    return min(moves, key=dist)[0]
