# pi-xai-tts

A pi extension that reads aloud the last AI assistant output using xAI's Text-to-Speech API.

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

## Usage

After the AI responds to your message, type `/listen` to hear the last assistant message read aloud.

To stop playback early, type `/listen-stop`.

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
```

## Requirements

This extension requires **FFmpeg** to be installed, specifically the `ffplay` command.

### Installing FFmpeg

- **macOS**:
  ```bash
  brew install ffmpeg
  ```

- **Ubuntu/Debian**:
  ```bash
  sudo apt-get install ffmpeg
  ```

- **Fedora**:
  ```bash
  sudo dnf install ffmpeg
  ```

- **Windows**: Download from https://ffmpeg.org/download.html and add to PATH

## API Reference

This extension uses the xAI Text-to-Speech API:
- Endpoint: `POST https://api.x.ai/v1/tts`
- Documentation: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
