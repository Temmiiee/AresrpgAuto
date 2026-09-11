import json, os, shutil, subprocess
from pathlib import Path

def _bun_executable():
    # A shell that ran `curl bun.com/install | bash` (e.g. notebooks/colab_setup.sh)
    # only exports PATH into its own subprocess -- that doesn't reach whatever later
    # process spawns this one, so `bun` is very often "installed" but not resolvable
    # via shutil.which here. Fall back to the installer's own default location before
    # giving up, instead of a bare FileNotFoundError that doesn't say why.
    found = shutil.which("bun")
    if found: return found
    default_bin = Path(os.environ.get("BUN_INSTALL", Path.home() / ".bun")) / "bin"
    found = shutil.which("bun", path=str(default_bin))  # PATHEXT-aware: finds bun.exe on Windows too
    if found: return found
    raise RuntimeError(
        f"bun executable not found on PATH or in {default_bin}. Install it "
        "(see notebooks/colab_setup.sh) or add its bin/ directory to PATH."
    )

DATA_DIR = Path(__file__).resolve().parents[1] / "data"

class AresBridge:
    def __init__(self):
        root=os.environ.get("ARES_RPG_ROOT")
        if not root: raise RuntimeError("Set ARES_RPG_ROOT first.")
        script=Path(__file__).resolve().parents[1]/"bridge"/"server.ts"
        self.p=subprocess.Popen([_bun_executable(),"run",str(script)],cwd=root,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            text=True,bufsize=1)
        # Send the full spell catalog once per subprocess lifetime; ScenarioGenerator.setup()
        # sends only spell names per reset and the bridge fills these back in (see
        # bridge/server.ts) -- was ~330KB of identical data resent every single episode.
        spells=json.loads((DATA_DIR/"spells.json").read_text())
        r=self.request({"op":"load_spells","spells":spells})
        if not r.get("ok"): raise RuntimeError(f"load_spells failed: {r}")

    def request(self,x):
        self.p.stdin.write(json.dumps(x)+"\n"); self.p.stdin.flush()
        line=self.p.stdout.readline()
        if not line: raise RuntimeError(self.p.stderr.read())
        return json.loads(line)

    def snapshot(self) -> int:
        """Sauvegarde l'état courant du combat dans le bridge et retourne un snap_id entier.
        Utiliser restore(snap_id) pour y revenir ultérieurement.
        Les snapshots sont libérés automatiquement au prochain reset(); drop_snapshot()
        permet de les libérer explicitement avant ça."""
        r = self.request({"op": "snapshot"})
        if not r.get("ok"):
            raise RuntimeError(f"snapshot failed: {r}")
        return r["snap_id"]

    def restore(self, snap_id: int) -> dict:
        """Restaure le bridge à l'état enregistré sous snap_id.
        Retourne le dict {state, actions} identique à un reset/step réussi."""
        r = self.request({"op": "restore", "snap_id": snap_id})
        if not r.get("ok"):
            raise RuntimeError(f"restore({snap_id}) failed: {r}")
        return r

    def drop_snapshot(self, snap_id: int) -> None:
        """Libère un snapshot explicitement. Optionnel — tous les snapshots sont
        effacés au prochain reset() de toute façon."""
        self.request({"op": "drop_snapshot", "snap_id": snap_id})

    def close(self):
        if self.p.poll() is None: self.p.terminate()
