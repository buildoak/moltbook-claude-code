/**
 * Moltbook Telegram Bot
 * Uses Claude Agent SDK with strict path isolation and tool whitelisting
 *
 * Features:
 * - Voice transcription via OpenAI Whisper
 * - Session persistence across restarts
 * - Interrupt mechanism (! prefix)
 * - Hard deny for unsafe tools (no prompts)
 * - Path isolation (WORKING_DIR write, read-only for specified paths)
 */
import { Bot, Context, InputFile } from "grammy";
import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import { existsSync, mkdirSync, unlinkSync, createReadStream, readFileSync } from "fs";
import { resolve, normalize } from "path";

// ============== Configuration ==============

const BOT_TOKEN = process.env.TGBOT_API_KEY!;
const ALLOWED_USERS = (process.env.TGBOT_ALLOWED_USERS || "")
  .split(",")
  .map((id) => parseInt(id.trim()))
  .filter((id) => !isNaN(id));

const HOME = process.env.HOME!;

// CONFIGURE: Set your agent's working directory
const WORKING_DIR = process.env.WORKING_DIR || `${HOME}/moltbook-agent`;

// CONFIGURE: Add any read-only paths your agent should access
// Example: research folders, reference documents
const READ_ONLY_PATHS: string[] = [
  // `${HOME}/path/to/research/`,
  // `${HOME}/path/to/reference/`,
];

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TEMP_DIR = "/tmp/moltbook-tg-bot";
const SESSION_FILE = `${TEMP_DIR}/sessions.json`;

// File sending pattern - Claude can output [SEND_FILE:/path] to send files to user
const SEND_FILE_PATTERN = /\[SEND_FILE:([^\]]+)\]/g;

// Ensure temp directory exists
if (!existsSync(TEMP_DIR)) {
  mkdirSync(TEMP_DIR, { recursive: true });
}

// Load system prompt from CLAUDE.md
const SYSTEM_PROMPT_PATH = `${WORKING_DIR}/CLAUDE.md`;
let systemPrompt = "";
try {
  if (existsSync(SYSTEM_PROMPT_PATH)) {
    systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
    console.log(`Loaded system prompt from ${SYSTEM_PROMPT_PATH} (${systemPrompt.length} chars)`);
  } else {
    console.warn(`System prompt not found at ${SYSTEM_PROMPT_PATH}`);
  }
} catch (err) {
  console.error("Failed to load system prompt:", err);
}

// ============== Global Error Handlers ==============

process.on("unhandledRejection", (reason, _promise) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[FATAL] Uncaught exception:", error);
});

// ============== Path Security ==============

/**
 * Check if a path is within the WORKING_DIR (write allowed)
 */
function isPathWithinWorkingDir(inputPath: string): boolean {
  if (!inputPath) return false;
  const absolutePath = resolve(WORKING_DIR, inputPath);
  const normalizedPath = normalize(absolutePath);
  const normalizedWorkingDir = normalize(WORKING_DIR);
  return normalizedPath.startsWith(normalizedWorkingDir + "/") ||
         normalizedPath === normalizedWorkingDir;
}

/**
 * Check if a path is within one of the read-only paths
 */
function isPathReadOnly(inputPath: string): boolean {
  if (!inputPath) return false;
  const absolutePath = resolve(WORKING_DIR, inputPath);
  const normalizedPath = normalize(absolutePath);

  return READ_ONLY_PATHS.some(roPath => {
    const normalizedRoPath = normalize(roPath);
    return normalizedPath.startsWith(normalizedRoPath) ||
           normalizedPath === normalizedRoPath.slice(0, -1); // handle trailing slash
  });
}

/**
 * Check if a path is allowed for reading (working dir OR read-only paths)
 */
function isPathAllowedForRead(inputPath: string): boolean {
  return isPathWithinWorkingDir(inputPath) || isPathReadOnly(inputPath);
}

/**
 * Extract path from tool input based on tool type
 */
