# pi-grok-tts

A pi extension that reads aloud the last AI assistant output using Grok's Text-to-Speech API.

## Installation

Install via npm:

```bash
$ pi install npm:pi-grok-tts
```

Or install from git:

```bash
$ pi install git:github.com/richardanaya/pi-grok-tts
```

## Configuration

Create a JSON file at `~/.pi/grok-tts.json` with your API key:

```json
{
  "grokApiKey": "your-api-key-here",
  "voice": "eve"
}
```

Replace `your-api-key-here` with your actual xAI API key. You can get one at https://console.x.ai/

### Optional Settings

- **voice**: The voice to use for speech synthesis. Options:
  - `eve` (default) - Energetic, upbeat
  - `ara` - Warm, friendly
  - `rex` - Confident, clear
  - `sal` - Smooth, balanced
  - `leo` - Authoritative, strong

- **language**: BCP-47 language code (e.g., `en`, `zh`, `pt-BR`). Defaults to `en`.

## Usage

After the AI responds to your message, type `/listen` to hear the last assistant message read aloud.

### Examples

```
# Ask pi something
> What is the capital of France?

[pi responds with "The capital of France is Paris..."]

# Listen to the response
/listen

# The response will be read aloud using Grok TTS
```

## Requirements

This extension requires a system audio player:
- **macOS**: `afplay` (built-in)
- **Linux**: `mpg123`, `paplay` (PulseAudio), or `aplay` (ALSA)
- **Windows**: Not currently supported (contributions welcome!)

## API Reference

This extension uses the Grok Text-to-Speech API:
- Endpoint: `POST https://api.x.ai/v1/tts`
- Documentation: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
