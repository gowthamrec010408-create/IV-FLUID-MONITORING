# Smart IV Fluid Monitoring System — Verification & Acceptance Test Procedures

This document provides step-by-step instructions to verify all 14 functional acceptance criteria for the Smart IV Fluid Monitoring System.

---

## Acceptance Test Matrix

### TEST 1: Dashboard Opens Successfully
* **Objective**: Confirm that the local web application loads without network dependency.
* **Procedure**:
  1. Open a PowerShell terminal in the project directory.
  2. Start the server using:
     ```powershell
     npm start
     ```
  3. Open a browser to `http://localhost:3000`.
* **Expected Result**: The dashboard loads instantly with healthcare telemetry styling, clean navigation bar, four summary cards, two bottle cards, and no console errors.

---

### TEST 2: Dual Bottle Cards Appear in Left-Right Layout
* **Objective**: Verify responsive side-by-side positioning on desktop and stacked layout on mobile.
* **Procedure**:
  1. View the dashboard on a standard desktop monitor (viewport &ge; 1024px).
  2. Resize browser window width below 768px (or inspect via mobile emulator).
* **Expected Result**:
  - On desktop: **IV Bottle 1** appears on the LEFT and **IV Bottle 2** appears on the RIGHT side by side.
  - On mobile: Both cards stack vertically with Bottle 1 above Bottle 2.

---

### TEST 3: USB Serial Ports Listed Correctly
* **Objective**: Ensure Node.js SerialPort library detects available COM ports.
* **Procedure**:
  1. Plug in the ESP32 via a USB data cable into the Windows PC.
  2. In the "Option A: Connect ESP32 via USB" card, click the **Refresh Ports** button (`🔄`).
  3. Inspect the "COM Port" dropdown menu.
* **Expected Result**: The dropdown populates with active serial COM ports (e.g. `COM3 - Silicon Labs CP210x` or `COM4 - USB-SERIAL CH340`).

---

### TEST 4: USB Connection Receives Actual ESP32 Telemetry
* **Objective**: Establish serial communication and stream real-time JSON packets.
* **Procedure**:
  1. Select the ESP32 COM port and ensure baud rate is set to `115200`.
  2. Click **Connect USB**.
  3. Inspect the live "USB Serial Communication Log" terminal.
* **Expected Result**:
  - Terminal prints incoming lines: `[RX]: {"device":"ESP32","bottle1":{...},"bottle2":{...}}`.
  - Navbar dot changes to green `CONNECTED`.
  - Both bottle cards display real load cell weights and estimated remaining volumes.

---

### TEST 5: Wi-Fi Connection Receives Actual ESP32 Readings via IP
* **Objective**: Connect over local area network HTTP endpoints.
* **Procedure**:
  1. Flash `esp32/smart_iv_monitor.ino` with your local Wi-Fi SSID and password.
  2. Note the IP address printed on the ESP32 Serial Monitor (e.g., `192.168.1.105`).
  3. Enter this IP in the dashboard's "Option B: Connect ESP32 via Wi-Fi" card.
  4. Click **Connect Wi-Fi**.
* **Expected Result**:
  - Connection mode switches cleanly from USB to `WIFI`.
  - The backend polls `/api/readings` at 1-second intervals.
  - Live data from the ESP32 populates the dashboard.

---

### TEST 6: Independent Dual Bottle Updating
* **Objective**: Confirm that load changes on Bottle 1 do not alter Bottle 2 readings.
* **Procedure**:
  1. Apply downward pressure or add 100 mL of water to Bottle 1 load cell only.
  2. Observe the numerical readouts and progress bars for both bottles.
* **Expected Result**:
  - Bottle 1 remaining volume increases by ~100 mL.
  - Bottle 2 remaining volume remains completely unchanged.

---

### TEST 7: Both Charts Update from Real Sensor Readings
* **Objective**: Verify live time-series volume decay graphs.
* **Procedure**:
  1. Observe the "Bottle 1: Remaining Fluid vs Time" and "Bottle 2: Remaining Fluid vs Time" charts.
