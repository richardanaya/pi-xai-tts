import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, unlink, open } from "node:fs/promises";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const CONFIG_PATH = join(homedir(), ".pi", "xai-tts.json");
const TEMP_FILE = join(homedir(), ".pi", "xai-tts-temp.mp3");
const MIC_TEMP_FILE = join(homedir(), ".pi", "xai-tts-mic.wav");

// Load config from disk
async function loadConfig(): Promise<{
  xaiApiKey?: string;
  voice?: string;
  language?: string;
  speed?: number;
  accent?: string;
  autoListen?: boolean;
}> {
  try {
    const data = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Save config to disk
async function saveConfig(config: Record<string, unknown>): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

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

// Extract text from an assistant message
function extractAssistantText(message: any): string | null {
  if (message?.role !== "assistant") return null;
  const content = message.content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text);
    if (textParts.length > 0) return textParts.join("\n");
  } else if (typeof content === "string") {
    return content;
  }
  return null;
}

// Get last assistant message from session entries
function getLastAssistantMessage(ctx: any): string | null {
  const entries = ctx.sessionManager?.getEntries?.() || [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const text = extractAssistantText(entry.message);
      if (text) return text;
    }
  }
  return null;
}

// Generate TTS audio and play it
async function speakText(
  text: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  ctx: any,
): Promise<void> {
  const MAX_CHARS = 15000;
  let textToSpeak = text;
  if (textToSpeak.length > MAX_CHARS) {
    textToSpeak = textToSpeak.slice(0, MAX_CHARS);
    ctx.ui.notify("Message is very long, truncating to 15,000 characters...", "info");
  }

  ctx.ui.notify("Generating speech with xAI TTS...", "info");

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

  const audioBuffer = await response.arrayBuffer();
  await writeFileSynced(TEMP_FILE, Buffer.from(audioBuffer));
  await playWithFfplay(TEMP_FILE, config.speed ?? 1.0);

  setTimeout(() => {
    unlink(TEMP_FILE).catch(() => {});
  }, 5000);

  ctx.ui.notify("Finished playing", "success");
}

// Play audio with ffplay (detached so it survives extension reloads)
async function playWithFfplay(filePath: string, speed: number = 1.0): Promise<void> {
  // Kill any existing playback first
  await killExistingPlayback();

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
    // Spawn detached so it doesn't get killed when extension reloads
    const proc = spawn("ffplay", args, { 
      detached: true,
      stdio: "ignore"
    });

    // Unref so Node doesn't wait for it
    proc.unref();

    // Check if it started successfully
    setTimeout(() => {
      if (proc.exitCode !== null && proc.exitCode !== 0) {
        reject(new Error(`ffplay failed to start with code ${proc.exitCode}`));
      } else {
        resolve();
      }
    }, 100);
  });
}

