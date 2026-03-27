import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, unlink, open } from "node:fs/promises";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const CONFIG_PATH = join(homedir(), ".pi", "xai-tts.json");

// Track the current ffplay process for stopping
let currentPlayback: ChildProcess | null = null;

// Check if a command exists
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(`which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

// Write file and ensure it's fully synced to disk
async function writeFileSynced(path: string, data: Buffer): Promise<void> {
  const fd = await open(path, "w");
  try {
    await fd.write(data);
    await fd.sync(); // Ensure data is written to disk
  } finally {
    await fd.close();
  }
}

// Default configuration
const DEFAULT_VOICE = "leo";
const DEFAULT_LANGUAGE = "en";

// Get last assistant message from session
function getLastAssistantMessage(ctx: any): string | null {
  const entries = ctx.sessionManager?.getEntries?.() || [];
  
  // Iterate backwards to find the last assistant message
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    
    if (entry.type === "message" && entry.message?.role === "assistant") {
      // Extract text content from the assistant message
      const content = entry.message.content;
      if (Array.isArray(content)) {
        // Find text content parts
        const textParts = content
          .filter((part: any) => part.type === "text")
          .map((part: any) => part.text);
        
        if (textParts.length > 0) {
          return textParts.join("\n");
        }
      } else if (typeof content === "string") {
        return content;
      }
    }
  }
  
  return null;
}

// Track the PID separately for more reliable killing
let currentPid: number | null = null;

// Play audio with ffplay (spawn for cancellable playback)
async function playWithFfplay(filePath: string, speed: number = 1.0): Promise<void> {
  // Kill any existing playback
  stopPlayback();

  const args = [
    "-nodisp",
    "-autoexit",
    "-loglevel", "quiet",
  ];

  // Add speed filter if not default speed
  if (speed !== 1.0) {
    args.push("-af", `atempo=${speed}`);
  }

  args.push(filePath);

  return new Promise((resolve, reject) => {
    const proc = spawn("ffplay", args);

    currentPlayback = proc;
    currentPid = proc.pid || null;
    
    console.log(`Started ffplay with PID: ${currentPid}`);

    proc.on("exit", (code) => {
      console.log(`ffplay exited with code: ${code}`);
      if (currentPlayback === proc) {
        currentPlayback = null;
        currentPid = null;
      }
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`ffplay exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      if (currentPlayback === proc) {
        currentPlayback = null;
        currentPid = null;
      }
      reject(err);
    });
  });
}

// Stop current playback
function stopPlayback(): boolean {
  console.log(`stopPlayback called. currentPlayback: ${currentPlayback ? "exists" : "null"}, currentPid: ${currentPid}`);
  
  if (currentPlayback && currentPid) {
    try {
      console.log(`Killing process ${currentPid}`);
      // Try SIGTERM first
      currentPlayback.kill("SIGTERM");
      
      // Force kill after 200ms if still running
      setTimeout(() => {
        try {
          process.kill(currentPid!, 0); // Check if still exists
          console.log(`Process ${currentPid} still alive, force killing`);
          process.kill(currentPid!, "SIGKILL");
        } catch {
          console.log(`Process ${currentPid} already dead`);
        }
      }, 200);
    } catch (err) {
      console.log(`Error killing process: ${err}`);
    }
    currentPlayback = null;
    currentPid = null;
    return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("listen", {
    description: "Read aloud the last AI assistant message using xAI TTS",
    handler: async (_args, ctx) => {
      // Check for UI availability
      if (!ctx.hasUI) {
        console.error("/listen is only available in interactive mode");
        return;
      }

      // Check for ffplay
      if (!(await commandExists("ffplay"))) {
        ctx.ui.notify(
          "ffplay not found. Please install FFmpeg: https://ffmpeg.org/download.html",
          "error"
        );
        return;
      }

      // Load configuration
      let config: {
        xaiApiKey?: string;
        voice?: string;
        language?: string;
        speed?: number;
      };
      
      try {
        const configData = await readFile(CONFIG_PATH, "utf8");
        config = JSON.parse(configData);
      } catch (error) {
        ctx.ui.notify(
          `Failed to load config from ${CONFIG_PATH}. Please create it with your xaiApiKey.`,
          "error"
        );
        return;
      }

      if (!config.xaiApiKey) {
        ctx.ui.notify(
          "Missing xaiApiKey in configuration file",
          "error"
        );
        return;
      }

      // Get last assistant message
      const lastMessage = getLastAssistantMessage(ctx);
      if (!lastMessage) {
        ctx.ui.notify("No assistant message found to read aloud", "warning");
        return;
      }

      // Truncate if too long (xAI TTS has 15,000 char limit)
      const MAX_CHARS = 15000;
      let textToSpeak = lastMessage;
      if (textToSpeak.length > MAX_CHARS) {
        textToSpeak = textToSpeak.slice(0, MAX_CHARS);
        ctx.ui.notify("Message is very long, truncating to 15,000 characters...", "info");
      }

      // Notify user
      ctx.ui.notify("Generating speech with xAI TTS...", "info");

      try {
        // Call xAI TTS API
        const response = await fetch("https://api.x.ai/v1/tts", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${config.xaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: textToSpeak,
            voice_id: config.voice || DEFAULT_VOICE,
            language: config.language || DEFAULT_LANGUAGE,
            output_format: {
              codec: "mp3",
              sample_rate: 24000,
              bit_rate: 128000,
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`xAI TTS API error: ${response.status} ${errorText}`);
        }

        // Get audio data
        const audioBuffer = await response.arrayBuffer();
        
        // Save to temp file with explicit extension - ensure fully synced before playback
        const tempFile = join(homedir(), ".pi", "xai-tts-temp.mp3");
        await writeFileSynced(tempFile, Buffer.from(audioBuffer));

        // Play audio with ffplay
        await playWithFfplay(tempFile, config.speed ?? 1.0);

        // Clean up temp file
        await unlink(tempFile).catch(() => {});

        ctx.ui.notify("Finished playing", "success");
      } catch (error) {
        ctx.ui.notify(
          `Failed to generate or play speech: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    },
  });

  pi.registerCommand("listen-stop", {
    description: "Stop the current audio playback",
    handler: async (_args, ctx) => {
      console.log("listen-stop command triggered");
      const stopped = stopPlayback();
      if (stopped) {
        ctx.ui.notify("Playback stopped", "info");
      } else {
        ctx.ui.notify("No audio currently playing", "warning");
      }
    },
  });
}
