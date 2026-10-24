/**
 * Smart IV Fluid Monitoring System - Node.js Backend Server
 * 
 * Features:
 * - Express.js REST API
 * - WebSocket server for real-time telemetry streaming
 * - SerialPort with ReadlineParser for USB serial communication
 * - Wi-Fi HTTP polling client for ESP32 IP communication
 * - In-memory chart history (max 300 records) and event log (max 200 records)
 * - Safe transport switching (Serial <-> Wi-Fi) with no conflicting connections
 * - Built-in simulation harness for demonstration & testing without hardware
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.json());

// Enable CORS for IDE Live Server / Five Server development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// In-Memory State (Cleared on server restart - No DB used)
// -------------------------------------------------------------
const state = {
  transport: 'NONE', // 'NONE' | 'SERIAL' | 'WIFI' | 'SIMULATION'
  status: 'DISCONNECTED', // 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'ERROR'
  errorMessage: null,
  lastUpdated: null,
  isStale: true,
  settings: {
    bottle1Capacity: 500,
    bottle2Capacity: 500,
    lowFluidThreshold: 20,
    serialBaudRate: 115200,
    esp32Ip: '192.168.1.100',
    esp32Port: 80,
    chartHistoryLimit: 300,
    fluidDensity: 1.0, // g/mL for water
    bottle1Tare: 30.0, // empty container grams
    bottle2Tare: 30.0
  },
  readings: {
    device: 'ESP32',
    timestamp: 0,
    bottle1: {
      weight_g: 0.0,
      fluid_g: 0.0,
      remaining_ml: 0.0,
      percentage: 0.0,
      valve_command: 'OPEN',
      sensor_ok: false,
      calibrated: true,
      low_fluid: false
    },
    bottle2: {
      weight_g: 0.0,
      fluid_g: 0.0,
      remaining_ml: 0.0,
      percentage: 0.0,
      valve_command: 'OPEN',
      sensor_ok: false,
      calibrated: true,
      low_fluid: false
    }
  }
};

const chartHistory = []; // Bounded array, max 300
const eventLog = []; // Bounded array, max 200

// Active hardware handles
let activeSerialPort = null;
let activeSerialParser = null;
let activeWifiInterval = null;
let lastDataReceiptTime = 0;
let simulationInterval = null;

// Helper: Add Event to in-memory log
function logEvent(type, message, severity = 'INFO') {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).substr(2, 5),
    timestamp: new Date().toISOString(),
    type,
    message,
    severity // 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'
  };

  eventLog.unshift(entry);
  if (eventLog.length > 200) {
    eventLog.pop();
  }

  // Broadcast event to WebSocket clients
  broadcast({
    type: 'EVENT_LOG',
    event: entry
  });

  console.log(`[${entry.severity}] ${entry.type}: ${entry.message}`);
}

// Helper: Broadcast to all connected WebSocket clients
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// Helper: Process and validate incoming ESP32 sensor reading
function handleIncomingReading(json) {
  if (!json || typeof json !== 'object') {
    logEvent('SENSOR_ERROR', 'Received invalid non-object payload from ESP32', 'ERROR');
    return false;
  }

  const now = Date.now();
  lastDataReceiptTime = now;
  state.lastUpdated = new Date().toISOString();
  state.isStale = false;
  state.status = 'CONNECTED';

  const prevB1Low = state.readings.bottle1.low_fluid;
  const prevB2Low = state.readings.bottle2.low_fluid;
  const prevB1Valve = state.readings.bottle1.valve_command;
  const prevB2Valve = state.readings.bottle2.valve_command;

  // Validate and sanitize Bottle 1
  if (json.bottle1) {
    const b1 = json.bottle1;
    const remaining_ml = Number(b1.remaining_ml) || 0;
    const capacity = state.settings.bottle1Capacity || 500;
    const pct = Math.max(0, Math.min(100, (remaining_ml / capacity) * 100));
    const isSensorOk = b1.sensor_ok !== false;

    state.readings.bottle1 = {
      weight_g: Number(b1.weight_g) || 0,
      fluid_g: Number(b1.fluid_g) || (Number(b1.remaining_ml) * state.settings.fluidDensity) || 0,
      remaining_ml: remaining_ml,
      percentage: Number(pct.toFixed(1)),
      valve_command: b1.valve_command === 'CLOSED' ? 'CLOSED' : 'OPEN',
      sensor_ok: isSensorOk,
      calibrated: b1.calibrated !== false,
      low_fluid: isSensorOk && (remaining_ml <= state.settings.lowFluidThreshold || b1.low_fluid === true)
    };
  }

  // Validate and sanitize Bottle 2
  if (json.bottle2) {
    const b2 = json.bottle2;
    const remaining_ml = Number(b2.remaining_ml) || 0;
    const capacity = state.settings.bottle2Capacity || 500;
    const pct = Math.max(0, Math.min(100, (remaining_ml / capacity) * 100));
    const isSensorOk = b2.sensor_ok !== false;

    state.readings.bottle2 = {
      weight_g: Number(b2.weight_g) || 0,
      fluid_g: Number(b2.fluid_g) || (Number(b2.remaining_ml) * state.settings.fluidDensity) || 0,
      remaining_ml: remaining_ml,
      percentage: Number(pct.toFixed(1)),
      valve_command: b2.valve_command === 'CLOSED' ? 'CLOSED' : 'OPEN',
      sensor_ok: isSensorOk,
      calibrated: b2.calibrated !== false,
      low_fluid: isSensorOk && (remaining_ml <= state.settings.lowFluidThreshold || b2.low_fluid === true)
    };
  }

  // Record history point for live line charts
  const historyPoint = {
    timestamp: new Date().toLocaleTimeString(),
    b1_ml: state.readings.bottle1.remaining_ml,
    b2_ml: state.readings.bottle2.remaining_ml,
    b1_g: state.readings.bottle1.fluid_g,
    b2_g: state.readings.bottle2.fluid_g
  };

  chartHistory.push(historyPoint);
  if (chartHistory.length > (state.settings.chartHistoryLimit || 300)) {
    chartHistory.shift();
  }

  // Check state transitions for event logging
  if (!prevB1Low && state.readings.bottle1.low_fluid) {
    logEvent('LOW_FLUID_WARNING', `Bottle 1 fluid level dropped to ${state.readings.bottle1.remaining_ml.toFixed(1)} mL (threshold: ${state.settings.lowFluidThreshold} mL)`, 'CRITICAL');
  }
  if (!prevB2Low && state.readings.bottle2.low_fluid) {
    logEvent('LOW_FLUID_WARNING', `Bottle 2 fluid level dropped to ${state.readings.bottle2.remaining_ml.toFixed(1)} mL (threshold: ${state.settings.lowFluidThreshold} mL)`, 'CRITICAL');
  }

  if (prevB1Valve !== 'CLOSED' && state.readings.bottle1.valve_command === 'CLOSED') {
    logEvent('VALVE_SHUT_OFF', 'Valve 1 automatically COMMANDED CLOSED by ESP32 safety logic', 'CRITICAL');
  }
  if (prevB2Valve !== 'CLOSED' && state.readings.bottle2.valve_command === 'CLOSED') {
    logEvent('VALVE_SHUT_OFF', 'Valve 2 automatically COMMANDED CLOSED by ESP32 safety logic', 'CRITICAL');
  }

  const prevB1SensorOk = state.readings.bottle1.sensor_ok;
  const prevB2SensorOk = state.readings.bottle2.sensor_ok;

  // Sensor OK fault detection (logged only on status change to avoid flooding)
  if (prevB1SensorOk && json.bottle1 && json.bottle1.sensor_ok === false) {
    logEvent('SENSOR_FAULT', 'Bottle 1 load cell reports sensor fault or unstable reading', 'ERROR');
  } else if (!prevB1SensorOk && json.bottle1 && json.bottle1.sensor_ok === true) {
    logEvent('SENSOR_RECOVERED', 'Bottle 1 load cell connection normalized', 'INFO');
  }

  if (prevB2SensorOk && json.bottle2 && json.bottle2.sensor_ok === false) {
    logEvent('SENSOR_FAULT', 'Bottle 2 load cell reports sensor fault or unstable reading', 'ERROR');
  } else if (!prevB2SensorOk && json.bottle2 && json.bottle2.sensor_ok === true) {
    logEvent('SENSOR_RECOVERED', 'Bottle 2 load cell connection normalized', 'INFO');
  }

  // Broadcast real-time telemetry update to all connected frontend clients
  broadcast({
    type: 'TELEMETRY_UPDATE',
    status: state.status,
    transport: state.transport,
    isStale: state.isStale,
    readings: state.readings,
    historyPoint
  });

  return true;
}

// Watchdog: detect stale data if no message received within 3.5 seconds
setInterval(() => {
  if (state.status === 'CONNECTED' && state.transport !== 'NONE') {
    const elapsed = Date.now() - lastDataReceiptTime;
    if (elapsed > 3500 && !state.isStale) {
      state.isStale = true;
      logEvent('DATA_STALE', `No incoming sensor packets received for ${(elapsed / 1000).toFixed(1)}s. Readings marked stale.`, 'WARN');
      broadcast({
        type: 'STATUS_UPDATE',
        status: state.status,
        transport: state.transport,
        isStale: true
      });
    }
  }
}, 1000);

// -------------------------------------------------------------
// USB Serial Connection Logic
// -------------------------------------------------------------
async function closeActiveSerial() {
  return new Promise((resolve) => {
    if (!activeSerialPort) return resolve();
    const port = activeSerialPort;
    activeSerialPort = null;
    activeSerialParser = null;

    if (port.isOpen) {
      port.close((err) => {
        if (err) console.error('Error closing serial port:', err);
        resolve();
      });
    } else {
      resolve();
    }
  });
}

async function closeActiveWifi() {
  if (activeWifiInterval) {
    clearInterval(activeWifiInterval);
    activeWifiInterval = null;
  }
}

function stopSimulation() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
}

// Disconnect all transports cleanly
async function disconnectAllTransports() {
  stopSimulation();
  await closeActiveSerial();
  await closeActiveWifi();
  state.transport = 'NONE';
  state.status = 'DISCONNECTED';
  state.isStale = true;
}

// -------------------------------------------------------------
// REST API Endpoints
// -------------------------------------------------------------

// 1. Get system status & snapshot
app.get('/api/status', (req, res) => {
  res.json({
    status: state.status,
    transport: state.transport,
    isStale: state.isStale,
    lastUpdated: state.lastUpdated,
    settings: state.settings,
    readings: state.readings,
    clientCount: wss.clients.size
  });
});

// 2. Get live chart history
app.get('/api/history', (req, res) => {
  res.json({
    history: chartHistory
  });
});

// 3. Get event log
app.get('/api/events', (req, res) => {
  res.json({
    events: eventLog
  });
});

// 4. Clear event log
app.post('/api/events/clear', (req, res) => {
  eventLog.length = 0;
  logEvent('SYSTEM', 'In-memory event log cleared by user', 'INFO');
  res.json({ success: true, message: 'Event log cleared' });
});

// 4b. Health Check Endpoint
app.get(['/api/health', '/api/server/health'], (req, res) => {
  res.json({
    success: true,
    status: 'ONLINE',
    uptime: process.uptime(),
    transport: state.transport,
    connected: state.status === 'CONNECTED',
    serverTime: new Date().toISOString()
  });
});

// 5. USB Serial: List available ports
app.get('/api/serial/ports', async (req, res) => {
  let formatted = [];
  try {
    const ports = await SerialPort.list();
    if (Array.isArray(ports)) {
      formatted = ports.map(p => {
        const name = (p.friendlyName || p.path || '').toString();
        const mfg = (p.manufacturer || '').toString();
        const pnp = (p.pnpId || '').toString();
        const isEsp = /CP210|Silicon Labs|CH340|CH341|FTDI|USB-SERIAL|ESP/i.test(`${name} ${mfg} ${pnp}`);
        return {
          path: p.path,
          manufacturer: mfg || 'Unknown',
          friendlyName: name,
          pnpId: pnp,
          isEsp32: isEsp
        };
      });
    }
  } catch (err) {
    console.warn('SerialPort.list() error, attempting Windows fallback:', err.message);
  }

  // Windows fallback if list is empty or threw an error
  if (formatted.length === 0 && process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const raw = execSync('powershell.exe -NoProfile -Command "Get-CimInstance Win32_SerialPort | Select-Object DeviceID, Caption, PNPDeviceID | ConvertTo-Json -Compress"', { timeout: 4000 }).toString().trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        formatted = items.map(it => {
          const caption = (it.Caption || it.DeviceID || '').toString();
          const pnp = (it.PNPDeviceID || '').toString();
          const isEsp = /CP210|Silicon Labs|CH340|CH341|FTDI|USB-SERIAL|ESP/i.test(`${caption} ${pnp}`);
          return {
            path: it.DeviceID,
            manufacturer: 'Windows Serial Device',
            friendlyName: caption,
            pnpId: pnp,
            isEsp32: isEsp
          };
        });
      }
    } catch (winErr) {
      console.warn('Windows PowerShell port fallback failed:', winErr.message);
    }
  }

  // If still empty, check [System.IO.Ports.SerialPort]::GetPortNames()
  if (formatted.length === 0 && process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const raw = execSync('powershell.exe -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames()"', { timeout: 3000 }).toString().trim();
      if (raw) {
        const portNames = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        formatted = portNames.map(p => ({
          path: p,
          manufacturer: 'Serial Port',
          friendlyName: `${p} (System Serial Port)`,
          pnpId: '',
          isEsp32: p === 'COM7' // Known ESP32 port on this device
        }));
      }
    } catch (_) {}
  }

  // Sort so ESP32 devices come first
  formatted.sort((a, b) => (b.isEsp32 ? 1 : 0) - (a.isEsp32 ? 1 : 0));
  res.json({ success: true, ports: formatted });
});

// 6. USB Serial: Connect to port
app.post('/api/serial/connect', async (req, res) => {
  const { path: portPath, baudRate } = req.body;
  if (!portPath) {
    return res.status(400).json({ success: false, message: 'COM port path is required' });
  }

  const baud = Number(baudRate) || state.settings.serialBaudRate || 115200;

  try {
    // Cleanly close any existing transport first
    await disconnectAllTransports();

    state.status = 'CONNECTING';
    state.transport = 'SERIAL';
    state.errorMessage = null;

    logEvent('SERIAL_CONNECTING', `Opening USB serial connection on ${portPath} at ${baud} baud...`, 'INFO');
    broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport });

    const port = new SerialPort({
      path: portPath,
      baudRate: baud,
      autoOpen: false
    });

    port.open((err) => {
      if (err) {
        state.status = 'ERROR';
        state.transport = 'NONE';
        let friendlyMsg = err.message;
        if (err.message.includes('Access denied') || err.message.includes('EBUSY')) {
          friendlyMsg = `Port ${portPath} is busy (Access denied). The Arduino IDE Serial Monitor is likely open and holding the port. Please CLOSE the Serial Monitor in Arduino IDE and try connecting again.`;
        }
        state.errorMessage = friendlyMsg;
        logEvent('SERIAL_ERROR', friendlyMsg, 'ERROR');
        broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport, error: friendlyMsg });
        return;
      }

      activeSerialPort = port;
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      activeSerialParser = parser;

      logEvent('SERIAL_CONNECTED', `USB serial port ${portPath} opened successfully. Awaiting ESP32 JSON data...`, 'INFO');

      parser.on('data', (rawLine) => {
        const line = rawLine.toString().trim();
        if (!line) return;

        // Broadcast raw serial line to UI serial monitor terminal
        broadcast({
          type: 'SERIAL_RAW',
          direction: 'RX',
          data: line,
          timestamp: new Date().toLocaleTimeString()
        });

        // Parse JSON
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            const parsed = JSON.parse(line);
            handleIncomingReading(parsed);
          } catch (jsonErr) {
            console.warn('Malformed JSON received on serial:', line);
            logEvent('SERIAL_PARSE_ERROR', `Malformed JSON: ${line.substring(0, 80)}`, 'WARN');
          }
        }
      });

      port.on('error', (portErr) => {
        console.error('Serial port runtime error:', portErr);
        state.status = 'ERROR';
        state.isStale = true;
        logEvent('SERIAL_ERROR', `Runtime serial error: ${portErr.message}`, 'ERROR');
        broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport, error: portErr.message });
      });

      port.on('close', () => {
        logEvent('SERIAL_DISCONNECTED', `USB serial connection on ${portPath} closed`, 'WARN');
        activeSerialPort = null;
        activeSerialParser = null;
        state.status = 'DISCONNECTED';
        state.transport = 'NONE';
        state.isStale = true;
        broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport });
      });
    });

    res.json({ success: true, message: `Connecting to ${portPath} at ${baud} baud...` });
  } catch (err) {
    state.status = 'ERROR';
    state.errorMessage = err.message;
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. USB Serial: Disconnect
app.post('/api/serial/disconnect', async (req, res) => {
  await disconnectAllTransports();
  logEvent('SERIAL_DISCONNECTED', 'USB Serial manually disconnected by user', 'INFO');
  broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport });
  res.json({ success: true, message: 'USB Serial disconnected' });
});

// 8. Wi-Fi IP: Connect
app.post('/api/wifi/connect', async (req, res) => {
  const { ip, port: portNum } = req.body;
  if (!ip || !ip.trim()) {
    return res.status(400).json({ success: false, message: 'Valid ESP32 IP address is required' });
  }

  const sanitizedIp = ip.trim();
  const port = Number(portNum) || 80;

  try {
    await disconnectAllTransports();

    state.status = 'CONNECTING';
    state.transport = 'WIFI';
    state.errorMessage = null;
    state.settings.esp32Ip = sanitizedIp;
    state.settings.esp32Port = port;

    logEvent('WIFI_CONNECTING', `Connecting to ESP32 at http://${sanitizedIp}:${port}...`, 'INFO');
    broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport });

    const targetUrl = `http://${sanitizedIp}:${port}/api/readings`;

    // Polling function
    const fetchReadings = async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(targetUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        handleIncomingReading(data);
      } catch (pollErr) {
        if (state.transport === 'WIFI') {
          // Log wifi error
          logEvent('WIFI_ERROR', `Failed to poll ESP32 at ${targetUrl}: ${pollErr.message}`, 'WARN');
        }
      }
    };

    // Immediate first probe
    fetchReadings();

    // Regular 1000ms polling interval
    activeWifiInterval = setInterval(fetchReadings, 1000);

    res.json({ success: true, message: `Wi-Fi polling active for http://${sanitizedIp}:${port}` });
  } catch (err) {
    state.status = 'ERROR';
    state.errorMessage = err.message;
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Wi-Fi IP: Disconnect
app.post('/api/wifi/disconnect', async (req, res) => {
  await disconnectAllTransports();
  logEvent('WIFI_DISCONNECTED', 'Wi-Fi polling manually stopped by user', 'INFO');
  broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport });
  res.json({ success: true, message: 'Wi-Fi connection disconnected' });
});

// 10. Manual Valve Open / Reset Command (Requests unlatching and starts fluid flow)
app.post(['/api/valve/open', '/api/valve/reset'], async (req, res) => {
  const rawBottle = req.body.bottle;
  let bottleId = 0; // 0 = all
  if (rawBottle === 1 || rawBottle === '1') bottleId = 1;
  else if (rawBottle === 2 || rawBottle === '2') bottleId = 2;
  else bottleId = 0;

  const targetLabel = bottleId === 0 ? 'BOTH Bottles' : `Bottle ${bottleId}`;
  logEvent('VALVE_OPEN_REQUESTED', `User commanded valve OPEN for ${targetLabel}`, 'INFO');

  let sent = false;

  // Send command through active transport
  if (state.transport === 'SERIAL' && activeSerialPort && activeSerialPort.isOpen) {
    const cmdStr = JSON.stringify({ cmd: 'OPEN', bottle: bottleId }) + '\n';
    activeSerialPort.write(cmdStr);
    broadcast({ type: 'SERIAL_RAW', direction: 'TX', data: cmdStr.trim(), timestamp: new Date().toLocaleTimeString() });
    sent = true;
  } else if (state.transport === 'WIFI') {
    try {
      const url = `http://${state.settings.esp32Ip}:${state.settings.esp32Port}/api/open`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bottle: bottleId })
      });
      sent = true;
    } catch (err) {
      // Fallback to /api/reset for older firmware
      try {
        const fallbackUrl = `http://${state.settings.esp32Ip}:${state.settings.esp32Port}/api/reset`;
        await fetch(fallbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bottle: bottleId })
        });
        sent = true;
      } catch (fbErr) {
        logEvent('OPEN_FAILED', `Failed to deliver valve open command via Wi-Fi: ${err.message}`, 'ERROR');
      }
    }
  }

  // Reflect OPEN state in memory immediately
  if (bottleId === 1 || bottleId === 0) {
    state.readings.bottle1.valve_command = 'OPEN';
    state.readings.bottle1.low_fluid = false;
    if (state.transport === 'SIMULATION') {
      state.readings.bottle1.remaining_ml = 450;
    }
  }
  if (bottleId === 2 || bottleId === 0) {
    state.readings.bottle2.valve_command = 'OPEN';
    state.readings.bottle2.low_fluid = false;
    if (state.transport === 'SIMULATION') {
      state.readings.bottle2.remaining_ml = 450;
    }
  }

  broadcast({
    type: 'TELEMETRY_UPDATE',
    status: state.status,
    transport: state.transport,
    isStale: false,
    readings: state.readings
  });

  res.json({
    success: true,
    message: `Valve commanded OPEN for ${targetLabel}`,
    bottleId,
    transportSent: sent ? state.transport : 'NONE'
  });
});

// 10b. Emergency / Manual Valve Shut-off Command (Stop Fluid Flow)
app.post('/api/valve/close', async (req, res) => {
  const rawBottle = req.body.bottle;
  let bottleId = 0; // 0 = all
  if (rawBottle === 1 || rawBottle === '1') bottleId = 1;
  else if (rawBottle === 2 || rawBottle === '2') bottleId = 2;
  else bottleId = 0;

  const targetLabel = bottleId === 0 ? 'BOTH Bottles' : `Bottle ${bottleId}`;
  logEvent('VALVE_SHUT_OFF', `User issued manual fluid stop for ${targetLabel}`, 'CRITICAL');

  let sent = false;

  if (state.transport === 'SERIAL' && activeSerialPort && activeSerialPort.isOpen) {
    const cmdStr = JSON.stringify({ cmd: 'CLOSE', bottle: bottleId }) + '\n';
    activeSerialPort.write(cmdStr);
    broadcast({ type: 'SERIAL_RAW', direction: 'TX', data: cmdStr.trim(), timestamp: new Date().toLocaleTimeString() });
    sent = true;
  } else if (state.transport === 'WIFI') {
    try {
      const url = `http://${state.settings.esp32Ip}:${state.settings.esp32Port}/api/close`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bottle: bottleId })
      });
      sent = true;
    } catch (err) {
      logEvent('CLOSE_FAILED', `Failed to deliver valve close command via Wi-Fi: ${err.message}`, 'ERROR');
    }
  }

  // Always reflect state immediately
  if (bottleId === 1 || bottleId === 0) {
    state.readings.bottle1.valve_command = 'CLOSED';
    state.readings.bottle1.low_fluid = true;
  }
  if (bottleId === 2 || bottleId === 0) {
    state.readings.bottle2.valve_command = 'CLOSED';
    state.readings.bottle2.low_fluid = true;
  }

  broadcast({
    type: 'TELEMETRY_UPDATE',
    status: state.status,
    transport: state.transport,
    isStale: false,
    readings: state.readings
  });

  res.json({
    success: true,
    message: `Valve commanded CLOSED for ${targetLabel}`,
    bottleId,
    transportSent: sent ? state.transport : 'NONE'
  });
});

// 11. Update Settings & transmit threshold to ESP32
app.post('/api/settings/update', async (req, res) => {
  const { lowFluidThreshold, bottle1Capacity, bottle2Capacity, fluidDensity, bottle1Tare, bottle2Tare } = req.body;

  if (lowFluidThreshold !== undefined) {
    const val = Number(lowFluidThreshold);
    if (!isNaN(val) && val > 0 && val < 500) {
      state.settings.lowFluidThreshold = val;

      // Transmit to ESP32 via active connection
      if (state.transport === 'SERIAL' && activeSerialPort && activeSerialPort.isOpen) {
        const cmdStr = JSON.stringify({ cmd: 'SET_THRESHOLD', threshold: val }) + '\n';
        activeSerialPort.write(cmdStr);
        broadcast({ type: 'SERIAL_RAW', direction: 'TX', data: cmdStr.trim(), timestamp: new Date().toLocaleTimeString() });
      } else if (state.transport === 'WIFI') {
        try {
          fetch(`http://${state.settings.esp32Ip}:${state.settings.esp32Port}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ low_fluid_threshold: val })
          }).catch(() => {});
        } catch (_) {}
      }

      logEvent('SETTINGS_CHANGED', `Low-fluid threshold updated to ${val} mL`, 'INFO');
    }
  }

  if (bottle1Capacity) state.settings.bottle1Capacity = Number(bottle1Capacity) || 500;
  if (bottle2Capacity) state.settings.bottle2Capacity = Number(bottle2Capacity) || 500;
  if (fluidDensity) state.settings.fluidDensity = Number(fluidDensity) || 1.0;
  if (bottle1Tare !== undefined) state.settings.bottle1Tare = Number(bottle1Tare);
  if (bottle2Tare !== undefined) state.settings.bottle2Tare = Number(bottle2Tare);

  broadcast({ type: 'SETTINGS_UPDATE', settings: state.settings });
  res.json({ success: true, settings: state.settings });
});

// 12. Tare / Calibrate Load Cell command
app.post('/api/sensor/tare', async (req, res) => {
  const { bottle } = req.body;
  const bId = (bottle == 2 || bottle === '2') ? 2 : 1;

  logEvent('CALIBRATION_COMMAND', `Tare calibration requested for Bottle ${bId} load cell`, 'INFO');

  if (state.transport === 'SERIAL' && activeSerialPort && activeSerialPort.isOpen) {
    const cmdStr = JSON.stringify({ cmd: 'TARE', bottle: bId }) + '\n';
    activeSerialPort.write(cmdStr);
    broadcast({ type: 'SERIAL_RAW', direction: 'TX', data: cmdStr.trim(), timestamp: new Date().toLocaleTimeString() });
  } else if (state.transport === 'WIFI') {
    fetch(`http://${state.settings.esp32Ip}:${state.settings.esp32Port}/api/tare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bottle: bId })
    }).catch(() => {});
  }

  res.json({ success: true, message: `Tare command sent for Bottle ${bId}` });
});

// 13. Demonstration Simulation Mode Toggle (For testing without physical ESP32)
app.post('/api/simulation/toggle', async (req, res) => {
  const { enable } = req.body;

  if (enable) {
    await disconnectAllTransports();
    state.transport = 'SIMULATION';
    state.status = 'CONNECTED';
    state.isStale = false;
    logEvent('SIMULATION_STARTED', 'Demonstration simulation mode active with simulated dual-bottle infusion', 'WARN');

    let simB1 = 340.0;
    let simB2 = 180.0;
    let b1Valve = 'OPEN';
    let b2Valve = 'OPEN';

    simulationInterval = setInterval(() => {
      // Simulate slow infusion flow rate (0.8 - 1.5 mL per tick) if valve is open
      if (b1Valve === 'OPEN') {
        simB1 -= 1.2;
        if (simB1 <= state.settings.lowFluidThreshold) {
          simB1 = Math.max(0, simB1);
          b1Valve = 'CLOSED'; // ESP32 latched shut-off simulation
        }
      }

      if (b2Valve === 'OPEN') {
        simB2 -= 1.5;
        if (simB2 <= state.settings.lowFluidThreshold) {
          simB2 = Math.max(0, simB2);
          b2Valve = 'CLOSED'; // ESP32 latched shut-off simulation
        }
      }

      const mockPayload = {
        device: 'ESP32-SIMULATOR',
        timestamp: Date.now(),
        bottle1: {
          weight_g: Number((simB1 + 30.5 + (Math.random() * 0.2 - 0.1)).toFixed(1)),
          fluid_g: Number(simB1.toFixed(1)),
          remaining_ml: Number(simB1.toFixed(1)),
          valve_command: b1Valve,
          sensor_ok: true,
          calibrated: true,
          low_fluid: simB1 <= state.settings.lowFluidThreshold
        },
        bottle2: {
          weight_g: Number((simB2 + 29.8 + (Math.random() * 0.2 - 0.1)).toFixed(1)),
          fluid_g: Number(simB2.toFixed(1)),
          remaining_ml: Number(simB2.toFixed(1)),
          valve_command: b2Valve,
          sensor_ok: true,
          calibrated: true,
          low_fluid: simB2 <= state.settings.lowFluidThreshold
        }
      };

      handleIncomingReading(mockPayload);
    }, 1000);

    res.json({ success: true, simulation: true, message: 'Simulation mode enabled' });
  } else {
    await disconnectAllTransports();
    logEvent('SIMULATION_STOPPED', 'Simulation mode disabled', 'INFO');
    broadcast({ type: 'STATUS_UPDATE', status: state.status, transport: state.transport });
    res.json({ success: true, simulation: false, message: 'Simulation mode stopped' });
  }
});

// -------------------------------------------------------------
// WebSocket Server Connection Handler
// -------------------------------------------------------------
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket telemetry stream');

  // Send initial snapshot immediately upon connection
  ws.send(JSON.stringify({
    type: 'INITIAL_STATE',
    status: state.status,
    transport: state.transport,
    isStale: state.isStale,
    settings: state.settings,
    readings: state.readings,
    history: chartHistory.slice(-50),
    events: eventLog.slice(0, 50)
  }));

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    // Client disconnected
  });
});

// -------------------------------------------------------------
// Graceful Server Shutdown
// -------------------------------------------------------------
const shutdown = async () => {
  console.log('\nGracefully shutting down Smart IV Monitor server...');
  await disconnectAllTransports();
  server.close(() => {
    console.log('Server stopped cleanly.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`Smart IV Fluid Monitoring System Server Started`);
  console.log(`Local Dashboard URL: http://localhost:${PORT}`);
  console.log(`Environment: Node.js ${process.version} on Windows`);
  console.log(`WebSocket Server: Active on ws://localhost:${PORT}`);
  console.log(`=======================================================`);
  logEvent('SYSTEM_START', `Smart IV Monitor server initialized on port ${PORT}`, 'INFO');
});