// Kill any existing ffplay processes playing our temp file
async function killExistingPlayback(): Promise<boolean> {
  try {
    // Use pkill to find and kill ffplay processes playing our temp file
    await execAsync(`pkill -f "ffplay.*xai-tts-temp.mp3"`);
    return true;
  } catch {
    // pkill returns error if no processes found, that's fine
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let isRecording = false;
  let recordingProcess: ChildProcess | null = null;
  let micInputUnsub: (() => void) | null = null;
  let recordingTimeout: NodeJS.Timeout | null = null;
  const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000; // 5 minutes
  function startVisualizer(ctx: any): void {
    ctx.ui.setWidget(
      "mic",
      [
        `┌─────────────────────────────────────────────────────────────┐`,
        `│  🎤  Recording...  press F12 to stop & send  (max 5 min)  🎤  │`,
        `└─────────────────────────────────────────────────────────────┘`,
      ],
      { placement: "aboveEditor" }
    );
  }

  function stopVisualizer(ctx: any): void {
    ctx.ui.setWidget("mic", undefined);
  }

  async function startRecording(ctx: any): Promise<void> {
    if (isRecording) return;

    const hasRec = await commandExists("rec");
    const hasArecord = await commandExists("arecord");
    const hasFfmpeg = await commandExists("ffmpeg");

    if (!hasRec && !hasArecord && !hasFfmpeg) {
      ctx.ui.notify("No audio recorder found. Install sox (rec), arecord, or ffmpeg.", "error");
      return;
    }

    let cmd: string;
    let args: string[];

    if (hasRec) {
      cmd = "rec";
      args = ["-q", "-c", "1", "-r", "16000", "-b", "16", "-e", "signed-integer", MIC_TEMP_FILE];
    } else if (hasArecord) {
      cmd = "arecord";
      args = ["-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "wav", MIC_TEMP_FILE];
    } else {
      cmd = "ffmpeg";
      if (process.platform === "darwin") {
        args = ["-f", "avfoundation", "-i", ":0", "-ar", "16000", "-ac", "1", "-y", MIC_TEMP_FILE];
      } else {
        args = ["-f", "alsa", "-i", "default", "-ar", "16000", "-ac", "1", "-y", MIC_TEMP_FILE];
      }
    }

    // Clean up any stale recording file
    try { await unlink(MIC_TEMP_FILE); } catch { /* ignore */ }

    recordingProcess = spawn(cmd, args, { stdio: "ignore" });

    recordingProcess.on("error", () => {
      isRecording = false;
      stopVisualizer(ctx);
    });

    recordingProcess.on("exit", () => {
      recordingProcess = null;
    });

    isRecording = true;
    ctx.ui.notify("🎤 Recording... press F12 to stop and send (max 5 min)", "info");
    startVisualizer(ctx);

    // Auto-stop after max duration - discard to prevent accidental long recordings
    recordingTimeout = setTimeout(() => {
      if (isRecording) {
        void cancelRecordingForTooLong(ctx);
      }
    }, MAX_RECORDING_DURATION_MS);
  }

  async function cancelRecordingForTooLong(ctx: any): Promise<void> {
    if (!isRecording || !recordingProcess) return;

    isRecording = false;
    recordingProcess.kill("SIGTERM");
    recordingProcess = null;
    stopVisualizer(ctx);

    // Clear the auto-stop timeout
    if (recordingTimeout) {
      clearTimeout(recordingTimeout);
      recordingTimeout = null;
    }

    ctx.ui.notify("Recording stopped — exceeded 5 minute limit. Message discarded to prevent accidental sends. Press F12 again to record a shorter message.", "warning");

    // Clean up the temp file without sending
    try { await unlink(MIC_TEMP_FILE); } catch { /* ignore */ }
  }

  async function stopRecordingAndSend(ctx: any): Promise<void> {
    if (!isRecording || !recordingProcess) return;

    isRecording = false;
    recordingProcess.kill("SIGTERM");
    recordingProcess = null;
    stopVisualizer(ctx);

    // Clear the auto-stop timeout
    if (recordingTimeout) {
      clearTimeout(recordingTimeout);
      recordingTimeout = null;
    }

    // Give the recorder a moment to flush the file
    await new Promise((r) => setTimeout(r, 600));

    let audioBuffer: Buffer;
    try {
      audioBuffer = await readFile(MIC_TEMP_FILE);
    } catch {
      ctx.ui.notify("Recording failed — no audio captured", "error");
      await unlink(MIC_TEMP_FILE).catch(() => {});
      return;
    }

    const config = await loadConfig();
    if (!config.xaiApiKey) {
      ctx.ui.notify("Missing xaiApiKey for speech-to-text", "error");
      await unlink(MIC_TEMP_FILE).catch(() => {});
      return;
    }

    try {
      ctx.ui.notify("Transcribing...", "info");

      const formData = new FormData();
      formData.append("format", "true");
      formData.append("language", config.language || "en");
      formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "recording.wav");

      const response = await fetch("https://api.x.ai/v1/stt", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.xaiApiKey}` },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`STT API error: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as { text?: string };
      const text = result.text?.trim();

      if (!text) {
        ctx.ui.notify("No speech detected", "warning");
        return;
      }

      ctx.ui.notify(`🎤 Heard: "${text}"`, "success");
      pi.sendUserMessage(text);
    } catch (error) {
      ctx.ui.notify(
        `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    } finally {
      unlink(MIC_TEMP_FILE).catch(() => {});
    }
  }

  // Wire up Ctrl+M hold-to-record in interactive mode
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    micInputUnsub = ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, Key.f12)) {
        void (async () => {
          const killed = await killExistingPlayback();
          if (killed) {
            ctx.ui.notify("Stopped listening", "info");
          } else {
            if (isRecording) {
              await stopRecordingAndSend(ctx);
            } else {
              await startRecording(ctx);
            }
          }
        })();
        return { consume: true };
      }
      return undefined;
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (micInputUnsub) {
      micInputUnsub();
      micInputUnsub = null;
    }
    if (recordingTimeout) {
      clearTimeout(recordingTimeout);
      recordingTimeout = null;
    }
    if (isRecording && recordingProcess) {
      recordingProcess.kill("SIGTERM");
      isRecording = false;
      stopVisualizer(ctx);
    }
  });

  pi.registerCommand("add-accent", {
    description: "Add a speaking accent/dialect to the AI's responses (e.g., 'talk like a pirate')",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        console.error("/add-accent is only available in interactive mode");
        return;
      }

      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /add-accent <description> — e.g., /add-accent talk like a pirate", "warning");
        return;
      }

      const config = await loadConfig();
      config.accent = description;
      await saveConfig(config);

      ctx.ui.notify(`Accent set: "${description}"`, "success");
    },
  });

  pi.registerCommand("remove-accent", {
    description: "Remove the active speaking accent/dialect",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        console.error("/remove-accent is only available in interactive mode");
        return;
      }

      const config = await loadConfig();
      if (config.accent) {
        delete config.accent;
        await saveConfig(config);
        ctx.ui.notify("Accent removed", "info");
      } else {
        ctx.ui.notify("No accent is currently set", "warning");
      }
    },
  });

  // Inject accent instructions into the system prompt before each agent turn
  pi.on("before_agent_start", async (event) => {
    const config = await loadConfig();
    if (config.accent) {
      return {
        systemPrompt:
          event.systemPrompt +
          `

IMPORTANT: When writing any text that will be spoken aloud (including explanations, summaries, or responses to the user), you must adopt the following speaking style for ALL responses: ${config.accent}. Write everything in a natural, conversational way that sounds authentic when read aloud. Do not break character. Still complete the actual task correctly.

You are also aware of xAI TTS speech tags for expressive delivery. Use them sparingly and only when they genuinely enhance the spoken delivery:

INLINE TAGS (insert at specific points): [pause] [long-pause] [laugh] [giggle] [chuckle] [sigh] [groan] [gasp] [breath] [inhale] [exhale] [lip-smack] [cough] [throat-clear] [sneeze] [whimper] [swallow]

WRAPPING TAGS (wrap sections): <whisper>...</whisper> <loud>...</loud> <soft>...</soft> <emphasis>...</emphasis> <reduced>...</reduced> <high>...</high> <low>...</low> <fast>...</fast> <slow>...</slow> <singing>...</singing> <shouting>...</shouting> <screaming>...</screaming>

Tips: Place tags where the expression occurs naturally; combine with punctuation for better flow; wrapping tags work best around complete phrases.
`,
      };
    }
    return undefined;
  });

  pi.registerCommand("listen", {
    description: "Read aloud the last AI assistant message using xAI TTS",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        console.error("/listen is only available in interactive mode");
        return;
      }

      if (!(await commandExists("ffplay"))) {
        ctx.ui.notify(
          "ffplay not found. Please install FFmpeg: https://ffmpeg.org/download.html",
          "error"
        );
        return;
      }

      const config = await loadConfig();
      if (!config.xaiApiKey) {
        ctx.ui.notify("Missing xaiApiKey in configuration file", "error");
        return;
      }

      const lastMessage = getLastAssistantMessage(ctx);
      if (!lastMessage) {
        ctx.ui.notify("No assistant message found to read aloud", "warning");
        return;
      }

      try {
        await speakText(lastMessage, config, ctx);
      } catch (error) {
        ctx.ui.notify(
          `Failed to generate or play speech: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    },
  });

  pi.registerCommand("auto-listen-on", {
    description: "Automatically read aloud each assistant response when it finishes",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        console.error("/auto-listen-on is only available in interactive mode");
        return;
      }

      const config = await loadConfig();
      if (!config.xaiApiKey) {
        ctx.ui.notify("Missing xaiApiKey in configuration file", "error");
        return;
      }

      if (!(await commandExists("ffplay"))) {
        ctx.ui.notify(
          "ffplay not found. Please install FFmpeg: https://ffmpeg.org/download.html",
          "error"
        );
        return;
      }

      config.autoListen = true;
      await saveConfig(config);
      ctx.ui.notify("Auto-listen enabled — assistant responses will be read aloud automatically", "success");
    },
  });

  pi.registerCommand("auto-listen-off", {
    description: "Disable automatic read-aloud of assistant responses",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        console.error("/auto-listen-off is only available in interactive mode");
        return;
      }

      const config = await loadConfig();
      config.autoListen = false;
      await saveConfig(config);
      ctx.ui.notify("Auto-listen disabled", "info");
    },
  });

  // Auto-listen: play TTS on the final assistant message when agent finishes
  pi.on("agent_end", async (event, ctx) => {
    if (!ctx.hasUI) return;

    const config = await loadConfig();
    if (!config.autoListen || !config.xaiApiKey) return;
    if (!(await commandExists("ffplay"))) return;

    const messages = event.messages || [];
    let lastText: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const text = extractAssistantText(messages[i]);
      if (text) {
        lastText = text;
        break;
      }
    }

    if (!lastText) return;

    try {
      await speakText(lastText, config, ctx);
    } catch (error) {
      ctx.ui.notify(
        `Auto-listen failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  });

  pi.registerCommand("listen-stop", {
    description: "Stop the current audio playback",
    handler: async (_args, ctx) => {
      const killed = await killExistingPlayback();
      if (killed) {
        ctx.ui.notify("Playback stopped", "info");
      } else {
        ctx.ui.notify("No audio currently playing", "warning");
      }
    },
  });
}
