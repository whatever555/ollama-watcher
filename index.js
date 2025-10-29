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
const COMMIT_DETECTION_DELAY = 2000; // Longer delay for commit detection
let debounceRecord = null;
let commitDebounceTimer = null;
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
 * Get git diff for uncommitted changes (working directory vs HEAD)
 */
async function getUncommittedDiff(git, filePath) {
  try {
    // Check if file is in git first
    const status = await git.status();
    
    // Get diff for working directory changes (uncommitted)
    // This shows changes in the working directory (not staged)
    const diff = await git.diff(['HEAD', '--', filePath]);
    return diff;
  } catch (error) {
    // File might not be tracked yet, check if it's a new file
    try {
      // For new files, we can show the entire content as additions
      const isTracked = await git.raw(['ls-files', '--error-unmatch', filePath]).then(() => true).catch(() => false);
      if (!isTracked) {
        // New file - return empty diff, we'll handle this in the prompt
        return '';
      }
      return '';
    } catch (err) {
      return '';
    }
  }
}

/**
 * Get git diff for committed changes (last commit)
 */
async function getCommittedDiff(git, filePath) {
  try {
    // Get diff between HEAD and HEAD~1 (last commit)
    const diff = await git.diff(['HEAD~1', 'HEAD', '--', filePath]);
    return diff;
  } catch (error) {
    // Might be first commit or file not in previous commit
    try {
      // Try to get diff against base branch
      const baseBranch = await getBaseBranch(git);
      const diff = await git.diff([baseBranch, 'HEAD', '--', filePath]);
      return diff;
    } catch (err) {
      return '';
    }
  }
}

/**
 * Get all files changed in the last commit
 */
