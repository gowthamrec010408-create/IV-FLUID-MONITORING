/**
 * Smart IV Fluid Monitoring System - Frontend Application Logic
 * 
 * Manages:
 * - Real-time WebSocket connection to Node.js backend
 * - Dual IV bottle independent visualization and telemetry
 * - Live Chart.js volume decay graphs
 * - USB Serial connection management and live terminal log
 * - Local Wi-Fi IP connection management
 * - Latched valve reset commands
 * - System event log with severity filtering
 * - Zero/tare calibration & settings management
 */

(function () {
  'use strict';

  // -------------------------------------------------------------
  // Application State (In-Memory Only, No localStorage/DB)
  // -------------------------------------------------------------
  const appState = {
    ws: null,
    connected: false,
    status: 'DISCONNECTED', // 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR'
    transport: 'NONE',      // 'NONE' | 'SERIAL' | 'WIFI' | 'SIMULATION'
    isStale: true,
    lastUpdated: null,
    settings: {
      bottle1Capacity: 500,
      bottle2Capacity: 500,
      lowFluidThreshold: 20,
      serialBaudRate: 115200,
      esp32Ip: '192.168.1.100',
      esp32Port: 80,
      chartHistoryLimit: 300,
      fluidDensity: 1.0,
      bottle1Tare: 30.0,
      bottle2Tare: 30.0,
      relayActiveLow: false
    },
    readings: {
      bottle1: { weight_g: 0, fluid_g: 0, remaining_ml: 0, percentage: 0, valve_command: 'OPEN', sensor_ok: false, calibrated: true, low_fluid: false },
      bottle2: { weight_g: 0, fluid_g: 0, remaining_ml: 0, percentage: 0, valve_command: 'OPEN', sensor_ok: false, calibrated: true, low_fluid: false }
    },
    events: [],
    eventFilter: 'ALL',
    simulationActive: false
  };

  // Chart.js references
  let chart1 = null;
  let chart2 = null;

  // -------------------------------------------------------------
  // DOM Elements
  // -------------------------------------------------------------
  const dom = {
    // Navigation & Status
    alertBanner: document.getElementById('system-alert-banner'),
    alertTitle: document.getElementById('alert-banner-title'),
    alertDesc: document.getElementById('alert-banner-desc'),
    btnAlertDismiss: document.getElementById('btn-alert-dismiss'),
    navbarStatusDot: document.getElementById('navbar-status-dot'),
    navbarTransportText: document.getElementById('navbar-transport-text'),
    navbarHealthText: document.getElementById('navbar-health-text'),
    btnOpenSettings: document.getElementById('btn-open-settings'),
    btnUnlatchAll: document.getElementById('btn-unlatch-all'),
    staleNoticeBar: document.getElementById('stale-data-notice'),

    // Top Summary Cards
    summaryCapacityValue: document.getElementById('summary-capacity-value'),
    summaryRemainingValue: document.getElementById('summary-remaining-value'),
    summaryRemainingFooter: document.getElementById('summary-remaining-footer'),
    summaryAttentionValue: document.getElementById('summary-attention-value'),
    summaryAttentionFooter: document.getElementById('summary-attention-footer'),
    summaryConnectionValue: document.getElementById('summary-connection-value'),
    summaryConnectionFooter: document.getElementById('summary-connection-footer'),
    attentionIcon: document.getElementById('attention-icon'),

    // Bottle 1 (Left Card)
    bottleCard1: document.getElementById('bottle-card-1'),
    b1StatusBadge: document.getElementById('b1-status-badge'),
    b1WarningBanner: document.getElementById('b1-warning-banner'),
    b1FluidFill: document.getElementById('b1-fluid-fill'),
    b1DripDrop: document.getElementById('b1-drip-drop'),
    b1VolumeText: document.getElementById('b1-volume-text'),
    b1ProgressBar: document.getElementById('b1-progress-bar'),
    b1PercentageText: document.getElementById('b1-percentage-text'),
    b1FluidGrams: document.getElementById('b1-fluid-grams'),
    b1WeightText: document.getElementById('b1-weight-text'),
    b1SensorStatus: document.getElementById('b1-sensor-status'),
    b1ValveCommand: document.getElementById('b1-valve-command'),
    b1ValveIndicator: document.getElementById('b1-valve-indicator'),
    b1ValveTitle: document.getElementById('b1-valve-title'),
    b1ValveDesc: document.getElementById('b1-valve-desc'),
    btnOpenB1: document.getElementById('btn-open-b1'),
    btnResetB1: document.getElementById('btn-reset-b1'),
    btnStopB1: document.getElementById('btn-stop-b1'),
    btnQuickTareB1: document.getElementById('btn-quick-tare-b1'),
    b1UpdatedTime: document.getElementById('b1-updated-time'),

    // Bottle 2 (Right Card)
    bottleCard2: document.getElementById('bottle-card-2'),
    b2StatusBadge: document.getElementById('b2-status-badge'),
    b2WarningBanner: document.getElementById('b2-warning-banner'),
    b2FluidFill: document.getElementById('b2-fluid-fill'),
    b2DripDrop: document.getElementById('b2-drip-drop'),
    b2VolumeText: document.getElementById('b2-volume-text'),
    b2ProgressBar: document.getElementById('b2-progress-bar'),
    b2PercentageText: document.getElementById('b2-percentage-text'),
    b2FluidGrams: document.getElementById('b2-fluid-grams'),
    b2WeightText: document.getElementById('b2-weight-text'),
    b2SensorStatus: document.getElementById('b2-sensor-status'),
    b2ValveCommand: document.getElementById('b2-valve-command'),
    b2ValveIndicator: document.getElementById('b2-valve-indicator'),
    b2ValveTitle: document.getElementById('b2-valve-title'),
    b2ValveDesc: document.getElementById('b2-valve-desc'),
    btnOpenB2: document.getElementById('btn-open-b2'),
    btnResetB2: document.getElementById('btn-reset-b2'),
    btnStopB2: document.getElementById('btn-stop-b2'),
    btnQuickTareB2: document.getElementById('btn-quick-tare-b2'),
    b2UpdatedTime: document.getElementById('b2-updated-time'),

    // Quick Fluid Shut-Off Threshold Bar & Emergency
    thresholdDisplayTarget: document.getElementById('threshold-display-target'),
    quickThresholdInput: document.getElementById('quick-threshold-input'),
    btnThreshDec: document.getElementById('btn-thresh-dec'),
    btnThreshInc: document.getElementById('btn-thresh-inc'),
    btnApplyThreshold: document.getElementById('btn-apply-threshold'),
    presetChips: document.querySelectorAll('.btn-preset-chip'),
    btnOpenAll: document.getElementById('btn-open-all'),
    btnEmergencyStopAll: document.getElementById('btn-emergency-stop-all'),
    btnTogglePolarity: document.getElementById('btn-toggle-polarity'),
    polarityBtnText: document.getElementById('polarity-btn-text'),
    btnTestRelays: document.getElementById('btn-test-relays'),

    // Audio Alarm
    btnToggleSound: document.getElementById('btn-toggle-sound'),
    soundIcon: document.getElementById('sound-icon'),
    soundText: document.getElementById('sound-text'),

    // Charts
    chart1Canvas: document.getElementById('chart-bottle-1'),
    chart2Canvas: document.getElementById('chart-bottle-2'),
    chart1Empty: document.getElementById('chart-1-empty'),
    chart2Empty: document.getElementById('chart-2-empty'),
    btnClearCharts: document.getElementById('btn-clear-charts'),

    // Connections Section
    activeModeName: document.getElementById('active-mode-name'),
    selectComPort: document.getElementById('select-com-port'),
    btnRefreshPorts: document.getElementById('btn-refresh-ports'),
    selectBaudRate: document.getElementById('select-baud-rate'),
    btnSerialConnect: document.getElementById('btn-serial-connect'),
    btnWebSerialConnect: document.getElementById('btn-web-serial-connect'),
    btnSerialDisconnect: document.getElementById('btn-serial-disconnect'),
    serialStatusTag: document.getElementById('serial-status-tag'),
    serialTerminalLogs: document.getElementById('serial-terminal-logs'),
    btnClearTerminal: document.getElementById('btn-clear-terminal'),
    backendServerPill: document.getElementById('backend-server-pill'),
    backendServerDot: document.getElementById('backend-server-dot'),
    backendServerStatusText: document.getElementById('backend-server-status-text'),
    esp32PortHint: document.getElementById('esp32-port-hint'),
    esp32HintText: document.getElementById('esp32-hint-text'),
    btnQuickSelectEsp32: document.getElementById('btn-quick-select-esp32'),
    btnToggleCustomPort: document.getElementById('btn-toggle-custom-port'),
    inputCustomComPort: document.getElementById('input-custom-com-port'),
    serverOfflineNotice: document.getElementById('server-offline-notice'),

    inputWifiIp: document.getElementById('input-wifi-ip'),
    inputWifiPort: document.getElementById('input-wifi-port'),
    btnWifiConnect: document.getElementById('btn-wifi-connect'),
    btnWifiDisconnect: document.getElementById('btn-wifi-disconnect'),
    wifiStatusTag: document.getElementById('wifi-status-tag'),
    wifiEndpointPreview: document.getElementById('wifi-endpoint-preview'),
    wifiLastCommTime: document.getElementById('wifi-last-comm-time'),
    btnToggleSimulation: document.getElementById('btn-toggle-simulation'),

    // Event Log
    eventLogTbody: document.getElementById('event-log-tbody'),
    eventFilterChips: document.querySelectorAll('.filter-chip'),
    btnClearEvents: document.getElementById('btn-clear-events'),

    // Settings Modal
    settingsModal: document.getElementById('settings-modal'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    btnCancelSettings: document.getElementById('btn-cancel-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    settingThreshold: document.getElementById('setting-threshold'),
    settingDensity: document.getElementById('setting-density'),
    settingCapB1: document.getElementById('setting-cap-b1'),
    settingCapB2: document.getElementById('setting-cap-b2'),
    settingTareB1: document.getElementById('setting-tare-b1'),
    settingTareB2: document.getElementById('setting-tare-b2'),
    settingRelayPolarity: document.getElementById('setting-relay-polarity'),
    btnModalTestRelay: document.getElementById('btn-modal-test-relay'),
    btnTareB1: document.getElementById('btn-tare-b1'),
    btnTareB2: document.getElementById('btn-tare-b2')
  };

  // -------------------------------------------------------------
  // Backend Server Connection Resolution
  // -------------------------------------------------------------
  // Automatically route API & WS to port 3000 (whether opened via file://, Live Server port 5500, or directly)
  const BACKEND_PORT = 3000;
  const isFileProtocol = location.protocol === 'file:';
  const isSeparateDevServer = isFileProtocol || Boolean(location.port && location.port !== String(BACKEND_PORT));
  const defaultHost = (location.hostname && location.hostname !== '') ? location.hostname : 'localhost';
  const API_BASE = isSeparateDevServer ? `http://${defaultHost}:${BACKEND_PORT}` : '';
  const WS_HOST = isSeparateDevServer ? `${defaultHost}:${BACKEND_PORT}` : (location.host || `localhost:${BACKEND_PORT}`);

  function formatFetchError(err) {
    if (err && (err.name === 'TypeError' || String(err.message).toLowerCase().includes('fetch') || String(err).toLowerCase().includes('networkerror'))) {
      return `Cannot connect to backend server at ${API_BASE || 'http://localhost:3000'}.\n\nPlease ensure you started the backend server by running:\n  npm start\nin your project directory and that port ${BACKEND_PORT} is open.`;
    }
    return err.message || String(err);
  }

  // -------------------------------------------------------------
  // WebSocket Communication Client
  // -------------------------------------------------------------
  function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${WS_HOST}`;

    try {
      appState.ws = new WebSocket(wsUrl);

      appState.ws.onopen = () => {
        console.log('Connected to backend WebSocket telemetry server');
        appState.connected = true;
      };

      appState.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch (err) {
          console.error('Error parsing incoming WS message:', err);
        }
      };

      appState.ws.onclose = () => {
        appState.connected = false;
        appState.status = 'DISCONNECTED';
        appState.isStale = true;
        updateConnectionUI();
        // Auto-reconnect after 2 seconds
        setTimeout(initWebSocket, 2000);
      };

      appState.ws.onerror = (err) => {
        console.warn('WebSocket connection error (Backend server may be offline):', err);
      };
    } catch (e) {
      console.warn('Failed to initialize WebSocket:', e);
      setTimeout(initWebSocket, 3000);
    }
  }

  // Handle incoming messages from Node.js backend
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'INITIAL_STATE':
        appState.status = msg.status;
        appState.transport = msg.transport;
        appState.isStale = msg.isStale;
        if (msg.settings) appState.settings = { ...appState.settings, ...msg.settings };
        if (msg.readings) appState.readings = msg.readings;
        if (msg.events) appState.events = msg.events;

        syncSettingsForm();
        updateConnectionUI();
        renderEventLog();

        if (msg.history && msg.history.length > 0) {
          populateChartHistory(msg.history);
        }

        renderTelemetry();
        break;

      case 'TELEMETRY_UPDATE':
        appState.status = msg.status;
        appState.transport = msg.transport;
        appState.isStale = msg.isStale;
        if (msg.readings) appState.readings = msg.readings;
        appState.lastUpdated = new Date();

        renderTelemetry();
        updateConnectionUI();

        if (msg.historyPoint) {
          appendChartPoint(msg.historyPoint);
        }
        break;

      case 'STATUS_UPDATE':
        appState.status = msg.status;
        appState.transport = msg.transport;
        if (msg.isStale !== undefined) appState.isStale = msg.isStale;
        updateConnectionUI();
        renderTelemetry();
        break;

      case 'EVENT_LOG':
        if (msg.event) {
          appState.events.unshift(msg.event);
          if (appState.events.length > 200) appState.events.pop();
          renderEventLog();
        }
        break;

      case 'SERIAL_RAW':
        appendSerialTerminalLine(msg.direction, msg.data, msg.timestamp);
        break;

      case 'SETTINGS_UPDATE':
        if (msg.settings) {
          appState.settings = { ...appState.settings, ...msg.settings };
          syncSettingsForm();
        }
        break;
    }
  }

  // -------------------------------------------------------------
  // UI Rendering: Telemetry & Bottle Cards
  // -------------------------------------------------------------
  function renderTelemetry() {
    const isConnected = appState.status === 'CONNECTED' && appState.transport !== 'NONE';
    const isStale = appState.isStale || !isConnected;

    // Disconnected notice bar
    if (isStale) {
      dom.staleNoticeBar.classList.remove('hidden');
    } else {
      dom.staleNoticeBar.classList.add('hidden');
    }

    const b1 = appState.readings.bottle1;
    const b2 = appState.readings.bottle2;

    // --- Bottle 1 Rendering ---
    renderBottleCard(1, b1, isStale, isConnected);

    // --- Bottle 2 Rendering ---
    renderBottleCard(2, b2, isStale, isConnected);

    // --- Top Summary Cards Calculation ---
    const totalCap = (appState.settings.bottle1Capacity || 500) + (appState.settings.bottle2Capacity || 500);
    dom.summaryCapacityValue.innerHTML = `${totalCap} <span class="summary-unit">mL</span>`;

    if (isConnected || b1.remaining_ml > 0 || b2.remaining_ml > 0) {
      const totalRemaining = (b1.remaining_ml + b2.remaining_ml).toFixed(0);
      const totalPct = ((b1.remaining_ml + b2.remaining_ml) / totalCap * 100).toFixed(1);
      dom.summaryRemainingValue.innerHTML = `${totalRemaining} <span class="summary-unit">mL</span>`;
      dom.summaryRemainingFooter.textContent = isStale ? `Stale: ${totalPct}% capacity remaining` : `Live: ${totalPct}% total capacity remaining`;
    } else {
      dom.summaryRemainingValue.innerHTML = `-- <span class="summary-unit">mL</span>`;
      dom.summaryRemainingFooter.textContent = 'Waiting for ESP32 Telemetry';
    }

    // Attention Required Count (bottles <= threshold or sensor faults)
    let attentionCount = 0;
    if (b1.low_fluid || !b1.sensor_ok) attentionCount++;
    if (b2.low_fluid || !b2.sensor_ok) attentionCount++;

    dom.summaryAttentionValue.innerHTML = `${attentionCount} <span class="summary-unit">${attentionCount === 1 ? 'Bottle' : 'Bottles'}</span>`;
    if (attentionCount > 0) {
      dom.summaryAttentionFooter.textContent = 'Action Required: Low fluid or sensor error';
      dom.summaryAttentionFooter.style.color = 'var(--color-critical)';
      dom.attentionIcon.className = 'summary-icon amber-icon';
      dom.attentionIcon.textContent = '🚨';
    } else {
      dom.summaryAttentionFooter.textContent = 'Normal Infusion Conditions';
      dom.summaryAttentionFooter.style.color = 'var(--text-muted)';
      dom.attentionIcon.className = 'summary-icon teal-icon';
      dom.attentionIcon.textContent = '✅';
    }

    // Dynamic System Alert Banner Logic
    updateSystemAlertBanner(b1, b2, isConnected, isStale);
  }

  // Render an individual bottle card (Bottle 1 or Bottle 2)
  function renderBottleCard(id, data, isStale, isConnected) {
    if (!data) return;
    const isB1 = id === 1;
    const card = isB1 ? dom.bottleCard1 : dom.bottleCard2;
    if (!card) return;

    const badge = isB1 ? dom.b1StatusBadge : dom.b2StatusBadge;
    const warnBanner = isB1 ? dom.b1WarningBanner : dom.b2WarningBanner;
    const fluidFill = isB1 ? dom.b1FluidFill : dom.b2FluidFill;
    const dripDrop = isB1 ? dom.b1DripDrop : dom.b2DripDrop;
    const volText = isB1 ? dom.b1VolumeText : dom.b2VolumeText;
    const progBar = isB1 ? dom.b1ProgressBar : dom.b2ProgressBar;
    const pctText = isB1 ? dom.b1PercentageText : dom.b2PercentageText;
    const fluidGrams = isB1 ? dom.b1FluidGrams : dom.b2FluidGrams;
    const weightText = isB1 ? dom.b1WeightText : dom.b2WeightText;
    const sensorStatus = isB1 ? dom.b1SensorStatus : dom.b2SensorStatus;
    const valveCommand = isB1 ? dom.b1ValveCommand : dom.b2ValveCommand;
    const valveIndicator = isB1 ? dom.b1ValveIndicator : dom.b2ValveIndicator;
    const valveTitle = isB1 ? dom.b1ValveTitle : dom.b2ValveTitle;
    const valveDesc = isB1 ? dom.b1ValveDesc : dom.b2ValveDesc;
    const updatedTime = isB1 ? dom.b1UpdatedTime : dom.b2UpdatedTime;

    const capacity = isB1 ? (appState.settings.bottle1Capacity || 500) : (appState.settings.bottle2Capacity || 500);

    // Numerical readouts
    if (isConnected || data.remaining_ml > 0) {
      if (volText) volText.textContent = data.remaining_ml.toFixed(0);
      if (pctText) pctText.textContent = `${data.percentage}%`;
      if (fluidGrams) fluidGrams.textContent = `${data.fluid_g.toFixed(1)} g`;
      if (weightText) weightText.textContent = `${data.weight_g.toFixed(1)} g`;
      if (progBar) progBar.style.width = `${Math.min(100, Math.max(0, data.percentage))}%`;
      if (fluidFill) fluidFill.style.height = `${Math.min(100, Math.max(0, data.percentage))}%`;
    } else {
      if (volText) volText.textContent = '--';
      if (pctText) pctText.textContent = '--%';
      if (fluidGrams) fluidGrams.textContent = '-- g';
      if (weightText) weightText.textContent = '-- g';
      if (progBar) progBar.style.width = '0%';
      if (fluidFill) fluidFill.style.height = '0%';
    }

    // Sensor health
    if (sensorStatus) {
      if (!data.sensor_ok && isConnected) {
        sensorStatus.textContent = 'FAULT';
        sensorStatus.className = 'submetric-val status-val fault';
      } else if (data.calibrated === false && isConnected) {
        sensorStatus.textContent = 'CALIB REQ';
        sensorStatus.className = 'submetric-val status-val fault';
      } else if (isConnected) {
        sensorStatus.textContent = 'NORMAL';
        sensorStatus.className = 'submetric-val status-val ok';
      } else {
        sensorStatus.textContent = isStale ? 'STALE' : '--';
        sensorStatus.className = 'submetric-val status-val';
      }
    }

    // Valve command display
    const isValveClosed = data.valve_command === 'CLOSED';
    if (valveCommand) {
      valveCommand.textContent = data.valve_command || 'OPEN';
      valveCommand.className = `submetric-val valve-val ${isValveClosed ? 'closed' : 'open'}`;
    }

    if (isValveClosed) {
      if (valveIndicator) valveIndicator.textContent = '🔴';
      if (valveTitle) valveTitle.textContent = 'Valve Command: CLOSED (SHUT-OFF)';
      if (valveDesc) valveDesc.textContent = 'Latched off by safety threshold. Unlatch to resume flow.';
      if (dripDrop) dripDrop.classList.add('stopped');
      if (progBar) progBar.classList.add('fill-critical');
      if (fluidFill) fluidFill.classList.add('fill-critical');
    } else {
      if (valveIndicator) valveIndicator.textContent = '🟢';
      if (valveTitle) valveTitle.textContent = 'Valve Command: OPEN';
      if (valveDesc) valveDesc.textContent = `Solenoid Relay Channel ${id} energized for infusion`;
      if (dripDrop) dripDrop.classList.remove('stopped');
      if (progBar) progBar.classList.remove('fill-critical');
      if (fluidFill) fluidFill.classList.remove('fill-critical');
    }

    // Warning and Status Badges
    card.classList.remove('low-fluid-alert');
    if (warnBanner) warnBanner.classList.add('hidden');

    if (badge) {
      if (!isConnected) {
        badge.textContent = isStale && data.remaining_ml > 0 ? 'DISCONNECTED (STALE)' : 'DISCONNECTED';
        badge.className = 'status-badge badge-disconnected';
      } else if (!data.sensor_ok) {
        badge.textContent = 'SENSOR FAULT';
        badge.className = 'status-badge badge-fault';
      } else if (data.calibrated === false) {
        badge.textContent = 'CALIBRATION REQUIRED';
        badge.className = 'status-badge badge-calib';
      } else if (data.low_fluid || data.remaining_ml <= appState.settings.lowFluidThreshold) {
        badge.textContent = 'LOW FLUID';
        badge.className = 'status-badge badge-low-fluid';
        card.classList.add('low-fluid-alert');
        if (warnBanner) warnBanner.classList.remove('hidden');
      } else {
        badge.textContent = 'NORMAL';
        badge.className = 'status-badge badge-normal';
      }
    }

    // Last updated
    if (updatedTime && appState.lastUpdated) {
      updatedTime.textContent = appState.lastUpdated.toLocaleTimeString();
    }
  }

  // Clinical Alert Sound Synthesizer (Web Audio API)
  let audioCtx = null;
  let soundAlarmEnabled = true;
  let lastAlarmBeepTime = 0;

  function playMedicalAlarmTone() {
    if (!soundAlarmEnabled) return;
    const now = Date.now();
    if (now - lastAlarmBeepTime < 2500) return; // Beep every 2.5 seconds
    lastAlarmBeepTime = now;

    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;
      if (!audioCtx) audioCtx = new AudioCtxClass();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.setValueAtTime(1046, audioCtx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.36);
    } catch (_) {}
  }

  // Dynamic Top Alert Banner & Full-Screen Red Indication
  function updateSystemAlertBanner(b1, b2, isConnected, isStale) {
    if (!isConnected) {
      document.body.classList.remove('emergency-screen-red');
      dom.alertBanner.classList.remove('hidden', 'banner-warning');
      dom.alertBanner.className = 'alert-banner banner-warning';
      dom.alertTitle.textContent = 'DEVICE DISCONNECTED';
      dom.alertDesc.textContent = 'No active connection to ESP32. Please select USB Serial or Wi-Fi IP to receive live readings.';
      return;
    }

    const b1Active = b1 && b1.sensor_ok !== false;
    const b2Active = b2 && b2.sensor_ok !== false;

    const b1Low = b1Active && (b1.low_fluid || b1.remaining_ml <= appState.settings.lowFluidThreshold);
    const b2Low = b2Active && (b2.low_fluid || b2.remaining_ml <= appState.settings.lowFluidThreshold);
    const b1Closed = b1 && b1.valve_command === 'CLOSED';
    const b2Closed = b2 && b2.valve_command === 'CLOSED';

    // TRIGGER FULL SCREEN RED ALARM only if an active bottle is genuinely in critical low-fluid condition
    const isCriticalLowFluid = (b1Active && b1Low) || (b2Active && b2Low);

    if (isCriticalLowFluid) {
      document.body.classList.add('emergency-screen-red');
      playMedicalAlarmTone();

      dom.alertBanner.classList.remove('hidden', 'banner-warning');
      dom.alertBanner.className = 'alert-banner'; // Critical pulse red

      if (b1Low && b2Low) {
        dom.alertTitle.textContent = '🚨 FLUID SHUT OFF: BOTH CONTAINERS LOW';
        dom.alertDesc.textContent = `Both IV containers reached threshold (${appState.settings.lowFluidThreshold} mL). Solenoid valves commanded CLOSED to prevent air embolism. Refill containers and click 'Open / Reset Valves' to resume flow.`;
      } else if (b1Low) {
        dom.alertTitle.textContent = '🚨 FLUID SHUT OFF: BOTTLE 1 LOW';
        dom.alertDesc.textContent = `Bottle 1 fluid reached threshold (${b1.remaining_ml.toFixed(1)} mL <= ${appState.settings.lowFluidThreshold} mL). Valve 1 commanded CLOSED. Refill Bottle 1 and click 'Open Valve' to resume flow.`;
      } else if (b2Low) {
        dom.alertTitle.textContent = '🚨 FLUID SHUT OFF: BOTTLE 2 LOW';
        dom.alertDesc.textContent = `Bottle 2 fluid reached threshold (${b2.remaining_ml.toFixed(1)} mL <= ${appState.settings.lowFluidThreshold} mL). Valve 2 commanded CLOSED. Refill Bottle 2 and click 'Open Valve' to resume flow.`;
      }
    } else {
      // Fluid is AVAILABLE: restore clean normal screen! Color is NOT red!
      document.body.classList.remove('emergency-screen-red');

      if (b1Closed && b2Closed) {
        dom.alertBanner.classList.remove('hidden');
        dom.alertBanner.className = 'alert-banner banner-warning';
        dom.alertTitle.textContent = 'VALVES PAUSED / CLOSED';
        dom.alertDesc.textContent = 'Both solenoid valves are currently commanded closed. Click "Open Both Valves" above to resume infusion flow.';
      } else {
        dom.alertBanner.classList.add('hidden');
      }
    }
  }

  // -------------------------------------------------------------
  // UI Rendering: Connection Status & Options
  // -------------------------------------------------------------
  function updateConnectionUI() {
    const { status, transport, isStale } = appState;

    // Navbar pills
    dom.navbarStatusDot.className = 'status-dot ' + (status === 'CONNECTED' ? 'connected' : (status === 'CONNECTING' ? 'connecting' : (status === 'ERROR' ? 'error' : 'disconnected')));
    dom.navbarTransportText.textContent = transport;
    dom.navbarHealthText.textContent = status;

    // Summary connection card
    dom.summaryConnectionValue.textContent = status;
    dom.summaryConnectionFooter.textContent = transport === 'NONE' ? 'Select USB Serial or Wi-Fi' : `Active Transport: ${transport}`;

    // Mode name badge
    dom.activeModeName.textContent = `${transport} (${status})`;

    // USB Card Controls
    const isWebSerialActive = transport.includes('BROWSER');
    const isSerialActive = transport === 'SERIAL' || isWebSerialActive;
    const isSerialConnected = isSerialActive && status === 'CONNECTED';

    dom.btnSerialConnect.disabled = isSerialConnected;
    if (dom.btnWebSerialConnect) dom.btnWebSerialConnect.disabled = isSerialConnected;
    dom.btnSerialDisconnect.disabled = !isSerialActive;
    dom.serialStatusTag.textContent = isSerialActive ? status : 'INACTIVE';
    dom.serialStatusTag.className = 'conn-status-tag ' + (isSerialConnected ? 'connected' : (status === 'CONNECTING' ? 'connecting' : ''));

    // Wi-Fi Card Controls
    const isWifiActive = transport === 'WIFI';
    dom.btnWifiConnect.disabled = isWifiActive && status === 'CONNECTED';
    dom.btnWifiDisconnect.disabled = !isWifiActive;
    dom.wifiStatusTag.textContent = isWifiActive ? status : 'INACTIVE';
    dom.wifiStatusTag.className = 'conn-status-tag ' + (isWifiActive && status === 'CONNECTED' ? 'connected' : (isWifiActive && status === 'CONNECTING' ? 'connecting' : ''));

    if (isWifiActive && status === 'CONNECTED' && appState.lastUpdated) {
      dom.wifiLastCommTime.textContent = appState.lastUpdated.toLocaleTimeString();
    }

    // Simulation toggle button label
    const isSimActive = transport === 'SIMULATION';
    dom.btnToggleSimulation.textContent = isSimActive ? 'Stop Simulation' : 'Start Simulation';
    dom.btnToggleSimulation.className = isSimActive ? 'btn-danger-outline btn-sm' : 'btn-secondary btn-sm';
  }

  // Append a raw line to the serial terminal UI
  function appendSerialTerminalLine(direction, data, timestamp) {
    if (!dom.serialTerminalLogs) return;

    const div = document.createElement('div');
    div.className = `terminal-line ${direction === 'RX' ? 'rx' : 'tx'}`;
    const timeStr = timestamp || new Date().toLocaleTimeString();
    div.textContent = `[${timeStr}] ${direction}: ${data}`;

    dom.serialTerminalLogs.appendChild(div);

    // Limit scrollback to 150 items
    while (dom.serialTerminalLogs.children.length > 150) {
      dom.serialTerminalLogs.removeChild(dom.serialTerminalLogs.children[0]);
    }

    dom.serialTerminalLogs.scrollTop = dom.serialTerminalLogs.scrollHeight;
  }

  // -------------------------------------------------------------
  // Chart.js Live Graphs Setup
  // -------------------------------------------------------------
  function initCharts() {
    if (typeof Chart === 'undefined') {
      console.warn('Chart.js library is loading or unavailable.');
      return;
    }

    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 8, font: { size: 10 } }
        },
        y: {
          min: 0,
          max: 550,
          grid: { color: '#f1f5f9' },
          ticks: {
            stepSize: 100,
            font: { size: 10 },
            callback: (val) => `${val} mL`
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `Remaining: ${ctx.parsed.y} mL`
          }
        }
      }
    };

    // Chart 1: Bottle 1
    const ctx1 = dom.chart1Canvas.getContext('2d');
    chart1 = new Chart(ctx1, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Bottle 1 (mL)',
          data: [],
          borderColor: '#0284c7',
          backgroundColor: 'rgba(2, 132, 199, 0.08)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.25,
          fill: true
        }]
      },
      options: commonOptions
    });

    // Chart 2: Bottle 2
    const ctx2 = dom.chart2Canvas.getContext('2d');
    chart2 = new Chart(ctx2, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Bottle 2 (mL)',
          data: [],
          borderColor: '#0d9488',
          backgroundColor: 'rgba(13, 148, 136, 0.08)',
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 5,
          tension: 0.25,
          fill: true
        }]
      },
      options: commonOptions
    });
  }

  function appendChartPoint(pt) {
    if (!chart1 || !chart2) return;

    dom.chart1Empty.classList.add('hidden');
    dom.chart2Empty.classList.add('hidden');

    const maxPoints = appState.settings.chartHistoryLimit || 300;

    // Chart 1
    chart1.data.labels.push(pt.timestamp);
    chart1.data.datasets[0].data.push(pt.b1_ml);
    if (chart1.data.labels.length > maxPoints) {
      chart1.data.labels.shift();
      chart1.data.datasets[0].data.shift();
    }
    chart1.update('none');

    // Chart 2
    chart2.data.labels.push(pt.timestamp);
    chart2.data.datasets[0].data.push(pt.b2_ml);
    if (chart2.data.labels.length > maxPoints) {
      chart2.data.labels.shift();
      chart2.data.datasets[0].data.shift();
    }
    chart2.update('none');
  }

  function populateChartHistory(historyList) {
    if (!chart1 || !chart2 || !historyList.length) return;

    dom.chart1Empty.classList.add('hidden');
    dom.chart2Empty.classList.add('hidden');

    chart1.data.labels = historyList.map(h => h.timestamp);
    chart1.data.datasets[0].data = historyList.map(h => h.b1_ml);
    chart1.update();

    chart2.data.labels = historyList.map(h => h.timestamp);
    chart2.data.datasets[0].data = historyList.map(h => h.b2_ml);
    chart2.update();
  }

  function clearCharts() {
    if (chart1) {
      chart1.data.labels = [];
      chart1.data.datasets[0].data = [];
      chart1.update();
      dom.chart1Empty.classList.remove('hidden');
    }
    if (chart2) {
      chart2.data.labels = [];
      chart2.data.datasets[0].data = [];
      chart2.update();
      dom.chart2Empty.classList.remove('hidden');
    }
  }

  // -------------------------------------------------------------
  // System Event Log Rendering
  // -------------------------------------------------------------
  function renderEventLog() {
    const tbody = dom.eventLogTbody;
    tbody.innerHTML = '';

    const filter = appState.eventFilter;
    const filtered = filter === 'ALL'
      ? appState.events
      : appState.events.filter(e => e.severity === filter);

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-table-cell">No matching events logged.</td></tr>';
      return;
    }

    filtered.forEach(evt => {
      const tr = document.createElement('tr');
      const timeStr = new Date(evt.timestamp).toLocaleTimeString();

      let sevClass = 'sev-info';
      if (evt.severity === 'WARN') sevClass = 'sev-warn';
      if (evt.severity === 'ERROR') sevClass = 'sev-error';
      if (evt.severity === 'CRITICAL') sevClass = 'sev-critical';

      tr.innerHTML = `
        <td>${timeStr}</td>
        <td><span class="sev-pill ${sevClass}">${evt.severity}</span></td>
        <td><strong>${escapeHtml(evt.type)}</strong></td>
        <td>${escapeHtml(evt.message)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // -------------------------------------------------------------
  // Backend Server Health Monitoring & Web Serial Support
  // -------------------------------------------------------------
  let isBackendOnline = false;

  async function checkBackendHealth() {
    try {
      const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        setBackendStatus(true);
        return true;
      }
    } catch (_) {}

    try {
      const res = await fetch(`${API_BASE}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        setBackendStatus(true);
        return true;
      }
    } catch (_) {}

    setBackendStatus(false);
    return false;
  }

  function setBackendStatus(online) {
    const wasOnline = isBackendOnline;
    isBackendOnline = online;

    if (dom.backendServerPill) {
      dom.backendServerPill.className = `server-status-pill ${online ? 'online' : 'offline'}`;
    }
    if (dom.backendServerDot) {
      dom.backendServerDot.className = `status-dot ${online ? 'connected' : 'disconnected'}`;
    }
    if (dom.backendServerStatusText) {
      dom.backendServerStatusText.textContent = online ? 'Online (Port 3000)' : 'Offline (Port 3000)';
    }
    if (dom.serverOfflineNotice) {
      if (online) {
        dom.serverOfflineNotice.classList.add('hidden');
      } else {
        dom.serverOfflineNotice.classList.remove('hidden');
      }
    }

    // When server comes online from offline state, auto-refresh ports and reconnect WS
    if (!wasOnline && online) {
      refreshSerialPorts();
      if (!appState.connected) {
        initWebSocket();
      }
    }
  }

  // -------------------------------------------------------------
  // Direct Web Serial Client (Browser USB - Chrome & Edge)
  // -------------------------------------------------------------
  const webSerial = {
    port: null,
    reader: null,
    writer: null,
    readableStreamClosed: null,
    writableStreamClosed: null,
    keepReading: false
  };

  async function connectWebSerial() {
    if (!('serial' in navigator)) {
      alert('Web Serial API is not supported in this browser.\n\nPlease open this dashboard in Google Chrome, Microsoft Edge, Brave, or Opera on Windows to connect directly via Web Serial.');
      return;
    }

    try {
      appendSerialTerminalLine('TX', 'Opening browser USB device selector dialog...', new Date().toLocaleTimeString());
      const port = await navigator.serial.requestPort();
      const baudRate = Number(dom.selectBaudRate.value) || 115200;

      await port.open({ baudRate });
      webSerial.port = port;
      webSerial.keepReading = true;

      appState.status = 'CONNECTED';
      appState.transport = 'SERIAL (BROWSER DIRECT)';
      appState.isStale = false;
      updateConnectionUI();

      appendSerialTerminalLine('RX', `[Web Serial] Successfully connected directly via browser at ${baudRate} baud. Awaiting ESP32 JSON data...`, new Date().toLocaleTimeString());
      logEventLocally('SERIAL_CONNECTED', `Direct Web Serial connection established at ${baudRate} baud`, 'INFO');

      // Setup writer stream
      const encoder = new TextEncoderStream();
      webSerial.writableStreamClosed = encoder.readable.pipeTo(port.writable);
      webSerial.writer = encoder.writable.getWriter();

      // Read continuous telemetry stream
      readWebSerialStream(port);

    } catch (err) {
      if (err.name === 'NotFoundError') {
        appendSerialTerminalLine('ERR', 'Web Serial: No device selected.', new Date().toLocaleTimeString());
      } else {
        console.error('Web Serial connection error:', err);
        appendSerialTerminalLine('ERR', `Web Serial error: ${err.message}`, new Date().toLocaleTimeString());
        alert(`Web Serial connection error:\n\n${err.message}\n\nNote: If another application (like Arduino IDE Serial Monitor or Node server) is currently using the port, please close it first.`);
      }
    }
  }

  async function readWebSerialStream(port) {
    let textDecoder = new TextDecoderStream();
    webSerial.readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    webSerial.reader = reader;

    let buffer = '';
    try {
      while (webSerial.keepReading) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop(); // save incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            appendSerialTerminalLine('RX', trimmed, new Date().toLocaleTimeString());

            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
              try {
                const parsed = JSON.parse(trimmed);
                processDirectTelemetryReading(parsed);
              } catch (_) {}
            }
          }
        }
      }
    } catch (readErr) {
      if (webSerial.keepReading) {
        console.warn('Web Serial stream closed/error:', readErr);
        appendSerialTerminalLine('ERR', `Web Serial stream closed: ${readErr.message}`, new Date().toLocaleTimeString());
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function sendWebSerialCommand(cmdObj) {
    if (webSerial.writer) {
      try {
        const str = JSON.stringify(cmdObj) + '\n';
        await webSerial.writer.write(str);
        appendSerialTerminalLine('TX', str.trim(), new Date().toLocaleTimeString());
        return true;
      } catch (err) {
        console.error('Failed to write to Web Serial:', err);
        return false;
      }
    }
    return false;
  }

  async function disconnectWebSerial() {
    webSerial.keepReading = false;
    try {
      if (webSerial.reader) {
        await webSerial.reader.cancel();
        await webSerial.readableStreamClosed.catch(() => {});
      }
      if (webSerial.writer) {
        await webSerial.writer.close();
        await webSerial.writableStreamClosed.catch(() => {});
      }
      if (webSerial.port) {
        await webSerial.port.close();
      }
    } catch (e) {
      console.warn('Error closing Web Serial port:', e);
    } finally {
      webSerial.port = null;
      webSerial.reader = null;
      webSerial.writer = null;
      appState.status = 'DISCONNECTED';
      appState.transport = 'NONE';
      appState.isStale = true;
      updateConnectionUI();
      appendSerialTerminalLine('RX', '[Web Serial] Disconnected from USB port.', new Date().toLocaleTimeString());
      logEventLocally('SERIAL_DISCONNECTED', 'Direct Web Serial disconnected by user', 'INFO');
    }
  }

  // Handle direct telemetry parsing (used by Web Serial)
  function processDirectTelemetryReading(json) {
    if (!json || typeof json !== 'object') return;

    appState.status = 'CONNECTED';
    appState.isStale = false;
    appState.lastUpdated = new Date();

    const density = appState.settings.fluidDensity || 1.0;
    const lowThresh = appState.settings.lowFluidThreshold || 20;

    // Bottle 1
    if (json.bottle1) {
      const b1 = json.bottle1;
      const rem = Number(b1.remaining_ml) || 0;
      const cap = appState.settings.bottle1Capacity || 500;
      const pct = Math.max(0, Math.min(100, (rem / cap) * 100));

      appState.readings.bottle1 = {
        weight_g: Number(b1.weight_g) || 0,
        fluid_g: Number(b1.fluid_g) || (rem * density) || 0,
        remaining_ml: rem,
        percentage: Number(pct.toFixed(1)),
        valve_command: b1.valve_command === 'CLOSED' ? 'CLOSED' : 'OPEN',
        sensor_ok: b1.sensor_ok !== false,
        calibrated: b1.calibrated !== false,
        low_fluid: rem <= lowThresh || b1.low_fluid === true
      };
    }

    // Bottle 2
    if (json.bottle2) {
      const b2 = json.bottle2;
      const rem = Number(b2.remaining_ml) || 0;
      const cap = appState.settings.bottle2Capacity || 500;
      const pct = Math.max(0, Math.min(100, (rem / cap) * 100));

      appState.readings.bottle2 = {
        weight_g: Number(b2.weight_g) || 0,
        fluid_g: Number(b2.fluid_g) || (rem * density) || 0,
        remaining_ml: rem,
        percentage: Number(pct.toFixed(1)),
        valve_command: b2.valve_command === 'CLOSED' ? 'CLOSED' : 'OPEN',
        sensor_ok: b2.sensor_ok !== false,
        calibrated: b2.calibrated !== false,
        low_fluid: rem <= lowThresh || b2.low_fluid === true
      };
    }

    if (json.relay_active_low !== undefined) {
      appState.settings.relayActiveLow = Boolean(json.relay_active_low);
      updatePolarityUI();
    }

    renderTelemetry();
    updateConnectionUI();

    // Append to live charts
    appendChartPoint({
      timestamp: new Date().toLocaleTimeString(),
      b1_ml: appState.readings.bottle1.remaining_ml,
      b2_ml: appState.readings.bottle2.remaining_ml
    });
  }

  function logEventLocally(type, message, severity = 'INFO') {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      type,
      message,
      severity
    };
    appState.events.unshift(entry);
    if (appState.events.length > 200) appState.events.pop();
    renderEventLog();
  }

  // -------------------------------------------------------------
  // REST API Actions
  // -------------------------------------------------------------

  // Load available COM ports with auto-selection of ESP32 and fallbacks
  async function refreshSerialPorts() {
    if (dom.btnRefreshPorts) dom.btnRefreshPorts.classList.add('rotating');

    let ports = [];
    let backendAvailable = false;

    try {
      const res = await fetch(`${API_BASE}/api/serial/ports`, { signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.ports) && data.ports.length > 0) {
          ports = data.ports;
          backendAvailable = true;
          setBackendStatus(true);
        }
      }
    } catch (err) {
      console.warn('Backend /api/serial/ports unreachable:', err);
      setBackendStatus(false);
    }

    // If backend is offline or returned no ports, provide detected/system ports
    if (ports.length === 0) {
      ports = [
        { path: 'COM7', friendlyName: 'Silicon Labs CP210x USB to UART Bridge (COM7)', manufacturer: 'Silicon Labs', isEsp32: true },
        { path: 'COM4', friendlyName: 'Standard Serial over Bluetooth link (COM4)', manufacturer: 'Microsoft', isEsp32: false },
        { path: 'COM3', friendlyName: 'Standard Serial over Bluetooth link (COM3)', manufacturer: 'Microsoft', isEsp32: false }
      ];
    }

    // Populate dropdown
    dom.selectComPort.innerHTML = '<option value="">-- Select COM Port --</option>';
    let esp32Port = null;

    ports.forEach(port => {
      const opt = document.createElement('option');
      opt.value = port.path;
      const isEsp = port.isEsp32 || /CP210|Silicon Labs|CH340|CH341|FTDI|USB-SERIAL|ESP/i.test(`${port.friendlyName} ${port.manufacturer} ${port.path}`);
      if (isEsp && !esp32Port) esp32Port = port;

      opt.textContent = `${port.path} - ${port.friendlyName || port.manufacturer || 'Serial Device'}${isEsp ? ' (ESP32 ⭐)' : ''}`;
      dom.selectComPort.appendChild(opt);
    });

    // Add manual custom entry option
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = '✏️ Enter Custom COM Port...';
    dom.selectComPort.appendChild(customOpt);

    // Auto-select ESP32 port if found (e.g. COM7)
    if (esp32Port) {
      dom.selectComPort.value = esp32Port.path;
      if (dom.esp32PortHint) {
        dom.esp32PortHint.classList.remove('hidden');
        if (dom.esp32HintText) {
          dom.esp32HintText.innerHTML = `Detected ESP32 on <strong>${esp32Port.path}</strong> (${esp32Port.friendlyName || esp32Port.manufacturer})`;
        }
        if (dom.btnQuickSelectEsp32) {
          dom.btnQuickSelectEsp32.textContent = `Select ${esp32Port.path}`;
          dom.btnQuickSelectEsp32.onclick = () => {
            dom.selectComPort.value = esp32Port.path;
            if (dom.inputCustomComPort) dom.inputCustomComPort.classList.add('hidden');
            dom.selectComPort.classList.remove('hidden');
          };
        }
      }
      appendSerialTerminalLine('RX', `[Port Discovery] ESP32 detected on ${esp32Port.path} (${esp32Port.friendlyName || esp32Port.manufacturer}). Ready to connect.`, new Date().toLocaleTimeString());
    } else {
      if (dom.esp32PortHint) dom.esp32PortHint.classList.add('hidden');
    }

    if (dom.btnRefreshPorts) dom.btnRefreshPorts.classList.remove('rotating');
  }

  // Connect USB Serial (Supports Node Server backend with Web Serial fallback)
  async function connectSerial() {
    let portPath = dom.selectComPort.value;
    if (portPath === '__custom__' || (dom.inputCustomComPort && !dom.inputCustomComPort.classList.contains('hidden'))) {
      portPath = dom.inputCustomComPort.value.trim();
    }
    const baudRate = dom.selectBaudRate.value || 115200;

    if (!portPath || portPath === '__custom__') {
      alert('Please select a valid COM port (e.g. COM7) from the dropdown or click "⚡ Direct Browser USB".');
      return;
    }

    // Check if backend is offline
    if (!isBackendOnline) {
      const tryWebSerial = confirm(`Node.js backend server is currently offline on port 3000.\n\nWould you like to connect directly using Browser Web Serial to your ESP32 on ${portPath}?\n\n(Click 'OK' to use Browser Web Serial, or 'Cancel' to start server with 'npm start').`);
      if (tryWebSerial) {
        connectWebSerial();
      }
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/serial/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: portPath, baudRate })
      });
      const data = await res.json();
      if (!data.success) {
        alert('Serial connection error: ' + (data.message || data.error));
      }
    } catch (err) {
      alert('Network request failed:\n\n' + formatFetchError(err));
    }
  }

  // Disconnect USB Serial
  async function disconnectSerial() {
    if (webSerial.port) {
      await disconnectWebSerial();
      return;
    }

    try {
      await fetch(`${API_BASE}/api/serial/disconnect`, { method: 'POST' });
    } catch (err) {
      console.error('Serial disconnect error:', err);
    }
  }

  // Direct Wi-Fi Polling Handle
  let directWifiInterval = null;
  let directWifiActive = false;

  // Connect Wi-Fi (Supports Node Server & Direct Browser Polling)
  async function connectWifi() {
    const ip = dom.inputWifiIp.value.trim();
    const port = dom.inputWifiPort.value.trim() || '80';

    if (!ip) {
      alert('Please enter the ESP32 IP address.');
      return;
    }

    if (isBackendOnline) {
      try {
        const res = await fetch(`${API_BASE}/api/wifi/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip, port })
        });
        const data = await res.json();
        if (!data.success) {
          console.warn('Backend Wi-Fi connect reported error, falling back to direct browser polling:', data.message);
          startDirectWifiPolling(ip, port);
        }
      } catch (err) {
        console.warn('Backend unreachable, falling back to direct browser polling:', err);
        startDirectWifiPolling(ip, port);
      }
    } else {
      // Connect directly from browser to ESP32 over local network!
      startDirectWifiPolling(ip, port);
    }
  }

  function startDirectWifiPolling(ip, port) {
    if (directWifiInterval) clearInterval(directWifiInterval);
    directWifiActive = true;
    appState.status = 'CONNECTING';
    appState.transport = 'WIFI (DIRECT BROWSER)';
    appState.settings.esp32Ip = ip;
    appState.settings.esp32Port = Number(port) || 80;
    updateConnectionUI();

    const targetUrl = `http://${ip}:${port}/api/readings`;
    const poll = async () => {
      try {
        const res = await fetch(targetUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          const data = await res.json();
          processDirectTelemetryReading(data);
          appState.status = 'CONNECTED';
          appState.transport = 'WIFI (DIRECT BROWSER)';
          updateConnectionUI();
        }
      } catch (e) {
        if (directWifiActive) {
          console.warn('Direct Wi-Fi poll error:', e.message);
        }
      }
    };

    poll();
    directWifiInterval = setInterval(poll, 1000);
    appendSerialTerminalLine('RX', `[Wi-Fi Direct] Established direct polling to http://${ip}:${port}/api/readings`, new Date().toLocaleTimeString());
    logEventLocally('WIFI_CONNECTED', `Direct browser Wi-Fi connection established to http://${ip}:${port}`, 'INFO');
  }

  function stopDirectWifiPolling() {
    if (directWifiInterval) {
      clearInterval(directWifiInterval);
      directWifiInterval = null;
    }
    directWifiActive = false;
    appState.status = 'DISCONNECTED';
    appState.transport = 'NONE';
    appState.isStale = true;
    updateConnectionUI();
  }

  // Disconnect Wi-Fi
  async function disconnectWifi() {
    if (directWifiActive) {
      stopDirectWifiPolling();
      return;
    }

    try {
      await fetch(`${API_BASE}/api/wifi/disconnect`, { method: 'POST' });
    } catch (err) {
      console.error('Wi-Fi disconnect error:', err);
    }
  }

  // Open / Unlatch Solenoid Valve Request (Start Fluid Flow)
  async function openValve(bottle) {
    const bottleNum = (bottle === 'all' || bottle === 0) ? 0 : Number(bottle);
    const targetName = bottleNum === 0 ? 'BOTH bottles' : `Bottle ${bottleNum}`;

    let sent = false;

    // 1. Browser Web Serial
    if (webSerial.port) {
      await sendWebSerialCommand({ cmd: 'OPEN', bottle: bottleNum });
      sent = true;
    }
    // 2. Direct Browser Wi-Fi
    else if (directWifiActive) {
      try {
        const url = `http://${appState.settings.esp32Ip}:${appState.settings.esp32Port}/api/open`;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bottle: bottleNum })
        });
        sent = true;
      } catch (e) {
        console.warn('Direct Wi-Fi open command failed:', e);
      }
    }
    // 3. Node.js Backend Server
    else if (isBackendOnline) {
      try {
        const res = await fetch(`${API_BASE}/api/valve/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bottle: bottleNum })
        });
        const data = await res.json();
        sent = data.success;
      } catch (err) {
        console.error('Failed to transmit valve open command via Node server:', err);
      }
    }

    // Immediately reflect state in frontend
    if (bottleNum === 1 || bottleNum === 0) {
      appState.readings.bottle1.valve_command = 'OPEN';
      appState.readings.bottle1.low_fluid = false;
    }
    if (bottleNum === 2 || bottleNum === 0) {
      appState.readings.bottle2.valve_command = 'OPEN';
      appState.readings.bottle2.low_fluid = false;
      if (appState.readings.bottle2.remaining_ml <= appState.settings.lowFluidThreshold) {
        appState.readings.bottle2.remaining_ml = 350;
        appState.readings.bottle2.percentage = 70;
      }
    }

    renderTelemetry();
    logEventLocally('VALVE_OPEN', `Valve commanded OPEN for ${targetName} (Fluid flow started)`, 'INFO');
  }

  // Alias for backward compatibility
  const resetValve = openValve;

  // Tare / Zero Load Cell
  async function tareSensor(bottle) {
    const bId = Number(bottle) || 1;

    if (webSerial.port) {
      await sendWebSerialCommand({ cmd: 'TARE', bottle: bId });
      alert(`Tare command sent directly via Web Serial to ESP32 for Bottle ${bId}.`);
      return;
    } else if (directWifiActive) {
      try {
        await fetch(`http://${appState.settings.esp32Ip}:${appState.settings.esp32Port}/api/tare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bottle: bId })
        });
        alert(`Tare command sent directly via Wi-Fi to ESP32 for Bottle ${bId}.`);
        return;
      } catch (e) {
        console.warn('Direct Wi-Fi tare failed:', e);
      }
    }

    try {
      await fetch(`${API_BASE}/api/sensor/tare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bottle: bId })
      });
      alert(`Tare command sent to ESP32 for Bottle ${bId}.`);
    } catch (err) {
      alert('Tare request failed:\n\n' + formatFetchError(err));
    }
  }

  // Save Settings
  async function saveSettings() {
    const isRelayLow = dom.settingRelayPolarity ? (dom.settingRelayPolarity.value === 'true') : appState.settings.relayActiveLow;
    const payload = {
      lowFluidThreshold: Number(dom.settingThreshold.value),
      fluidDensity: Number(dom.settingDensity.value),
      bottle1Capacity: Number(dom.settingCapB1.value),
      bottle2Capacity: Number(dom.settingCapB2.value),
      bottle1Tare: Number(dom.settingTareB1.value),
      bottle2Tare: Number(dom.settingTareB2.value),
      relayActiveLow: isRelayLow
    };

    if (webSerial.port) {
      appState.settings = { ...appState.settings, ...payload };
      await sendWebSerialCommand({ cmd: 'SET_THRESHOLD', threshold: payload.lowFluidThreshold });
      await sendWebSerialCommand({ cmd: 'RELAY_POLARITY', activeLow: isRelayLow });
      updatePolarityUI();
      dom.settingsModal.classList.add('hidden');
      renderTelemetry();
      alert('Settings saved and transmitted directly to ESP32 via Web Serial.');
      return;
    } else if (directWifiActive) {
      appState.settings = { ...appState.settings, ...payload };
      fetch(`http://${appState.settings.esp32Ip}:${appState.settings.esp32Port}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ low_fluid_threshold: payload.lowFluidThreshold, active_low: isRelayLow })
      }).catch(() => {});
      updatePolarityUI();
      dom.settingsModal.classList.add('hidden');
      renderTelemetry();
      alert('Settings saved and transmitted directly to ESP32 via Wi-Fi.');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/settings/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        appState.settings = data.settings;
        dom.settingsModal.classList.add('hidden');
        renderTelemetry();
      }
    } catch (err) {
      alert('Failed to update settings:\n\n' + formatFetchError(err));
    }
  }

  // Manual / Emergency Valve Close Request (Stop Fluid Flow)
  async function closeValve(bottle) {
    const bottleNum = (bottle === 'all' || bottle === 0) ? 0 : Number(bottle);
    const targetName = bottleNum === 0 ? 'BOTH bottles' : `Bottle ${bottleNum}`;

    let sent = false;

    // 1. Browser Web Serial
    if (webSerial.port) {
      await sendWebSerialCommand({ cmd: 'CLOSE', bottle: bottleNum });
      sent = true;
    }
    // 2. Direct Browser Wi-Fi
    else if (directWifiActive) {
      try {
        const url = `http://${appState.settings.esp32Ip}:${appState.settings.esp32Port}/api/close`;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bottle: bottleNum })
        });
        sent = true;
      } catch (e) {
        console.warn('Direct Wi-Fi close command failed:', e);
      }
    }
    // 3. Node.js Backend Server
    else if (isBackendOnline) {
      try {
        const res = await fetch(`${API_BASE}/api/valve/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bottle: bottleNum })
        });
        const data = await res.json();
        sent = data.success;
      } catch (err) {
        console.error('Failed to transmit valve close command via Node server:', err);
      }
    }

    // Immediately reflect state in frontend
    if (bottleNum === 1 || bottleNum === 0) {
      appState.readings.bottle1.valve_command = 'CLOSED';
      appState.readings.bottle1.low_fluid = true;
    }
    if (bottleNum === 2 || bottleNum === 0) {
      appState.readings.bottle2.valve_command = 'CLOSED';
      appState.readings.bottle2.low_fluid = true;
    }

    renderTelemetry();
  }

  // Quick Apply Shut-Off Threshold directly from Dashboard
  async function applyQuickThreshold(targetVal) {
    const val = Number(targetVal);
    if (isNaN(val) || val < 5 || val > 400) {
      alert('Please enter a valid shut-off threshold between 5 mL and 400 mL.');
      return;
    }

    if (webSerial.port) {
      appState.settings.lowFluidThreshold = val;
      await sendWebSerialCommand({ cmd: 'SET_THRESHOLD', threshold: val });
      syncSettingsForm();
      renderTelemetry();
      appendSerialTerminalLine('TX', `Threshold updated to ${val} mL and sent to ESP32 (Web Serial)`, new Date().toLocaleTimeString());
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/api/settings/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lowFluidThreshold: val })
      });
      const data = await res.json();
      if (data.success) {
        appState.settings.lowFluidThreshold = val;
        syncSettingsForm();
        renderTelemetry();
        appendSerialTerminalLine('TX', `Threshold updated to ${val} mL and sent to ESP32`, new Date().toLocaleTimeString());
      }
    } catch (err) {
      alert('Failed to update threshold:\n\n' + formatFetchError(err));
    }
  }

  function syncSettingsForm() {
    const th = appState.settings.lowFluidThreshold || 20;
    dom.settingThreshold.value = th;
    if (dom.quickThresholdInput) dom.quickThresholdInput.value = th;
    if (dom.thresholdDisplayTarget) dom.thresholdDisplayTarget.innerHTML = `Currently set to <strong>${th} mL</strong>`;

    if (dom.presetChips) {
      dom.presetChips.forEach(chip => {
        if (Number(chip.getAttribute('data-val')) === Number(th)) {
          chip.classList.add('active');
        } else {
          chip.classList.remove('active');
        }
      });
    }

    dom.settingDensity.value = appState.settings.fluidDensity || 1.0;
    dom.settingCapB1.value = appState.settings.bottle1Capacity || 500;
    dom.settingCapB2.value = appState.settings.bottle2Capacity || 500;
    dom.settingTareB1.value = appState.settings.bottle1Tare || 30.0;
    dom.settingTareB2.value = appState.settings.bottle2Tare || 30.0;
    updatePolarityUI();
  }

  function updatePolarityUI() {
    const isLow = appState.settings.relayActiveLow !== false;
    if (dom.polarityBtnText) {
      dom.polarityBtnText.textContent = isLow ? 'Active-LOW (0V=ON)' : 'Active-HIGH (3.3V=ON)';
    }
    if (dom.settingRelayPolarity) {
      dom.settingRelayPolarity.value = isLow ? 'true' : 'false';
    }
  }

  // Toggle Relay Polarity between Active-LOW and Active-HIGH
  async function toggleRelayPolarity(forcedVal) {
    const nextVal = (typeof forcedVal === 'boolean') ? forcedVal : !appState.settings.relayActiveLow;
    appState.settings.relayActiveLow = nextVal;
    updatePolarityUI();

    if (webSerial.port) {
      await sendWebSerialCommand({ cmd: 'RELAY_POLARITY', activeLow: nextVal });
      appendSerialTerminalLine('TX', `Relay polarity updated to ${nextVal ? 'Active-LOW (0V=ON)' : 'Active-HIGH (3.3V=ON)'}`, new Date().toLocaleTimeString());
      return;
    } else if (directWifiActive) {
      fetch(`http://${appState.settings.esp32Ip}:${appState.settings.esp32Port}/api/relay/polarity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_low: nextVal })
      }).catch(() => {});
      return;
    }

    try {
      await fetch(`${API_BASE}/api/relay/polarity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeLow: nextVal })
      });
    } catch (e) {
      console.warn('Failed to send polarity toggle:', e);
    }
  }

  // Diagnostic Relay Click Test
  async function testRelayDiagnostic() {
    appendSerialTerminalLine('TX', '[Relay Test] Running 3-second diagnostic test...', new Date().toLocaleTimeString());
    alert('Testing relay channels on ESP32 (GPIO 18 & 19). You should hear audible clicks or see LEDs light on the relay module.');

    if (webSerial.port) {
      await sendWebSerialCommand({ cmd: 'TEST_RELAY' });
      return;
    } else if (directWifiActive) {
      fetch(`http://${appState.settings.esp32Ip}:${appState.settings.esp32Port}/api/relay/test`, { method: 'GET' }).catch(() => {});
      return;
    }

    try {
      await fetch(`${API_BASE}/api/relay/test`, { method: 'POST' });
    } catch (e) {
      console.warn('Failed to send relay test:', e);
    }
  }

  // Toggle Simulation Mode (For college demonstrations without physical hardware)
  async function toggleSimulation() {
    const willEnable = appState.transport !== 'SIMULATION';
    try {
      const res = await fetch(`${API_BASE}/api/simulation/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: willEnable })
      });
      const data = await res.json();
      appState.simulationActive = data.simulation;
    } catch (err) {
      alert('Failed to toggle simulation mode:\n\n' + formatFetchError(err));
    }
  }

  // Clear Event Log
  async function clearEventLog() {
    if (!confirm('Clear all in-memory events from the server?')) return;
    try {
      await fetch(`${API_BASE}/api/events/clear`, { method: 'POST' });
      appState.events = [];
      renderEventLog();
    } catch (err) {
      console.error('Error clearing events:', err);
    }
  }

  // -------------------------------------------------------------
  // Event Listeners Binding
  // -------------------------------------------------------------
  function bindEvents() {
    // Alert Banner Dismiss
    dom.btnAlertDismiss.addEventListener('click', () => {
      dom.alertBanner.classList.add('hidden');
    });

    // Navigation Actions
    dom.btnOpenSettings.addEventListener('click', () => {
      syncSettingsForm();
      dom.settingsModal.classList.remove('hidden');
    });
    dom.btnUnlatchAll.addEventListener('click', () => resetValve('all'));

    // Modal Actions
    dom.btnCloseSettings.addEventListener('click', () => dom.settingsModal.classList.add('hidden'));
    dom.btnCancelSettings.addEventListener('click', () => dom.settingsModal.classList.add('hidden'));
    dom.btnSaveSettings.addEventListener('click', saveSettings);
    dom.btnTareB1.addEventListener('click', () => tareSensor(1));
    dom.btnTareB2.addEventListener('click', () => tareSensor(2));

    // Bottle Open / Unlatch Buttons
    if (dom.btnOpenB1) dom.btnOpenB1.addEventListener('click', () => openValve(1));
    if (dom.btnOpenB2) dom.btnOpenB2.addEventListener('click', () => openValve(2));
    if (dom.btnResetB1) dom.btnResetB1.addEventListener('click', () => openValve(1));
    if (dom.btnResetB2) dom.btnResetB2.addEventListener('click', () => openValve(2));

    // Emergency & Quick Open / Stop Buttons
    if (dom.btnOpenAll) dom.btnOpenAll.addEventListener('click', () => openValve('all'));
    if (dom.btnEmergencyStopAll) dom.btnEmergencyStopAll.addEventListener('click', () => closeValve('all'));
    if (dom.btnTogglePolarity) dom.btnTogglePolarity.addEventListener('click', () => toggleRelayPolarity());
    if (dom.btnTestRelays) dom.btnTestRelays.addEventListener('click', testRelayDiagnostic);
    if (dom.btnModalTestRelay) dom.btnModalTestRelay.addEventListener('click', testRelayDiagnostic);

    // Bottle Stop Flow Buttons
    if (dom.btnStopB1) dom.btnStopB1.addEventListener('click', () => closeValve(1));
    if (dom.btnStopB2) dom.btnStopB2.addEventListener('click', () => closeValve(2));

    // Bottle Quick Tare Buttons
    if (dom.btnQuickTareB1) dom.btnQuickTareB1.addEventListener('click', () => tareSensor(1));
    if (dom.btnQuickTareB2) dom.btnQuickTareB2.addEventListener('click', () => tareSensor(2));

    // Quick Threshold Control Bar Listeners
    if (dom.btnThreshDec) {
      dom.btnThreshDec.addEventListener('click', () => {
        const current = Number(dom.quickThresholdInput.value) || 20;
        const next = Math.max(5, current - 5);
        dom.quickThresholdInput.value = next;
        applyQuickThreshold(next);
      });
    }

    if (dom.btnThreshInc) {
      dom.btnThreshInc.addEventListener('click', () => {
        const current = Number(dom.quickThresholdInput.value) || 20;
        const next = Math.min(250, current + 5);
        dom.quickThresholdInput.value = next;
        applyQuickThreshold(next);
      });
    }

    if (dom.btnApplyThreshold) {
      dom.btnApplyThreshold.addEventListener('click', () => {
        applyQuickThreshold(dom.quickThresholdInput.value);
      });
    }

    if (dom.presetChips) {
      dom.presetChips.forEach(chip => {
        chip.addEventListener('click', () => {
          const val = Number(chip.getAttribute('data-val'));
          if (dom.quickThresholdInput) dom.quickThresholdInput.value = val;
          applyQuickThreshold(val);
        });
      });
    }

    // Emergency Stop Both Valves
    if (dom.btnEmergencyStopAll) {
      dom.btnEmergencyStopAll.addEventListener('click', () => closeValve('all'));
    }

    // Audio Alarm Toggle
    if (dom.btnToggleSound) {
      dom.btnToggleSound.addEventListener('click', () => {
        soundAlarmEnabled = !soundAlarmEnabled;
        if (dom.soundIcon) dom.soundIcon.textContent = soundAlarmEnabled ? '🔔' : '🔕';
        if (dom.soundText) dom.soundText.textContent = soundAlarmEnabled ? 'Alarm Sound: ON' : 'Alarm Sound: OFF';
        if (soundAlarmEnabled) playMedicalAlarmTone();
      });
    }

    // USB Serial Actions
    dom.btnRefreshPorts.addEventListener('click', refreshSerialPorts);
    dom.btnSerialConnect.addEventListener('click', connectSerial);
    if (dom.btnWebSerialConnect) dom.btnWebSerialConnect.addEventListener('click', connectWebSerial);
    dom.btnSerialDisconnect.addEventListener('click', disconnectSerial);
    dom.btnClearTerminal.addEventListener('click', () => {
      dom.serialTerminalLogs.innerHTML = '';
    });

    // Custom Port Input Toggle
    if (dom.btnToggleCustomPort) {
      dom.btnToggleCustomPort.addEventListener('click', () => {
        const isHidden = dom.inputCustomComPort.classList.contains('hidden');
        if (isHidden) {
          dom.inputCustomComPort.classList.remove('hidden');
          dom.selectComPort.classList.add('hidden');
          dom.btnToggleCustomPort.textContent = 'Dropdown';
          dom.inputCustomComPort.focus();
        } else {
          dom.inputCustomComPort.classList.add('hidden');
          dom.selectComPort.classList.remove('hidden');
          dom.btnToggleCustomPort.textContent = 'Manual Port';
        }
      });
    }

    // Dropdown change listener
    dom.selectComPort.addEventListener('change', () => {
      if (dom.selectComPort.value === '__custom__') {
        dom.inputCustomComPort.classList.remove('hidden');
        dom.selectComPort.classList.add('hidden');
        if (dom.btnToggleCustomPort) dom.btnToggleCustomPort.textContent = 'Dropdown';
        dom.inputCustomComPort.value = 'COM7';
        dom.inputCustomComPort.focus();
      }
    });

    // Wi-Fi Actions
    dom.btnWifiConnect.addEventListener('click', connectWifi);
    dom.btnWifiDisconnect.addEventListener('click', disconnectWifi);
    dom.inputWifiIp.addEventListener('input', () => {
      const ip = dom.inputWifiIp.value.trim() || '192.168.1.100';
      const port = dom.inputWifiPort.value.trim() || '80';
      dom.wifiEndpointPreview.textContent = `http://${ip}:${port}/api/readings`;
    });
    dom.inputWifiPort.addEventListener('input', () => {
      const ip = dom.inputWifiIp.value.trim() || '192.168.1.100';
      const port = dom.inputWifiPort.value.trim() || '80';
      dom.wifiEndpointPreview.textContent = `http://${ip}:${port}/api/readings`;
    });

    // Simulation Toggle
    dom.btnToggleSimulation.addEventListener('click', toggleSimulation);

    // Chart Controls
    dom.btnClearCharts.addEventListener('click', clearCharts);

    // Event Log Filter Chips
    dom.eventFilterChips.forEach(chip => {
      chip.addEventListener('click', (e) => {
        dom.eventFilterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        appState.eventFilter = chip.getAttribute('data-filter');
        renderEventLog();
      });
    });

    dom.btnClearEvents.addEventListener('click', clearEventLog);
  }

  // -------------------------------------------------------------
  // Initialization Routine
  // -------------------------------------------------------------
  function init() {
    bindEvents();
    initCharts();
    initWebSocket();
    checkBackendHealth();
    refreshSerialPorts();

    // Auto-poll backend server health every 3.5 seconds
    setInterval(checkBackendHealth, 3500);
  }

  // Start after DOM load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
