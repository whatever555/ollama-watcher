# Rapid Start 

Get ollama and install a model   
First, verify in ollama settings that "Expose Ollama to the network" is enabled  
Go to your project folder and set `OLLAMA_MODEL=YOUR_OLLAMA_MODEL_NAME` in the `.env` file.   
then..  
```bash
npm install -g ollama-watcher
ollama serve
npx ollama-watcher --watch --light
```


# Ollama Watcher

An intelligent npm package that watches your code files for changes and provides AI-powered code reviews using your local Ollama instance. Get instant feedback on uncommitted changes and committed code with detailed suggestions, line-numbered feedback, and helpful improvements.

<img width="4358" height="2530" alt="screen" src="https://github.com/user-attachments/assets/fa43f52c-01fd-43d2-bb1a-f15363fd14df" />



## Features

- 🤖 **AI-Powered Reviews** - Uses your local Ollama instance for code reviews
- 🔍 **Automatic File Watching** - Reviews files automatically when you save them
- 📝 **Uncommitted & Committed Reviews** - Reviews both working directory changes and committed code
- 📊 **Thumbs Up/Down Indicators** - Quick visual feedback on code quality
- 📍 **Line-Number Specific Feedback** - Always includes line numbers in suggestions
- ⚡ **Light Mode** - Quick, concise feedback option
- 🎯 **Focused Reviews** - Only reviews changed lines, not entire files
- 🔇 **Smart Filtering** - Automatically skips images, binaries, and ignored files

## Prerequisites

