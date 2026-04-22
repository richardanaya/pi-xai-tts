# pi-xai-tts

A pi extension for voice interaction: speech-to-text input via microphone, and text-to-speech playback of assistant responses — powered by xAI.

## Installation

Install via npm:

```bash
$ pi install npm:pi-xai-tts
```

Or install from git:

```bash
$ pi install git:github.com/richardanaya/pi-xai-tts
```

## Configuration

Create a JSON file at `~/.pi/xai-tts.json` with your API key:

```json
{
  "xaiApiKey": "your-api-key-here",
  "voice": "leo"
}
```

Replace `your-api-key-here` with your actual xAI API key. You can get one at https://console.x.ai/

### Optional Settings

- **voice**: The voice to use for speech synthesis. Options:
  - `leo` (default) - Authoritative, strong
  - `eve` - Energetic, upbeat
  - `ara` - Warm, friendly
  - `rex` - Confident, clear
  - `sal` - Smooth, balanced

- **language**: BCP-47 language code (e.g., `en`, `zh`, `pt-BR`). Defaults to `en`.

- **speed**: Playback speed multiplier (e.g., `0.5` for half speed, `1.5` for 1.5x speed, `2.0` for double speed). Defaults to `1.0` (normal speed). Range: `0.5` to `2.0`.

## Usage

After the AI responds to your message, type `/listen` to hear the last assistant message read aloud.

To stop playback early, type `/listen-stop`.

### Voice Input (Speech-to-Text)

Hold **Ctrl+M** to record your voice. Release to stop — the audio is transcribed via xAI and sent as your prompt.

If your terminal doesn't distinguish `Ctrl+M` from `Enter`, use the `/mic` command instead:

```
# Start recording
/mic

# Stop recording — transcription is sent automatically
/mic
```

### Accent / Dialect Mode

To make the AI speak with a specific accent or dialect (affecting both text responses and TTS output):

```
# Make the AI talk like a pirate
/add-accent talk like a pirate

# Remove the accent
/remove-accent
```

The accent is persisted in your config file and injected into the system prompt before every agent turn, so the AI writes in character for all responses. This makes TTS output sound natural and consistent.

### Examples

```
# Ask pi something
> What is the capital of France?

[pi responds with "The capital of France is Paris..."]

# Listen to the response
/listen

# The response will be read aloud using xAI TTS

# Stop playback early if needed
/listen-stop

# Hold Ctrl+M, speak, then release to send a voice message

# Enable pirate speak for all future responses
/add-accent talk like a pirate

# Remove it later
/remove-accent
```

## Requirements

### Playback (TTS)
Requires **FFmpeg** to be installed, specifically the `ffplay` command.

- **macOS**: `brew install ffmpeg`
- **Ubuntu/Debian**: `sudo apt-get install ffmpeg`
- **Fedora**: `sudo dnf install ffmpeg`
- **Windows**: Download from https://ffmpeg.org/download.html and add to PATH

### Voice Input (STT)
Requires one of the following audio recording tools:

- **sox** (preferred — most portable)
  - macOS: `brew install sox`
  - Ubuntu/Debian: `sudo apt-get install sox libsox-fmt-all`
  - Fedora: `sudo dnf install sox`

- **arecord** (Linux ALSA, usually pre-installed)

- **ffmpeg** (also used for playback)

## API Reference

This extension uses xAI's audio APIs:

- **Text-to-Speech**
  - Endpoint: `POST https://api.x.ai/v1/tts`
  - Docs: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech

- **Speech-to-Text**
  - Endpoint: `POST https://api.x.ai/v1/audio/transcriptions`
  - Docs: https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
