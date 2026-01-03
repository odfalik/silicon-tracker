import * as vscode from 'vscode';
import { PowerMetricsCollector, Metrics, ErrorCallback } from './powermetrics';

let collector: PowerMetricsCollector | null = null;
let sudoErrorShown = false;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let lastMetrics: Metrics | null = null;
let metricsHistory: MetricsHistoryEntry[] = [];
let panel: vscode.WebviewPanel | null = null;
let isPanelVisible = false;

interface MetricsHistoryEntry {
    timestamp: number;
    gpu: number;
    cpu: number;
    eCores: number;
    pCores: number;
    power: number;
    cpuPower: number;
    gpuPower: number;
    memory: number;
    swap: number;
}

function getConfig() {
    const config = vscode.workspace.getConfiguration('siliconTracker');
    return {
        sampleRate: config.get<number>('sampleRate', 1000),
        backgroundSampleRate: config.get<number>('backgroundSampleRate', 2000),
        historyDuration: config.get<number>('historyDuration', 20),
        statusBarDisplay: config.get<string[]>('statusBarDisplay', ['gpu'])
    };
}

function getCurrentSampleRate(): number {
    const config = getConfig();
    return isPanelVisible ? config.sampleRate : config.backgroundSampleRate;
}

function getHistoryDurationMs(): number {
    return getConfig().historyDuration * 1000;
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Silicon Tracker');

    // Create single configurable status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'siliconTracker.showPanel';
    statusBarItem.text = '$(pulse) --';
    statusBarItem.tooltip = 'Silicon Tracker - Click to open panel';
    context.subscriptions.push(statusBarItem);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('siliconTracker.start', startMonitoring),
        vscode.commands.registerCommand('siliconTracker.stop', stopMonitoring),
        vscode.commands.registerCommand('siliconTracker.showPanel', () => showPanel(context)),
        vscode.commands.registerCommand('siliconTracker.showDetails', showDetails)
    );

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('siliconTracker')) {
                updateStatusBar();
                // Restart collector with new sample rate if running
                if (collector) {
                    restartWithNewSampleRate();
                }
            }
        })
    );

    // Auto-start monitoring
    startMonitoring();
}

async function restartWithNewSampleRate() {
    if (!collector) return;

    const newRate = getCurrentSampleRate();
    collector.setSampleRate(newRate);
}

async function startMonitoring() {
    if (collector) {
        vscode.window.showInformationMessage('Silicon Tracker is already running');
        return;
    }

    // Check if running on macOS
    if (process.platform !== 'darwin') {
        vscode.window.showErrorMessage('Silicon Tracker only works on macOS');
        return;
    }

    try {
        const sampleRate = getCurrentSampleRate();
        collector = new PowerMetricsCollector(sampleRate, (msg) => outputChannel.appendLine(msg));
        sudoErrorShown = false;

        outputChannel.appendLine('Starting Silicon Tracker...');
        outputChannel.appendLine('Note: powermetrics requires sudo access.');
        outputChannel.appendLine('');

        const onError: ErrorCallback = (error) => {
            if (error.type === 'sudo' && !sudoErrorShown) {
                sudoErrorShown = true;
                showSudoSetupNotification();
            }
        };

        await collector.start(onMetricsUpdate, onError);

        updateStatusBarVisibility();
        vscode.window.showInformationMessage('Silicon Tracker started');

    } catch (err) {
        vscode.window.showErrorMessage(`Failed to start monitoring: ${err}`);
        collector = null;
    }
}

function stopMonitoring() {
    if (!collector) {
        vscode.window.showInformationMessage('Silicon Tracker is not running');
        return;
    }

    collector.stop();
    collector = null;
    metricsHistory = [];

    statusBarItem.hide();

    vscode.window.showInformationMessage('Silicon Tracker stopped');
}