function getPathFromToolInput(toolName: string, input: Record<string, unknown>): string | null {
  switch (toolName) {
    case "Read":
      return (input.file_path as string) || null;
    case "Write":
    case "Edit":
      return (input.file_path as string) || null;
    case "Glob":
      return (input.path as string) || null;
    case "Grep":
      return (input.path as string) || null;
    default:
      return null;
  }
}

// ============== Safe Bash Commands ==============

// CONFIGURE: Whitelist safe bash command prefixes for your agent
const SAFE_BASH_PREFIXES = [
  // Basic read-only commands (NO env, printenv, echo, find, grep, rg)
  "ls", "cat", "head", "tail", "pwd", "which", "wc", "date", "uptime", "hostname", "uname", "file", "stat",
  // Git read-only
  "git status", "git log", "git diff", "git branch", "git show",
  // Version checks only
  "python --version", "python3 --version", "node --version", "bun --version",
  // Agent-specific scripts (update path to your setup)
  `python ${WORKING_DIR}/scripts/mac-health-collector.py`,
  `python3 ${WORKING_DIR}/scripts/mac-health-collector.py`,
  // Moltbook API calls (chained with source for env loading)
  `source ${WORKING_DIR}/.env && curl`,
];

function isSafeBashCommand(command: string): boolean {
  const trimmed = command.trim();
  return SAFE_BASH_PREFIXES.some(prefix =>
    trimmed === prefix ||
    trimmed.startsWith(prefix + " ") ||
    trimmed.startsWith(prefix + "\n")
  );
}

// ============== OpenAI Client ==============

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log("OpenAI client initialized (voice transcription available)");
} else {
  console.log("No OPENAI_API_KEY - voice transcription disabled");
}

// ============== Session Storage ==============

interface Session {
  sessionId?: string;
  lastActivity: number;
  chatId?: number;
  abortController?: AbortController;
  wasInterruptedByNewMessage: boolean;
}

const sessions = new Map<number, Session>();

// ============== Session Persistence ==============

interface PersistedSession {
  sessionId: string;
  lastActivity: number;
}

async function saveSessions(): Promise<void> {
  try {
    const data: Record<string, PersistedSession> = {};
    for (const [userId, session] of sessions.entries()) {
      if (session.sessionId) {
        data[userId] = {
          sessionId: session.sessionId,
          lastActivity: session.lastActivity,
        };
      }
    }
    await Bun.write(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save sessions:", err);
  }
}

// Load sessions on startup
(async () => {
  try {
    if (existsSync(SESSION_FILE)) {
      const data = JSON.parse(await Bun.file(SESSION_FILE).text());
      for (const [userIdStr, persisted] of Object.entries(data as Record<string, PersistedSession>)) {
        const userId = parseInt(userIdStr);
        if (!isNaN(userId) && (persisted as PersistedSession).sessionId) {
          sessions.set(userId, {
            sessionId: (persisted as PersistedSession).sessionId,
            lastActivity: (persisted as PersistedSession).lastActivity || Date.now(),
            wasInterruptedByNewMessage: false,
          });
          console.log(`Restored session for user ${userId}: ${(persisted as PersistedSession).sessionId.slice(0, 8)}...`);
        }
      }
    }
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
})();

// ============== Session Management ==============

function abortUserQuery(userId: number, isInterrupt: boolean = false): void {
  const session = sessions.get(userId);
  if (session?.abortController) {
    console.log(`Aborting query for user ${userId} (interrupt: ${isInterrupt})`);
    if (isInterrupt) {
      session.wasInterruptedByNewMessage = true;
    }
    session.abortController.abort();
    session.abortController = undefined;
  }
}

function consumeInterruptFlag(session: Session): boolean {
  const wasInterrupted = session.wasInterruptedByNewMessage;
  session.wasInterruptedByNewMessage = false;
  return wasInterrupted;
}

function getSession(userId: number): Session {
  let session = sessions.get(userId);
  if (!session) {
    session = {
      lastActivity: Date.now(),
      wasInterruptedByNewMessage: false,
    };
    sessions.set(userId, session);
  }
  return session;
}

function isAuthorized(userId: number): boolean {
  if (ALLOWED_USERS.length === 0) return false;
  return ALLOWED_USERS.includes(userId);
}

// ============== Voice Transcription ==============

async function transcribeVoice(filePath: string): Promise<string | null> {
  if (!openaiClient) {
    console.warn("OpenAI client not available for transcription");
    return null;
  }

  try {
    const transcript = await openaiClient.audio.transcriptions.create({
      model: "whisper-1",
      file: createReadStream(filePath),
    });
    return transcript.text;
  } catch (err) {
    console.error("Transcription error:", err);
    return null;
  }
}

// ============== File Sending ==============

async function sendFilesToUser(chatId: number, text: string): Promise<string> {
  const matches = [...text.matchAll(SEND_FILE_PATTERN)];
  let cleanedText = text;

  for (const match of matches) {
    const filePath = match[1].trim();
    try {
      // Only allow sending files from allowed paths
      if (!isPathAllowedForRead(filePath)) {
        console.log(`[DENIED] sendFilesToUser outside allowed paths: ${filePath}`);
        cleanedText = cleanedText.replace(match[0], `[Access denied: file outside allowed paths]`);
      } else if (existsSync(filePath)) {
        const filename = filePath.split("/").pop() || "file";
        await bot.api.sendDocument(chatId, new InputFile(filePath, filename));
        cleanedText = cleanedText.replace(match[0], `[Sent: ${filename}]`);
      } else {
        cleanedText = cleanedText.replace(match[0], `[File not found: ${filePath}]`);
      }
    } catch (e) {
      console.error("File send error:", e);
      cleanedText = cleanedText.replace(match[0], `[Failed to send: ${filePath}]`);
    }
  }
  return cleanedText;
}

// ============== Image Handling ==============

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  const mimeTypes: Record<string, string> = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
  };
  return mimeTypes[ext] || "image/jpeg";
}

