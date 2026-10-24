# Smart IV Fluid Monitoring System with Dual-Bottle Monitoring and Automatic Shut-Off

An engineering demonstration platform for real-time IV infusion monitoring using an **ESP32 microcontroller**, dual **HX711 24-bit ADC load cells**, an optocoupler-isolated **2-channel relay module**, and a modern **clinical-grade web dashboard** built with HTML5, CSS3, vanilla JavaScript, and Node.js.

---

## 1. System Overview

In clinical intravenous therapy, running out of infusion fluid can lead to blood backflow, vein collapse, and air embolism risks. This project demonstrates an automated monitoring solution:

- **Dual-Bottle Independent Weight Telemetry**: Two 500 mL IV fluid containers are continuously weighed using independent strain-gauge load cells.
- **Accurate Volume Estimation**: Net fluid mass is calculated by subtracting the empty container tare assembly weight:
  $$\text{Fluid Mass (g)} = \text{Total Measured Mass (g)} - \text{Empty Assembly Tare (g)}$$
  $$\text{Estimated Volume (mL)} = \frac{\text{Fluid Mass (g)}}{\text{Fluid Density (1.00 g/mL for water)}}$$
- **Independent 20 mL Automatic Shut-Off**: When either container reaches approximately **20 mL**, the ESP32 automatically closes the corresponding solenoid valve via relay actuation.
- **Latched Shut-Off Logic**: Valve shut-off is safety-latched in ESP32 firmware. Noisy sensor fluctuations or fluid sloshing cannot accidentally reopen the valve until an explicit manual reset procedure is executed.
- **Dual Connection Channels**: Seamless switching between **USB Cable (SerialPort at 115200 baud)** and **Wi-Fi Local IP (HTTP REST polling)**.
- **Zero Database Requirement**: Complies with strict non-database architecture (no Firebase, MongoDB, MySQL, SQLite, or browser local storage). All chart histories and event logs reside purely in server memory and clear on restart.

---

## 2. Directory Structure

```
smart-iv-monitor/
│
├── package.json               # Node.js dependencies and run scripts
├── server.js                  # Express backend, SerialPort, Wi-Fi client, WebSocket streaming
├── README.md                  # Complete Windows installation & user guide
│
├── public/                    # Web frontend dashboard
│   ├── index.html             # Healthcare dashboard layout
│   ├── styles.css             # Responsive medical design system (CSS Grid/Flexbox)
│   ├── app.js                 # WebSocket client, dual bottle gauges, terminal log
│   └── vendor/
│       └── chart.umd.min.js   # Local Chart.js bundle (100% offline capable)
│
├── esp32/
│   └── smart_iv_monitor.ino   # Arduino C++ firmware sketch for ESP32
│
└── docs/
    ├── wiring.md              # Complete hardware schematics, pinouts, and relay protection
    └── testing.md             # Verification procedures for all 14 Acceptance Tests
```

---

## 3. Windows Quick Start & Running Instructions

### Step 1: Install Node.js
Ensure Node.js (version 18, 20, or 22 LTS) is installed on your Windows machine:
```powershell
node --version
```

### Step 2: Open Project Directory
Navigate to the project directory in PowerShell or Command Prompt:
```powershell
cd "c:\Users\GOWTHAM NK\OneDrive\Documents\AIC PROJECT"
```

### Step 3: Install Dependencies
Install all required Node.js packages (Express, WS, SerialPort, Parser-Readline, Chart.js):
```powershell
npm install
```
*(On Windows systems where script execution policies are restricted, use `npm.cmd install`)*.

### Step 4: Start the Server
Launch the server:
```powershell
npm start
```
The console will display:
```
=======================================================
Smart IV Fluid Monitoring System Server Started
Local Dashboard URL: http://localhost:3000
Environment: Node.js on Windows
WebSocket Server: Active on ws://localhost:3000
=======================================================
```

### Step 5: Open the Local Dashboard
Open your web browser (Chrome, Edge, or Firefox) and navigate to:
```
http://localhost:3000
```
*(No internet access is required after `npm install` has finished; all scripts and Chart.js libraries are bundled locally).*

---

## 4. Connecting the ESP32 Microcontroller

### Method 1: USB Serial Connection (Option A)
1. Connect the ESP32 board to your Windows PC using a micro-USB or USB-C **data cable** (ensure it is not a charge-only cable).
2. On the dashboard, locate the card titled **Connect ESP32 via USB**.
3. Click the **Refresh Ports** button (`🔄`).
4. Select your ESP32's COM port (e.g., `COM3`, `COM4`, or `COM5`).
5. Ensure the baud rate is set to **115200** (default).
6. Click **Connect USB**.
7. The status indicator will turn green (`CONNECTED`), and real-time JSON frames will scroll in the USB Serial Communication Log terminal.

