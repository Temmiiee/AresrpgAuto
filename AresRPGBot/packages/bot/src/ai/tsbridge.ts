import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(dirnameFromUrl(import.meta.url));

function dirnameFromUrl(url: URL | string): string {
  return new URL(url, 'file://').pathname.endsWith('/')
    ? new URL(url, 'file://').pathname.slice(0, -1)
    : new URL(url, 'file://').pathname.split('/').slice(0, -1).join('/');
}

/**
 * TypeScript client for communicating with the AresRPG fight engine (bridge/server.ts).
 * Similar to rl/bridge.py but in TypeScript for use by the live bot.
 */
export class TSBridge {
  private bunProcess: ReturnType<typeof spawn> | null = null;
  private isInitialized = false;
  private resolveCallback: ((value: unknown) => void) | null = null;
  private rejectCallback: ((reason?: any) => void) | null = null;

  /** Path to the bridge server script */
  private readonly serverPath: string;

  constructor() {
    // Path to the bridge server relative to the AresRPG root
    this.serverPath = resolve(__dirname, '../../../AresRPG-RL/bridge/server.ts');
  }

  /** Initialize the bridge by spawning the Bun process */
  async initialize(aresRpgRoot: string): Promise<void> {
    if (this.isInitialized) return;

    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;

      try {
        // Spawn the Bun process
        this.bunProcess = spawn('bun', ['run', this.serverPath], {
          // Set the AresRPG root as environment variable
          env: { ...process.env, ARES_RPG_ROOT: aresRpgRoot },
          // Use pipes for stdin/stdout
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // Handle process output
        let stdoutData = '';
        this.bunProcess.stdout.on('data', (data) => {
          stdoutData += data.toString();
          const lines = stdoutData.split('\n');
          // Keep the last incomplete line in the buffer
          stdoutData = lines.pop() ?? '';

          // Process complete lines
          for (const line of lines) {
            if (line.trim()) {
              try {
                const response = JSON.parse(line);
                if (this.resolveCallback) {
                  this.resolveCallback(response);
                  this.resolveCallback = null;
                  this.rejectCallback = null;
                }
              } catch (e) {
                if (this.rejectCallback) {
                  this.rejectCallback(new Error(`Failed to parse JSON response: ${e}`));
                  this.resolveCallback = null;
                  this.rejectCallback = null;
                }
              }
            }
          }
        });

        this.bunProcess.stderr.on('data', (data) => {
          console.error('TSBridge STDERR:', data.toString());
        });

        this.bunProcess.on('error', (err) => {
          if (this.rejectCallback) {
            this.rejectCallback(err);
            this.resolveCallback = null;
            this.rejectCallback = null;
          }
        });

        this.bunProcess.on('close', (code) => {
          if (this.rejectCallback) {
            this.rejectCallback(new Error(`Bun process exited with code ${code}`));
            this.resolveCallback = null;
            this.rejectCallback = null;
          }
          this.isInitialized = false;
        });

        // Send a ready ping to make sure the process is ready
        this.bunProcess.stdin.write(JSON.stringify({ ping: true }) + '\n');
        this.bunProcess.stdin.flush();

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a request to the bridge and get the response.
   * @param request The request object to send
   * @returns Promise resolving to the response object
   */
  async request(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('TSBridge not initialized');
    }

    if (!this.bunProcess) {
      throw new Error('TSBridge Bun process not available');
    }

    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;

      try {
        // Send the request to the Bun process
        this.bunProcess.stdin.write(JSON.stringify(request) + '\n');
        this.bunProcess.stdin.flush();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Take a snapshot of the current fight state.
   * @returns Promise resolving to the snapshot ID
   */
  async snapshot(): Promise<number> {
    const response = await this.request({ op: "snapshot" });
    if (!response.ok) {
      throw new Error(`Snapshot failed: ${response.error}`);
    }
    return response.snap_id;
  }

  /**
   * Restore the bridge to a previously snapshotted state.
   * @param snapId The snapshot ID to restore
   * @returns Promise resolving to the state and actions
   */
  async restore(snapId: number): Promise<{ state: any; actions: any[] }> {
    const response = await this.request({ op: "restore", snap_id: snapId });
    if (!response.ok) {
      throw new Error(`Restore failed: ${response.error}`);
    }
    return { state: response.state, actions: response.actions };
  }

  /**
   * Drop (free) a snapshot.
   * @param snapId The snapshot ID to drop
   */
  async dropSnapshot(snapId: number): Promise<void> {
    const response = await this.request({ op: "drop_snapshot", snap_id: snapId });
    if (!response.ok) {
      throw new Error(`Drop snapshot failed: ${response.error}`);
    }
  }

  /**
   * Step the fight forward with an action.
   * @param action The action to execute
   * @returns Promise resolving to the new state, events, and actions
   */
  async step(action: any): Promise<{ state: any; events: any[]; actions: any[] }> {
    const response = await this.request({ op: "step", action });
    if (!response.ok) {
      throw new Error(`Step failed: ${response.error}`);
    }
    return { state: response.state, events: response.events, actions: response.actions };
  }

  /**
   * Get the current state and available actions.
   * @returns Promise resolving to the state and actions
   */
  async getState(): Promise<{ state: any; actions: any[] }> {
    const response = await this.request({ op: "state" });
    if (!response.ok) {
      throw new Error(`Get state failed: ${response.error}`);
    }
    return { state: response.state, actions: response.actions };
  }

  /** Shutdown the bridge and cleanup resources */
  async shutdown(): Promise<void> {
    if (this.bunProcess) {
      this.bunProcess.kill();
      this.bunProcess = null;
    }
    this.isInitialized = false;
    this.resolveCallback = null;
    this.rejectCallback = null;
  }
}

// Helper function to convert live fight state to bridge state format
import { live_state_to_checkpoint } from '../fight/live_checkpoint.ts';
import type { HydratedFightCheckpoint } from '@aresrpg/fight';
import { all_spell_sources } from './sim_content.ts';
import type { SimPartyMember } from './simulate.ts';

const SPELLS = all_spell_sources();

/**
 * Converts live fight state to the format expected by the bridge decision system.
 * This adapts the live_state_to_checkpoint function to return the plain object format
 * that the bridge expects (with numbers instead of BigInt).
 */
export function liveStateToBridgeState(
  rawFightJson: unknown,
  simPartyStats: ReadonlyMap<string, SimPartyMember>
): any {
  // First get the HydratedFightCheckpoint
  const checkpoint = live_state_to_checkpoint(rawFightJson, simPartyStats);

  // Then convert it to the plain object format that bridge/server.ts summary() produces
  // This is essentially the reverse of the summary function in bridge/server.ts

  const raw = checkpoint as any;
  const rawFighters = Array.isArray(raw.contract.fighters) ? raw.contract.fighters : [];

  // Convert fighters to plain numbers
  const fighters = rawFighters.map((f: any, idx: number) => {
    const hp = typeof f.hp === 'bigint' ? Number(f.hp) : f.hp;
    const maxHp = typeof f.max_hp === 'bigint' ? Number(f.max_hp) : f.max_hp;
    const ap = typeof f.ap === 'bigint' ? Number(f.ap) : f.ap;
    const mp = typeof f.mp === 'bigint' ? Number(f.mp) : f.mp;
    const cell = typeof f.cell === 'bigint' ? Number(f.cell) : f.cell;

    return {
      id: idx, // We'll use array index as ID for simplicity
      team: typeof f.team === 'bigint' ? Number(f.team) : f.team,
      cell,
      hp,
      max_hp: maxHp,
      ap,
      mp,
      dead: f.dead,
      kind: f.kind.type,
      level: typeof f.level === 'bigint' ? Number(f.level) : f.level,
      name: f.kind.type === 'player' ? f.kind.character : f.kind.snapshot.mob_type,
      classe: f.kind.type === 'player' ? f.classe : null,
      spell_levels: f.spell_levels,
      effects: f.effects?.length ?? 0,
      cooldowns: f.cooldowns?.length ?? 0,
      // Elemental resistances
      earth_res: f.earth_res ?? 0,
      fire_res: f.fire_res ?? 0,
      water_res: f.water_res ?? 0,
      air_res: f.air_res ?? 0
    };
  });

  return {
    ended: raw.contract.ended,
    winner: raw.contract.winner === null ? null : Number(raw.contract.winner),
    round: Number(raw.contract.round),
    turn: raw.contract.turn_ptr === null ? null : Number(raw.contract.turn_ptr),
    fighters,
    board: {
      width: Number(raw.contract.board.width),
      height: Number(raw.contract.board.height),
      shape_mask: raw.contract.board.shape_mask.map(String),
      obstacles: raw.contract.board.obstacles.map(String),
      holes: raw.contract.board.holes.map(String),
      grid_w: Number(raw.contract.board.grid_w),
      grid_h: Number(raw.contract.board.grid_h)
    }
  };
}