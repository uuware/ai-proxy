#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');

const DEFAULT_TARGET_BASE = '';
const DEFAULT_API_MODEL = '';
const CONTROL_TOKEN = process.env.AI_PROXY_CONTROL_TOKEN || '';
let runtimeProfileConfig;

function createRuntimeProfileConfig(source) {
  const targetBaseValue = String((source && source.targetBase) || DEFAULT_TARGET_BASE).trim();
  let targetBaseUrl;

  try {
    targetBaseUrl = new URL(targetBaseValue);
  } catch (error) {
    throw new Error(`Invalid target base URL: ${targetBaseValue}`);
  }

  return {
    targetBase: targetBaseValue,
    targetBaseUrl,
    apiKey: typeof (source && source.apiKey) === 'string' ? source.apiKey : '',
    model: String((source && source.model) || DEFAULT_API_MODEL).trim() || DEFAULT_API_MODEL,
    modelReplace: Boolean(source && (source.modelReplace === true || source.modelReplace === '1' || source.modelReplace === 1)),
    updatedAt: new Date().toISOString(),
  };
}

try {
  runtimeProfileConfig = createRuntimeProfileConfig({
    targetBase: process.env.AI_PROXY_TARGET_BASE,
    apiKey: process.env.AI_PROXY_KEY || '',
    model: process.env.AI_PROXY_MODEL,
    modelReplace: process.env.AI_PROXY_MODEL_REPLACE === '1',
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function getRuntimeProfileConfig() {
  return runtimeProfileConfig;
}

function updateRuntimeProfileConfig(source) {
  runtimeProfileConfig = createRuntimeProfileConfig({
    ...runtimeProfileConfig,
    ...source,
  });

  return runtimeProfileConfig;
}

const LISTEN_HOST = process.env.AI_PROXY_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.AI_PROXY_PORT || 8899);
const TIMEOUT_MS = Number(process.env.AI_PROXY_TIMEOUT_MS || 600000);
// Log output directory.
const LOG_DIR = process.env.AI_PROXY_LOG_DIR || path.join(process.cwd(), '.ai-proxy-logs');
// Maximum number of retained log files.
const LOG_MAX_COUNT = Number(process.env.AI_PROXY_LOG_MAX_COUNT || 10);
let requestSequence = 0;
let requestLastTime = 0;
let logFileEntries = [];
let logFileEntriesInitialized = false;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function compareLogFileEntries(left, right) {
  return left.sortTime - right.sortTime || left.fileName.localeCompare(right.fileName);
}

function createLogFileEntry(fileName, sortTime) {
  return {
    fileName,
    filePath: path.join(LOG_DIR, fileName),
    sortTime,
  };
}

function initializeLogFileEntries() {
  ensureLogDir();

  logFileEntries = fs
    .readdirSync(LOG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.log'))
    .map((entry) => {
      const filePath = path.join(LOG_DIR, entry.name);
      let sortTime = 0;

      try {
        sortTime = fs.statSync(filePath).mtimeMs;
      } catch (error) {
        sortTime = 0;
      }

      return createLogFileEntry(entry.name, sortTime);
    })
    .sort(compareLogFileEntries);
  logFileEntriesInitialized = true;
}

function rememberLogFile(logContext) {
  const filePath = path.resolve(logContext.filePath);
  const existingIndex = logFileEntries.findIndex((entry) => path.resolve(entry.filePath) === filePath);
  const logEntry = createLogFileEntry(logContext.fileName, logContext.startedAtDate.getTime());

  if (existingIndex !== -1) {
    logFileEntries.splice(existingIndex, 1);
  }

  logFileEntries.push(logEntry);
  logFileEntries.sort(compareLogFileEntries);
}

function pruneLogFiles(maxCount = LOG_MAX_COUNT) {
  if (!Number.isFinite(maxCount) || maxCount < 0) {
    return;
  }

  const deleteCount = logFileEntries.length - maxCount;

  if (deleteCount <= 0) {
    return;
  }

  const deletedFilePaths = new Set();

  for (const log of logFileEntries.slice(0, deleteCount)) {
    try {
      fs.unlinkSync(log.filePath);
      deletedFilePaths.add(path.resolve(log.filePath));
      console.log(`[${new Date().toISOString()}] deleted old proxy log ${log.fileName}`);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        deletedFilePaths.add(path.resolve(log.filePath));
        continue;
      }

      console.error(`[${new Date().toISOString()}] failed to delete old proxy log ${log.fileName}: ${error.message}`);
    }
  }

  if (deletedFilePaths.size > 0) {
    logFileEntries = logFileEntries.filter((log) => !deletedFilePaths.has(path.resolve(log.filePath)));
  }
}

function formatFileTime(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safeFilePart(value, fallback) {
  const safe = String(value || '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return safe || fallback;
}

function createRequestLogContext(req) {
  const startedAtDate = new Date();
  const requestTime = startedAtDate.getTime();
  const baseFileName = formatFileTime(startedAtDate);
  let fileName = `${baseFileName}.log`;

  if (requestTime === requestLastTime) {
    requestSequence += 1;
    fileName = `${baseFileName}-${String(requestSequence).padStart(3, '0')}.log`;
  } else {
    requestLastTime = requestTime;
    requestSequence = 0;
  }

  return {
    filePath: path.join(LOG_DIR, fileName),
    fileName,
    startedAtDate,
  };
}

function isRememberedLogFile(logContext) {
  const filePath = path.resolve(logContext.filePath);

  return logFileEntries.some((entry) => path.resolve(entry.filePath) === filePath);
}

async function writeRequestLog(logContext, content) {
  try {
    await fs.promises.writeFile(logContext.filePath, content);

    if (!logFileEntriesInitialized) {
      initializeLogFileEntries();
    }

    rememberLogFile(logContext);
    pruneLogFiles();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] failed to write proxy log ${logContext.fileName}: ${error.message}`);
  }
}

async function appendRequestLog(logContext, content) {
  if (!isRememberedLogFile(logContext)) {
    return;
  }

  try {
    await fs.promises.appendFile(logContext.filePath, `\n${content}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] failed to append proxy log ${logContext.fileName}: ${error.message}`);
  }
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function sendJsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJsonRequestBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      receivedBytes += chunk.length;

      if (receivedBytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }

      if (!tooLarge) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        reject(error);
        return;
      }

      const text = Buffer.concat(chunks).toString('utf8').trim();

      if (!text) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function getHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function timingSafeStringEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isControlRequestAuthorized(req) {
  if (!CONTROL_TOKEN || !isLoopbackAddress(req.socket.remoteAddress)) {
    return false;
  }

  return timingSafeStringEquals(getHeaderValue(req.headers['x-ai-proxy-control-token']), CONTROL_TOKEN);
}

function runtimeProfileStatusBody() {
  const runtimeConfig = getRuntimeProfileConfig();

  return {
    targetBase: runtimeConfig.targetBaseUrl.href,
    model: runtimeConfig.model,
    modelReplace: runtimeConfig.modelReplace,
    apiKeySet: Boolean(runtimeConfig.apiKey),
    updatedAt: runtimeConfig.updatedAt,
  };
}

async function handleRuntimeProfileConfigRequest(req, res) {
  if (req.method !== 'POST') {
    sendJsonResponse(res, 405, { error: 'method_not_allowed', message: 'Use POST to update runtime profile config.' });
    return;
  }

  if (!isControlRequestAuthorized(req)) {
    sendJsonResponse(res, 403, { error: 'forbidden', message: 'Runtime profile updates are only accepted from the local control client.' });
    return;
  }

  let body;

  try {
    body = await readJsonRequestBody(req);
  } catch (error) {
    sendJsonResponse(res, error.statusCode || 400, { error: 'invalid_json', message: error.message });
    return;
  }

  try {
    const runtimeConfig = updateRuntimeProfileConfig({
      targetBase: body.targetBase,
      apiKey: body.apiKey,
      model: body.model,
      modelReplace: body.modelReplace,
    });

    console.log(
      `[${new Date().toISOString()}] runtime profile updated: target=${runtimeConfig.targetBaseUrl.href}, model=${
        runtimeConfig.model
      }, modelReplacement=${runtimeConfig.modelReplace ? 'enabled' : 'disabled'}`
    );

    sendJsonResponse(res, 200, {
      status: 'ok',
      ...runtimeProfileStatusBody(),
    });
  } catch (error) {
    sendJsonResponse(res, 400, { error: 'invalid_runtime_config', message: error.message });
  }
}

function bufferToLogString(buffer, contentType) {
  if (!buffer || buffer.length === 0) {
    return '<empty>';
  }

  const type = String(contentType || '').toLowerCase();
  const text = buffer.toString('utf8');

  if (type.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (error) {
      return text;
    }
  }

  const looksText =
    type.startsWith('text/') ||
    type.includes('xml') ||
    type.includes('javascript') ||
    type.includes('x-www-form-urlencoded') ||
    type === '';

  if (looksText) {
    return text;
  }

  return `<binary ${buffer.length} bytes>\n${buffer.toString('hex')}`;
}

function decodeResponseBodyForLog(buffer, headers) {
  const encoding = String(headers['content-encoding'] || '')
    .toLowerCase()
    .trim();

  if (!encoding || encoding === 'identity') {
    return { buffer, lines: [] };
  }

  try {
    if (encoding.includes('gzip') || encoding.includes('x-gzip')) {
      const decodedBuffer = zlib.gunzipSync(buffer);
      return {
        buffer: decodedBuffer,
        lines: [`decodedFrom: ${encoding}`, `decodedBodyBytes: ${decodedBuffer.length}`],
      };
    }

    if (encoding.includes('br')) {
      const decodedBuffer = zlib.brotliDecompressSync(buffer);
      return {
        buffer: decodedBuffer,
        lines: [`decodedFrom: ${encoding}`, `decodedBodyBytes: ${decodedBuffer.length}`],
      };
    }

    if (encoding.includes('deflate')) {
      const decodedBuffer = zlib.inflateSync(buffer);
      return {
        buffer: decodedBuffer,
        lines: [`decodedFrom: ${encoding}`, `decodedBodyBytes: ${decodedBuffer.length}`],
      };
    }

    return { buffer, lines: [`decodedFrom: <unsupported ${encoding}>`] };
  } catch (error) {
    return { buffer, lines: [`decodedFrom: <failed ${encoding}: ${error.message}>`] };
  }
}

function formatLogBlock(title, lines, at = new Date()) {
  return [`[${at.toISOString()}] ${title}`, '='.repeat(Math.max(20, title.length)), ...lines, ''].join('\n');
}

function buildRequestLog({ req, targetUrl, requestOptions, requestBody, logContext }) {
  return [
    formatLogBlock(
      'CLIENT -> PROXY request headers',
      [
        `${req.method} ${req.url} HTTP/${req.httpVersion}`,
        `target: ${targetUrl.href}`,
        `remoteAddress: ${req.socket.remoteAddress}`,
        `remotePort: ${req.socket.remotePort}`,
        // `rawHeaders: ${safeJson(req.rawHeaders)}`,
        `headers: ${safeJson(req.headers)}`,
        `forwardedRequestOptions: ${safeJson(requestOptions)}`,
      ],
      logContext.startedAtDate
    ),
    formatLogBlock('CLIENT -> PROXY request body', [
      `${req.method} ${req.url}`,
      `bodyBytes: ${requestBody.length}`,
      bufferToLogString(requestBody, req.headers['content-type']),
    ]),
    `sentAt: ${new Date().toISOString()}\n`,
  ].join('\n');
}

function buildResponseLog({ req, proxyRes, responseBody, startedAt }) {
  const completedAt = new Date();
  const durationMs = Date.now() - startedAt;
  const sections = [];

  if (proxyRes) {
    const responseBodyForLog = decodeResponseBodyForLog(responseBody, proxyRes.headers);
    const assembledResponseLog = buildAssembledChatCompletionResponseLog(responseBodyForLog.buffer, proxyRes.headers);

    sections.push(
      formatLogBlock('TARGET -> PROXY response headers', [
        `${req.method} ${req.url}`,
        `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode || 502} ${proxyRes.statusMessage || ''}`,
        // `rawHeaders: ${safeJson(proxyRes.rawHeaders)}`,
        `headers: ${safeJson(proxyRes.headers)}`,
      ]),
      formatLogBlock('TARGET -> PROXY response body', [
        `${req.method} ${req.url}`,
        `status: ${proxyRes.statusCode || 502}`,
        `durationMs: ${durationMs}`,
        `bodyBytes: ${responseBody.length}`,
        ...responseBodyForLog.lines,
        bufferToLogString(responseBodyForLog.buffer, proxyRes.headers['content-type']),
      ])
    );

    if (assembledResponseLog) {
      sections.push(formatLogBlock('TARGET -> PROXY assembled response', assembledResponseLog));
    }
  } else {
    sections.push(
      formatLogBlock('TARGET -> PROXY response error', [
        `${req.method} ${req.url}`,
        `durationMs: ${durationMs}`,
        bufferToLogString(responseBody, 'application/json'),
      ])
    );
  }

  sections.push(
    [
      `completedAt: ${completedAt.toISOString()}`,
      `requestDuration(seconds): ${Math.floor(durationMs / 1000)}`,
      '',
    ].join('\n')
  );

  return sections.join('\n');
}

function createChatCompletionAssemblyState() {
  return {
    role: '',
    contentParts: [],
    reasoningParts: [],
    refusalParts: [],
    finishReasons: [],
    usage: null,
    toolCalls: [],
    toolCallByIndex: new Map(),
  };
}

function getOrCreateAssembledToolCall(state, toolCall, fallbackIndex) {
  const index = Number.isInteger(toolCall && toolCall.index) ? toolCall.index : fallbackIndex;
  const key = Number.isInteger(index) ? index : state.toolCalls.length;

  if (state.toolCallByIndex.has(key)) {
    return state.toolCallByIndex.get(key);
  }

  const assembledToolCall = {
    index: key,
    id: '',
    type: '',
    functionName: '',
    argumentsParts: [],
  };

  state.toolCallByIndex.set(key, assembledToolCall);
  state.toolCalls.push(assembledToolCall);

  return assembledToolCall;
}

function appendUniqueValue(values, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }

  if (!values.includes(value)) {
    values.push(value);
  }
}

function appendChatCompletionToolCalls(state, toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return;
  }

  toolCalls.forEach((toolCall, fallbackIndex) => {
    if (!toolCall || typeof toolCall !== 'object') {
      return;
    }

    const assembledToolCall = getOrCreateAssembledToolCall(state, toolCall, fallbackIndex);

    if (typeof toolCall.id === 'string') {
      assembledToolCall.id += toolCall.id;
    }

    if (typeof toolCall.type === 'string') {
      assembledToolCall.type += toolCall.type;
    }

    const fn = toolCall.function;

    if (fn && typeof fn === 'object') {
      if (typeof fn.name === 'string') {
        assembledToolCall.functionName += fn.name;
      }

      if (typeof fn.arguments === 'string') {
        assembledToolCall.argumentsParts.push(fn.arguments);
      }
    }
  });
}

function appendChatCompletionContainer(state, container) {
  if (!container || typeof container !== 'object') {
    return;
  }

  if (typeof container.role === 'string') {
    state.role += container.role;
  }

  if (typeof container.content === 'string') {
    state.contentParts.push(container.content);
  }

  if (typeof container.reasoning === 'string') {
    state.reasoningParts.push(container.reasoning);
  }

  if (typeof container.reasoning_content === 'string') {
    state.reasoningParts.push(container.reasoning_content);
  }

  if (typeof container.refusal === 'string') {
    state.refusalParts.push(container.refusal);
  }

  appendChatCompletionToolCalls(state, container.tool_calls);
}

function appendChatCompletionChoice(state, choice) {
  if (!choice || typeof choice !== 'object') {
    return;
  }

  appendChatCompletionContainer(state, choice.delta);
  appendChatCompletionContainer(state, choice.message);

  appendUniqueValue(state.finishReasons, choice.finish_reason);
  appendUniqueValue(state.finishReasons, choice.native_finish_reason);
}

function appendChatCompletionPayload(state, payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  if (Array.isArray(payload.choices)) {
    payload.choices.forEach((choice) => appendChatCompletionChoice(state, choice));
  } else {
    appendChatCompletionContainer(state, payload);
  }

  if (payload.usage && typeof payload.usage === 'object') {
    state.usage = payload.usage;
  }

  return true;
}

function finalizeAssembledChatCompletion(state) {
  const toolCalls = state.toolCalls
    .slice()
    .sort((left, right) => left.index - right.index)
    .map((toolCall) => {
      const argumentsText = toolCall.argumentsParts.join('');
      let parsedArguments = null;

      if (argumentsText) {
        try {
          parsedArguments = JSON.parse(argumentsText);
        } catch (error) {
          parsedArguments = null;
        }
      }

      return {
        index: toolCall.index,
        id: toolCall.id || undefined,
        type: toolCall.type || undefined,
        function: {
          name: toolCall.functionName || undefined,
          arguments: argumentsText,
          parsed_arguments: parsedArguments || undefined,
        },
      };
    });

  return {
    role: state.role || undefined,
    content: state.contentParts.join(''),
    reasoning: state.reasoningParts.join(''),
    refusal: state.refusalParts.join(''),
    finish_reasons: state.finishReasons,
    tool_calls: toolCalls,
    usage: state.usage || undefined,
  };
}

function compactUndefinedForJson(value) {
  if (Array.isArray(value)) {
    return value.map(compactUndefinedForJson).filter((item) => item !== undefined);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const nextValue = {};

  for (const [key, entryValue] of Object.entries(value)) {
    const compactedValue = compactUndefinedForJson(entryValue);
    const isEmptyArray = Array.isArray(compactedValue) && compactedValue.length === 0;
    const isEmptyString = compactedValue === '';

    if (compactedValue !== undefined && !isEmptyArray && !isEmptyString) {
      nextValue[key] = compactedValue;
    }
  }

  return nextValue;
}

function formatAssembledChatCompletionForLog(state, details) {
  const assembled = compactUndefinedForJson(finalizeAssembledChatCompletion(state));
  const lines = [
    `assembledFrom: ${details.assembledFrom}`,
    `eventCount: ${details.eventCount}`,
    `payloadCount: ${details.payloadCount}`,
  ];

  if (details.doneCount) {
    lines.push(`doneCount: ${details.doneCount}`);
  }

  lines.push(safeJson(assembled));

  return lines;
}

function buildAssembledChatCompletionFromJsonText(jsonText) {
  const payload = parseChatCompletionJsonText(jsonText);

  if (!payload) {
    return null;
  }

  const state = createChatCompletionAssemblyState();
  const appended = appendChatCompletionPayload(state, payload);

  if (!appended) {
    return null;
  }

  return formatAssembledChatCompletionForLog(state, {
    assembledFrom: 'json',
    eventCount: 1,
    payloadCount: 1,
    doneCount: 0,
  });
}

function buildAssembledChatCompletionFromSseText(sseText) {
  let pending = String(sseText || '');
  let eventDelimiter = findSseEventDelimiter(pending);
  let eventCount = 0;
  let payloadCount = 0;
  let doneCount = 0;
  const state = createChatCompletionAssemblyState();

  function appendEvent(eventText) {
    if (!eventText || !eventText.trim()) {
      return;
    }

    eventCount += 1;
    const eventData = splitSseEvent(eventText);

    if (!eventData || !eventData.payloadText) {
      return;
    }

    if (eventData.payloadText.trim() === '[DONE]') {
      doneCount += 1;
      return;
    }

    const payload = parseChatCompletionJsonText(eventData.payloadText);

    if (!payload) {
      return;
    }

    if (appendChatCompletionPayload(state, payload)) {
      payloadCount += 1;
    }
  }

  while (eventDelimiter) {
    appendEvent(pending.slice(0, eventDelimiter.index));
    pending = pending.slice(eventDelimiter.index + eventDelimiter.delimiter.length);
    eventDelimiter = findSseEventDelimiter(pending);
  }

  appendEvent(pending);

  if (payloadCount === 0) {
    return null;
  }

  return formatAssembledChatCompletionForLog(state, {
    assembledFrom: 'sse',
    eventCount,
    payloadCount,
    doneCount,
  });
}

function buildAssembledChatCompletionResponseLog(responseBuffer, headers) {
  if (!responseBuffer || responseBuffer.length === 0) {
    return null;
  }

  const responseText = responseBuffer.toString('utf8');

  if (shouldSanitizeSseResponse(headers)) {
    return buildAssembledChatCompletionFromSseText(responseText);
  }

  if (shouldSanitizeJsonResponse(headers)) {
    return buildAssembledChatCompletionFromJsonText(responseText);
  }

  return null;
}

function buildTargetUrl(reqUrl, runtimeConfig = getRuntimeProfileConfig()) {
  const incoming = new URL(reqUrl || '/', `http://${LISTEN_HOST}:${LISTEN_PORT}`);
  const targetBase = runtimeConfig.targetBaseUrl;
  const targetPathBase = targetBase.pathname.replace(/\/$/, '');
  const incomingPath = incoming.pathname.replace(/^\//, '');
  const joinedPath = incomingPath ? `${targetPathBase}/${incomingPath}` : targetPathBase || '/';

  return new URL(`${joinedPath}${incoming.search}`, targetBase);
}

function sanitizeHeaders(headers, targetUrl, runtimeConfig = getRuntimeProfileConfig()) {
  const nextHeaders = { ...headers };

  nextHeaders.host = targetUrl.host;
  nextHeaders['accept-encoding'] = 'identity';
  delete nextHeaders.connection;
  delete nextHeaders['proxy-connection'];
  delete nextHeaders['keep-alive'];
  delete nextHeaders['transfer-encoding'];
  delete nextHeaders.upgrade;
  delete nextHeaders['content-length'];

  nextHeaders['x-forwarded-host'] = headers.host || `${LISTEN_HOST}:${LISTEN_PORT}`;
  nextHeaders['x-forwarded-proto'] = 'https';
  nextHeaders['authorization'] = `Bearer ${runtimeConfig.apiKey}`;
  return nextHeaders;
}

function isIdentityContentEncoding(headers) {
  const encoding = String(headers['content-encoding'] || '')
    .toLowerCase()
    .trim();

  return !encoding || encoding === 'identity';
}

function shouldSanitizeJsonResponse(headers) {
  const contentType = String(headers['content-type'] || '').toLowerCase();

  return contentType.includes('json');
}

function shouldSanitizeSseResponse(headers) {
  const contentType = String(headers['content-type'] || '').toLowerCase();

  return contentType.includes('text/event-stream');
}

function sanitizeResponseHeadersForTransform(headers, contentLength, shouldTransform) {
  if (!shouldTransform) {
    return headers;
  }

  const nextHeaders = { ...headers };

  delete nextHeaders['content-encoding'];
  delete nextHeaders['content-length'];
  delete nextHeaders['transfer-encoding'];

  if (typeof contentLength === 'number') {
    nextHeaders['content-length'] = String(contentLength);
  }

  return nextHeaders;
}

function getImageMimeType(image) {
  if (!image || typeof image !== 'object') {
    return 'image/png';
  }

  return image.mime_type || image.mimeType || image.media_type || image.mediaType || 'image/png';
}

function normalizeImageUrl(url) {
  const stringUrl = String(url || '');

  if (/^data:image\//i.test(stringUrl)) {
    return stringUrl.replace(/\s+/g, '');
  }

  return stringUrl;
}

function getImageUrl(image) {
  if (typeof image === 'string') {
    return normalizeImageUrl(image);
  }

  if (!image || typeof image !== 'object') {
    return null;
  }

  if (typeof image.url === 'string') {
    return normalizeImageUrl(image.url);
  }

  if (typeof image.image_url === 'string') {
    return normalizeImageUrl(image.image_url);
  }

  if (image.image_url && typeof image.image_url.url === 'string') {
    return normalizeImageUrl(image.image_url.url);
  }

  if (typeof image.data === 'string') {
    if (image.data.startsWith('data:image/')) {
      return normalizeImageUrl(image.data);
    }

    return normalizeImageUrl(`data:${getImageMimeType(image)};base64,${image.data}`);
  }

  if (typeof image.base64 === 'string') {
    return normalizeImageUrl(`data:${getImageMimeType(image)};base64,${image.base64}`);
  }

  if (typeof image.b64_json === 'string') {
    return normalizeImageUrl(`data:${getImageMimeType(image)};base64,${image.b64_json}`);
  }

  return null;
}

function getImageFileExtension(mimeType) {
  const subtype =
    String(mimeType || 'image/png')
      .toLowerCase()
      .split('/')[1] || 'png';
  const normalizedSubtype = subtype.split(';')[0];

  if (normalizedSubtype === 'jpeg' || normalizedSubtype === 'pjpeg') {
    return 'jpg';
  }

  if (normalizedSubtype === 'svg+xml') {
    return 'svg';
  }

  if (normalizedSubtype === 'x-icon' || normalizedSubtype === 'vnd.microsoft.icon') {
    return 'ico';
  }

  return safeFilePart(normalizedSubtype.replace(/\+xml$/i, ''), 'png');
}

function getWorkspaceRelativePath(filePath) {
  const workspaceDir = path.resolve(__dirname, '..');
  const relativePath = path.relative(workspaceDir, filePath).replace(/\\/g, '/');

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return filePath.replace(/\\/g, '/');
  }

  return relativePath;
}

function formatMarkdownFileLink(filePath) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/');
  return `[
\`${normalizedPath}\`](${normalizedPath})`.replace('[\n', '[');
}

function createImageHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createImageSaveContext(logContext) {
  return {
    logContext,
    nextImageIndex: 1,
    savedImageByHash: new Map(),
    completionMessages: [],
    completionMessageSet: new Set(),
    completionToolCallId: null,
    completionToolCallEmitted: false,
    sawToolCalls: false,
  };
}

function recordCompletionMessage(imageSaveContext, message) {
  const text = String(message || '').trim();

  if (!text || !imageSaveContext || !Array.isArray(imageSaveContext.completionMessages)) {
    return;
  }

  if (imageSaveContext.completionMessageSet && imageSaveContext.completionMessageSet.has(text)) {
    return;
  }

  imageSaveContext.completionMessages.push(text);

  if (imageSaveContext.completionMessageSet) {
    imageSaveContext.completionMessageSet.add(text);
  }
}

function getAttemptCompletionResultText(imageSaveContext) {
  const messages =
    imageSaveContext && Array.isArray(imageSaveContext.completionMessages) ? imageSaveContext.completionMessages : [];

  if (messages.length === 0) {
    return 'The current task has been completed.';
  }

  return ['The current task has been completed.', ...messages].join('\n');
}

function getAttemptCompletionToolCallId(imageSaveContext) {
  if (imageSaveContext && imageSaveContext.completionToolCallId) {
    return imageSaveContext.completionToolCallId;
  }

  const baseName =
    imageSaveContext && imageSaveContext.logContext
      ? imageSaveContext.logContext.fileName.replace(/\.log$/i, '')
      : `completion-${Date.now()}`;
  const suffix = safeFilePart(baseName.replace(/[^a-z0-9]+/gi, ''), 'completion').slice(0, 32);
  const toolCallId = `call_${suffix || Date.now()}`;

  if (imageSaveContext) {
    imageSaveContext.completionToolCallId = toolCallId;
  }

  return toolCallId;
}

function getAttemptCompletionArgumentsText(imageSaveContext) {
  return JSON.stringify({ result: getAttemptCompletionResultText(imageSaveContext) });
}

function parseDataImageUrl(url) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(String(url || ''));

  if (!match) {
    return null;
  }

  return {
    mimeType: match[1].toLowerCase(),
    base64Data: match[2].replace(/\s+/g, ''),
  };
}

