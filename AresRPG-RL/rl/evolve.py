"""Ported from AresRPGBot's packages/bot/src/cli_train.ts: a (mu+lambda) evolution strategy over
policy.py's weight vector, evaluated against calibrated simulated fights -- no neural net, no
gradient signal, no PPO instability. See docs/ROADMAP.md for why this project pivoted here: seven
different MaskablePPO configurations (varying init, entropy coefficient, learning rate, gradient
clipping, network width, and a behavior-cloning warm-start) all hit the identical entropy-collapse
failure, while this approach is proven working in the exact same domain (the AresRPGBot project,
same simulator, same content).

python -m rl.evolve --generations 8 --population 10 --scenarios 8
"""
import argparse, json, random, sys, time
from dataclasses import asdict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # run directly with `python rl/evolve.py`
from rl.bridge import AresBridge
from rl.scenarios import ScenarioGenerator
from rl.policy import Policy, DEFAULT_POLICY, POLICY_KEYS, clamp_policy
from rl.policy_store import save_trained_policy
from rl.scored_decide import choose_action_index

MAX_STEPS_PER_FIGHT = 300  # a fight this heuristic can't resolve by then is a stalemate, not signal


class SimHandle:
    """Just enough of AresFightEnv's interface (.state, .actions) for choose_action_index,
    backed directly by AresBridge instead of the Gym wrapper -- lets simulate_fight replay the
    exact same setup dict across many engine seeds, which calibration and multi-run evaluation
    both need and AresFightEnv's own random-scenario-per-reset design doesn't expose."""
    def __init__(self, bridge):
        self.bridge = bridge
        self.state = None
        self.actions = None

    def reset(self, setup, seed):
        r = self.bridge.request({"op": "reset", "setup": setup, "seed": seed})
        if not r["ok"]:
            raise RuntimeError(r)
        self.state, self.actions = r["state"], r["actions"]

    def step(self, idx):
        # AresFightEnv.step() guards this same way: `actions` is occasionally empty when
        # control briefly lands on a state candidates() has nothing for (e.g. mid mob-turn
        # resolution) -- a no-op here, not a crash; simulate_fight's own max_steps bound
        # still guarantees termination if this repeats.
        if idx >= len(self.actions):
            return
        r = self.bridge.request({"op": "step", "action": self.actions[idx]})
        self.state, self.actions = r["state"], r["actions"]


def simulate_fight(handle, setup, seed, policy, max_steps=MAX_STEPS_PER_FIGHT):
    handle.reset(setup, seed)
    steps = 0
    while not handle.state["ended"] and steps < max_steps:
        handle.step(choose_action_index(handle, policy))
        steps += 1
    return {"won": handle.state.get("winner") == 0, "steps": steps, "rounds": handle.state["round"]}


def simulate_many(handle, setup, runs, seed_base, policy):
    outcomes = [simulate_fight(handle, setup, seed_base + i, policy) for i in range(runs)]
    wins = sum(o["won"] for o in outcomes)
    won_rounds = [o["rounds"] for o in outcomes if o["won"]]
    return {
        "runs": runs,
        "win_rate": wins / runs,
        "avg_rounds": sum(o["rounds"] for o in outcomes) / runs,
        # Only over WINS -- see fitness_score's comment for why avg_rounds (pooled over
        # wins and losses) can't be the thing scored.
        "avg_rounds_when_won": sum(won_rounds) / len(won_rounds) if won_rounds else 0.0,
    }


# WIN_RATE_SCALE=300 mirrors cli_train.ts's fitness_score exactly (winning should always
# outweigh round count for any realistic fight length). ROUND_PENALTY is scaled up from the TS
# original's TURN_PENALTY=1 because this project's "rounds" are a coarser, smaller-magnitude
# unit than the TS bot's per-actor "turns" (roughly 5-20 here vs. tens-to-hundreds there) --
# without rescaling, round count would barely function as a tiebreaker at all.
#
# Scores avg_rounds_when_won, NOT the pooled avg_rounds across wins and losses (2026-09-03,
# flagged by the project owner): penalizing round count on ALL outcomes rewards a policy for
# dying FASTER in the fights it loses, which is exactly backwards -- speed should only ever
# be a tiebreaker among ways of WINNING. A scenario the policy never wins scores 0 from this
# term regardless of how long the losses took (not a bug -- losing fast and losing slow are
# both just losing; win_rate already penalizes not winning at full WIN_RATE_SCALE weight).
# This exact same flaw existed in the ported TS original (cli_train.ts's fitness_score) too
# -- fixed there in the same pass, see AresRPGBot's simulate.ts.
WIN_RATE_SCALE = 300
ROUND_PENALTY = 10