async function showSudoSetupNotification() {
    const setupGuide = 'Show Setup Guide';
    const copyCommand = 'Copy sudoers Line';

    const result = await vscode.window.showWarningMessage(
        'Silicon Tracker requires sudo access to run powermetrics. Would you like help setting this up?',
        setupGuide,
        copyCommand
    );

    if (result === setupGuide) {
        outputChannel.clear();
        outputChannel.appendLine('='.repeat(60));
        outputChannel.appendLine('Silicon Tracker - Sudo Setup Guide');
        outputChannel.appendLine('='.repeat(60));
        outputChannel.appendLine('');
        outputChannel.appendLine('powermetrics requires root access to read CPU/GPU metrics.');
        outputChannel.appendLine('');
        outputChannel.appendLine('Option 1: Enable passwordless sudo for powermetrics (recommended)');
        outputChannel.appendLine('-'.repeat(60));
        outputChannel.appendLine('');
        outputChannel.appendLine('1. Open Terminal');
        outputChannel.appendLine('2. Run: sudo visudo');
        outputChannel.appendLine('3. Add this line at the end:');
        outputChannel.appendLine('');
        outputChannel.appendLine('   %admin ALL=(ALL) NOPASSWD: /usr/bin/powermetrics');
        outputChannel.appendLine('');
        outputChannel.appendLine('4. Save and exit (Ctrl+X, then Y, then Enter)');
        outputChannel.appendLine('5. Restart VS Code');
        outputChannel.appendLine('');
        outputChannel.appendLine('Option 2: Run VS Code with elevated privileges');
        outputChannel.appendLine('-'.repeat(60));
        outputChannel.appendLine('');
        outputChannel.appendLine('Run from terminal: sudo code .');
        outputChannel.appendLine('(Not recommended for regular use)');
        outputChannel.appendLine('');
        outputChannel.appendLine('='.repeat(60));
        outputChannel.show();
    } else if (result === copyCommand) {
        await vscode.env.clipboard.writeText('%admin ALL=(ALL) NOPASSWD: /usr/bin/powermetrics');
        vscode.window.showInformationMessage('Copied to clipboard! Add this line to /etc/sudoers using "sudo visudo"');
    }
}

function onMetricsUpdate(metrics: Metrics) {
    lastMetrics = metrics;
    const now = Date.now();

    // Add to history
    const entry: MetricsHistoryEntry = {
        timestamp: now,
        gpu: metrics.gpu.activePercent,
        cpu: Math.round((metrics.cpu.eClusterActive + metrics.cpu.pClusterActive) / 2),
        eCores: metrics.cpu.eClusterActive,
        pCores: metrics.cpu.pClusterActive,
        power: metrics.cpu.packagePowerW,
        cpuPower: metrics.cpu.cpuPowerW,
        gpuPower: metrics.cpu.gpuPowerW,
        memory: metrics.memory.usedPercent,
        swap: metrics.memory.swapUsedGB
    };
    metricsHistory.push(entry);

    // Trim history based on configured duration
    const cutoff = now - getHistoryDurationMs();
    metricsHistory = metricsHistory.filter(e => e.timestamp > cutoff);

    updateStatusBar();
    updatePanel();
}

function updateStatusBarVisibility() {
    const config = getConfig();
    if (config.statusBarDisplay.length === 0) {
        statusBarItem.hide();
    } else {
        statusBarItem.show();
    }
}