async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; filename: string }> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = file.file_path?.split("/").pop() || "image.jpg";
  return { buffer, filename };
}

interface ImageData {
  buffer: Buffer;
  mimeType: string;
}

async function* createImagePrompt(
  images: ImageData[],
  text: string,
  sessionId: string
): AsyncGenerator<any> {
  const content: any[] = [];

  // Wrap text with TG formatting instructions
  const wrappedText = `<tg_format>
You are responding via Telegram. Keep responses concise and plain text:
- Start with a brief (1-2 sentence) summary of what you did
- No markdown formatting (no **bold**, no \`code\`, no headers)
- Keep total response under 2000 chars when possible
</tg_format>

<tg_message>
${text}
</tg_message>`;
  content.push({ type: "text", text: wrappedText });

  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mimeType,
        data: img.buffer.toString("base64"),
      },
    });
  }

  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

// ============== Formatting Helpers ==============

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')      // **bold**
    .replace(/\*(.+?)\*/g, '$1')          // *italic*
    .replace(/__(.+?)__/g, '$1')          // __bold__
    .replace(/_(.+?)_/g, '$1')            // _italic_
    .replace(/`([^`]+)`/g, '$1')          // `code`
    .replace(/```[\s\S]*?```/g, match =>  // ```code blocks```
      match.replace(/```\w*\n?/g, '').trim()
    )
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')   // ## headers
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')  // [links](url)
    .replace(/^[-*+]\s+/gm, '- ')         // bullet points
    .replace(/^\d+\.\s+/gm, '- ')         // numbered lists
    .replace(/^>\s+/gm, '')               // > blockquotes
    .replace(/^---+$/gm, '')              // --- horizontal rules
    .replace(/\n{3,}/g, '\n\n');          // multiple blank lines
}

