import * as vscode from 'vscode';
import { PowerMetricsCollector, Metrics, ErrorCallback } from './powermetrics';

let collector: PowerMetricsCollector | null = null;
let sudoErrorShown = false;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let lastMetrics: Metrics | null = null;
let metricsHistory: MetricsHistoryEntry[] = [];
let panel: vscode.WebviewPanel | null = null;

const HISTORY_DURATION_MS = 20000; // 20 seconds of history

interface MetricsHistoryEntry {
    timestamp: number;
    gpu: number;
    cpu: number;
    eCores: number;
    pCores: number;
    power: number;
    cpuPower: number;
    gpuPower: number;
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Silicon Tracker');

    // Create single configurable status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'asitop.showPanel';
    statusBarItem.text = '$(pulse) --';
    statusBarItem.tooltip = 'Apple Silicon Monitor - Click to open panel';
    context.subscriptions.push(statusBarItem);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('asitop.start', startMonitoring),
        vscode.commands.registerCommand('asitop.stop', stopMonitoring),
        vscode.commands.registerCommand('asitop.showPanel', () => showPanel(context)),
        vscode.commands.registerCommand('asitop.showDetails', showDetails)
    );

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('asitop')) {
                updateStatusBar();
            }
        })
    );

    // Auto-start monitoring
    startMonitoring();
}

async function startMonitoring() {
    if (collector) {
        vscode.window.showInformationMessage('Silicon Tracker is already running');
        return;
    }

    const config = vscode.workspace.getConfiguration('asitop');
    const interval = config.get<number>('refreshInterval', 1000);

    // Check if running on macOS
    if (process.platform !== 'darwin') {
        vscode.window.showErrorMessage('Silicon Tracker only works on macOS');
        return;
    }

    try {
        collector = new PowerMetricsCollector(interval, (msg) => outputChannel.appendLine(msg));
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

        statusBarItem.show();
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
        gpuPower: metrics.cpu.gpuPowerW
    };
    metricsHistory.push(entry);

    // Trim history to keep only last 20 seconds
    const cutoff = now - HISTORY_DURATION_MS;
    metricsHistory = metricsHistory.filter(e => e.timestamp > cutoff);

    updateStatusBar();
    updatePanel();
}

function updateStatusBar() {
    if (!lastMetrics) return;

    const config = vscode.workspace.getConfiguration('asitop');
    const displayMode = config.get<string>('statusBarDisplay', 'gpu');
    const m = lastMetrics;

    let text = '';
    let tooltip = '';
    let isWarning = false;

    switch (displayMode) {
        case 'gpu':
            text = `$(pulse) GPU ${m.gpu.activePercent}%`;
            tooltip = `GPU: ${m.gpu.activePercent}% @ ${m.gpu.freqMHz} MHz`;
            isWarning = m.gpu.activePercent > 80;
            break;
        case 'cpu':
            const avgCpu = Math.round((m.cpu.eClusterActive + m.cpu.pClusterActive) / 2);
            text = `$(cpu) CPU ${avgCpu}%`;
            tooltip = `E-Cores: ${m.cpu.eClusterActive}%\nP-Cores: ${m.cpu.pClusterActive}%`;
            isWarning = avgCpu > 80;
            break;
        case 'power':
            text = `$(zap) ${m.cpu.packagePowerW.toFixed(1)}W`;
            tooltip = `CPU: ${m.cpu.cpuPowerW.toFixed(1)}W | GPU: ${m.cpu.gpuPowerW.toFixed(1)}W`;
            isWarning = m.cpu.packagePowerW > 30;
            break;
        case 'all':
            const avg = Math.round((m.cpu.eClusterActive + m.cpu.pClusterActive) / 2);
            text = `$(pulse) G${m.gpu.activePercent}% $(cpu) C${avg}% $(zap) ${m.cpu.packagePowerW.toFixed(0)}W`;
            tooltip = `GPU: ${m.gpu.activePercent}%\nCPU: ${avg}%\nPower: ${m.cpu.packagePowerW.toFixed(1)}W`;
            isWarning = m.gpu.activePercent > 80 || avg > 80;
            break;
        default:
            text = `$(pulse) GPU ${m.gpu.activePercent}%`;
            tooltip = `GPU: ${m.gpu.activePercent}%`;
    }

    tooltip += '\nClick to open monitor panel';
    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip;
    statusBarItem.backgroundColor = isWarning
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
}