function saveGeneratedImage(image, imageSaveContext) {
  const url = getImageUrl(image);

  if (!url) {
    return null;
  }

  const parsedDataUrl = parseDataImageUrl(url);

  if (!parsedDataUrl) {
    return {
      saved: false,
      text: `Generated image URL: ${url}`,
    };
  }

  if (!imageSaveContext || !imageSaveContext.logContext) {
    return {
      saved: false,
      text: 'Generated image returned, but no proxy log context was available to save it.',
    };
  }

  const imageBuffer = Buffer.from(parsedDataUrl.base64Data, 'base64');
  const imageHash = createImageHash(imageBuffer);

  if (imageSaveContext.savedImageByHash && imageSaveContext.savedImageByHash.has(imageHash)) {
    return imageSaveContext.savedImageByHash.get(imageHash);
  }

  const imageIndex = imageSaveContext.nextImageIndex++;
  const logBaseName = imageSaveContext.logContext.fileName.replace(/\.log$/i, '');
  const imageFileName = `${logBaseName}${
    imageIndex === 1 ? '' : `-${String(imageIndex).padStart(3, '0')}`
  }.${getImageFileExtension(parsedDataUrl.mimeType)}`;
  const imageFilePath = path.join(LOG_DIR, imageFileName);

  try {
    ensureLogDir();
    fs.writeFileSync(imageFilePath, imageBuffer);
  } catch (error) {
    return {
      saved: false,
      text: `Generated image returned, but failed to save it: ${error.message}`,
    };
  }

  const absolutePath = path.resolve(imageFilePath).replace(/\\/g, '/');
  const savedImage = {
    saved: true,
    filePath: imageFilePath,
    relativePath: absolutePath,
    text: `Generated image saved to ${formatMarkdownFileLink(absolutePath)}`,
  };

  if (imageSaveContext.savedImageByHash) {
    imageSaveContext.savedImageByHash.set(imageHash, savedImage);
  }

  console.log(
    `[${new Date().toISOString()}] saved generated image to ${absolutePath} (log: ${
      imageSaveContext.logContext.fileName
    })`
  );

  return savedImage;
}

