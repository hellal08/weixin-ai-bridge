/**
 * Agent backend: arbitrary shell command.
 * Pipes the message as argument, returns stdout.
 * Example: --agent command --command "python my_bot.py"
 */

import { execFile } from "node:child_process";
import type { AgentBackend } from "./types.js";
import { sanitizeErrorMessage } from "./sanitize.js";

export class CommandAgent implements AgentBackend {
  name: string;
  private cmd: string;
  private cmdArgs: string[];

  constructor(command: string) {
    const parts = command.split(/\s+/);
    this.cmd = parts[0];
    this.cmdArgs = parts.slice(1);
    this.name = `Command (${command})`;
  }

  async ask(_userId: string, message: string): Promise<string> {
    return new Promise((resolve) => {
      const args = [...this.cmdArgs, message];
      console.log(`[command] ${this.cmd} ${this.cmdArgs.join(" ")} "<message>"`);

      execFile(this.cmd, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 2 * 60 * 1000,
        env: { ...process.env },
      }, (error, stdout) => {
        if (error) {
          resolve(`⚠️ 命令出错: ${sanitizeErrorMessage(error.message)}`);
          return;
        }
        resolve(stdout.trim() || "[命令无输出]");
      });
    });
  }

  reset(): void {
    // No state to clear for command agent
  }
}
