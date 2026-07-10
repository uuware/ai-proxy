const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

const CONFIG_KEY = 'aiProxy.config.v1';
const CONTROL_VIEW_ID = 'aiProxy.controlView';
const DEFAULT_PROFILE_ID = 'profile-aixoras';
const RECENT_FILE_EXTENSIONS = new Set([
  '.log',
  '.png',
  '.jpg',
  '.jpeg',
]);

const DEFAULT_CONFIG = Object.freeze({
  profiles: [
    {
      id: DEFAULT_PROFILE_ID,
      name: 'aixoras',
      targetBase: 'https://api.aixoras.com/v1',
      apiKey: '',
      model: 'gpt-5.5',
      modelReplace: false,
    },
  ],
  activeProfileId: DEFAULT_PROFILE_ID,
  bindHost: '127.0.0.1',
  port: 8899,
  logMaxCount: 10,
  useAutoProjectRoot: true,
  customProjectRoot: '',
  selectedWorkspaceFolder: '',
});

let activeController;

function activate(context) {
  activeController = new AiProxyController(context);

  context.subscriptions.push(activeController);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CONTROL_VIEW_ID, new AiProxyWebviewProvider(activeController))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiProxy.openControl', () => activeController.focusControlView())
  );
  context.subscriptions.push(vscode.commands.registerCommand('aiProxy.start', () => activeController.startServer()));
  context.subscriptions.push(vscode.commands.registerCommand('aiProxy.stop', () => activeController.stopServer()));
  context.subscriptions.push(
    vscode.commands.registerCommand('aiProxy.restart', () => activeController.restartServer())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiProxy.openLogs', () => activeController.openLogDirectory())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiProxy.openLatestLog', () => activeController.openLatestLog())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiProxy.copyLocalUrl', () => activeController.copyLocalUrl())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('aiProxy.showOutput', () => activeController.showOutput())
  );
}

function deactivate() {
  if (activeController) {
    activeController.dispose();
  }
}

class AiProxyWebviewProvider {
  constructor(controller) {
    this.controller = controller;
  }

  resolveWebviewView(webviewView) {
    this.controller.attachView(webviewView);
  }
}