def fitness_score(result):
    return result["win_rate"] * WIN_RATE_SCALE - result["avg_rounds_when_won"] * ROUND_PENALTY


def calibrated_scenarios(gen, handle, count, probe_runs=4, min_win_rate=0.15, max_win_rate=0.9, attempts_multiplier=8):
    """Draws scenarios until `count` land in a genuinely contested win-rate band under
    DEFAULT_POLICY, discarding free wins and hopeless losses -- ported from
    AresRPGBot's training_scenarios.ts calibrate_group, adapted to this project's
    ScenarioGenerator (draws team+mobs together, unlike the TS version's independently
    adjustable mob group) via filtering instead of iterative level-nudging. Without this, a
    training set dominated by free wins or hopeless losses gives evolution nothing to select
    for -- confirmed happening upstream too (training_scenarios.ts: "5 of 8 raw-random
    scenarios were 0% or 100% regardless of policy, and training flat-lined for 5 straight
    generations because of it").
    """
    scenarios = []
    attempts = 0
    max_attempts = count * attempts_multiplier
    while len(scenarios) < count and attempts < max_attempts:
        attempts += 1
        setup = gen.setup()
        probe = simulate_many(handle, setup, probe_runs, seed_base=500, policy=DEFAULT_POLICY)
        if min_win_rate <= probe["win_rate"] <= max_win_rate:
            scenarios.append(setup)
    if len(scenarios) < count:
        print(f"[calibrate] only found {len(scenarios)}/{count} contested scenarios in {attempts} attempts",
              file=sys.stderr)
    return scenarios


def mutate(policy, std, rng=None):
    # `rng` doit être un `random.Random` seedé pour que la trajectoire évolutive soit
    # reproductible -- le module global `random` n'est pas seedé ici (seul
    # ScenarioGenerator a son propre random.Random(a.seed)), donc sans ce paramètre
    # --seed ne reproduit pas exactement les mêmes mutations d'une run à l'autre.
    r = rng or random
    return clamp_policy(Policy(**{k: getattr(policy, k) + r.gauss(0, 1) * std for k in POLICY_KEYS}))


def crossover(a, b, rng=None):
    r = rng or random
    return clamp_policy(Policy(**{k: (getattr(a, k) + getattr(b, k)) / 2 for k in POLICY_KEYS}))


def describe(policy):
    return " ".join(f"{k}={getattr(policy, k):.2f}" for k in POLICY_KEYS)


# A machine crash mid-run (2026-09-02: lost generations 1-5 of an 8-generation run, ~85
# minutes of compute, right after the previous checkpointing work for rl/train.py -- the
# irony was not lost) is exactly what per-generation checkpointing exists to survive.
# Written after every generation; --resume picks it back up instead of restarting.
def save_checkpoint(path, generation, population, best, scenarios, baseline_fitness):
    Path(path).write_text(json.dumps({
        "generation": generation,
        "population": [asdict(p) for p in population],
        "best": {"policy": asdict(best["policy"]), "fitness": best["fitness"]},
        "scenarios": scenarios,
        "baseline_fitness": baseline_fitness,
    }, indent=2))


