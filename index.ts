import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, unlink, open } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import playerFactory from "play-sound";

const execAsync = promisify(exec);
const CONFIG_PATH = join(homedir(), ".pi", "grok-tts.json");

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

// Play audio with specified player
async function playWithPlayer(filePath: string, playerCmd: string): Promise<void> {
  const commands: Record<string, string> = {
    afplay: `afplay "${filePath}"`,
    mpg123: `mpg123 -q "${filePath}"`,
    mpg321: `mpg321 -q "${filePath}"`,
    paplay: `paplay "${filePath}"`,
    aplay: `aplay -q "${filePath}"`,
    ffplay: `ffplay -nodisp -autoexit -loglevel quiet "${filePath}"`,
    vlc: `vlc "${filePath}" --play-and-exit --quiet`,
  };

  const command = commands[playerCmd];
  if (!command) {
    throw new Error(`Unknown audio player: ${playerCmd}`);
  }

  await execAsync(command);
}

export default function (pi: ExtensionAPI) {
  // Initialize the audio player
  const player = playerFactory();

  pi.registerCommand("listen", {
    description: "Read aloud the last AI assistant message using Grok TTS",
    handler: async (_args, ctx) => {
      // Check for UI availability
      if (!ctx.hasUI) {
        console.error("/listen is only available in interactive mode");
        return;
      }

      // Load configuration
      let config: {
        xaiApiKey?: string;
        voice?: string;
        language?: string;
        player?: string;
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

      // Truncate if too long (Grok TTS has 15,000 char limit)
      const MAX_CHARS = 15000;
      let textToSpeak = lastMessage;
      if (textToSpeak.length > MAX_CHARS) {
        textToSpeak = textToSpeak.slice(0, MAX_CHARS);
        ctx.ui.notify("Message is very long, truncating to 15,000 characters...", "info");
      }

      // Notify user
      ctx.ui.notify("Generating speech with Grok TTS...", "info");

      try {
        // Call Grok TTS API
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
          throw new Error(`Grok TTS API error: ${response.status} ${errorText}`);
        }

        // Debug: Log response info
        const contentType = response.headers.get("content-type");
        console.log(`TTS response: Content-Type=${contentType}`);

        // Get audio data
        const audioBuffer = await response.arrayBuffer();
        console.log(`TTS audio size: ${audioBuffer.byteLength} bytes`);
        
        // Save to temp file with explicit extension - ensure fully synced before playback
        const tempFile = join(homedir(), ".pi", "grok-tts-temp.mp3");
        await writeFileSynced(tempFile, Buffer.from(audioBuffer));
        console.log(`Audio saved and synced to: ${tempFile}`);

        // Play audio - prefer direct ffplay, fall back to play-sound
        if (config.player) {
          // Use manually specified player
          console.log(`Playing with configured player: ${config.player}`);
          await playWithPlayer(tempFile, config.player);
          await unlink(tempFile).catch(() => {});
        } else if (await commandExists("ffplay")) {
          // Use direct ffplay (most reliable)
          console.log("Playing with direct ffplay invocation");
          await execAsync(`ffplay -nodisp -autoexit -loglevel quiet "${tempFile}"`);
          await unlink(tempFile).catch(() => {});
        } else {
          // Fall back to play-sound auto-detection
          console.log("Playing with play-sound auto-detection");
          
          await new Promise<void>((resolve, reject) => {
            player.play(tempFile, (err) => {
              // Clean up temp file
              unlink(tempFile).catch(() => {});
              
              if (err) {
                reject(new Error(`Audio playback failed: ${err.message}. Try installing ffmpeg (recommended) or set "player" in config to one of: ffplay, afplay, mpg123, paplay, aplay, vlc`));
              } else {
                resolve();
              }
            });
          });
        }

        ctx.ui.notify("Finished playing", "success");
      } catch (error) {
        ctx.ui.notify(
          `Failed to generate or play speech: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    },
  });
}
