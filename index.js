#!/usr/bin/env node

require('dotenv').config();
const { program } = require('commander');
const chokidar = require('chokidar');
const simpleGit = require('simple-git');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const { readFile } = require('fs').promises;

// Configuration
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost';
const OLLAMA_PORT = process.env.OLLAMA_PORT || '11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.DEFAULT_MODEL || 'llama2';
const OLLAMA_BASE_URL = `${OLLAMA_HOST}:${OLLAMA_PORT}`;

// Debounce delay in milliseconds
const DEBOUNCE_DELAY = 1000;
let debounceTimer = null;
let processingFile = null;

/**
 * Get the base branch name (usually main or master)
 */
async function getBaseBranch(git) {
  try {
    const branches = await git.branchLocal();
    const remoteBranches = await git.branch(['-r']);
    
    // Try to find main or master as base branch
    if (branches.all.includes('main')) {
      return 'main';
    } else if (branches.all.includes('master')) {
      return 'master';
    } else if (remoteBranches.all.some(b => b.includes('main'))) {
      return 'origin/main';
    } else if (remoteBranches.all.some(b => b.includes('master'))) {
      return 'origin/master';
    }
    
    // Fallback to current branch's upstream
    const currentBranch = branches.current;
    const branchInfo = await git.branch(['-vv']);
    const upstreamMatch = branchInfo.all.find(b => b.includes(currentBranch));
    if (upstreamMatch) {
      const match = upstreamMatch.match(/\[(.*?)[:\]]/);
      if (match) {
        return match[1];
      }
    }
    
    return 'main'; // Default fallback
  } catch (error) {
    console.error(chalk.red('Error getting base branch:'), error.message);
    return 'main';
  }
}

/**
 * Get git diff for a specific file
 */
async function getGitDiff(git, filePath) {
  try {
    const baseBranch = await getBaseBranch(git);
    const diff = await git.diff([baseBranch, '--', filePath]);
    return diff;
  } catch (error) {
    // If file is new or not in git, try to get diff against HEAD
    try {
      const diff = await git.diff(['HEAD', '--', filePath]);
      return diff;
    } catch (err) {
      // If still fails, return empty (new file)
      return '';
    }
  }
}

/**
 * Check if a file should be ignored (git ignored files)
 */