function updateStatusBar() {
    if (!lastMetrics) return;

    const config = getConfig();
    const displayItems = config.statusBarDisplay;
    const m = lastMetrics;

    if (displayItems.length === 0) {
        statusBarItem.hide();
        return;
    }

    const textParts: string[] = [];
    const tooltipParts: string[] = [];
    let isWarning = false;

    for (const item of displayItems) {
        switch (item) {
            case 'gpu':
                textParts.push(`$(pulse) G${m.gpu.activePercent}%`);
                tooltipParts.push(`GPU: ${m.gpu.activePercent}% @ ${m.gpu.freqMHz} MHz`);
                if (m.gpu.activePercent > 80) isWarning = true;
                break;
            case 'cpu':
                const avgCpu = Math.round((m.cpu.eClusterActive + m.cpu.pClusterActive) / 2);
                textParts.push(`$(cpu) C${avgCpu}%`);
                tooltipParts.push(`CPU: ${avgCpu}% (E: ${m.cpu.eClusterActive}% | P: ${m.cpu.pClusterActive}%)`);
                if (avgCpu > 80) isWarning = true;
                break;
            case 'memory':
                textParts.push(`$(database) M${m.memory.usedPercent}%`);
                const swapInfo = m.memory.swapUsedGB > 0.01
                    ? ` | Swap: ${m.memory.swapUsedGB.toFixed(1)}GB`
                    : '';
                tooltipParts.push(`Memory: ${m.memory.usedGB.toFixed(1)}/${m.memory.totalGB.toFixed(0)}GB (${m.memory.usedPercent}%)${swapInfo}`);
                if (m.memory.usedPercent > 85 || m.memory.pressure !== 'nominal') isWarning = true;
                break;
            case 'power':
                textParts.push(`$(zap) ${m.cpu.packagePowerW.toFixed(0)}W`);
                tooltipParts.push(`Power: ${m.cpu.packagePowerW.toFixed(1)}W (CPU: ${m.cpu.cpuPowerW.toFixed(1)}W | GPU: ${m.cpu.gpuPowerW.toFixed(1)}W)`);
                if (m.cpu.packagePowerW > 30) isWarning = true;
                break;
        }
    }

    const text = textParts.join(' ');
    let tooltip = tooltipParts.join('\n');
    tooltip += '\nClick to open monitor panel';

    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip;
    statusBarItem.backgroundColor = isWarning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    statusBarItem.show();
}

function showPanel(context: vscode.ExtensionContext) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'siliconTracker',
        'Silicon Tracker',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getWebviewContent();

    // Handle panel visibility changes
    panel.onDidChangeViewState(e => {
        const wasVisible = isPanelVisible;
        isPanelVisible = e.webviewPanel.visible;

        if (wasVisible !== isPanelVisible && collector) {
            restartWithNewSampleRate();
        }
    }, null, context.subscriptions);

    panel.onDidDispose(() => {
        panel = null;
        isPanelVisible = false;
        if (collector) {
            restartWithNewSampleRate();
        }
    }, null, context.subscriptions);

    // Handle messages from webview
    panel.webview.onDidReceiveMessage(message => {
        if (message.type === 'updateSettings') {
            const config = vscode.workspace.getConfiguration('siliconTracker');
            if (message.sampleRate !== undefined) {
                config.update('sampleRate', message.sampleRate, vscode.ConfigurationTarget.Global);
            }
            if (message.historyDuration !== undefined) {
                config.update('historyDuration', message.historyDuration, vscode.ConfigurationTarget.Global);
            }
            if (message.statusBarDisplay !== undefined) {
                config.update('statusBarDisplay', message.statusBarDisplay, vscode.ConfigurationTarget.Global);
            }
        }
    }, null, context.subscriptions);

    isPanelVisible = true;
    restartWithNewSampleRate();

    // Send initial data
    updatePanel();
}

function updatePanel() {
    if (!panel || !lastMetrics) return;

    const config = getConfig();
    panel.webview.postMessage({
        type: 'update',
        metrics: lastMetrics,
        history: metricsHistory,
        settings: {
            sampleRate: config.sampleRate,
            historyDuration: config.historyDuration,
            statusBarDisplay: config.statusBarDisplay
        }
    });
}