function formatGeneratedImageSaveMessage(image, imageSaveContext) {
  const savedImage = saveGeneratedImage(image, imageSaveContext);

  if (!savedImage) {
    return null;
  }

  return savedImage.text;
}

function captureImagesFromContainer(container, imageSaveContext) {
  if (!container || typeof container !== 'object' || !Array.isArray(container.images)) {
    return false;
  }

  let captured = false;

  for (const image of container.images) {
    const imageSaveMessage = formatGeneratedImageSaveMessage(image, imageSaveContext);

    if (imageSaveMessage) {
      recordCompletionMessage(imageSaveContext, imageSaveMessage);
      captured = true;
    }
  }

  return captured || container.images.length > 0;
}

function removeRoleFromImageOnlyContainer(container) {
  if (!container || container.role !== 'assistant') {
    return;
  }

  const keys = Object.keys(container);

  if (keys.length === 1 && keys[0] === 'role') {
    delete container.role;
  }
}

function sanitizeImageContainer(container, imageSaveContext) {
  if (!container || typeof container !== 'object' || !Array.isArray(container.images)) {
    return false;
  }

  captureImagesFromContainer(container, imageSaveContext);
  delete container.images;
  removeRoleFromImageOnlyContainer(container);

  return true;
}

function containerHasToolCalls(container) {
  return Boolean(
    container && typeof container === 'object' && Array.isArray(container.tool_calls) && container.tool_calls.length > 0
  );
}