async function sendLongMessage(ctx: Context, text: string, maxLen = 4000) {
  if (text.length <= maxLen) {
    await ctx.reply(text);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      await ctx.reply(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    await ctx.reply(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
}

async function sendLongMessageDirect(chatId: number, text: string, maxLen = 4000) {
  if (text.length <= maxLen) {
    await bot.api.sendMessage(chatId, text);
    return;
  }

  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      await bot.api.sendMessage(chatId, remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    await bot.api.sendMessage(chatId, remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
}

// ============== Tool Whitelist ==============

// Tools allowed with path validation
const PATH_VALIDATED_READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const PATH_VALIDATED_WRITE_TOOLS = new Set(["Write", "Edit"]);

// Tools allowed without restrictions
const UNRESTRICTED_TOOLS = new Set(["WebSearch", "WebFetch"]);

// MCP tools allowed
const ALLOWED_MCP_TOOLS = new Set([
  "mcp__exa__web_search_exa",
  "mcp__exa__company_research_exa",
  "mcp__exa__get_code_context_exa",
]);

// All allowed tools list for the SDK
const ALLOWED_TOOLS = [
  "Read", "Glob", "Grep",  // Read tools (path validated)
  "Write", "Edit",          // Write tools (path validated, working dir only)
  "Bash",                   // Bash (command validated)
  "WebSearch", "WebFetch",  // Web tools (unrestricted)
  // MCP tools are enabled via allowedTools but also validated in canUseTool
];

// ============== Core Query Handler ==============

async function handleQuery(
  ctx: Context | null,
  message: string,
  userId: number,
  session: Session,
  chatId: number,
  statusMsgId?: number,
  images?: ImageData[]
): Promise<void> {
  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    _options: Record<string, unknown>
  ): Promise<PermissionResult> => {
    // Unrestricted tools
    if (UNRESTRICTED_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    // MCP tools
    if (toolName.startsWith("mcp__exa__")) {
      if (ALLOWED_MCP_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }
      console.log(`[DENIED] Unknown MCP tool: ${toolName}`);
      return {
        behavior: "deny",
        message: `MCP tool "${toolName}" is not in the allowed list.`
      };
    }

    // Read tools - validate path allows reading
    if (PATH_VALIDATED_READ_TOOLS.has(toolName)) {
      const toolPath = getPathFromToolInput(toolName, input);
      if (toolPath && !isPathAllowedForRead(toolPath)) {
        console.log(`[DENIED] ${toolName} outside allowed paths: ${toolPath}`);
        return {
          behavior: "deny",
          message: `Access denied: "${toolPath}" is outside allowed directories.`
        };
      }
      return { behavior: "allow", updatedInput: input };
    }

    // Write tools - validate path is within WORKING_DIR only
    if (PATH_VALIDATED_WRITE_TOOLS.has(toolName)) {
      const toolPath = getPathFromToolInput(toolName, input);
      if (toolPath && !isPathWithinWorkingDir(toolPath)) {
        console.log(`[DENIED] ${toolName} outside working dir: ${toolPath}`);
        return {
          behavior: "deny",
          message: `Write access denied: "${toolPath}" is outside the agent working directory`
        };
      }
      return { behavior: "allow", updatedInput: input };
    }

    // Bash - validate command is in whitelist
    if (toolName === "Bash" && typeof input.command === "string") {
      if (isSafeBashCommand(input.command)) {
        return { behavior: "allow", updatedInput: input };
      }
      console.log(`[DENIED] Unsafe Bash command: ${input.command.slice(0, 100)}`);
      return {
        behavior: "deny",
        message: "This command is not in the allowed list."
      };
    }

    // Everything else - hard deny
    console.log(`[DENIED] Unsafe tool: ${toolName}`);
    return {
      behavior: "deny",
      message: `Tool "${toolName}" is not allowed.`
    };
  };

  // Status update helper with throttling
  let lastStatusUpdate = 0;
  let currentStatus = "Processing...";
  const STATUS_THROTTLE_MS = 500;

  const updateStatus = async (newStatus: string) => {
    const now = Date.now();
    if (statusMsgId && newStatus !== currentStatus && now - lastStatusUpdate > STATUS_THROTTLE_MS) {
      currentStatus = newStatus;
      lastStatusUpdate = now;
      try {
        await bot.api.editMessageText(chatId, statusMsgId, newStatus);
      } catch {
        // Ignore edit errors (message might be deleted)
      }
    }
  };

  try {
    const abortController = new AbortController();
    session.abortController = abortController;

    // Use image prompt generator if images provided, otherwise plain text
    const prompt = images && images.length > 0
      ? createImagePrompt(images, message, session.sessionId || "")
      : message;

    const queryInstance = query({
      prompt,
      options: {
        model: "claude-sonnet-4-20250514",
        cwd: WORKING_DIR,
        systemPrompt,
        settingSources: [],
        canUseTool,
        allowedTools: ALLOWED_TOOLS,
        resume: session.sessionId,
        abortController,
      },
    });

    let responseText = "";
    let newSessionId: string | undefined;

    for await (const event of queryInstance) {
      if ("session_id" in event && event.session_id) {
        newSessionId = event.session_id;
      }

      // Update status based on event type
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            responseText += block.text;
            await updateStatus("Writing response...");
          } else if (block.type === "tool_use") {
            const toolBlock = block as { name?: string; input?: Record<string, unknown> };
            const toolName = toolBlock.name || "tool";
            // Show more context for specific tools
            if (toolName === "Read" && toolBlock.input?.file_path) {
              const path = String(toolBlock.input.file_path).split("/").slice(-2).join("/");
              await updateStatus(`Reading: ${path}`);
            } else if (toolName === "Grep" && toolBlock.input?.pattern) {
              await updateStatus(`Searching: ${String(toolBlock.input.pattern).slice(0, 30)}`);
            } else if (toolName === "Glob") {
              await updateStatus(`Finding files...`);
            } else if (toolName === "Bash") {
              const cmd = String(toolBlock.input?.command || "").split("\n")[0].slice(0, 30);
              await updateStatus(`Running: ${cmd}`);
            } else if (toolName === "Edit" || toolName === "Write") {
              await updateStatus(`Editing file...`);
            } else if (toolName === "Task") {
              await updateStatus(`Spawning agent...`);
            } else if (toolName.startsWith("mcp__exa__")) {
              await updateStatus(`Searching web...`);
            } else {
              await updateStatus(`Using: ${toolName}`);
            }
          }
        }
      } else if (event.type === "user" && (event as { message?: { content?: Array<{ type: string }> } }).message?.content) {
        // Tool results coming back
        await updateStatus("Processing result...");
      }
    }

    session.abortController = undefined;

    if (newSessionId) {
      session.sessionId = newSessionId;
      await saveSessions();
    }
    session.lastActivity = Date.now();

    // Delete status message if we have one
    if (statusMsgId) {
      try {
        await bot.api.deleteMessage(chatId, statusMsgId);
      } catch {
        // Ignore if message already deleted
      }
    }

    // Process [SEND_FILE:] patterns and send files
    responseText = await sendFilesToUser(chatId, responseText);

    // Strip any remaining markdown formatting for cleaner TG display
    responseText = stripMarkdown(responseText);

    if (responseText.trim()) {
      if (ctx) {
        await sendLongMessage(ctx, responseText.trim());
      } else {
        await sendLongMessageDirect(chatId, responseText.trim());
      }
    } else {
      if (ctx) {
        await ctx.reply("(No text response from Claude)");
      } else {
        await bot.api.sendMessage(chatId, "(No text response from Claude)");
      }
    }
  } catch (error) {
    session.abortController = undefined;

    // Delete status message on error too
    if (statusMsgId) {
      try {
        await bot.api.deleteMessage(chatId, statusMsgId);
      } catch {
        // Ignore
      }
    }

    const errorStr = String(error).toLowerCase();
    if (errorStr.includes("abort") || errorStr.includes("cancel")) {
      const wasInterrupt = consumeInterruptFlag(session);
      if (!wasInterrupt) {
        if (ctx) {
          await ctx.reply("Query stopped.");
        } else {
          await bot.api.sendMessage(chatId, "Query stopped.");
        }
      }
    } else {
      console.error("Query error:", error);
      const errMsg = `Error: ${error instanceof Error ? error.message : String(error)}`;
      if (ctx) {
        await ctx.reply(errMsg);
      } else {
        await bot.api.sendMessage(chatId, errMsg);
      }
    }
  }
}

// ============== Bot Setup ==============

const bot = new Bot(BOT_TOKEN);

// Authorization middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) {
    await ctx.reply(`Unauthorized. Your user ID: ${userId}`);
    return;
  }
  await next();
});

