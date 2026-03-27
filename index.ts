import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const CONFIG_PATH = join(homedir(), ".pi", "grok-tts.json");

// Default configuration
const DEFAULT_VOICE = "eve";
const DEFAULT_LANGUAGE = "en";

// Find a suitable audio player
async function findAudioPlayer(): Promise<string | null> {
  const players = ["afplay", "mpg123", "paplay", "aplay", "ffplay"];
  
  for (const player of players) {
    try {
      await execAsync(`which ${player}`);
      return player;
    } catch {
      continue;
    }
  }
  
  return null;
}

// Play audio file using system player
async function playAudio(filePath: string, player: string): Promise<void> {
  const commands: Record<string, string> = {
    afplay: `afplay "${filePath}"`,
    mpg123: `mpg123 -q "${filePath}"`,
    paplay: `paplay "${filePath}"`,
    aplay: `aplay -q "${filePath}"`,
    ffplay: `ffplay -nodisp -autoexit -loglevel quiet "${filePath}"`,
  };

  const command = commands[player];
  if (!command) {
    throw new Error(`Unknown audio player: ${player}`);
  }

  await execAsync(command);
}

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

export default function (pi: ExtensionAPI) {
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
        grokApiKey?: string;
        voice?: string;
        language?: string;
      };
      
      try {
        const configData = await readFile(CONFIG_PATH, "utf8");
        config = JSON.parse(configData);
      } catch (error) {
        ctx.ui.notify(
          `Failed to load config from ${CONFIG_PATH}. Please create it with your grokApiKey.`,
          "error"
        );
        return;
      }

      if (!config.grokApiKey) {
        ctx.ui.notify(
          "Missing grokApiKey in configuration file",
          "error"
        );
        return;
      }

      // Find audio player
      const player = await findAudioPlayer();
      if (!player) {
        ctx.ui.notify(
          "No audio player found. Please install afplay (macOS), mpg123, paplay, or aplay (Linux).",
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
            "Authorization": `Bearer ${config.grokApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: textToSpeak,
            voice_id: config.voice || DEFAULT_VOICE,
            language: config.language || DEFAULT_LANGUAGE,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Grok TTS API error: ${response.status} ${errorText}`);
        }

        // Get audio data
        const audioBuffer = await response.arrayBuffer();
        
        // Save to temp file
        const tempFile = join(homedir(), ".pi", "grok-tts-temp.mp3");
        await writeFile(tempFile, Buffer.from(audioBuffer));

        // Play audio
        await playAudio(tempFile, player);

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
}