1. **Node.js** (version 18.0.0 or higher)
2. **Ollama** - [Install Ollama](https://ollama.ai/) and ensure it's running locally
3. **Git Repository** - This tool works within git repositories

## Installation

### Global Installation (Recommended)

Install globally to use `ollama-watcher` from any directory:

```bash
npm install -g ollama-watcher
```

**Pros of Global Installation:**
- Use the command from any project directory
- No need to install per-project
- Consistent version across all projects
- Easier to use as a development tool

### Local Installation

Install locally for project-specific usage:

```bash
npm install --save-dev ollama-watcher
```

Then use via `npx`:
```bash
npx ollama-watcher --watch --light
```

**Pros of Local Installation:**
- Version locked per project
- Team members get same version
- Can be added to package.json scripts

### Recommendation

For most users, **global installation is recommended** since this is a development tool you'll use across multiple projects.

## Quick Start

### 1. Start Ollama

Make sure Ollama is running on your machine, and make sure to enable the toggle for "Expose Ollama to the network" in Ollama settings.

```bash
ollama serve
```

Verify it's working:
```bash
curl http://localhost:11434/api/tags
```

### 2. Navigate to Your Project

```bash
cd /path/to/your/project
```

**Important:** Make sure you're in a git repository (the tool requires git to track changes).

### 3. Start Watching

```bash
ollama-watcher --watch --light
```

That's it! The watcher will now:
- Monitor your project files for changes
- Review uncommitted changes when you save files
- Review committed changes when you make commits
- Display AI-powered feedback with line numbers

## Usage

### Basic Usage

```bash
# Watch current directory
ollama-watcher --watch

# Watch a specific directory
ollama-watcher --watch --dir /path/to/project

# Use light mode for quick feedback
ollama-watcher --watch --light
```

### Command Options

#### `--watch` / `-w`

Enables file watching mode. When enabled, the tool will:
- Watch all non-ignored files in your project
- Automatically review files when you save them (uncommitted changes)
- Automatically review files when you commit them (committed changes)

**Example:**
```bash
ollama-watcher --watch
```

#### `--light` / `-l`

Provides short, concise feedback instead of detailed reviews. Perfect for quick checks.

**Light mode provides:**
- 2-3 brief improvement suggestions
- One line per suggestion
- Only critical issues highlighted
- Faster reviews

**Example:**
```bash
ollama-watcher --watch --light
```

#### `--dir` / `-d`

Specify a directory to watch (defaults to current directory).

**Example:**
```bash
ollama-watcher --watch --dir ~/projects/my-app
```

## Configuration

Create a `.env` file in your project root (or copy from `env.dist`) to customize Ollama settings:

```env
# Ollama Configuration
OLLAMA_HOST=http://localhost
OLLAMA_PORT=11434
OLLAMA_MODEL=llama2
```

### Environment Variables

- **OLLAMA_HOST** - Ollama server host (default: `http://localhost`)
- **OLLAMA_PORT** - Ollama server port (default: `11434`)
- **OLLAMA_MODEL** - Model to use for code reviews (default: `llama2`)

To see available models:
```bash
ollama list
```

Popular models for code review:
- `llama2` - Good general purpose
- `codellama` - Optimized for code
- `deepseek-coder` - Specialized for code understanding

## How It Works

### Uncommitted Changes Review

When you save a file, the tool:
1. Detects the file change
2. Compares your working directory changes against the base branch (main/master)
3. Generates a focused review of **only the changed lines**
4. Displays feedback with **specific line numbers**
5. Shows a thumbs up 👍 or thumbs down 👎 indicator

**Example output:**
```
🔍 Analyzing: src/utils/helpers.js

👍 THUMBS UP - Code looks good!

📝 Code Review: src/utils/helpers.js
════════════════════════════════════════════════════════════════

**Change Analysis**
- Line 42: Added null check - good defensive programming
- Line 55: Improved error handling

**Issues**
- Line 78: Potential edge case when value is 0

**Improvements**
- Line 95: Consider extracting this logic into a helper function
```

### Committed Changes Review

When you make a commit, the tool:
1. Detects the new commit
2. Reviews all files changed in that commit
3. Focuses on the specific changes made
4. Provides feedback with line numbers

### What Gets Reviewed

✅ **Reviewed:**
- Code files (`.js`, `.ts`, `.py`, `.java`, etc.)
- Configuration files (`.json`, `.yaml`, `.toml`, etc.)
- Text files
- Markdown files
- CSS/SCSS files
- SQL files

❌ **Automatically Skipped:**
- Images (`.png`, `.jpg`, `.gif`, etc.)
- Binaries (`.exe`, `.dll`, `.so`, etc.)
- Archives (`.zip`, `.tar`, `.gz`, etc.)
- Media files (`.mp3`, `.mp4`, etc.)
- Files listed in `.gitignore`
- Node modules and backup files

## Review Types

### Full Mode (Default)

Comprehensive reviews with:
- Change analysis
- Correctness checks
- Issue identification
- Improvement suggestions
- Impact assessment
- **All with specific line numbers**

### Light Mode (`--light`)

Quick, focused feedback:
- 2-3 improvement suggestions
- Only critical issues
- One line per suggestion
- **Still includes line numbers**

## Tips for Best Results

1. **Choose the Right Model**: For better code understanding, use a code-specialized model like `codellama`
   ```bash
   ollama pull codellama
   ```
   Then set in `.env`: `OLLAMA_MODEL=codellama`

2. **Use Light Mode During Active Development**: When making many small changes, light mode provides quick feedback without overwhelming output

3. **Review Before Committing**: The tool reviews uncommitted changes when you save, helping you catch issues before they're committed

4. **Focus on Changed Lines**: The tool only reviews what you changed, not the entire file, making feedback more actionable

## Troubleshooting

### "Cannot connect to Ollama"

**Problem:** The tool can't reach your Ollama instance.

**Solutions:**
- Make sure Ollama is running: `ollama serve`
- Check your OLLAMA_HOST and OLLAMA_PORT in `.env`
- Verify Ollama is accessible: `curl http://localhost:11434/api/tags`

### " repository not found"

**Problem:** You're not in a git repository.

**Solution:** Navigate to a git repository or initialize one:
```bash
git init
```

### Model Not Found

**Problem:** The specified model doesn't exist.

**Solution:** 
1. List available models: `ollama list`
2. Pull the model if needed: `ollama pull model-name`
3. Update `.env` with correct model name

### Too Much Output

**Solution:** Use `--light` mode for concise feedback:
```bash
ollama-watcher --watch --light
```

## Examples

### Basic Workflow

```bash
# 1. Start Ollama (in a separate terminal)
ollama serve

# 2. Navigate to your project
cd my-project

# 3. Start watching
ollama-watcher --watch

# 4. Edit and save files - reviews happen automatically!
# 5. Make commits - committed changes get reviewed!
```

### With Custom Model

```bash
# Pull a code-specialized model
ollama pull codellama

# Create .env file
echo "OLLAMA_MODEL=codellama" > .env

# Start watching
ollama-watcher --watch
```

### Light Mode for Quick Feedback

```bash
ollama-watcher --watch --light
```

## Stopping the Watcher

Press `Ctrl+C` to stop the watcher gracefully.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC

## Support

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/whatever555/ollama-watcher/issues).

---

**Happy Coding! 🚀**