function getWebviewContent(): string {
    const config = getConfig();
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Silicon Tracker</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 16px;
            overflow-x: hidden;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
        }
        .status {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #4caf50;
            animation: pulse 2s infinite;
        }
        .status-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .settings-toggle {
            background: none;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            color: var(--vscode-foreground);
            padding: 4px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .settings-toggle:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .settings-panel {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
            display: none;
        }
        .settings-panel.visible {
            display: block;
        }
        .setting-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        .setting-row:last-child {
            margin-bottom: 0;
        }
        .setting-label {
            font-size: 12px;
        }
        .setting-control {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .setting-control input[type="range"] {
            width: 120px;
            accent-color: var(--vscode-focusBorder);
        }
        .setting-value {
            font-size: 12px;
            min-width: 40px;
            text-align: right;
            color: var(--vscode-descriptionForeground);
        }
        .checkbox-group {
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
        }
        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            cursor: pointer;
        }
        .checkbox-label input[type="checkbox"] {
            accent-color: var(--vscode-focusBorder);
            cursor: pointer;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 12px;
            margin-bottom: 16px;
        }
        .card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 12px;
        }
        .card-title {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .card-value {
            font-size: 28px;
            font-weight: bold;
            margin-bottom: 2px;
        }
        .card-subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .gpu-value { color: #42a5f5; }
        .cpu-value { color: #66bb6a; }
        .memory-value { color: #ce93d8; }
        .power-value { color: #ffa726; }
        .chart-container {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 12px;
        }
        .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .chart-title {
            font-size: 12px;
            color: var(--vscode-foreground);
        }
        .chart {
            height: 120px;
            position: relative;
            overflow: hidden;
        }
        canvas {
            width: 100%;
            height: 100%;
        }
        .legend {
            display: flex;
            gap: 12px;
            margin-top: 6px;
            font-size: 11px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .legend-color {
            width: 10px;
            height: 2px;
            border-radius: 1px;
        }
        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .thermal {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .thermal-value {
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 10px;
        }
        .thermal-nominal { background: #2e7d32; }
        .thermal-fair { background: #f57c00; }
        .thermal-serious { background: #d32f2f; }
    </style>
</head>
<body>
    <div class="header">
        <div class="status">
            <span class="status-dot"></span>
            <span class="status-text">Live</span>
        </div>
        <button class="settings-toggle" onclick="toggleSettings()">
            <span>Settings</span>
        </button>
    </div>

    <div class="settings-panel" id="settings">
        <div class="setting-row">
            <span class="setting-label">Sample Rate</span>
            <div class="setting-control">
                <input type="range" id="sampleRate" min="500" max="5000" step="100" value="${config.sampleRate}"
                    onchange="updateSetting('sampleRate', this.value)">
                <span class="setting-value" id="sampleRateValue">${config.sampleRate}ms</span>
            </div>
        </div>
        <div class="setting-row">
            <span class="setting-label">History Duration</span>
            <div class="setting-control">
                <input type="range" id="historyDuration" min="10" max="120" step="5" value="${config.historyDuration}"
                    onchange="updateSetting('historyDuration', this.value)">
                <span class="setting-value" id="historyDurationValue">${config.historyDuration}s</span>
            </div>
        </div>
        <div class="setting-row">
            <span class="setting-label">Status Bar</span>
            <div class="setting-control checkbox-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="sb-gpu" onchange="updateStatusBar()" ${config.statusBarDisplay.includes('gpu') ? 'checked' : ''}>
                    <span>GPU</span>
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="sb-cpu" onchange="updateStatusBar()" ${config.statusBarDisplay.includes('cpu') ? 'checked' : ''}>
                    <span>CPU</span>
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="sb-memory" onchange="updateStatusBar()" ${config.statusBarDisplay.includes('memory') ? 'checked' : ''}>
                    <span>Mem</span>
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="sb-power" onchange="updateStatusBar()" ${config.statusBarDisplay.includes('power') ? 'checked' : ''}>
                    <span>Power</span>
                </label>
            </div>
        </div>
    </div>

    <div class="grid">
        <div class="card">
            <div class="card-title">GPU Usage</div>
            <div class="card-value gpu-value" id="gpu-value">--%</div>
            <div class="card-subtitle" id="gpu-freq">-- MHz</div>
        </div>
        <div class="card">
            <div class="card-title">CPU Usage</div>
            <div class="card-value cpu-value" id="cpu-value">--%</div>
            <div class="card-subtitle" id="cpu-detail">E: --% | P: --%</div>
        </div>
        <div class="card">
            <div class="card-title">Memory</div>
            <div class="card-value memory-value" id="memory-value">--%</div>
            <div class="card-subtitle" id="memory-detail">--/-- GB</div>
        </div>
        <div class="card">
            <div class="card-title">Power</div>
            <div class="card-value power-value" id="power-value">--W</div>
            <div class="card-subtitle" id="power-detail">CPU: -- | GPU: --</div>
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-header">
            <span class="chart-title">Usage</span>
            <span class="chart-title" id="usage-duration">(${config.historyDuration}s)</span>
        </div>
        <div class="chart">
            <canvas id="usageChart"></canvas>
        </div>
        <div class="legend">
            <div class="legend-item">
                <div class="legend-color" style="background: #42a5f5;"></div>
                <span>GPU</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background: #66bb6a;"></div>
                <span>CPU</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background: #ce93d8;"></div>
                <span>Memory</span>
            </div>
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-header">
            <span class="chart-title">Power</span>
            <span class="chart-title" id="power-duration">(${config.historyDuration}s)</span>
        </div>
        <div class="chart">
            <canvas id="powerChart"></canvas>
        </div>
        <div class="legend">
            <div class="legend-item">
                <div class="legend-color" style="background: #ffa726;"></div>
                <span>Total</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background: #ef5350;"></div>
                <span>CPU</span>
            </div>
            <div class="legend-item">
                <div class="legend-color" style="background: #ab47bc;"></div>
                <span>GPU</span>
            </div>
        </div>
    </div>

    <div class="footer">
        <div class="thermal">
            <span>Thermal:</span>
            <span class="thermal-value" id="thermal">--</span>
        </div>
        <div class="thermal">
            <span>Memory:</span>
            <span class="thermal-value" id="memory-pressure">--</span>
        </div>
        <div class="thermal" id="swap-container" style="display: none;">
            <span>Swap:</span>
            <span class="thermal-value" id="swap-value">--</span>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const usageCanvas = document.getElementById('usageChart');
        const powerCanvas = document.getElementById('powerChart');
        const usageCtx = usageCanvas.getContext('2d');
        const powerCtx = powerCanvas.getContext('2d');

        let history = [];
        let currentSettings = { sampleRate: ${config.sampleRate}, historyDuration: ${config.historyDuration} };

        function toggleSettings() {
            document.getElementById('settings').classList.toggle('visible');
        }

        function updateSetting(key, value) {
            const numValue = parseInt(value);
            currentSettings[key] = numValue;

            if (key === 'sampleRate') {
                document.getElementById('sampleRateValue').textContent = numValue + 'ms';
            } else if (key === 'historyDuration') {
                document.getElementById('historyDurationValue').textContent = numValue + 's';
                document.getElementById('usage-duration').textContent = '(' + numValue + 's)';
                document.getElementById('power-duration').textContent = '(' + numValue + 's)';
            }

            vscode.postMessage({ type: 'updateSettings', [key]: numValue });
        }

        function updateStatusBar() {
            const items = [];
            if (document.getElementById('sb-gpu').checked) items.push('gpu');
            if (document.getElementById('sb-cpu').checked) items.push('cpu');
            if (document.getElementById('sb-memory').checked) items.push('memory');
            if (document.getElementById('sb-power').checked) items.push('power');
            vscode.postMessage({ type: 'updateSettings', statusBarDisplay: items });
        }

        function resizeCanvas() {
            const dpr = window.devicePixelRatio || 1;
            [usageCanvas, powerCanvas].forEach(canvas => {
                const rect = canvas.getBoundingClientRect();
                canvas.width = rect.width * dpr;
                canvas.height = rect.height * dpr;
                canvas.getContext('2d').scale(dpr, dpr);
            });
        }
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

        function drawChart(ctx, canvas, data, maxValue, colors, timeRangeMs) {
            const rect = canvas.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            const padding = { top: 8, right: 8, bottom: 16, left: 32 };
            const chartWidth = width - padding.left - padding.right;
            const chartHeight = height - padding.top - padding.bottom;

            ctx.clearRect(0, 0, width, height);

            // Draw grid
            ctx.strokeStyle = 'rgba(128, 128, 128, 0.2)';
            ctx.lineWidth = 1;
            for (let i = 0; i <= 4; i++) {
                const y = padding.top + (chartHeight * i / 4);
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(width - padding.right, y);
                ctx.stroke();

                ctx.fillStyle = 'rgba(128, 128, 128, 0.6)';
                ctx.font = '9px sans-serif';
                ctx.textAlign = 'right';
                const label = Math.round(maxValue * (4 - i) / 4);
                ctx.fillText(label.toString(), padding.left - 4, y + 3);
            }

            if (data.length < 2) return;

            const now = Date.now();

            colors.forEach((color, seriesIdx) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.beginPath();

                let started = false;
                data.forEach((point, i) => {
                    const x = padding.left + ((point.t - (now - timeRangeMs)) / timeRangeMs) * chartWidth;
                    const values = Array.isArray(point.v) ? point.v : [point.v];
                    const value = values[seriesIdx] || 0;
                    const y = padding.top + chartHeight - (value / maxValue) * chartHeight;

                    if (x >= padding.left) {
                        if (!started) {
                            ctx.moveTo(x, y);
                            started = true;
                        } else {
                            ctx.lineTo(x, y);
                        }
                    }
                });
                ctx.stroke();
            });
        }

        function updateUI(metrics, hist, settings) {
            history = hist;
            if (settings) {
                currentSettings = settings;
                document.getElementById('sampleRate').value = settings.sampleRate;
                document.getElementById('sampleRateValue').textContent = settings.sampleRate + 'ms';
                document.getElementById('historyDuration').value = settings.historyDuration;
                document.getElementById('historyDurationValue').textContent = settings.historyDuration + 's';
                document.getElementById('usage-duration').textContent = '(' + settings.historyDuration + 's)';
                document.getElementById('power-duration').textContent = '(' + settings.historyDuration + 's)';
                // Sync status bar checkboxes
                if (settings.statusBarDisplay) {
                    document.getElementById('sb-gpu').checked = settings.statusBarDisplay.includes('gpu');
                    document.getElementById('sb-cpu').checked = settings.statusBarDisplay.includes('cpu');
                    document.getElementById('sb-memory').checked = settings.statusBarDisplay.includes('memory');
                    document.getElementById('sb-power').checked = settings.statusBarDisplay.includes('power');
                }
            }

            // Update cards
            document.getElementById('gpu-value').textContent = metrics.gpu.activePercent + '%';
            document.getElementById('gpu-freq').textContent = metrics.gpu.freqMHz + ' MHz';

            const avgCpu = Math.round((metrics.cpu.eClusterActive + metrics.cpu.pClusterActive) / 2);
            document.getElementById('cpu-value').textContent = avgCpu + '%';
            document.getElementById('cpu-detail').textContent =
                'E: ' + metrics.cpu.eClusterActive + '% | P: ' + metrics.cpu.pClusterActive + '%';

            document.getElementById('power-value').textContent = metrics.cpu.packagePowerW.toFixed(1) + 'W';
            document.getElementById('power-detail').textContent =
                'CPU: ' + metrics.cpu.cpuPowerW.toFixed(1) + 'W | GPU: ' + metrics.cpu.gpuPowerW.toFixed(1) + 'W';

            // Memory card
            document.getElementById('memory-value').textContent = metrics.memory.usedPercent + '%';
            document.getElementById('memory-detail').textContent =
                metrics.memory.usedGB.toFixed(1) + '/' + metrics.memory.totalGB.toFixed(0) + ' GB';

            // Thermal pressure
            const thermalEl = document.getElementById('thermal');
            thermalEl.textContent = metrics.thermalPressure;
            thermalEl.className = 'thermal-value';
            if (metrics.thermalPressure.toLowerCase().includes('nominal')) {
                thermalEl.classList.add('thermal-nominal');
            } else if (metrics.thermalPressure.toLowerCase().includes('fair')) {
                thermalEl.classList.add('thermal-fair');
            } else if (metrics.thermalPressure.toLowerCase().includes('serious')) {
                thermalEl.classList.add('thermal-serious');
            }

            // Memory pressure
            const memPressureEl = document.getElementById('memory-pressure');
            const memPressure = metrics.memory.pressure;
            memPressureEl.textContent = memPressure.charAt(0).toUpperCase() + memPressure.slice(1);
            memPressureEl.className = 'thermal-value';
            if (memPressure === 'nominal') {
                memPressureEl.classList.add('thermal-nominal');
            } else if (memPressure === 'warn') {
                memPressureEl.classList.add('thermal-fair');
            } else if (memPressure === 'critical') {
                memPressureEl.classList.add('thermal-serious');
            }

            // Swap usage
            const swapContainer = document.getElementById('swap-container');
            const swapEl = document.getElementById('swap-value');
            if (metrics.memory.swapUsedGB > 0.01) {
                swapContainer.style.display = 'flex';
                swapEl.textContent = metrics.memory.swapUsedGB.toFixed(1) + ' GB';
                swapEl.className = 'thermal-value';
                if (metrics.memory.swapUsedGB < 1) {
                    swapEl.classList.add('thermal-nominal');
                } else if (metrics.memory.swapUsedGB < 4) {
                    swapEl.classList.add('thermal-fair');
                } else {
                    swapEl.classList.add('thermal-serious');
                }
            } else {
                swapContainer.style.display = 'none';
            }

            // Prepare chart data
            const timeRangeMs = currentSettings.historyDuration * 1000;

            const usageData = history.map(h => ({
                t: h.timestamp,
                v: [h.gpu, h.cpu, h.memory]
            }));

            const powerData = history.map(h => ({
                t: h.timestamp,
                v: [h.power, h.cpuPower, h.gpuPower]
            }));

            // Find max power for scaling
            const maxPower = Math.max(30, ...history.map(h => h.power));

            drawChart(usageCtx, usageCanvas, usageData, 100, ['#42a5f5', '#66bb6a', '#ce93d8'], timeRangeMs);
            drawChart(powerCtx, powerCanvas, powerData, maxPower, ['#ffa726', '#ef5350', '#ab47bc'], timeRangeMs);
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                updateUI(message.metrics, message.history, message.settings);
            }
        });
    </script>
</body>
</html>`;
}

function showDetails() {
    if (!lastMetrics) {
        vscode.window.showInformationMessage('No metrics available yet. Make sure monitoring is running.');
        return;
    }

    const m = lastMetrics;
    const swapInfo = m.memory.swapUsedGB > 0.01
        ? `  Swap:     ${m.memory.swapUsedGB.toFixed(2)} / ${m.memory.swapTotalGB.toFixed(2)} GB`
        : '  Swap:     Not in use';

    const details = `
Silicon Tracker - Detailed Stats
========================================

GPU
---
  Usage:     ${m.gpu.activePercent}%
  Frequency: ${m.gpu.freqMHz} MHz

CPU (E-Cores)
-------------
  Usage:     ${m.cpu.eClusterActive}%
  Frequency: ${m.cpu.eClusterFreqMHz} MHz

CPU (P-Cores)
-------------
  Usage:     ${m.cpu.pClusterActive}%
  Frequency: ${m.cpu.pClusterFreqMHz} MHz

Memory
------
  Usage:    ${m.memory.usedPercent}%
  Used:     ${m.memory.usedGB.toFixed(2)} / ${m.memory.totalGB.toFixed(2)} GB
  Pressure: ${m.memory.pressure}
${swapInfo}

Power Consumption
-----------------
  Package: ${m.cpu.packagePowerW.toFixed(2)} W
  CPU:     ${m.cpu.cpuPowerW.toFixed(2)} W
  GPU:     ${m.cpu.gpuPowerW.toFixed(2)} W
  ANE:     ${m.cpu.anePowerW.toFixed(2)} W

Thermal Pressure: ${m.thermalPressure}
Last Updated: ${m.timestamp.toLocaleTimeString()}
`;

    outputChannel.clear();
    outputChannel.appendLine(details);
    outputChannel.show();
}

export function deactivate() {
    if (collector) {
        collector.stop();
        collector = null;
    }
}