async function isIgnored(git, filePath) {
  try {
    const checkResult = await git.raw(['check-ignore', '-v', filePath]);
    return checkResult.trim().length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Send request to Ollama API
 */
async function requestOllama(prompt) {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.response || '';
  } catch (error) {
    throw new Error(`Failed to connect to Ollama: ${error.message}`);
  }
}

/**
 * Generate code review prompt
 */
function generatePrompt(filePath, fileContent, gitDiff) {
  const hasDiff = gitDiff && gitDiff.trim().length > 0;
  
  let prompt = `You are an expert code reviewer. Review the following code file and provide feedback.\n\n`;
  
  if (hasDiff) {
    prompt += `Here are the changes (git diff) for this file:\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\n`;
    prompt += `Focus on reviewing the CHANGES shown in the diff, comparing them to the base branch.\n\n`;
  } else {
    prompt += `This appears to be a new file.\n\n`;
  }
  
  prompt += `File: ${filePath}\n`;
  prompt += `Full file content:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
  
  prompt += `Please provide a code review with the following structure:\n`;
  prompt += `1. **Summary**: Brief overview of the code\n`;
  prompt += `2. **What's Done Well**: List positive aspects, good practices, strengths\n`;
  prompt += `3. **Suggestions for Improvement**: Specific, actionable suggestions for fixes and improvements\n`;
  prompt += `4. **Potential Issues**: Any bugs, security concerns, or potential problems\n`;
  prompt += `5. **Best Practices**: Recommendations for better code organization, performance, or maintainability\n\n`;
  prompt += `Format your response in a clear, easy-to-read way with clear sections and bullet points.`;
  
  return prompt;
}

/**
 * Format and down output the review
 */
function displayReview(filePath, review) {
  console.log('\n' + chalk.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan(`📝 Code Review: ${filePath}`));
  console.log(chalk.cyan('═'.repeat(80)) + '\n');
  
  // Split review into sections if possible
  const sections = {
    summary: /summary|overview/i,
    doneWell: /what.*done.*well|positive|strength|good|excellent/i,
    suggestions: /suggestion|improvement|fix|enhancement/i,
    issues: /issue|problem|bug|concern|error/i,
    bestPractices: /best.*practice|recommendation|pattern/i,
  };
  
  // Try to format by sections
  let formatted = review;
  const lines = review.split('\n');
  
  // Basic formatting
  formatted = review
    .replace(/\*\*(.*?)\*\*/g, chalk.bold.yellow('$1'))
    .replace(/^\d+\.\s+/gm, (match) => chalk.green(match))
    .replace(/^[-•]\s+/gm, (match) => chalk.cyan(match))
    .replace(/```/g, '')
    .replace(/`([^`]+)`/g, chalk.gray('$1'));
  
  console.log(formatted);
  console.log(chalk.cyan('\n' + '═'.repeat(80)) + '\n');
}

/**
 * Process a file change
 */
async function processFileChange(filePath, baseDir = process.cwd()) {
  if (processingFile === filePath) {
    return; // Skip if already processing
  }
  
  processingFile = filePath;
  
  try {
    const git = simpleGit(baseDir);
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
    const relativePath = path.relative(baseDir, absolutePath);
    
    // Check if file is ignored
    if (await isIgnored(git, relativePath)) {
      console.log(chalk.gray(`⏭️  Skipping ignored file: ${relativePath}`));
      processingFile = null;
      return;
    }
    
    console.log(chalk.yellow(`\n🔍 Analyzing: ${relativePath}`));
    
    // Read file content
    let fileContent = '';
    try {
      fileContent = await readFile(absolutePath, 'utf8');
    } catch (error) {
      console.error(chalk.red(`Error reading file: ${error.message}`));
      processingFile = null;
      return;
    }
    
    // Get git diff
    const gitDiff = await getGitDiff(git, relativePath);
    
    // Generate prompt
    const prompt = generatePrompt(relativePath, fileContent, gitDiff);
    
    // Get review from Ollama
    console.log(chalk.gray('🤖 Requesting review from Ollama...'));
    const review = await requestOllama(prompt);
    
    // Display review
    displayReview(relativePath, review);
    
  } catch (error) {
    console.error(chalk.red(`\n❌ Error processing ${filePath}:`), error.message);
    if (error.message.includes('connect') || error.message.includes('fetch')) {
      console.error(chalk.red(`\n💡 Make sure Ollama is running at ${OLLAMA_BASE_URL}`));
      console.error(chalk.red(`   You can start Ollama or check your OLLAMA_HOST and OLLAMA_PORT settings.`));
    }
  } finally {
    processingFile = null;
  }
}

/**
 * Setup file watcher
 */
function setupWatcher(baseDir) {
  const git = simpleGit(baseDir);
  
  // Get gitignore patterns
  const watcher = chokidar.watch(baseDir, {
    ignored: [
      /node_modules([\/\\]|$)/,  // Ignore node_modules
      /.git([\/\\]|$)/,  // Ignore .git
      /\.idea([\/\\]|$)/, // Ignore IDE files
      /\.vscode([\/\\]|$)/,
      /\.DS_Store$/,
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });
  
  watcher.on('change', (filePath) => {
    // Debounce to avoid multiple rapid triggers
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    
    debounceTimer = setTimeout(async () => {
      await processFileChange(filePath, baseDir);
    }, DEBOUNCE_DELAY);
  });
  
  console.log(chalk.green('\n✨ Watching for file changes...\n'));
  console.log(chalk.gray(`   Base directory: ${baseDir}`));
  console.log(chalk.gray(`   Ollama: ${OLLAMA_BASE_URL}`));
  console.log(chalk.gray(`   Model: ${OLLAMA_MODEL}`));
  console.log(chalk.gray(`   Press Ctrl+C to stop\n`));
  
  return watcher;
}

// Watch functionality
async function startWatch(watchDir) {
  try {
    const resolvedDir = path.resolve(watchDir);
    
    // Verify we're in a git repository
    const git = simpleGit(resolvedDir);
    await git.status();
    
    // Check Ollama connection
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      if (!response.ok) {
        throw new Error('Ollama not responding');
      }
      console.log(chalk.green('✅ Connected to Ollama'));
    } catch (error) {
      console.error(chalk.red(`\n❌ Cannot connect to Ollama at ${OLLAMA_BASE_URL}`));
      console.error(chalk.red('   Please ensure Ollama is running and accessible.\n'));
      process.exit(1);
    }
    
    // Setup watcher
    const watcher = setupWatcher(resolvedDir);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n\n👋 Stopping watcher...'));
      watcher.close();
      process.exit(0);
    });
    
  } catch (error) {
    console.error(chalk.red(`\n❌ Error: ${error.message}`));
    if (error.message.includes('not a git repository')) {
      console.error(chalk.red('   Please run this command in a git repository.\n'));
    }
    process.exit(1);
  }
}

// CLI Setup
program
  .name('ollama-watcher')
  .description('Watch code files and get AI-powered reviews via Ollama')
  .version('1.0.0')
  .option('-w, --watch', 'Watch files for changes and review with Ollama')
  .option('-d, --dir <directory>', 'Directory to watch', process.cwd())
  .action(async (options) => {
    if (options.watch) {
      await startWatch(options.dir);
    } else {
      program.help();
    }
  });

// Parse arguments
program.parse();

