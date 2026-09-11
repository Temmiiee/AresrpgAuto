import { cp } from 'node:fs/promises';
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
 * Client for communicating with the Python RL decision service.
 * Spawns a Python process and communicates via stdin/stdout using JSON lines.
 */
export class RLDecisionService {
  private pythonProcess: ReturnType<typeof spawn> | null = null;
  private isInitialized = false;
  private resolveCallback: ((value: unknown) => void) | null = null;
  private rejectCallback: ((reason?: any) => void) | null = null;

  /** Path to the Python decision service script */
  private readonly scriptPath: string;

  constructor() {
    // Path relative to the bot package
    this.scriptPath = resolve(__dirname, '../../../AresRPG-RL/rl/decide_service.py');
  }

  /** Initialize the service by spawning the Python process */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;

      try {
        // Spawn the Python process
        this.pythonProcess = spawn('python3', [this.scriptPath], {
          // We'll use the AresRPG-RL directory as the working directory
          cwd: resolve(__dirname, '../../../AresRPG-RL'),
          // Use pipes for stdin/stdout
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // Handle process output
        let stdoutData = '';
        this.pythonProcess.stdout.on('data', (data) => {
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

        this.pythonProcess.stderr.on('data', (data) => {
          console.error('RL Decision Service STDERR:', data.toString());
        });

        this.pythonProcess.on('error', (err) => {
          if (this.rejectCallback) {
            this.rejectCallback(err);
            this.resolveCallback = null;
            this.rejectCallback = null;
          }
        });

        this.pythonProcess.on('close', (code) => {
          if (this.rejectCallback) {
            this.rejectCallback(new Error(`Python process exited with code ${code}`));
            this.resolveCallback = null;
            this.rejectCallback = null;
          }
          this.isInitialized = false;
        });

        // Send a ready ping to make sure the process is ready
        this.pythonProcess.stdin.write(JSON.stringify({ ping: true }) + '\n');
        this.pythonProcess.stdin.flush();

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Get the best action for a given fight state using the RL system.
   * @param state The fight state from the game (should match what the bridge expects)
   * @returns Promise resolving to the decision result
   */
  async decideBestAction(state: any): Promise<any> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.pythonProcess) {
      throw new Error('RL Decision Service not initialized');
    }

    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;

      try {
        // Send the state to the Python process
        const request = { state };
        this.pythonProcess.stdin.write(JSON.stringify(request) + '\n');
        this.pythonProcess.stdin.flush();
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Shutdown the service and cleanup resources */
  async shutdown(): Promise<void> {
    if (this.pythonProcess) {
      this.pythonProcess.kill();
      this.pythonProcess = null;
    }
    this.isInitialized = false;
    this.resolveCallback = null;
    this.rejectCallback = null;
  }
}

// Singleton instance for reuse
let rlDecisionServiceInstance: RLDecisionService | null = null;

/**
 * Get the singleton instance of the RL decision service.
 */
export function getRLDecisionService(): RLDecisionService {
  if (!rlDecisionServiceInstance) {
    rlDecisionServiceInstance = new RLDecisionService();
  }
  return rlDecisionServiceInstance;
}