* **Expected Result**:
  - Empty state overlay disappears upon arrival of the first real reading.
  - Real-time line curves advance from right to left as new readings arrive every second.
  - History is bounded to the configured limit (up to 300 points in memory).

---

### TEST 8: Visible Disconnected State on Cable Removal
* **Objective**: Guarantee that disconnected devices are immediately apparent and never show fabricated data.
* **Procedure**:
  1. While streaming live readings, unplug the USB cable or disconnect the ESP32 power.
* **Expected Result**:
  - Within 3.5 seconds, the watchdog triggers a `DATA_STALE` warning.
  - Status banner displays: `DEVICE DISCONNECTED - Waiting for ESP32 data`.
  - Status badge changes to `DISCONNECTED (STALE)`.
  - Last known readings remain visible but are distinctly marked as stale.

---

### TEST 9: Sensor Fault Displayed on Load Cell Disconnect
* **Objective**: Verify handling of broken wires or disconnected HX711 modules.
* **Procedure**:
  1. Disconnect the DOUT or SCK jumper wire from HX711 Channel 1.
* **Expected Result**:
  - ESP32 detects the timeout and transmits `"sensor_ok": false`.
  - Bottle 1 card immediately displays the red badge: `SENSOR FAULT`.
  - Event log records `SENSOR_FAULT` with timestamp and error severity.

---

### TEST 10: Automatic Solenoid Valve Shut-Off at 20 mL Threshold
* **Objective**: Verify safety-critical valve closure command generated directly on ESP32 firmware.
* **Procedure**:
  1. Allow Bottle 1 volume to drop to 20 mL (or simulate with light weight).
* **Expected Result**:
  - ESP32 triggers `digitalWrite(RELAY_VALVE_1_PIN, HIGH)` to close Solenoid Valve 1.
  - Bottle 1 card displays red alert banner: `CRITICAL: Remaining volume <= 20 mL! Valve commanded CLOSED.`
  - Valve command readout flips to `CLOSED (SHUT-OFF)`.
  - Relay 1 clicks mechanically shut.

---

### TEST 11: Valve Latching (No Fluctuations Auto-Reopening)
* **Objective**: Confirm that noise or sloshing does not reopen a shut-off valve.
* **Procedure**:
  1. After Valve 1 has latched shut at 19 mL, agitate the bottle or momentarily press down on the load cell so reading spikes to 40 mL.
* **Expected Result**:
  - Valve 1 remains latched **CLOSED**.
  - Valve command remains `CLOSED`.
  - Valve reopens only when the operator explicitly clicks the **Unlatch** button.

---

### TEST 12: Zero Database & Zero Persistent Storage Verification
* **Objective**: Ensure compliance with the strict non-database constraint.
* **Procedure**:
  1. Inspect the browser Application DevTools tab:
     - Check `localStorage`: empty.
     - Check `sessionStorage`: empty.
     - Check `IndexedDB`: empty.
     - Check `Cookies`: empty.
  2. Inspect the project directory: no SQLite, MongoDB, or MySQL dependencies.
  3. Restart the Node server (`Ctrl+C`, then `npm start`).
* **Expected Result**: All in-memory chart histories and event logs reset cleanly to zero on server restart.

---

### TEST 13: Complete File Structure Check
* **Objective**: Verify that all required files and directories are present.
* **Procedure**:
  Run in PowerShell:
  ```powershell
  Get-ChildItem -Recurse | Select-Object FullName
  ```
* **Expected Result**:
  - `package.json`
  - `server.js`
  - `README.md`
  - `public/index.html`
  - `public/styles.css`
  - `public/app.js`
  - `esp32/smart_iv_monitor.ino`
  - `docs/wiring.md`
  - `docs/testing.md`

---

### TEST 14: Clean Startup & Button Functional Behavior
* **Objective**: Confirm zero startup crashes and working interactive buttons.
* **Procedure**:
  1. Run `npm start`. Verify zero unhandled exceptions.
  2. Click **Settings** (opens modal dialog).
  3. Click **Reset Valves** (prompts confirmation).
  4. Click **Start Simulation** (initiates virtual demonstration fluid decay).
* **Expected Result**: All interactions trigger their corresponding REST endpoints or UI behaviors cleanly without console errors.