function rememberPayloadToolCalls(payload, imageSaveContext) {
  if (!imageSaveContext || !payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) {
    return;
  }

  for (const choice of payload.choices) {
    if (!choice || typeof choice !== 'object') {
      continue;
    }

    if (containerHasToolCalls(choice.delta) || containerHasToolCalls(choice.message)) {
      imageSaveContext.sawToolCalls = true;
      return;
    }
  }
}

function sanitizeChatCompletionPayload(payload, imageSaveContext) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) {
    return false;
  }

  rememberPayloadToolCalls(payload, imageSaveContext);

  let changed = false;

  changed = sanitizeImageContainer(payload, imageSaveContext) || changed;

  for (const choice of payload.choices) {
    if (!choice || typeof choice !== 'object') {
      continue;
    }

    changed = sanitizeImageContainer(choice.delta, imageSaveContext) || changed;
    changed = sanitizeImageContainer(choice.message, imageSaveContext) || changed;
  }

  return changed;
}

function captureImagesFromChatCompletionPayload(payload, imageSaveContext) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  let captured = captureImagesFromContainer(payload, imageSaveContext);

  if (!Array.isArray(payload.choices)) {
    return captured;
  }

  for (const choice of payload.choices) {
    if (!choice || typeof choice !== 'object') {
      continue;
    }

    captured = captureImagesFromContainer(choice.delta, imageSaveContext) || captured;
    captured = captureImagesFromContainer(choice.message, imageSaveContext) || captured;
  }

  return captured;
}

