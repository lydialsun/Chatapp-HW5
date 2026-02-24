import { GoogleGenerativeAI } from '@google/generative-ai';
import { CSV_TOOL_DECLARATIONS } from './csvTools';
import { YOUTUBE_TOOL_DECLARATIONS } from './youtubeTools';

// Strip surrounding quotes (e.g. from .env: REACT_APP_GEMINI_API_KEY="AIza...")
function stripQuotes(s) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1).trim();
  return t;
}
const GEMINI_KEY = stripQuotes(process.env.REACT_APP_GEMINI_API_KEY || '');
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

const MODEL = 'gemini-2.5-flash';

// Keep context under Gemini's 1M token limit: trim history and message sizes.
const MAX_HISTORY_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 8000;

function trimHistory(history) {
  const arr = Array.isArray(history) ? history : [];
  const trimmed = arr.slice(-MAX_HISTORY_MESSAGES);
  return trimmed.map((m) => {
    const text = (m.content || '').toString();
    const content = text.length <= MAX_MESSAGE_CHARS ? text : text.slice(0, MAX_MESSAGE_CHARS) + '\n\n[... truncated for length ...]';
    return { role: m.role === 'user' ? 'user' : 'model', parts: [{ text: content }] };
  });
}

function trimText(s) {
  if (typeof s !== 'string') return s;
  return s.length <= MAX_MESSAGE_CHARS
    ? s
    : s.slice(0, MAX_MESSAGE_CHARS) + '\n\n[... truncated for length ...]';
}

function sanitizeModelText(text) {
  const t = (text || '').toString();
  // Never treat these as executable commands; keep output plain and safe.
  if (/generateImage\s*\(|gemini_tools|name\s+'.*'\s+is\s+not\s+defined/i.test(t)) {
    return 'I cannot execute text-based tool code. Please send a normal request and I will use the proper tool path.';
  }
  return t;
}

const SEARCH_TOOL = { googleSearch: {} };

let cachedPrompt = null;

async function loadSystemPrompt() {
  if (cachedPrompt) return cachedPrompt;
  try {
    const res = await fetch('/prompt_chat.txt');
    cachedPrompt = res.ok ? (await res.text()).trim() : '';
  } catch {
    cachedPrompt = '';
  }
  return cachedPrompt;
}

// Yields:
//   { type: 'text', text }           — streaming text chunks
//   { type: 'fullResponse', parts }  — structured multimodal parts (e.g. images)
//   { type: 'grounding', data }      — Google Search metadata
//
// fullResponse parts: { type: 'text'|'code'|'result'|'image', ... }
//
// Note: no dynamic code execution is used in this app.
export const streamChat = async function* (history, newMessage, imageParts = []) {
  const systemInstruction = await loadSystemPrompt();
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: [SEARCH_TOOL],
  });

  const baseHistory = trimHistory(history);

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({ history: chatHistory });

  const parts = [
    { text: trimText(newMessage) },
    ...imageParts.map((img) => ({
      inlineData: { mimeType: img.mimeType || 'image/png', data: img.data },
    })),
  ].filter((p) => p.text !== undefined || p.inlineData !== undefined);

  const result = await chat.sendMessageStream(parts);

  // Stream text chunks for live display
  for await (const chunk of result.stream) {
    const chunkParts = chunk.candidates?.[0]?.content?.parts || [];
    for (const part of chunkParts) {
      if (part.text) yield { type: 'text', text: part.text };
    }
  }

  // After stream: inspect all response parts
  const response = await result.response;
  const allParts = response.candidates?.[0]?.content?.parts || [];

  const hasStructuredParts = allParts.some((p) => p.inlineData && p.inlineData.mimeType?.startsWith('image/'));
  if (hasStructuredParts) {
    // Build ordered structured parts to replace the streamed text (no code execution)
    const structuredParts = allParts
      .map((p) => {
        if (p.text) return { type: 'text', text: p.text };
        if (p.inlineData)
          return { type: 'image', mimeType: p.inlineData.mimeType, data: p.inlineData.data };
        return null;
      })
      .filter(Boolean);

    yield { type: 'fullResponse', parts: structuredParts };
  }

  // Grounding metadata (search sources)
  const grounding = response.candidates?.[0]?.groundingMetadata;
  if (grounding) {
    console.log('[Search grounding]', grounding);
    yield { type: 'grounding', data: grounding };
  }
};

// ── Function-calling chat for CSV tools ───────────────────────────────────────
// Gemini picks a tool + args → executeFn runs it client-side (free) → Gemini
// receives the result and returns a natural-language answer.
//
// executeFn(toolName, args) → plain JS object with the result
// Returns the final text response from the model.

export const chatWithCsvTools = async (history, newMessage, csvHeaders, executeFn) => {
  const systemInstruction = await loadSystemPrompt();
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: [{ functionDeclarations: CSV_TOOL_DECLARATIONS }],
  });

  const baseHistory = trimHistory(history);

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({ history: chatHistory });

  // Include column names so the model can match user intent to exact column names
  const msgWithContext = csvHeaders?.length
    ? `[CSV columns: ${csvHeaders.join(', ')}]\n\n${newMessage}`
    : newMessage;
  const trimmedMessage = trimText(msgWithContext);

  let response = (await chat.sendMessage(trimmedMessage)).response;

  // Accumulate chart payloads and a log of every tool call made
  const charts = [];
  const toolCalls = [];

  // Function-calling loop (Gemini may chain multiple tool calls)
  for (let round = 0; round < 5; round++) {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const funcCall = parts.find((p) => p.functionCall);
    if (!funcCall) break;

    const { name, args } = funcCall.functionCall;
    console.log('[CSV Tool]', name, args);
    const toolResult = executeFn(name, args);
    console.log('[CSV Tool result]', toolResult);

    // Log the call for persistence
    toolCalls.push({ name, args, result: toolResult });

    // Capture chart payloads so the UI can render them
    if (toolResult?._chartType) {
      charts.push(toolResult);
    }

    response = (
      await chat.sendMessage([
        { functionResponse: { name, response: { result: toolResult } } },
      ])
    ).response;
  }

  return { text: sanitizeModelText(response.text()), charts, toolCalls };
};

// ── Function-calling chat for YouTube / channel JSON tools ───────────────────
// executeFn(toolName, args) → Promise<result> (e.g. for generateImage)

export const chatWithYouTubeTools = async (history, newMessage, executeFn) => {
  const systemInstruction = await loadSystemPrompt();
  const model = genAI.getGenerativeModel({
    model: MODEL,
    tools: [{ functionDeclarations: YOUTUBE_TOOL_DECLARATIONS }],
  });

  const baseHistory = trimHistory(history);

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({ history: chatHistory });

  let response = (await chat.sendMessage(trimText(newMessage))).response;

  const charts = [];
  const toolCalls = [];

  for (let round = 0; round < 5; round++) {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const funcCall = parts.find((p) => p.functionCall);
    if (!funcCall) break;

    const { name, args } = funcCall.functionCall;
    console.log('[YouTube Tool]', name, args);
    const toolResult = await Promise.resolve(executeFn(name, args || {}));
    console.log('[YouTube Tool result]', toolResult);

    toolCalls.push({ name, args: args || {}, result: toolResult });
    if (toolResult?._chartType) charts.push(toolResult);

    response = (
      await chat.sendMessage([
        { functionResponse: { name, response: { result: toolResult } } },
      ])
    ).response;
  }

  return { text: sanitizeModelText(response.text()), charts, toolCalls };
};