async function getCommittedFiles(git) {
  try {
    // Get list of files changed in HEAD commit
    const files = await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
    return files.trim().split('\n').filter(f => f.length > 0);
  } catch (error) {
    // If HEAD~1 doesn't exist, get files in HEAD
    try {
      const files = await git.raw(['show', '--name-only', '--pretty=format:', 'HEAD']);
      return files.trim().split('\n').filter(f => f.length > 0);
    } catch (err) {
      return [];
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
function generatePrompt(filePath, fileContent, gitDiff, isCommitted = false) {
  const hasDiff = gitDiff && gitDiff.trim().length > 0;
  
  let prompt = `You are an expert code reviewer. Review the following code file and provide feedback.\n\n`;
  
  if (isCommitted) {
    prompt += `⚠️ REVIEWING COMMITTED CHANGES (already committed to git)\n\n`;
  } else {
    prompt += `📝 REVIEWING UNCOMMITTED CHANGES (working directory)\n\n`;
  }
  
  if (hasDiff) {
    prompt += `Here are the ${isCommitted ? 'committed' : 'uncommitted'} changes (git diff) for this file:\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\n`;
    if (isCommitted) {
      prompt += `Focus on reviewing the COMMITTED CHANGES shown in the diff.\n\n`;
    } else {
      prompt += `Focus on reviewing the UNCOMMITTED CHANGES shown in the diff (working directory vs HEAD).\n\n`;
    }
  } else {
    prompt += `This appears to be a ${isCommitted ? 'new file that was committed' : 'new file'}.\n\n`;
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
    
    // Get uncommitted git diff (working directory changes)
    const gitDiff = await getUncommittedDiff(git, relativePath);
    
    // Generate prompt for uncommitted changes
    const prompt = generatePrompt(relativePath, fileContent, gitDiff, false);
    
    // Get review from Ollama
    console.log(chalk.gray('🤖 Requesting review from Ollama...'));
    const review = await requestOllama(prompt);
    
    // Display review
    displayReview(relativePath, review);
    
  } catch (error) {
    console.error(chalk.red(`\n❌ Error processing ${filePath}:`), error.message);
    if (error.message.includes('connect') || error.message.includes('fetch')) {
      console.error(chalk.red(`\n💡 Make sure Ollama is running at ${OLLAMA_BASE_URL}`));
      console.log('test');
      console.error(chalk.red(`   You can start Ollama or check your OLLAMA_HOST and OLLAMA_PORT settings.`));
    }
  } finally {
    processingFile = null;
  }
}

/**
 * Process committed changes
 */
let lastCommitHash = null;
let processingCommit = false;

async function processCommit(git, baseDir) {
  if (processingCommit) {
    return;
  }
  
  processingCommit = true;
  
  try {
    // Get current HEAD commit hash
    const currentCommitHash = await git.revparse(['HEAD']);
    
    // Check if this is a new commit
    if (lastCommitHash && lastCommitHash === currentCommitHash) {
      processingCommit = false;
      return; // No new commit
    }
    
    lastCommitHash = currentCommitHash;
    
    // Get commit info
    const commitLog = await git.log(['-1']);
    const commit = commitLog.latest;
    
    if (!commit) {
      processingCommit = false;
      return;
    }
    
    console.log(chalk.magenta(`\n📦 New commit detected: ${commit.hash.substring(0, 7)} - ${commit.message}\n`));
    
    // Get all files changed in this commit
    const committedFiles = await getCommittedFiles(git);
    
    if (committedFiles.length === 0) {
      console.log(chalk.gray('No files changed in this commit.\n'));
      processingCommit = false;
      return;
    }
    
    console.log(chalk.yellow(`🔍 Reviewing ${committedFiles.length} file(s) in commit...\n`));
    
    // Process each file in the commit
    for (const filePath of committedFiles) {
      const absolutePath = path.resolve(baseDir, filePath);
      const relativePath = path.relative(baseDir, absolutePath);
      
      // Check if file is ignored (shouldn't happen for committed files, but just in case)
      if (await isIgnored(git, relativePath)) {
        continue;
      }
      
      // Check if file still exists (might have been deleted)
      let fileContent = '';
      try {
        fileContent = await readFile(absolutePath, 'utf8');
      } catch (error) {
        // File might have been deleted, get content from git
        try {
          fileContent = await git.show([`HEAD:${relativePath}`]);
        } catch (err) {
          console.log(chalk.gray(`⏭️  Skipping deleted file: ${relativePath}`));
          continue;
        }
      }
      
      // Get committed diff
      const gitDiff = await getCommittedDiff(git, relativePath);
      
      // Generate prompt for committed changes
      const prompt = generatePrompt(relativePath, fileContent, gitDiff, true);
      
      // Get review from Ollama
      console.log(chalk.gray(`🤖 Requesting review for committed file: ${relativePath}...`));
      const review = await requestOllama(prompt);
      
      // Display review
      displayReview(relativePath, review);
    }
    
    console.log(chalk.green(`\n✅ Finished reviewing commit ${commit.hash.substring(0, 7)}\n`));
    
  } catch (error) {
    console.error(chalk.red(`\n❌ Error processing commit:`), error.message);
  } finally {
    processingCommit = false;
  }
}

/**
 * Setup file watcher
 */
function setupWatcher(baseDir) {
  const git = simpleGit(baseDir);
  
  // Initialize last commit hash
  git.revparse(['HEAD']).then(hash => {
    lastCommitHash = hash;
  }).catch(() => {
    // First commit or no commits yet
    lastCommitHash = null;
  });
  
  // Get gitignore patterns
  const watcher = chokidar.watch(baseDir, {
    ignored: [
      /node_modules([\/\\]|$)/,  // Ignore node_modules
      /.git([\/\\]|$)/,  // Ignore .git (we watch HEAD separately)
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
    // Process file changes (uncommitted changes)
    // Debounce to avoid multiple rapid triggers
    if (debounceRecord) {
      clearTimeout(debounceRecord);
    }
    
    debounceRecord = setTimeout(async () => {
      await processFileChange(filePath, baseDir);
    }, DEBOUNCE_DELAY);
  });
  
  // Also watch .git/HEAD specifically for commit detection
  const gitHeadPath = path.join(baseDir, '.git', 'HEAD');
  try {
    if (fs.existsSync(gitHeadPath)) {
      const commitWatcher = chokidar.watch(gitHeadPath, { persistent: true });
      commitWatcher.on('change', () => {
        // Debounce commit detection
        if (commitDebounceTimer) {
          clearTimeout(commitDebounceTimer);
        }
        commitDebounceTimer = setTimeout(async () => {
          await processCommit(git, baseDir);
        }, COMMIT_DETECTION_DELAY);
      });
      
      // Also watch refs/heads/* for branch updates
      const refsPath = path.join(baseDir, '.git', 'refs', 'heads');
      if (fs.existsSync(refsPath)) {
        const refsWatcher = chokidar.watch(refsPath, { persistent: true, depth: 1 });
        refsWatcher.on('change', () => {
          // Debounce commit detection
          if (commitDebounceTimer) {
            clearTimeout(commitDebounceTimer);
          }
          commitDebounceTimer = setTimeout(async () => {
            await processCommit(git, baseDir);
          }, COMMIT_DETECTION_DELAY);
        });
      }
    }
  } catch (error) {
    // Silent fail if .git directory structure is unusual
  }
  
  console.log(chalk.green('\n✨ Watching for file changes and commits...\n'));
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
    
    // coment
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

