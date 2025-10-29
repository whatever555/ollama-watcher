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
let currentRequestController = null; // For cancelling in-flight requests

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
 * Get git diff for uncommitted changes (working directory vs base branch)
 * This compares the current working directory state against the base branch
 */
async function getUncommittedDiff(git, filePath) {
  try {
    // For uncommitted changes when file is saved, compare working directory vs base branch
    // This shows all changes (committed + uncommitted) in current branch vs base
    const baseBranch = await getBaseBranch(git);
    
    // First check if file exists in git
    const isTracked = await git.raw(['ls-files', '--error-unmatch', filePath]).then(() => true).catch(() => false);
    
    if (isTracked) {
      // File is tracked - compare working directory vs base branch
      // This shows uncommitted changes plus any committed changes vs base
      const diff = await git.diff([baseBranch, '--', filePath]);
      if (diff && diff.trim().length > 0) {
        return diff;
      }
      
      // If no diff vs base branch, check uncommitted changes vs HEAD
      const headDiff = await git.diff(['HEAD', '--', filePath]);
      if (headDiff && headDiff.trim().length > 0) {
        // There are uncommitted changes vs HEAD
        return headDiff;
      }
    } else {
      // File is not tracked - it's a new file
      // Check if it exists in base branch
      try {
        const existsInBase = await git.raw(['ls-tree', '-r', '--name-only', baseBranch, '--', filePath]).then(() => true).catch(() => false);
        if (!existsInBase) {
          // Completely new file - return empty, will be handled as new file
          return '';
        }
      } catch (err) {
        // Ignore error, treat as new file
        return '';
      }
    }
    
    return '';
  } catch (error) {
    // Fallback: try simple HEAD comparison for uncommitted changes
    try {
      const diff = await git.diff(['HEAD', '--', filePath]);
      return diff || '';
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
 * Check if file type should be reviewed (skip images, binaries, and non-text files)
 */
function isReviewableFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  
  // Image formats - skip
  const imageExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico',
    '.tiff', '.tif', '.psd', '.eps', '.raw', '.cr2', '.nef', '.orf',
    '.sr2', '.dng', '.heic', '.heif', '.avif'
  ];
  
  // Binary/document formats - skip
  const binaryExtensions = [
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', // Fonts
    '.db', '.sqlite', '.sqlite3', // Databases
    '.pyc', '.pyo', '.pyd', '.class', '.jar', '.war', // Compiled files
  ];
  
  // If file has no extension, check if it's a known binary or allow it (might be executable)
  if (!ext) {
    return true; // Allow files without extensions (might be scripts)
  }
  
  // Skip images and binaries
  if (imageExtensions.includes(ext) || binaryExtensions.includes(ext)) {
    return false;
  }
  
  // Allow code/text files
  return true;
}

/**
 * Send request to Ollama API
 */
async function requestOllama(prompt, abortController) {
  try {
    // Cancel previous request if exists
    if (currentRequestController) {
      currentRequestController.abort();
    }
    
    // Store current controller
    currentRequestController = abortController;
    
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
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Clear controller if this is the current request
    if (currentRequestController === abortController) {
      currentRequestController = null;
    }
    
    return data.response || '';
  } catch (error) {
    // Clear controller on error
    if (currentRequestController === abortController) {
      currentRequestController = null;
    }
    
    if (error.name === 'AbortError') {
      throw new Error('Request cancelled');
    }
    throw new Error(`Failed to connect to Ollama: ${error.message}`);
  }
}

/**
 * Generate code review prompt
 */
function generatePrompt(filePath, fileContent, gitDiff, isCommitted = false, isLight = false) {
  const hasDiff = gitDiff && gitDiff.trim().length > 0;
  
  if (isLight) {
    // Light mode: simple, clear improvement suggestions only
    let prompt = `Review the code changes and provide 2-3 simple, clear suggestions for improvement.\n\n`;
    
    if (hasDiff) {
      prompt += `Changes made (focus ONLY on the lines indicated by the line numbers in the diff):\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\n`;
      prompt += `IMPORTANT: When providing feedback, ALWAYS include the specific line numbers (from the + lines in the diff). `;
      prompt += `Reference the exact lines that need improvement using format "Line X: suggestion". `;
      prompt += `Only comment on the lines that were changed (added/modified), not the entire file.\n\n`;
    } else {
      prompt += `New file: ${filePath}\n\n`;
      prompt += `Code:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
      prompt += `When providing feedback, include line numbers where possible (e.g., "Line 15: suggestion").\n\n`;
    }
    
    prompt += `Provide 2-3 brief, actionable improvement suggestions with line numbers. Be simple and clear. One line per suggestion.`;
    
    return prompt;
  }
  
  // Full mode: detailed review
  let prompt = `You are an expert code reviewer. Review the code changes in the context of the project.\n\n`;
  
  if (isCommitted) {
    prompt += `Reviewing COMMITTED changes. Focus ONLY on the changes that were made in this commit.\n\n`;
  } else {
    prompt += `📝 REVIEWING UNCOMMITTED CHANGES (working directory vs base branch)\n\n`;
  }
  
  if (hasDiff) {
    prompt += `Here are the ${isCommitted ? 'committed' : 'uncommitted'} changes (git diff) for this file:\n\`\`\`diff\n${gitDiff}\n\`\`\`\n\n`;
    
    prompt += `CRITICAL INSTRUCTIONS:\n`;
    prompt += `1. Focus EXCLUSIVELY on the specific lines of code that were CHANGED (indicated by + and - in the diff)\n`;
    prompt += `2. ALWAYS reference specific LINE NUMBERS when providing feedback\n`;
    prompt += `3. The diff shows line numbers - use the line numbers from lines starting with '+' (additions/modifications)\n`;
    prompt += `4. Format your feedback with line numbers: "Line X: issue/suggestion" or "Lines X-Y: concern"\n`;
    prompt += `5. Do NOT review unchanged code - ONLY review the lines that were added, modified, or removed\n`;
    prompt += `6. When mentioning issues or suggestions, always specify which exact line(s) you're referring to\n\n`;
    
    if (isCommitted) {
      prompt += `Analyze ONLY the changed lines shown in the diff above. `;
      prompt += `Focus on what was added (+), modified, or removed (-). `;
      prompt += `Consider the context of why these specific lines were changed. `;
      prompt += `Evaluate if the changes to these specific lines are correct, maintainable, and follow best practices.\n\n`;
    } else {
      prompt += `Review ONLY the UNCOMMITTED CHANGES - the specific lines marked with + or - in the diff above. `;
      prompt += `Do NOT review the entire file - only analyze the exact lines that were changed.\n\n`;
    }
  } else {
    prompt += `This appears to be a ${isCommitted ? 'new file that was committed' : 'new file'}.\n\n`;
    prompt += `When providing feedback, include line numbers where possible (e.g., "Line 15: suggestion").\n\n`;
  }
  
  if (isCommitted && hasDiff) {
    // For committed changes with diff, focus on the changes
    const contextContent = fileContent.length > 2000 ? fileContent.substring(0, 2000) + '\n... (truncated for context)' : fileContent;
    prompt += `Current file state after commit (for context only - focus review on the diff above):\n\`\`\`\n${contextContent}\n\`\`\`\n\n`;
    prompt += `File: ${filePath}\n\n`;
    prompt += `Provide a focused review of ONLY THE CHANGED LINES shown in the diff (with line numbers):\n`;
    prompt += `1. **Change Analysis**: What specific lines (include line numbers) were added/modified/removed and why\n`;
    prompt += `   Example: "Line 42: Added error handling for null check"\n`;
    prompt += `2. **Correctness**: Are the changes on these specific lines correct? Reference line numbers.\n`;
    prompt += `   Example: "Line 55: This condition might fail when value is 0"\n`;
    prompt += `3. **Issues**: Any bugs, errors, or problems with the specific changed lines. ALWAYS include line numbers.\n`;
    prompt += `   Example: "Lines 78-80: Missing null check could cause NullPointerException"\n`;
    prompt += `4. **Improvements**: How these specific changed lines could be improved. Reference exact line numbers.\n`;
    prompt += `   Example: "Line 95: Consider extracting this logic into a helper function"\n`;
    prompt += `5. **Impact**: How these specific line changes affect the codebase. Mention relevant line numbers.\n\n`;
    prompt += `REMEMBER: Only review the lines that show + or - in the diff. Always include line numbers in your feedback.`;
  } else {
    // For uncommitted changes with diff, also use focused structure
    if (hasDiff && !isCommitted) {
      // Uncommitted changes - focus on the diff
      const contextContent = fileContent.length > 2000 ? fileContent.substring(0, 2000) + '\n... (truncated for context)' : fileContent;
      prompt += `Current file state (for context only - focus review on the diff above):\n\`\`\`\n${contextContent}\n\`\`\`\n\n`;
      prompt += `File: ${filePath}\n\n`;
      prompt += `Provide a focused review of ONLY THE CHANGED LINES shown in the diff (with line numbers):\n`;
      prompt += `1. **Change Analysis**: What specific lines (include line numbers) were added/modified/removed and why\n`;
      prompt += `   Example: "Line 42: Added error handling for null check"\n`;
      prompt += `2. **Correctness**: Are the changes on these specific lines correct? Reference line numbers.\n`;
      prompt += `   Example: "Line 55: This condition might fail when value is 0"\n`;
      prompt += `3. **Issues**: Any bugs, errors, or problems with the specific changed lines. ALWAYS include line numbers.\n`;
      prompt += `   Example: "Lines 78-80: Missing null check could cause NullPointerException"\n`;
      prompt += `4. **Improvements**: How these specific changed lines could be improved. Reference exact line numbers.\n`;
      prompt += `   Example: "Line 95: Consider extracting this logic into a helper function"\n`;
      prompt += `5. **Context**: How do these specific line changes fit with the rest of the codebase? Mention line numbers.\n\n`;
      prompt += `REMEMBER: Only review the lines that show + or - in the diff. Always include line numbers in your feedback.`;
    } else {
      // New files - use full review structure
      prompt += `File: ${filePath}\n`;
      prompt += `File content:\n\`\`\`\n${fileContent}\n\`\`\`\n\n`;
      prompt += `Please provide a code review with the following structure:\n`;
      prompt += `1. **Summary**: Brief overview of the code\n`;
      prompt += `2. **What's Done Well**: List positive aspects, good practices, strengths\n`;
      prompt += `3. **Suggestions for Improvement**: Specific, actionable suggestions for fixes and improvements\n`;
      prompt += `4. **Potential Issues**: Any bugs, security concerns, or potential problems\n`;
      prompt += `5. **Best Practices**: Recommendations for better code organization, performance, or maintainability\n\n`;
    }
  }
  prompt += `Format your response in a clear, easy-to-read way with clear sections and bullet points.`;
  
  return prompt;
}

/**
 * Analyze review to determine if code is okay (thumbs up) or needs work (thumbs down)
 */
function analyzeReviewSentiment(review) {
  const reviewLower = review.toLowerCase();
  
  // Negative indicators (thumbs down)
  const negativeKeywords = [
    'bug', 'error', 'issue', 'problem', 'concern', 'wrong', 'incorrect',
    'fails', 'broken', 'doesn\'t work', 'security', 'vulnerability',
    'critical', 'severe', 'major issue', 'must fix', 'needs to be fixed',
    'should be changed', 'incorrect', 'improper', 'bad practice',
    'anti-pattern', 'dangerous', 'risk', 'warning'
  ];
  
  // Positive indicators (thumbs up)
  const positiveKeywords = [
    'good', 'great', 'excellent', 'well done', 'correct', 'proper',
    'follows best practices', 'clean', 'maintainable', 'solid',
    'well written', 'looks good', 'no issues', 'no problems',
    'acceptable', 'fine', 'okay', 'ok', 'nice', 'well implemented'
  ];
  
  // Count occurrences
  let negativeScore = 0;
  let positiveScore = 0;
  
  negativeKeywords.forEach(keyword => {
    const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = reviewLower.match(regex);
    if (matches) {
      negativeScore += matches.length;
    }
  });
  
  positiveKeywords.forEach(keyword => {
    const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const matches = reviewLower.match(regex);
    if (matches) {
      positiveScore += matches.length;
    }
  });
  
  // Check for explicit "thumbs up" phrases (no issues, looks good, etc.)
  const noIssuesPattern = /(no\s+(issues?|problems?|concerns?|bugs?))|looks?\s+good|seems?\s+(fine|ok|okay|good|correct)/i;
  const hasIssuesPattern = /(has\s+(issues?|problems?|bugs?|concerns?))|needs?\s+(fix|change|improvement|work)/i;
  
  if (noIssuesPattern.test(review)) {
    positiveScore += 3;
  }
  
  if (hasIssuesPattern.test(review)) {
    negativeScore += 3;
  }
  
  // Determine verdict
  // If negative score is significantly higher, thumbs down
  // If positive is higher or they're close, thumbs up
  // Default to thumbs up if scores are equal (benefit of the doubt)
  return negativeScore > positiveScore + 1 ? 'down' : 'up';
}

/**
 * Format and output the review
 */
function displayReview(filePath, review) {
  // Analyze sentiment first
  const verdict = analyzeReviewSentiment(review);
  const thumbsEmoji = verdict === 'up' ? '👍' : '👎';
  const thumbsText = verdict === 'up' ? chalk.green('THUMBS UP - Code looks good!') : chalk.red('THUMBS DOWN - Issues found');
  
  console.log('\n' + chalk.cyan('═'.repeat(80)));
  console.log(chalk.bold.cyan(`📝 Code Review: ${filePath}`));
  console.log(chalk.cyan('═'.repeat(80)) + '\n');
  console.log(chalk.bold(`${thumbsEmoji} ${thumbsText}`) + '\n');
  
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
async function processFileChange(filePath, baseDir = process.cwd(), isLight = false) {
  if (processingFile === filePath) {
    return; // Skip if already processing
  }
  
  try {
    const git = simpleGit(baseDir);
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
    const relativePath = path.relative(baseDir, absolutePath);
    
    // Check if file is ignored FIRST - completely skip ignored files silently
    if (await isIgnored(git, relativePath)) {
      return; // Silently skip ignored files - no logging, no processing
    }
    
    // Check if file type is reviewable (skip images, binaries, etc.)
    if (!isReviewableFile(relativePath)) {
      return; // Silently skip non-code/non-text files
    }
    
    processingFile = filePath;
    
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
    // This compares working directory vs base branch (includes uncommitted + committed changes in branch)
    const gitDiff = await getUncommittedDiff(git, relativePath);
    
    // Also check specifically for uncommitted changes vs HEAD
    const uncommittedDiff = await git.diff(['HEAD', '--', relativePath]).catch(() => '');
    
    // Only skip if there are NO changes at all (no diff vs base branch AND no uncommitted changes vs HEAD)
    if ((!gitDiff || gitDiff.trim().length === 0) && (!uncommittedDiff || uncommittedDiff.trim().length === 0)) {
      const isTracked = await git.raw(['ls-files', '--error-unmatch', relativePath]).then(() => true).catch(() => false);
      if (isTracked) {
        console.log(chalk.gray(`ℹ️  No uncommitted changes in ${relativePath} - skipping review`));
        processingFile = null;
        return;
      }
      // If file is not tracked, continue - it's a new file to review
    }
    
    // Use uncommitted diff vs HEAD if available, otherwise use diff vs base branch
    const finalDiff = (uncommittedDiff && uncommittedDiff.trim().length > 0) ? uncommittedDiff : gitDiff;
    
    // Generate prompt for uncommitted changes
    const prompt = generatePrompt(relativePath, fileContent, finalDiff, false, isLight);
    
    // Create abort controller for this request
    const abortController = new AbortController();
    
    // Get review from Ollama
    console.log(chalk.gray('🤖 Requesting review from Ollama...'));
    const review = await requestOllama(prompt, abortController);
    
    // Display review
    displayReview(relativePath, review);
    
  } catch (error) {
    // Don't show error if request was cancelled
    if (error.message.includes('cancelled') || error.message.includes('Request cancelled')) {
      console.log(chalk.gray(`⏭️  Review cancelled for: ${relativePath || filePath}`));
      processingFile = null;
      return;
    }
    
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
 * Process committed changes
 */
let lastCommitHash = null;
let processingCommit = false;

async function processCommit(git, baseDir, isLight = false) {
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
      
      // Check if file type is reviewable (skip images, binaries, etc.)
      if (!isReviewableFile(relativePath)) {
        continue; // Skip non-code/non-text files silently
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
      const prompt = generatePrompt(relativePath, fileContent, gitDiff, true, isLight);
      
      // Create abort controller for this request
      const abortController = new AbortController();
      
      // Get review from Ollama
      console.log(chalk.gray(`🤖 Requesting review for committed file: ${relativePath}...`));
      const review = await requestOllama(prompt, abortController);
      
      // Display review
      displayReview(relativePath, review);
    }
    
    console.log(chalk.green(`\n✅ Finished reviewing commit ${commit.hash.substring(0, 7)}\n`));
    
  } catch (error) {
    // Don't show error if request was cancelled
    if (error.message.includes('cancelled') || error.message.includes('Request cancelled')) {
      console.log(chalk.gray(`⏭️  Commit review cancelled`));
      processingCommit = false;
      return;
    }
    
    console.error(chalk.red(`\n❌ Error processing commit:`), error.message);
  } finally {
    processingCommit = false;
  }
}

/**
 * Setup file watcher
 */
function setupWatcher(baseDir, isLight = false) {
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
  
  watcher.on('change', async (filePath) => {
    // Quick checks before processing
    try {
      const git = simpleGit(baseDir);
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
      const relativePath = path.relative(baseDir, absolutePath);
      
      // Silently skip ignored files
      if (await isIgnored(git, relativePath)) {
        return; // Don't process ignored files at all
      }
      
      // Silently skip non-reviewable file types (images, binaries, etc.)
      if (!isReviewableFile(relativePath)) {
        return; // Don't process non-code/non-text files
      }
    } catch (err) {
      // If check fails, continue anyway
    }
    
    // Process file changes (uncommitted changes)
    console.log(chalk.gray(`📝 File changed detected: ${filePath}`));
    
    // Debounce to avoid multiple rapid triggers
    if (debounceRecord) {
      clearTimeout(debounceRecord);
    }
    
    debounceRecord = setTimeout(async () => {
      await processFileChange(filePath, baseDir, isLight);
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
          await processCommit(git, baseDir, isLight);
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
async function startWatch(watchDir, isLight = false) {
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
    const watcher = setupWatcher(resolvedDir, isLight);
    
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
  .option('-l, --light', 'Provide short, concise feedback (light mode)')
  .action(async (options) => {
    if (options.watch) {
      await startWatch(options.dir, options.light);
    } else {
      program.help();
    }
  });

// Parse arguments
program.parse();