function showPanel(context: vscode.ExtensionContext) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        return;
    }

    panel = vscode.window.createWebviewPanel(
        'asitopMonitor',
        'Apple Silicon Monitor',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getWebviewContent();

    panel.onDidDispose(() => {
        panel = null;
    }, null, context.subscriptions);

    // Send initial data
    updatePanel();
}

function updatePanel() {
    if (!panel || !lastMetrics) return;

    panel.webview.postMessage({
        type: 'update',
        metrics: lastMetrics,
        history: metricsHistory
    });
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Apple Silicon Monitor</title>
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
        h1 {
            font-size: 18px;
            margin-bottom: 16px;
            color: var(--vscode-foreground);
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
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .card {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 16px;
        }
        .card-title {
            font-size: 12px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
        }
        .card-value {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 4px;
        }
        .card-subtitle {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .gpu-value { color: #42a5f5; }
        .cpu-value { color: #66bb6a; }
        .power-value { color: #ffa726; }
        .chart-container {
            background: var(--vscode-sideBar-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
        }
        .chart-title {
            font-size: 14px;
            margin-bottom: 12px;
            color: var(--vscode-foreground);
        }
        .chart {
            height: 150px;
            position: relative;
            overflow: hidden;
        }
        canvas {
            width: 100%;
            height: 100%;
        }
        .legend {
            display: flex;
            gap: 16px;
            margin-top: 8px;
            font-size: 12px;
        }
        .legend-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .legend-color {
            width: 12px;
            height: 3px;
            border-radius: 2px;
        }
        .thermal {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
            font-size: 12px;
        }
        .thermal-label {
            color: var(--vscode-descriptionForeground);
        }
        .thermal-value {
            padding: 2px 8px;
            border-radius: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .thermal-nominal { background: #2e7d32; }
        .thermal-fair { background: #f57c00; }
        .thermal-serious { background: #d32f2f; }
    </style>
</head>
<body>
    <h1><span class="status-dot"></span> Apple Silicon Monitor</h1>

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
            <div class="card-title">Power</div>
            <div class="card-value power-value" id="power-value">--W</div>
            <div class="card-subtitle" id="power-detail">CPU: -- | GPU: --</div>
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-title">Usage History (20s)</div>
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
        </div>
    </div>

    <div class="chart-container">
        <div class="chart-title">Power History (20s)</div>
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

    <div class="thermal">
        <span class="thermal-label">Thermal Pressure:</span>
        <span class="thermal-value" id="thermal">--</span>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        const usageCanvas = document.getElementById('usageChart');
        const powerCanvas = document.getElementById('powerChart');
        const usageCtx = usageCanvas.getContext('2d');
        const powerCtx = powerCanvas.getContext('2d');

        let history = [];

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

        function drawChart(ctx, canvas, data, maxValue, colors) {
            const rect = canvas.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            const padding = { top: 10, right: 10, bottom: 20, left: 40 };
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
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'right';
                const label = Math.round(maxValue * (4 - i) / 4);
                ctx.fillText(label.toString(), padding.left - 5, y + 3);
            }

            if (data.length < 2) return;

            const now = Date.now();
            const timeRange = 20000; // 20 seconds

            colors.forEach((color, seriesIdx) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.beginPath();

                let started = false;
                data.forEach((point, i) => {
                    const x = padding.left + ((point.t - (now - timeRange)) / timeRange) * chartWidth;
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

        function updateUI(metrics, hist) {
            history = hist;

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

            // Prepare chart data
            const usageData = history.map(h => ({
                t: h.timestamp,
                v: [h.gpu, h.cpu]
            }));

            const powerData = history.map(h => ({
                t: h.timestamp,
                v: [h.power, h.cpuPower, h.gpuPower]
            }));

            // Find max power for scaling
            const maxPower = Math.max(30, ...history.map(h => h.power));

            drawChart(usageCtx, usageCanvas, usageData, 100, ['#42a5f5', '#66bb6a']);
            drawChart(powerCtx, powerCanvas, powerData, maxPower, ['#ffa726', '#ef5350', '#ab47bc']);
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'update') {
                updateUI(message.metrics, message.history);
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