// Commands
bot.command("start", async (ctx) => {
  const userId = ctx.from!.id;
  abortUserQuery(userId);
  sessions.delete(userId);
  await saveSessions();
  await ctx.reply("New session started. Any running query was aborted.");
});

bot.command("stop", async (ctx) => {
  const userId = ctx.from!.id;
  abortUserQuery(userId);
  sessions.delete(userId);
  await saveSessions();
  await ctx.reply("Session stopped. Any running query was aborted.");
});

bot.command("status", async (ctx) => {
  const userId = ctx.from!.id;
  const session = sessions.get(userId);

  let status = "";
  if (session?.sessionId) {
    const idleSeconds = Math.floor((Date.now() - session.lastActivity) / 1000);
    status = `Session active\nID: ${session.sessionId.slice(0, 8)}...\nIdle: ${idleSeconds}s`;
  } else {
    status = "No active session.";
  }

  status += `\n\nVoice: ${openaiClient ? "enabled" : "disabled"}`;
  status += `\nWorking dir: ${WORKING_DIR}`;
  await ctx.reply(status);
});

// Handle voice messages
bot.on("message:voice", async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = ctx.chat.id;
  const session = getSession(userId);
  session.chatId = chatId;

  if (!openaiClient) {
    await ctx.reply("Voice transcription not configured. Set OPENAI_API_KEY in .env");
    return;
  }

  const statusMsg = await ctx.reply("Transcribing...");
  let voicePath: string | null = null;

  try {
    // Download voice file
    const file = await ctx.getFile();
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await downloadRes.arrayBuffer();
    await Bun.write(voicePath, buffer);

    // Transcribe
    const transcript = await transcribeVoice(voicePath);
    if (!transcript) {
      await bot.api.editMessageText(chatId, statusMsg.message_id, "Transcription failed.");
      return;
    }

    // Show transcript permanently
    await bot.api.editMessageText(chatId, statusMsg.message_id, `You said:\n"${transcript}"`);

    // Create a NEW status message for processing
    const processingStatusMsg = await ctx.reply("Processing...");

    // Check for interrupt prefix in transcript too
    const isInterrupt = transcript.startsWith("!");
    const actualMessage = isInterrupt ? transcript.slice(1).trim() : transcript;

    if (isInterrupt) {
      abortUserQuery(userId, true);
    }

    // Wrap message with TG formatting instructions
    const wrappedMessage = `<tg_format>
You are responding via Telegram. Keep responses concise and plain text:
- Start with a brief (1-2 sentence) summary of what you did
- No markdown formatting (no **bold**, no \`code\`, no headers)
- Keep total response under 2000 chars when possible
</tg_format>

<tg_message>
${actualMessage}
</tg_message>`;

    await handleQuery(ctx, wrappedMessage, userId, session, chatId, processingStatusMsg.message_id);

  } catch (error) {
    console.error("Voice handling error:", error);
    await ctx.reply(`Error: ${String(error).slice(0, 200)}`);
  } finally {
    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

// Media group buffer for collecting multiple images sent together
const mediaGroupBuffer = new Map<string, {
  images: ImageData[];
  caption: string;
  chatId: number;
  userId: number;
  timeout: Timer;
}>();

async function processMediaGroup(groupId: string) {
  const group = mediaGroupBuffer.get(groupId);
  if (!group) return;
  mediaGroupBuffer.delete(groupId);

  const session = getSession(group.userId);
  const statusMsg = await bot.api.sendMessage(
    group.chatId,
    `Processing ${group.images.length} image${group.images.length > 1 ? "s" : ""}...`
  );

  await handleQuery(
    null,
    group.caption || `What's in ${group.images.length > 1 ? "these images" : "this image"}?`,
    group.userId,
    session,
    group.chatId,
    statusMsg.message_id,
    group.images
  );
}

// Handle photo messages (single images or albums)
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = ctx.chat.id;
  const session = getSession(userId);
  session.chatId = chatId;

  // Get largest photo version
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];

  try {
    const { buffer, filename } = await downloadTelegramFile(largest.file_id);
    const mimeType = getMimeType(filename);
    const imageData: ImageData = { buffer, mimeType };

    const caption = ctx.message.caption || "";
    const mediaGroupId = ctx.message.media_group_id;

    if (mediaGroupId) {
      // Part of media group - buffer and wait for more
      let group = mediaGroupBuffer.get(mediaGroupId);
      if (!group) {
        group = {
          images: [],
          caption,
          chatId,
          userId,
          timeout: setTimeout(() => processMediaGroup(mediaGroupId), 500),
        };
        mediaGroupBuffer.set(mediaGroupId, group);
      } else {
        clearTimeout(group.timeout);
        group.timeout = setTimeout(() => processMediaGroup(mediaGroupId), 500);
      }
      group.images.push(imageData);
      // Use first non-empty caption
      if (caption && !group.caption) {
        group.caption = caption;
      }
    } else {
      // Single image - process immediately
      const statusMsg = await ctx.reply("Processing image...");
      const imagePrompt = caption || "What's in this image?";

      // Wrap message with TG formatting instructions
      const wrappedPrompt = `<tg_format>
You are responding via Telegram. Keep responses concise and plain text:
- Start with a brief (1-2 sentence) summary of what you did
- No markdown formatting (no **bold**, no \`code\`, no headers)
- Keep total response under 2000 chars when possible
</tg_format>

<tg_message>
${imagePrompt}
</tg_message>`;

      await handleQuery(
        ctx,
        wrappedPrompt,
        userId,
        session,
        chatId,
        statusMsg.message_id,
        [imageData]
      );
    }
  } catch (error) {
    console.error("Photo handling error:", error);
    await ctx.reply(`Error processing image: ${String(error).slice(0, 200)}`);
  }
});