def load_checkpoint(path):
    data = json.loads(Path(path).read_text())
    return {
        "generation": data["generation"],
        "population": [Policy(**p) for p in data["population"]],
        "best": {"policy": Policy(**data["best"]["policy"]), "fitness": data["best"]["fitness"]},
        "scenarios": data["scenarios"],
        "baseline_fitness": data["baseline_fitness"],
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--generations", type=int, default=8)
    p.add_argument("--population", type=int, default=10)
    p.add_argument("--scenarios", type=int, default=8)
    p.add_argument("--elites", type=int, default=4)
    p.add_argument("--runs-per-eval", type=int, default=3)
    p.add_argument("--mutation-std", type=float, default=0.35)
    p.add_argument("--seed", type=int, default=20260901, help="fixed by default so a training run is reproducible")
    p.add_argument("--difficulty", type=float, default=0.3,
                   help="ScenarioGenerator difficulty, 0-1 (default lower than the real target "
                        "distribution -- mirrors AresRPGBot's own training_scenarios.ts, which trains "
                        "on a narrow low-level band specifically so evolution has learnable scenarios "
                        "to select against; calibration on the full difficulty=1.0 distribution was "
                        "much slower to fill, 24 probe-attempts for 1 contested scenario in testing)")
    p.add_argument("--out", default="models/policy.json")
    p.add_argument("--holdout-seed", type=int, default=999_999,
                   help="held-out scenario-generator seed, distinct from --seed -- must never match it")
    p.add_argument("--holdout-scenarios", type=int, default=8)
    p.add_argument("--holdout-runs", type=int, default=8,
                   help="episodes per held-out scenario -- higher than --runs-per-eval since this is the "
                        "one number that decides whether to save, not a per-generation search signal")
    p.add_argument("--min-holdout-improvement", type=float, default=1.0,
                   help="minimum held-out fitness improvement over DEFAULT_POLICY required to save -- "
                        "see docs/ROADMAP.md: the first trained policy improved +15 on its own training "
                        "fitness but 0.00 on held-out data, pure overfitting to a small 24-evaluation signal")
    p.add_argument("--checkpoint", default="models/policy_checkpoint.json",
                   help="written after every generation -- see --resume")
    p.add_argument("--resume", action="store_true",
                   help="continue from --checkpoint instead of starting a fresh run (re-uses its saved "
                        "scenarios/population/best, skips calibration and baseline re-evaluation)")
    a = p.parse_args()
    if a.holdout_seed == a.seed:
        raise SystemExit("--holdout-seed must differ from --seed")

    # rng_evo est un générateur seedé séparé pour mutate/crossover, distinct du rng de
    # ScenarioGenerator -- sans ça, --seed ne reproduisait que le tirage des scénarios,
    # pas la trajectoire évolutive (mutations/croisements sur le module global `random`).
    rng_evo = random.Random(a.seed)

    bridge = AresBridge()
    handle = SimHandle(bridge)
    gen = ScenarioGenerator(seed=a.seed, difficulty=a.difficulty)

    try:
        # A single scenario's simulate_many call taking far longer than the rest is a real
        # signal (a rare pathological board/action state, not the norm -- direct profiling
        # of 60 consecutive ordinary fights here averaged ~1.1s each with no slowdown trend),
        # and previously there was no way to see it happen short of guessing from an opaque
        # multi-minute silence (see docs/ROADMAP.md). SLOW_SCENARIO_S is generous relative to
        # that ~1.1s baseline (runs_per_eval fights per call, so a few seconds is normal).
        SLOW_SCENARIO_S = 8.0

        def fitness_of(policy):
            results = []
            for i, s in enumerate(scenarios):
                t_s = time.time()
                results.append(simulate_many(handle, s, a.runs_per_eval, seed_base=1, policy=policy))
                dt = time.time() - t_s
                if dt > SLOW_SCENARIO_S:
                    print(f"  [slow] scenario {i} took {dt:.1f}s ({a.runs_per_eval} fights)", file=sys.stderr, flush=True)
            return sum(fitness_score(r) for r in results) / len(results)

        if a.resume:
            print(f"[checkpoint] resuming from {a.checkpoint}", file=sys.stderr, flush=True)
            ckpt = load_checkpoint(a.checkpoint)
            scenarios = ckpt["scenarios"]
            population = ckpt["population"]
            best = ckpt["best"]
            baseline_fitness = ckpt["baseline_fitness"]
            start_gen = ckpt["generation"] + 1
            print(f"[checkpoint] resuming at generation {start_gen}/{a.generations}, "
                  f"all_time_best={best['fitness']:.2f}", file=sys.stderr, flush=True)
        else:
            t0 = time.time()
            print(f"Calibrating {a.scenarios} scenarios...", file=sys.stderr)
            scenarios = calibrated_scenarios(gen, handle, a.scenarios)
            print(f"  {len(scenarios)} scenarios ready in {time.time()-t0:.0f}s", file=sys.stderr)

            print("Evaluating baseline...", file=sys.stderr, flush=True)
            baseline_fitness = fitness_of(DEFAULT_POLICY)
            print(f"gen 0 baseline (untrained default): fitness={baseline_fitness:.2f}  [{describe(DEFAULT_POLICY)}]")

            # High-priority_decay seeds directly test a specific gap the last validated run
            # left open (2026-09-02): its winning priority_decay (0.62) was still far from
            # clamp_policy's ceiling (3.0), and rl/heuristic.py's absolute lowest-HP
            # targeting -- which still out-won every scored policy tried -- behaves like
            # this same formula's priority_decay -> infinity limit. Seeding a few explicit
            # high-decay genomes gives the search a head start into that region instead of
            # relying on random-walk mutation to find it over many generations.
            DECAY_SEEDS = (1.5, 2.5, 3.0)
            seeded = [DEFAULT_POLICY] + [clamp_policy(Policy(priority_decay=d)) for d in DECAY_SEEDS]
            seeded = seeded[:a.population]
            population = seeded + [mutate(DEFAULT_POLICY, a.mutation_std, rng_evo) for _ in range(a.population - len(seeded))]
            best = {"policy": DEFAULT_POLICY, "fitness": baseline_fitness}
            start_gen = 1

        for gen_i in range(start_gen, a.generations + 1):
            t_gen = time.time()
            print(f"gen {gen_i}: evaluating {len(population)} genomes...", file=sys.stderr, flush=True)
            scored = []
            for genome_i, pol in enumerate(population):
                t_genome = time.time()
                scored.append((pol, fitness_of(pol)))
                print(f"  genome {genome_i+1}/{len(population)} fitness={scored[-1][1]:.2f} ({time.time()-t_genome:.0f}s)",
                      file=sys.stderr, flush=True)
            scored.sort(key=lambda t: -t[1])
            if scored[0][1] > best["fitness"]:
                best = {"policy": scored[0][0], "fitness": scored[0][1]}
            print(f"gen {gen_i}: best_this_gen={scored[0][1]:.2f}  all_time_best={best['fitness']:.2f}  "
                  f"[{describe(scored[0][0])}]  ({time.time()-t_gen:.0f}s)")

            elites = [pol for pol, _ in scored[:a.elites]]
            std = a.mutation_std * (1 - gen_i / (a.generations + 1))  # anneal: explore less as generations pass
            next_population = [best["policy"]]  # elitism: never lose the all-time best
            while len(next_population) < a.population:
                parent_a, parent_b = rng_evo.choice(elites), rng_evo.choice(elites)
                next_population.append(mutate(crossover(parent_a, parent_b, rng_evo), std, rng_evo))
            population = next_population

            save_checkpoint(a.checkpoint, gen_i, population, best, scenarios, baseline_fitness)
        print(f"\nbaseline fitness (training set): {baseline_fitness:.2f}")
        print(f"best found (training set):       {best['fitness']:.2f}  [{describe(best['policy'])}]")
        train_improvement = best["fitness"] - baseline_fitness

        # Held-out validation gate: the whole reason this exists is that a policy can improve
        # on the same small in-sample signal it was searched against without generalizing at
        # all -- confirmed happening (docs/ROADMAP.md, 2026-09-02): a policy that improved
        # +15.00 in-sample scored EXACTLY the same win rate as the untrained default on a
        # held-out seed (0.00 real improvement). Re-evaluates both policies on scenarios drawn
        # from a *different* seed, calibrated the same way, with more runs/scenario than the
        # search itself used (a cleaner signal is affordable here -- this runs once, not once
        # per genome per generation).
        print(f"\nCalibrating {a.holdout_scenarios} held-out scenarios (seed={a.holdout_seed})...",
              file=sys.stderr, flush=True)
        holdout_gen = ScenarioGenerator(seed=a.holdout_seed, difficulty=a.difficulty)
        holdout_scenarios = calibrated_scenarios(holdout_gen, handle, a.holdout_scenarios)

        def holdout_fitness_of(policy):
            results = [simulate_many(handle, s, a.holdout_runs, seed_base=1, policy=policy) for s in holdout_scenarios]
            return sum(fitness_score(r) for r in results) / len(results)

        holdout_default_fitness = holdout_fitness_of(DEFAULT_POLICY)
        holdout_best_fitness = holdout_fitness_of(best["policy"])
        holdout_improvement = holdout_best_fitness - holdout_default_fitness
        print(f"held-out default fitness: {holdout_default_fitness:.2f}")
        print(f"held-out best fitness:    {holdout_best_fitness:.2f}")
        print(f"training-set improvement: +{train_improvement:.2f}   held-out improvement: "
              f"{'+' if holdout_improvement >= 0 else ''}{holdout_improvement:.2f}")
    finally:
        bridge.close()

    if holdout_improvement >= a.min_holdout_improvement:
        save_trained_policy(best["policy"], a.out, generations=a.generations, fitness=best["fitness"],
                             holdout_fitness=holdout_best_fitness, holdout_improvement=holdout_improvement,
                             matchups=[s["board_seed"] for s in scenarios])
        print(f"-> validated: +{holdout_improvement:.2f} over default on held-out data. Saved to {a.out}")
    else:
        print(f"-> only {'+' if holdout_improvement >= 0 else ''}{holdout_improvement:.2f} over default on "
              f"held-out data (needed >= +{a.min_holdout_improvement:.2f}) -- NOT saving. The training-set "
              "improvement alone doesn't mean this generalizes; see docs/ROADMAP.md.")


if __name__ == "__main__":
    main()