function choiceHasStopFinishReason(choice) {
  return Boolean(choice && (choice.finish_reason === 'stop' || choice.native_finish_reason === 'stop'));
}

function payloadHasStopFinishReason(payload) {
  return Boolean(payload && Array.isArray(payload.choices) && payload.choices.some(choiceHasStopFinishReason));
}

function shouldEmitAttemptCompletionToolCall(payload, imageSaveContext) {
  return Boolean(
    imageSaveContext &&
      !imageSaveContext.sawToolCalls &&
      !imageSaveContext.completionToolCallEmitted &&
      Array.isArray(imageSaveContext.completionMessages) &&
      imageSaveContext.completionMessages.length > 0 &&
      payloadHasStopFinishReason(payload)
  );
}

function shouldEmitAttemptCompletionToolCallOnDone(imageSaveContext) {
  return Boolean(
    imageSaveContext &&
      !imageSaveContext.sawToolCalls &&
      !imageSaveContext.completionToolCallEmitted &&
      Array.isArray(imageSaveContext.completionMessages) &&
      imageSaveContext.completionMessages.length > 0
  );
}

function buildSyntheticStopPayload(imageSaveContext) {
  const baseName =
    imageSaveContext && imageSaveContext.logContext
      ? imageSaveContext.logContext.fileName.replace(/\.log$/i, '')
      : `completion-${Date.now()}`;

  return {
    id: `proxy_${safeFilePart(baseName, 'completion')}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'ai-proxy',
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
        native_finish_reason: 'stop',
      },
    ],
  };
}

function withoutUsage(payload) {
  const nextPayload = { ...payload };
  delete nextPayload.usage;
  return nextPayload;
}

function mapChoicesForSsePayload(payload, mapper, keepUsage) {
  const nextPayload = keepUsage ? { ...payload } : withoutUsage(payload);
  nextPayload.choices = payload.choices.map((choice, index) => mapper(choice || {}, index));
  return nextPayload;
}

function buildAttemptCompletionSsePayloads(finishPayload, imageSaveContext) {
  const toolCallId = getAttemptCompletionToolCallId(imageSaveContext);
  const argumentsText = getAttemptCompletionArgumentsText(imageSaveContext);

  imageSaveContext.completionToolCallEmitted = true;

  const startPayload = mapChoicesForSsePayload(
    finishPayload,
    (choice, index) => ({
      ...choice,
      delta:
        index === 0
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: toolCallId,
                  type: 'function',
                  function: {
                    name: 'attempt_completion',
                    arguments: '',
                  },
                },
              ],
            }
          : {},
      finish_reason: null,
      native_finish_reason: null,
    }),
    false
  );

  const argumentsPayload = mapChoicesForSsePayload(
    finishPayload,
    (choice, index) => ({
      ...choice,
      delta:
        index === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: argumentsText,
                  },
                },
              ],
            }
          : {},
      finish_reason: null,
      native_finish_reason: null,
    }),
    false
  );

  const finalPayload = mapChoicesForSsePayload(
    finishPayload,
    (choice) => ({
      ...choice,
      delta: {},
      finish_reason: 'tool_calls',
      native_finish_reason: 'tool_calls',
    }),
    true
  );

  return [startPayload, argumentsPayload, finalPayload];
}

function convertJsonPayloadToAttemptCompletionToolCall(payload, imageSaveContext) {
  const toolCallId = getAttemptCompletionToolCallId(imageSaveContext);
  const argumentsText = getAttemptCompletionArgumentsText(imageSaveContext);
  const nextPayload = { ...payload };

  imageSaveContext.completionToolCallEmitted = true;
  nextPayload.choices = payload.choices.map((choice, index) => {
    if (index !== 0) {
      return choice;
    }

    const nextChoice = {
      ...choice,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: {
              name: 'attempt_completion',
              arguments: argumentsText,
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
      native_finish_reason: 'tool_calls',
    };

    delete nextChoice.delta;
    return nextChoice;
  });

  return nextPayload;
}

function isDroppableSsePayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) {
    return false;
  }

  return payload.choices.every((choice) => {
    if (!choice || choice.finish_reason || choice.native_finish_reason) {
      return false;
    }

    const deltaKeys = choice.delta && typeof choice.delta === 'object' ? Object.keys(choice.delta) : [];
    const messageKeys = choice.message && typeof choice.message === 'object' ? Object.keys(choice.message) : [];

    return deltaKeys.length === 0 && messageKeys.length === 0;
  });
}

function escapeRawNewlinesInJsonStrings(jsonText) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const char of jsonText) {
    if (!inString) {
      output += char;

      if (char === '"') {
        inString = true;
      }

      continue;
    }

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      output += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }

    if (char === '\n') {
      output += '\\n';
      continue;
    }

    if (char === '\r') {
      output += '\\r';
      continue;
    }

    output += char;
  }

  return output;
}

function parseChatCompletionJsonText(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    const escapedJsonText = escapeRawNewlinesInJsonStrings(jsonText);

    if (escapedJsonText === jsonText) {
      return null;
    }

    try {
      return JSON.parse(escapedJsonText);
    } catch (escapedError) {
      return null;
    }
  }
}

function sanitizeChatCompletionJsonText(jsonText, imageSaveContext) {
  const payload = parseChatCompletionJsonText(jsonText);

  if (!payload) {
    return jsonText;
  }

  const changed = sanitizeChatCompletionPayload(payload, imageSaveContext);

  if (shouldEmitAttemptCompletionToolCall(payload, imageSaveContext)) {
    return JSON.stringify(convertJsonPayloadToAttemptCompletionToolCall(payload, imageSaveContext));
  }

  return changed ? JSON.stringify(payload) : jsonText;
}

function captureGeneratedImagesFromJsonText(jsonText, imageSaveContext) {
  const payload = parseChatCompletionJsonText(jsonText);

  if (!payload) {
    return false;
  }

  return captureImagesFromChatCompletionPayload(payload, imageSaveContext);
}

function captureGeneratedImagesFromSseEvent(eventText, imageSaveContext) {
  const eventData = splitSseEvent(eventText);

  if (!eventData || !eventData.payloadText || eventData.payloadText.trim() === '[DONE]') {
    return false;
  }

  const payload = parseChatCompletionJsonText(eventData.payloadText);

  if (!payload) {
    return false;
  }

  return captureImagesFromChatCompletionPayload(payload, imageSaveContext);
}

function captureGeneratedImagesFromSseText(sseText, imageSaveContext) {
  let pending = String(sseText || '');
  let captured = false;
  let eventDelimiter = findSseEventDelimiter(pending);

  while (eventDelimiter) {
    const eventText = pending.slice(0, eventDelimiter.index);
    captured = captureGeneratedImagesFromSseEvent(eventText, imageSaveContext) || captured;
    pending = pending.slice(eventDelimiter.index + eventDelimiter.delimiter.length);
    eventDelimiter = findSseEventDelimiter(pending);
  }

  if (pending.trim()) {
    captured = captureGeneratedImagesFromSseEvent(pending, imageSaveContext) || captured;
  }

  return captured;
}

function captureGeneratedImagesFromResponseBody(responseBody, headers, imageSaveContext) {
  if (!responseBody || !imageSaveContext) {
    return false;
  }

  const responseBodyForImages = decodeResponseBodyForLog(responseBody, headers).buffer;

  if (shouldSanitizeSseResponse(headers)) {
    return captureGeneratedImagesFromSseText(responseBodyForImages.toString('utf8'), imageSaveContext);
  }

  if (shouldSanitizeJsonResponse(headers)) {
    return captureGeneratedImagesFromJsonText(responseBodyForImages.toString('utf8'), imageSaveContext);
  }

  return false;
}

function splitSseEvent(eventText) {
  const lines = eventText.split(/\r?\n/);
  const firstDataLineIndex = lines.findIndex((line) => line.startsWith('data:'));

  if (firstDataLineIndex === -1) {
    return null;
  }

  const firstDataLine = lines[firstDataLineIndex];
  const firstDataMatch = firstDataLine.match(/^data:(\s*)/);

  if (!firstDataMatch) {
    return null;
  }

  const dataLines = lines.slice(firstDataLineIndex);
  const allDataLines = dataLines.every((line) => line.startsWith('data:'));
  const payloadText = allDataLines
    ? dataLines.map((line) => line.replace(/^data:\s?/, '')).join('\n')
    : `${firstDataLine.slice(firstDataMatch[0].length)}${
        dataLines.length > 1 ? `\n${dataLines.slice(1).join('\n')}` : ''
      }`;

  return {
    dataPrefix: `data:${firstDataMatch[1]}`,
    payloadText,
  };
}

function findSseEventDelimiter(text) {
  const match = /\r?\n\r?\n/.exec(text);

  if (!match) {
    return null;
  }

  return {
    index: match.index,
    delimiter: match[0],
  };
}

function sanitizeSseEvent(eventText, delimiter = '', imageSaveContext) {
  const eventData = splitSseEvent(eventText);

  if (!eventData || !eventData.payloadText) {
    return `${eventText}${delimiter}`;
  }

  if (eventData.payloadText.trim() === '[DONE]') {
    if (shouldEmitAttemptCompletionToolCallOnDone(imageSaveContext)) {
      return [
        ...buildAttemptCompletionSsePayloads(buildSyntheticStopPayload(imageSaveContext), imageSaveContext).map(
          (attemptCompletionPayload) => `${eventData.dataPrefix}${JSON.stringify(attemptCompletionPayload)}${delimiter}`
        ),
        `${eventText}${delimiter}`,
      ].join('');
    }

    return `${eventText}${delimiter}`;
  }

  const payload = parseChatCompletionJsonText(eventData.payloadText);

  if (!payload) {
    return `${eventText}${delimiter}`;
  }

  const changed = sanitizeChatCompletionPayload(payload, imageSaveContext);

  if (shouldEmitAttemptCompletionToolCall(payload, imageSaveContext)) {
    return buildAttemptCompletionSsePayloads(payload, imageSaveContext)
      .map(
        (attemptCompletionPayload) => `${eventData.dataPrefix}${JSON.stringify(attemptCompletionPayload)}${delimiter}`
      )
      .join('');
  }

  if (!changed) {
    return `${eventText}${delimiter}`;
  }

  if (isDroppableSsePayload(payload)) {
    return '';
  }

  return `${eventData.dataPrefix}${JSON.stringify(payload)}${delimiter}`;
}

function createSseResponseSanitizer(imageSaveContext) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return {
    kind: 'sse',
    imageSaveContext,
    write(chunk) {
      pending += decoder.write(chunk);

      let output = '';
      let eventDelimiter = findSseEventDelimiter(pending);

      while (eventDelimiter) {
        const eventText = pending.slice(0, eventDelimiter.index);
        output += sanitizeSseEvent(eventText, eventDelimiter.delimiter, imageSaveContext);
        pending = pending.slice(eventDelimiter.index + eventDelimiter.delimiter.length);
        eventDelimiter = findSseEventDelimiter(pending);
      }

      return output ? Buffer.from(output, 'utf8') : null;
    },
    end() {
      pending += decoder.end();

      if (!pending) {
        return null;
      }

      const output = sanitizeSseEvent(pending, '', imageSaveContext);
      pending = '';

      return output ? Buffer.from(output, 'utf8') : null;
    },
  };
}

function createJsonResponseSanitizer(imageSaveContext) {
  return {
    kind: 'json',
    imageSaveContext,
    end(buffer) {
      const originalText = buffer.toString('utf8');
      const sanitizedText = sanitizeChatCompletionJsonText(originalText, imageSaveContext);

      return sanitizedText === originalText ? buffer : Buffer.from(sanitizedText, 'utf8');
    },
  };
}

function createResponseSanitizer(headers, logContext) {
  if (!isIdentityContentEncoding(headers)) {
    return null;
  }

  const imageSaveContext = createImageSaveContext(logContext);

  if (shouldSanitizeSseResponse(headers)) {
    return createSseResponseSanitizer(imageSaveContext);
  }

  if (shouldSanitizeJsonResponse(headers)) {
    return createJsonResponseSanitizer(imageSaveContext);
  }

  return null;
}

const server = http.createServer((req, res) => {
  const incomingUrl = new URL(req.url || '/', `http://${LISTEN_HOST}:${LISTEN_PORT}`);

  if (incomingUrl.pathname === '/__ai_proxy_status') {
    sendJsonResponse(res, 200, {
      status: 'ok',
      ...runtimeProfileStatusBody(),
      logDir: LOG_DIR,
      port: LISTEN_PORT,
      now: new Date().toISOString(),
    });
    return;
  }

  if (incomingUrl.pathname === '/__ai_proxy_runtime_config') {
    handleRuntimeProfileConfigRequest(req, res);
    return;
  }

  const startedAt = Date.now();
  const runtimeConfig = getRuntimeProfileConfig();
  const logContext = createRequestLogContext(req);
  const targetUrl = buildTargetUrl(req.url, runtimeConfig);
  const requestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    headers: sanitizeHeaders(req.headers, targetUrl, runtimeConfig),
    timeout: TIMEOUT_MS,
    rejectUnauthorized: false,
  };

  console.log(
    `[${logContext.startedAtDate.toISOString()}] ${req.method} ${req.url} -> ${targetUrl.href} (log: ${
      logContext.fileName
    })`
  );

  const proxyReq = https.request(requestOptions, (proxyRes) => {
    const responseChunks = [];
    const responseSanitizer = createResponseSanitizer(proxyRes.headers, logContext);
    const isJsonSanitizer = responseSanitizer && responseSanitizer.kind === 'json';

    if (!isJsonSanitizer) {
      res.writeHead(
        proxyRes.statusCode || 502,
        sanitizeResponseHeadersForTransform(proxyRes.headers, null, Boolean(responseSanitizer))
      );
    }

    proxyRes.on('data', (chunk) => {
      responseChunks.push(chunk);

      if (isJsonSanitizer) {
        return;
      }

      if (responseSanitizer) {
        const sanitizedChunk = responseSanitizer.write(chunk);

        if (sanitizedChunk && sanitizedChunk.length > 0) {
          res.write(sanitizedChunk);
        }

        return;
      }

      res.write(chunk);
    });

    proxyRes.on('end', async () => {
      const responseBody = Buffer.concat(responseChunks);
      const requestBody = Buffer.concat(requestChunks);
      const durationMs = Date.now() - startedAt;
      const imageSaveContext =
        responseSanitizer && responseSanitizer.imageSaveContext
          ? responseSanitizer.imageSaveContext
          : createImageSaveContext(logContext);

      captureGeneratedImagesFromResponseBody(responseBody, proxyRes.headers, imageSaveContext);

      if (isJsonSanitizer) {
        const sanitizedResponseBody = responseSanitizer.end(responseBody);
        res.writeHead(
          proxyRes.statusCode || 502,
          sanitizeResponseHeadersForTransform(proxyRes.headers, sanitizedResponseBody.length, true)
        );
        res.end(sanitizedResponseBody);
      } else {
        if (responseSanitizer) {
          const tailChunk = responseSanitizer.end();

          if (tailChunk && tailChunk.length > 0) {
            res.write(tailChunk);
          }
        }

        res.end();
      }

      await writeRequestLog(
        logContext,
        buildRequestLog({
          req,
          targetUrl,
          requestOptions,
          requestBody,
          logContext,
        })
      );
      await appendRequestLog(
        logContext,
        buildResponseLog({
          req,
          proxyRes,
          responseBody,
          startedAt,
        })
      );

      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.url} <- ${
          proxyRes.statusCode || 502
        } (${durationMs}ms, log: ${logContext.fileName})`
      );
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy(new Error(`Proxy request timed out after ${TIMEOUT_MS}ms`));
  });

  proxyReq.on('error', async (error) => {
    const now = new Date().toISOString();
    console.error(`[${now}] !! ${req.method} ${req.url}: ${error.message}`);

    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }

    const errorBody = JSON.stringify({ error: 'proxy_error', message: error.message });
    const requestBody = Buffer.concat(requestChunks);

    await writeRequestLog(
      logContext,
      buildRequestLog({
        req,
        targetUrl,
        requestOptions,
        requestBody,
        logContext,
      })
    );
    await appendRequestLog(
      logContext,
      buildResponseLog({
        req,
        proxyRes: null,
        responseBody: Buffer.from(errorBody),
        startedAt,
      })
    );

    console.error(`[${now}] PROXY -> CLIENT error response body: ${errorBody} (log: ${logContext.fileName})`);
    res.end(errorBody);
  });

  const requestChunks = [];
  const isJsonRequest = req.headers['content-type'] && req.headers['content-type'].includes('json');

  req.on('data', (chunk) => {
    // {"model":"gpt-5.5","temperature":0,
    if (runtimeConfig.modelReplace && isJsonRequest && chunk.includes('"model"')) {
      let text = chunk.toString('utf8');
      text = text.replace(/"model"\s*:\s*"[^"]+"/, `"model":"${runtimeConfig.model}"`);
      chunk = Buffer.from(text, 'utf8');
    }
    requestChunks.push(chunk);
    proxyReq.write(chunk);
  });

  req.on('end', async () => {
    proxyReq.end();
    await writeRequestLog(
      logContext,
      buildRequestLog({
        req,
        targetUrl,
        requestOptions,
        requestBody: Buffer.concat(requestChunks),
        logContext,
      })
    );
  });

  req.on('error', (error) => {
    const now = new Date().toISOString();
    console.error(`[${now}] CLIENT -> PROXY request stream error: ${error.message}`);
    proxyReq.destroy(error);
  });
});

server.on('clientError', (error, socket) => {
  console.error(`[${new Date().toISOString()}] client error: ${error.message}`);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  initializeLogFileEntries();
  pruneLogFiles();
  const runtimeConfig = getRuntimeProfileConfig();
  console.log(`Proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Forwarding requests to ${runtimeConfig.targetBaseUrl.href}`);
  console.log(`Using model ${runtimeConfig.model}`);
  console.log(`Model replacement ${runtimeConfig.modelReplace ? 'enabled' : 'disabled'}`);
  console.log(`Saving proxy request logs to ${LOG_DIR}`);
});