// Handle text messages
bot.on("message:text", async (ctx) => {
  const userId = ctx.from!.id;
  const chatId = ctx.chat.id;
  let message = ctx.message.text;
  const session = getSession(userId);
  session.chatId = chatId;

  // Check for interrupt prefix (!)
  const isInterrupt = message.startsWith("!");
  if (isInterrupt) {
    message = message.slice(1).trim();
    abortUserQuery(userId, true);  // Abort with interrupt flag
  }

  // Wrap message with TG formatting instructions
  const wrappedMessage = `<tg_format>
You are responding via Telegram. Keep responses concise and plain text:
- Start with a brief (1-2 sentence) summary of what you did
- No markdown formatting (no **bold**, no \`code\`, no headers)
- Keep total response under 2000 chars when possible
</tg_format>

<tg_message>
${message}
</tg_message>`;

  const statusMsg = await ctx.reply("Processing...");
  await handleQuery(ctx, wrappedMessage, userId, session, chatId, statusMsg.message_id);
});

// ============== Graceful Shutdown ==============

const gracefulShutdown = async (signal: string) => {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  bot.stop();

  // Save sessions
  try {
    await saveSessions();
    console.log("Sessions saved.");
  } catch (e) {
    console.error("Failed to save sessions:", e);
  }

  console.log("Shutdown complete.");
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ============== Start Bot ==============

console.log("Starting Moltbook TG Bot...");
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.join(", ")}`);
console.log(`Session file: ${SESSION_FILE}`);
console.log(`Read-only paths: ${READ_ONLY_PATHS.length > 0 ? READ_ONLY_PATHS.join(", ") : "(none)"}`);

bot.start({
  drop_pending_updates: true,
  onStart: () => console.log("Bot started, old updates dropped"),
});