class AiProxyController {
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('AI Proxy');
    this.views = new Set();
    this.child = null;
    this.childExitListener = null;
    this.status = 'stopped';
    this.startedAt = '';
    this.lastMessage = 'Server is stopped.';
    this.stopping = false;
    this.disposed = false;
    this.logWatcher = null;
    this.watchedLogDir = '';
    this.logRefreshTimer = null;
    this.config = this.loadConfig();
    this.controlToken = '';

    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) {
          this.config = this.loadConfig();
          this.postState();
        }
      })
    );
  }

  dispose() {
    this.disposed = true;
    this.views.clear();
    this.disposeLogWatcher();

    if (this.logRefreshTimer) {
      clearTimeout(this.logRefreshTimer);
      this.logRefreshTimer = null;
    }

    this.output.dispose();

    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch (error) {
        // Ignore shutdown errors during extension deactivation.
      }
    }
  }

  attachView(webviewView) {
    webviewView.webview.options = {
      enableScripts: true,
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message));
    webviewView.onDidDispose(() => this.views.delete(webviewView));
    this.views.add(webviewView);
    this.watchLogDirectory();
    this.postState();
  }

  async focusControlView() {
    try {
      await vscode.commands.executeCommand(`${CONTROL_VIEW_ID}.focus`);
    } catch (error) {
      // Ignore if focus fails
    }
  }

  loadConfig() {
    const saved = this.context.globalState.get(CONFIG_KEY);
    return normalizeConfig(saved || DEFAULT_CONFIG);
  }

  async saveConfig() {
    this.config = normalizeConfig(this.config);
    await this.context.globalState.update(CONFIG_KEY, this.config);
    this.watchLogDirectory();
    this.postState();
  }

  getWorkspaceFolders() {
    return (vscode.workspace.workspaceFolders || []).map((folder, index) => ({
      index,
      name: folder.name,
      fsPath: folder.uri.fsPath,
    }));
  }

  getAutoProjectRoot() {
    const folders = this.getWorkspaceFolders();

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
      if (folder) {
        return folder.uri.fsPath;
      }
    }

    if (folders.length > 0) {
      return folders[0].fsPath;
    }

    return this.context.extensionPath;
  }

  getProjectRoot() {
    if (!this.config.useAutoProjectRoot && this.config.customProjectRoot) {
      return this.config.customProjectRoot;
    }

    return this.getAutoProjectRoot();
  }

  getLogDir() {
    return path.join(this.getProjectRoot(), '.ai-proxy-logs');
  }

  disposeLogWatcher() {
    if (this.logWatcher) {
      this.logWatcher.close();
      this.logWatcher = null;
    }

    this.watchedLogDir = '';
  }

  watchLogDirectory(logDir = this.getLogDir()) {
    const resolvedLogDir = path.resolve(logDir);

    if (this.logWatcher && this.watchedLogDir === resolvedLogDir) {
      return;
    }

    this.disposeLogWatcher();

    if (!fs.existsSync(resolvedLogDir)) {
      return;
    }

    try {
      this.logWatcher = fs.watch(resolvedLogDir, () => this.scheduleLogRefresh());
      this.watchedLogDir = resolvedLogDir;
    } catch (error) {
      this.output.appendLine(`[${new Date().toISOString()}] Failed to watch log directory: ${error.message}`);
    }
  }

  scheduleLogRefresh() {
    if (this.disposed) {
      return;
    }

    if (this.logRefreshTimer) {
      clearTimeout(this.logRefreshTimer);
    }

    this.logRefreshTimer = setTimeout(() => {
      this.logRefreshTimer = null;

      if (!this.disposed) {
        this.postState();
      }
    }, 250);
  }

  getServerPath() {
    return path.join(this.context.extensionPath, 'server', 'ai-proxy.js');
  }

  getActiveProfile() {
    const active = this.config.profiles.find((profile) => profile.id === this.config.activeProfileId);
    return active || this.config.profiles[0];
  }

  getNetworkAddresses() {
    const addresses = [];
    const seen = new Set();

    for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
      for (const entry of entries || []) {
        const isIpv4 = entry.family === 4 || entry.family === 'IPv4';

        if (!isIpv4 || entry.internal || !entry.address) {
          continue;
        }

        const address = String(entry.address);

        if (seen.has(address)) {
          continue;
        }

        seen.add(address);
        addresses.push({ interfaceName, family: 'IPv4', address });
      }
    }

    return addresses.sort(
      (left, right) => left.interfaceName.localeCompare(right.interfaceName) || left.address.localeCompare(right.address)
    );
  }

  getLocalUrl() {
    return `http://${this.config.bindHost}:${this.config.port}`;
  }

  getHealthCheckUrl() {
    return `http://127.0.0.1:${this.config.port}`;
  }

  getControlUrl(pathname) {
    return `${this.getHealthCheckUrl()}${pathname}`;
  }

  getRuntimeProfilePayload(profile = this.getActiveProfile()) {
    return {
      targetBase: profile ? profile.targetBase : '',
      apiKey: profile ? profile.apiKey || '' : '',
      model: profile ? profile.model || '' : '',
      modelReplace: Boolean(profile && profile.modelReplace),
    };
  }

  isRunning() {
    return Boolean(this.child && !this.child.killed && (this.status === 'starting' || this.status === 'running'));
  }

  validateRuntimeConfig() {
    this.config = normalizeConfig(this.config);
    const profile = this.getActiveProfile();

    if (!profile) {
      throw new Error('Create at least one proxy profile before starting the server.');
    }

    if (!profile.apiKey.trim()) {
      throw new Error('API key is required for the active proxy profile.');
    }

    try {
      new URL(profile.targetBase);
    } catch (error) {
      throw new Error(`Invalid target base URL: ${profile.targetBase}`);
    }

    if (!['127.0.0.1', '0.0.0.0'].includes(this.config.bindHost)) {
      throw new Error('Bind host must be 127.0.0.1 or 0.0.0.0.');
    }

    if (!Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65535) {
      throw new Error('Port must be an integer between 1 and 65535.');
    }

    if (!Number.isInteger(this.config.logMaxCount) || this.config.logMaxCount < 0) {
      throw new Error('Max log count must be 0 or a positive integer.');
    }
  }

  async startServer() {
    if (this.isRunning()) {
      vscode.window.showInformationMessage('AI Proxy server is already running.');
      return;
    }

    try {
      this.validateRuntimeConfig();
    } catch (error) {
      vscode.window.showErrorMessage(error.message);
      this.lastMessage = error.message;
      this.postState();
      return;
    }

    await this.saveConfig();

    const profile = this.getActiveProfile();
    const projectRoot = this.getProjectRoot();
    const logDir = this.getLogDir();
    const serverPath = this.getServerPath();

    try {
      await fs.promises.mkdir(logDir, { recursive: true });
      this.watchLogDirectory(logDir);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create log directory: ${error.message}`);
      return;
    }

    this.status = 'starting';
    this.startedAt = new Date().toISOString();
    this.lastMessage = `Starting server on ${this.getLocalUrl()} ...`;
    this.stopping = false;
    this.postState();

    const controlToken = crypto.randomBytes(32).toString('hex');
    this.controlToken = controlToken;

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AI_PROXY_TARGET_BASE: profile.targetBase,
      AI_PROXY_KEY: profile.apiKey || '',
      AI_PROXY_MODEL: profile.model || '',
      AI_PROXY_MODEL_REPLACE: profile.modelReplace ? '1' : '0',
      AI_PROXY_CONTROL_TOKEN: controlToken,
      AI_PROXY_HOST: this.config.bindHost,
      AI_PROXY_PORT: String(this.config.port),
      AI_PROXY_LOG_DIR: logDir,
      AI_PROXY_LOG_MAX_COUNT: String(this.config.logMaxCount),
    };

    this.output.appendLine(`[${new Date().toISOString()}] Starting AI Proxy`);
    this.output.appendLine(`Project root: ${projectRoot}`);
    this.output.appendLine(`Server script: ${serverPath}`);
    this.output.appendLine(`Bind URL: ${this.getLocalUrl()}`);
    this.output.appendLine(`Bind host: ${this.config.bindHost}`);
    this.output.appendLine(`Target base: ${profile.targetBase}`);
    this.output.appendLine(`Model: ${profile.model}`);
    this.output.appendLine(`Model replacement: ${profile.modelReplace ? 'enabled' : 'disabled'}`);
    this.output.appendLine(`Log directory: ${logDir}`);

    const child = cp.spawn(process.execPath, [serverPath], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child = child;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.output.append(text);

      if (text.includes('Proxy listening on')) {
        this.status = 'running';
        this.lastMessage = `Server is running at ${this.getLocalUrl()}.`;
        this.postState();
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.output.append(text);
      this.lastMessage = text.trim().split(/\r?\n/).pop() || this.lastMessage;
      this.postState();
    });

    child.once('error', (error) => {
      this.status = 'stopped';
      this.child = null;
      this.controlToken = '';
      this.lastMessage = `Failed to start server: ${error.message}`;
      this.output.appendLine(`[${new Date().toISOString()}] ${this.lastMessage}`);
      vscode.window.showErrorMessage(this.lastMessage);
      this.postState();
    });

    child.once('exit', (code, signal) => {
      const wasStopping = this.stopping || this.disposed;
      this.child = null;
      this.controlToken = '';
      this.stopping = false;
      this.status = 'stopped';
      this.startedAt = '';
      this.lastMessage = wasStopping
        ? 'Server stopped.'
        : `Server exited unexpectedly (code ${code === null ? 'null' : code}, signal ${signal || 'none'}).`;
      this.output.appendLine(`[${new Date().toISOString()}] ${this.lastMessage}`);

      if (!wasStopping && !this.disposed) {
        vscode.window.showWarningMessage(this.lastMessage);
      }

      this.postState();
    });

    setTimeout(() => {
      if (this.child === child && this.status === 'starting') {
        this.status = 'running';
        this.lastMessage = `Server process started at ${this.getLocalUrl()}.`;
        this.postState();
      }
    }, 1200);
  }

  async applyRuntimeProfileConfig() {
    if (!this.isRunning()) {
      return false;
    }

    if (!this.controlToken) {
      throw new Error('Running proxy control token is missing.');
    }

    const profile = this.getActiveProfile();
    const result = await httpPostJson(
      this.getControlUrl('/__ai_proxy_runtime_config'),
      this.getRuntimeProfilePayload(profile),
      {
        'x-ai-proxy-control-token': this.controlToken,
      },
      2500
    );

    if (result.statusCode < 200 || result.statusCode >= 300) {
      const message = result.body && result.body.message ? result.body.message : `HTTP ${result.statusCode}`;
      throw new Error(`Failed to update running proxy profile: ${message}`);
    }

    this.output.appendLine(
      `[${new Date().toISOString()}] Runtime profile updated: ${profile.name} -> ${profile.targetBase}`
    );
    return true;
  }

  async saveConfigFromWebview(nextConfig, message = 'Settings saved.') {
    const previousConfig = this.config;
    this.config = normalizeConfig(nextConfig || this.config);
    const shouldApplyRuntime = this.isRunning();

    try {
      if (shouldApplyRuntime) {
        this.validateRuntimeConfig();
      }

      await this.saveConfig();

      if (shouldApplyRuntime) {
        await this.applyRuntimeProfileConfig();
      }
    } catch (error) {
      this.config = previousConfig;

      try {
        await this.saveConfig();
      } catch (rollbackError) {
        this.output.appendLine(`[${new Date().toISOString()}] Failed to roll back profile config: ${rollbackError.message}`);
      }

      throw error;
    }

    this.lastMessage = shouldApplyRuntime
      ? `${message} Running proxy profile updated for next requests.`
      : message;
    this.postState();
  }

  async stopServer() {
    if (!this.child) {
      this.status = 'stopped';
      this.lastMessage = 'Server is already stopped.';
      this.postState();
      return;
    }

    const child = this.child;
    this.stopping = true;
    this.status = 'stopping';
    this.lastMessage = 'Stopping server ...';
    this.postState();

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.child === child) {
          try {
            child.kill('SIGKILL');
          } catch (error) {
            // Ignore kill errors; exit handler will update state when possible.
          }
        }
        resolve();
      }, 5000);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch (error) {
        clearTimeout(timeout);
        resolve();
      }
    });

    if (this.child === child) {
      this.child = null;
      this.controlToken = '';
      this.stopping = false;
      this.status = 'stopped';
      this.startedAt = '';
      this.lastMessage = 'Server stopped.';
      this.postState();
    }
  }

  async restartServer() {
    await this.stopServer();
    await this.startServer();
  }

  async openLogDirectory() {
    const logDir = this.getLogDir();
    await fs.promises.mkdir(logDir, { recursive: true });
    this.watchLogDirectory(logDir);

    try {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logDir));
    } catch (error) {
      await vscode.env.openExternal(vscode.Uri.file(logDir));
    }
  }

  async openLatestLog() {
    const latest = await this.findLatestLogFile();

    if (!latest) {
      vscode.window.showInformationMessage('No AI Proxy log files found yet.');
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(latest.filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async copyLocalUrl(url = this.getLocalUrl()) {
    const value = typeof url === 'string' && url.trim() ? url.trim() : this.getLocalUrl();
    await vscode.env.clipboard.writeText(value);
    vscode.window.showInformationMessage(`Copied ${value} to clipboard.`);
  }

  async chooseProjectRoot() {
    const defaultRoot = this.config.customProjectRoot || this.getProjectRoot();
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(defaultRoot),
      openLabel: 'Select Project Root',
      title: 'Select AI Proxy Project Root',
    });

    if (!selected || selected.length === 0) {
      this.postState();
      return;
    }

    this.config = normalizeConfig({
      ...this.config,
      useAutoProjectRoot: false,
      customProjectRoot: selected[0].fsPath,
    });
    this.lastMessage = `Project root set to ${this.config.customProjectRoot}.`;
    await this.saveConfig();
  }

  showOutput() {
    this.output.show(true);
  }

  async clearLogs() {
    const confirmed = await vscode.window.showWarningMessage(
      'Delete all files in the current AI Proxy log directory?',
      { modal: true },
      'Delete'
    );

    if (confirmed !== 'Delete') {
      this.postState();
      return;
    }

    const logDir = this.getLogDir();
    let removed = 0;

    try {
      const entries = await fs.promises.readdir(logDir, { withFileTypes: true });
      const results = await Promise.allSettled(
        entries
          .filter((entry) => entry.isFile())
          .map(async (entry) => {
            await fs.promises.unlink(path.join(logDir, entry.name));
            removed += 1;
          })
      );
      const failed = results.filter((result) => result.status === 'rejected');

      if (failed.length > 0) {
        throw failed[0].reason;
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        vscode.window.showErrorMessage(`Failed to clear logs: ${error.message}`);
        this.postState();
        return;
      }
    }

    this.lastMessage = `Removed ${removed} log/image file${removed === 1 ? '' : 's'}.`;
    vscode.window.showInformationMessage(this.lastMessage);
    this.postState();
  }

  async testLocalServer() {
    const url = `${this.getHealthCheckUrl()}/__ai_proxy_status`;

    try {
      const result = await httpGetJson(url, 2500);
      const message = `Server responded: ${result.statusCode} ${result.body && result.body.status ? result.body.status : ''
        }`.trim();
      this.lastMessage = message;
      vscode.window.showInformationMessage(message);
    } catch (error) {
      this.lastMessage = `Local server test failed: ${error.message}`;
      vscode.window.showErrorMessage(this.lastMessage);
    }

    this.postState();
  }

  async findLatestLogFile() {
    const logs = await this.listRecentLogs(1, { logsOnly: true });
    return logs[0] || null;
  }

  async listRecentLogs(limit = 8, options = {}) {
    const logDir = this.getLogDir();
    const logsOnly = Boolean(options.logsOnly);

    try {
      const entries = await fs.promises.readdir(logDir, { withFileTypes: true });
      const logs = [];

      for (const entry of entries) {
        const extension = path.extname(entry.name).toLowerCase();

        if (!entry.isFile() || !RECENT_FILE_EXTENSIONS.has(extension) || (logsOnly && extension !== '.log')) {
          continue;
        }

        const filePath = path.join(logDir, entry.name);
        const stat = await fs.promises.stat(filePath);
        logs.push({
          fileName: entry.name,
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          type: extension === '.log' ? 'log' : 'image',
        });
      }

      return logs.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
    } catch (error) {
      return [];
    }
  }

  async openLogFile(filePath) {
    if (!isPathInsideDirectory(filePath, this.getLogDir())) {
      vscode.window.showErrorMessage('Refused to open a file outside the AI Proxy log directory.');
      return;
    }

    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), { preview: false });
  }

  async handleWebviewMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    try {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          this.postState();
          break;
        case 'saveConfig':
          await this.saveConfigFromWebview(message.config, 'Settings saved.');
          break;
        case 'setActiveProfile':
          await this.saveConfigFromWebview(message.config, 'Active profile changed.');
          break;
        case 'start':
          this.config = normalizeConfig(message.config || this.config);
          await this.startServer();
          break;
        case 'stop':
          await this.stopServer();
          break;
        case 'restart':
          this.config = normalizeConfig(message.config || this.config);
          await this.restartServer();
          break;
        case 'chooseProjectRoot':
          this.config = normalizeConfig(message.config || this.config);
          await this.chooseProjectRoot();
          break;
        case 'openLogs':
          await this.openLogDirectory();
          break;
        case 'openLatestLog':
          await this.openLatestLog();
          break;
        case 'copyLocalUrl':
          await this.copyLocalUrl(message.url);
          break;
        case 'showOutput':
          this.showOutput();
          break;
        case 'clearLogs':
          await this.clearLogs();
          break;
        case 'testLocalServer':
          await this.testLocalServer();
          break;
        case 'openLogFile':
          await this.openLogFile(message.filePath);
          break;
        default:
          break;
      }
    } catch (error) {
      this.lastMessage = error.message;
      vscode.window.showErrorMessage(error.message);
      this.postState();
    }
  }

  async buildState() {
    const activeProfile = this.getActiveProfile();
    return {
      config: this.config,
      runtime: {
        status: this.status,
        isRunning: this.isRunning(),
        startedAt: this.startedAt,
        pid: this.child ? this.child.pid : null,
        localUrl: this.getLocalUrl(),
        networkAddresses: this.getNetworkAddresses(),
        logDir: this.getLogDir(),
        projectRoot: this.getProjectRoot(),
        autoProjectRoot: this.getAutoProjectRoot(),
        activeProfileName: activeProfile ? activeProfile.name : '',
        lastMessage: this.lastMessage,
        workspaceFolders: this.getWorkspaceFolders(),
      },
      recentLogs: await this.listRecentLogs(8),
    };
  }

  async postState() {
    const state = await this.buildState();

    for (const view of this.views) {
      try {
        view.webview.postMessage({ type: 'state', state });
      } catch (error) {
        // Ignore disposed webviews.
      }
    }
  }

  getHtml(webview) {
    const nonce = getNonce();
    const initialState = escapeScriptJson({
      config: this.config,
      runtime: {
        status: this.status,
        isRunning: this.isRunning(),
        startedAt: this.startedAt,
        pid: this.child ? this.child.pid : null,
        localUrl: this.getLocalUrl(),
        networkAddresses: this.getNetworkAddresses(),
        logDir: this.getLogDir(),
        projectRoot: this.getProjectRoot(),
        autoProjectRoot: this.getAutoProjectRoot(),
        activeProfileName: this.getActiveProfile() ? this.getActiveProfile().name : '',
        lastMessage: this.lastMessage,
        workspaceFolders: this.getWorkspaceFolders(),
      },
      recentLogs: [],
    });
    const initialStateJson = escapeScriptString(initialState);

    const templatePath = path.join(this.context.extensionPath, 'src', 'index.html');
    const template = fs.readFileSync(templatePath, 'utf8');
    return renderTemplate(template, { nonce, initialStateJson });
  }
}

function normalizeConfig(input) {
  const source = input && typeof input === 'object' ? input : DEFAULT_CONFIG;
  const rawProfiles =
    Array.isArray(source.profiles) && source.profiles.length > 0 ? source.profiles : DEFAULT_CONFIG.profiles;
  const profiles = rawProfiles.map((profile, index) => normalizeProfile(profile, index));
  let activeProfileId = typeof source.activeProfileId === 'string' ? source.activeProfileId : profiles[0].id;

  if (!profiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = profiles[0].id;
  }

  return {
    profiles,
    activeProfileId,
    bindHost: normalizeBindHost(source.bindHost || source.host),
    port: normalizeInteger(source.port, 8899, 1, 65535),
    logMaxCount: normalizeInteger(source.logMaxCount, 10, 0, Number.MAX_SAFE_INTEGER),
    useAutoProjectRoot: source.useAutoProjectRoot !== false,
    customProjectRoot: typeof source.customProjectRoot === 'string' ? source.customProjectRoot : '',
    selectedWorkspaceFolder: typeof source.selectedWorkspaceFolder === 'string' ? source.selectedWorkspaceFolder : '',
  };
}

function normalizeProfile(profile, index) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const id = typeof source.id === 'string' && source.id.trim() ? source.id : `profile-${index + 1}`;
  return {
    id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `Profile ${index + 1}`,
    targetBase:
      typeof source.targetBase === 'string' && source.targetBase.trim()
        ? source.targetBase.trim()
        : 'https://api.example.com/v1',
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
    model: typeof source.model === 'string' && source.model.trim() ? source.model.trim() : 'gpt-5.5',
    modelReplace: source.modelReplace === true,
  };
}

function normalizeBindHost(value) {
  return value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
}

function isPathInsideDirectory(filePath, directoryPath) {
  if (!filePath || !directoryPath) {
    return false;
  }

  const resolvedFilePath = path.resolve(filePath);
  const resolvedDirectoryPath = path.resolve(directoryPath);
  const relativePath = path.relative(resolvedDirectoryPath, resolvedFilePath);

  return Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function parseJsonResponseBody(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');

  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ statusCode: response.statusCode, body: parseJsonResponseBody(chunks) });
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

function httpPostJson(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const request = http.request(
      url,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(payload)),
          ...(headers || {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, body: parseJsonResponseBody(chunks) });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function renderTemplate(template, values) {
  return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

function escapeScriptString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

module.exports = {
  activate,
  deactivate,
};