### Method 2: Wi-Fi IP Connection (Option B)
1. Open `esp32/smart_iv_monitor.ino` in the Arduino IDE.
2. Edit the Wi-Fi credentials near the top of the file:
   ```cpp
   const char* WIFI_SSID     = "Your_Local_WiFi_Name";
   const char* WIFI_PASSWORD = "Your_WiFi_Password";
   ```
3. Upload the sketch to the ESP32.
4. Open the Arduino Serial Monitor (115200 baud) and note the assigned IP address:
   ```
   [Wi-Fi] Connected successfully! IP Address: 192.168.1.105
   ```
5. On the web dashboard, navigate to **Connect ESP32 via Wi-Fi**.
6. Enter the IP address (e.g. `192.168.1.105`) and port `80`.
7. Click **Connect Wi-Fi**.
8. The backend server will automatically poll `http://192.168.1.105/api/readings` every 1000ms and stream live readings to your browser.

---

## 5. Demonstration Simulation Mode (Hardware-Free Demo)

If you are presenting or testing this project without physical ESP32 load cells connected:
1. In the **Connect ESP32 via Wi-Fi** card, locate the **Virtual Test Harness** box.
2. Click **Start Simulation**.
3. The dashboard will simulate real-time fluid decay on both bottles:
   - Initial volumes: 340 mL (Bottle 1) and 180 mL (Bottle 2).
   - As fluid flows, the volumes drop steadily.
   - When Bottle 2 reaches &le; 20 mL, the simulated valve **COMMANDS CLOSED**, triggering a critical alert banner and turning the indicator red.
   - Click the **Unlatch** button or **Reset Valves** to restore normal flow.
4. Click **Stop Simulation** at any time.

---

## 6. Load Cell Calibration & Empty Container Tare

Accurate volume estimation depends on subtracting the tare weight of the empty bottle and clamp:

1. **Tare Zero Point**:
   - Power up the ESP32 with nothing hanging from the load cells.
   - The firmware automatically zeros (tares) raw ADC counts upon boot.
   - You can also click **Tare Bottle 1** or **Tare Bottle 2** in the dashboard's **Settings** panel.

2. **Empty Bottle Assembly Tare (Grams)**:
   - Weigh an empty 500 mL plastic IV bottle, IV spike, and drip tubing assembly on a precision kitchen scale (typically ~28 to 35 grams).
   - Open **Settings** in the dashboard navbar.
   - Enter this value into **Bottle 1 Assembly Tare (g)** and click **Save**.

3. **Calibration Factor Adjustment**:
   - In `esp32/smart_iv_monitor.ino`, `calibrationFactorB1 = 420.0f` represents raw counts per gram.
   - Hang a known weight (e.g., a 200g calibration weight or 500 mL water bottle = 500g).
   - If the displayed weight differs from the known weight:
     $$\text{New Calibration Factor} = \text{Current Factor} \times \frac{\text{Measured Weight}}{\text{Actual Known Weight}}$$
   - Update `calibrationFactorB1` or `calibrationFactorB2` in the sketch and re-upload.

---

## 7. Troubleshooting & Common Questions

### Q1: USB COM port does not appear in the dropdown list
- **Cause**: Missing USB-to-UART bridge driver on Windows.
- **Solution**: Install the driver for your ESP32 board's USB chip:
  - For CP2102 chips: Download Silicon Labs CP210x VCP Drivers.
  - For CH340 / CH341 chips: Download WCH CH340 USB Drivers.
  - Ensure the USB cable is a 4-wire data cable, not a 2-wire charging cable.

### Q2: "Access is denied" or COM port busy error
- **Cause**: The Arduino Serial Monitor or another terminal (PuTTY, Cura) is already holding the COM port open.
- **Solution**: Close the Arduino IDE Serial Monitor before clicking **Connect USB** in the dashboard. Only one application can access a COM port simultaneously on Windows.

### Q3: Solenoid valve clicks rapidly or ESP32 resets when valve closes
- **Cause**: Inductive back-EMF spike from the solenoid coil.
- **Solution**: Verify that a **1N4007 flyback diode** is connected across the solenoid valve terminals (Cathode with silver band to +12V, Anode to switched ground), and verify that the relay module and valves are powered from a separate 12V 2A adapter. See [docs/wiring.md](file:///c:/Users/GOWTHAM%20NK/OneDrive/Documents/AIC%20PROJECT/docs/wiring.md).

### Q4: Port 3000 already in use
- **Solution**: Start the server on a custom port:
  ```powershell
  $env:PORT=8080; npm start
  ```

---

## 8. Safety & Academic Disclaimer

This project is developed for non-clinical academic laboratory demonstrations and engineering coursework. It has not been subjected to clinical validation or medical device regulatory approvals (such as FDA 510(k) or CE mark for medical electrical equipment IEC 60601-1). **Do not use this system for human patient infusion or life-critical medical administration.**
#   I V - F L U I D - M O N I T O R I N G  
 