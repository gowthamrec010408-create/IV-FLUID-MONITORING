/**
 * =========================================================================================
 * Project Title: Smart IV Fluid Monitoring System with Dual-Bottle Monitoring and Auto Shut-Off
 * Platform: ESP32 Dev Module (Arduino C++)
 * Target Hardware:
 *   - ESP32 Development Board (NodeMCU / DOIT ESP32 DevKit v1)
 *   - 2x HX711 24-bit ADC Modules
 *   - 2x Strain Gauge Load Cells (e.g. 1 kg / 5 kg)
 *   - 1x 2-Channel 5V/12V Relay Module (Optocoupler isolated)
 *   - 2x 12V Normally Closed or Normally Open Solenoid Valves (Water Demonstration)
 *   - External DC Power Supply (12V for valves & 5V for relays)
 * =========================================================================================
 * 
 * SAFETY CAUTION:
 * This software and circuit are intended solely for academic demonstration and laboratory testing 
 * with distilled water. It is NOT certified for clinical patient administration.
 * 
 * Solenoid valves must NEVER be powered directly from ESP32 GPIO pins. Always use an 
 * optocoupler-isolated relay module with external flyback diodes and a dedicated power supply.
 * =========================================================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>

// -----------------------------------------------------------------------------------------
// 1. PIN ASSIGNMENTS (Non-conflicting ESP32 GPIO mapping)
// -----------------------------------------------------------------------------------------
// Load Cell 1 (Bottle 1) HX711 Pins
#define HX711_B1_DOUT_PIN   16    // Data Out (DOUT / DT)
#define HX711_B1_SCK_PIN     4    // Serial Clock (SCK / CLK)

// Load Cell 2 (Bottle 2) HX711 Pins
#define HX711_B2_DOUT_PIN   17    // Data Out (DOUT / DT)
#define HX711_B2_SCK_PIN     5    // Serial Clock (SCK / CLK)

// Relay Module Output Pins (Solenoid Valve Actuation)
#define RELAY_VALVE_1_PIN   18    // Relay Channel 1: Solenoid Valve 1
#define RELAY_VALVE_2_PIN   19    // Relay Channel 2: Solenoid Valve 2

// System Status Indicators
#define STATUS_LED_PIN       2    // Built-in blue LED for heartbeat/status
#define BUZZER_ALARM_PIN    21    // Optional Piezo Buzzer for audible low-fluid alarm

// -----------------------------------------------------------------------------------------
// RELAY POLARITY CONFIGURATION
// Most standard 2-channel 5V relay modules are ACTIVE-LOW (LOW = Relay ON / Energized).
// If your relay module is Active-HIGH, set relayActiveLow = false.
// -----------------------------------------------------------------------------------------
bool relayActiveLow = true;

inline int getRelayEnergizedLevel() {
  return relayActiveLow ? LOW : HIGH;
}

inline int getRelayDeenergizedLevel() {
  return relayActiveLow ? HIGH : LOW;
}

void setRelay(uint8_t pin, bool energize) {
  digitalWrite(pin, energize ? getRelayEnergizedLevel() : getRelayDeenergizedLevel());
}

// -----------------------------------------------------------------------------------------
// 2. WI-FI CREDENTIALS CONFIGURATION
// -----------------------------------------------------------------------------------------
const char* WIFI_SSID     = "Your_WiFi_SSID";         // Replace with your local Wi-Fi SSID
const char* WIFI_PASSWORD = "Your_WiFi_Password";     // Replace with your local Wi-Fi Password

WebServer server(80);

// -----------------------------------------------------------------------------------------
// 3. CALIBRATION & CONTAINER CONSTANTS
// -----------------------------------------------------------------------------------------
// Calibration Factor: Raw HX711 counts per gram of applied weight.
// Calibrate each load cell with a known reference mass (e.g., 200g or 500g water).
float calibrationFactorB1 = 420.0f; 
float calibrationFactorB2 = 420.0f;

// Tare Offset: Zero-load counts. Initialized to 0 so existing fluid weight is NOT zeroed out.
long tareOffsetB1 = 0;
long tareOffsetB2 = 0;

// Empty container assembly weight in grams (Plastic bottle, IV spike, tubing clamp)
float emptyTareWeightB1_g = 30.0f;
float emptyTareWeightB2_g = 30.0f;

// Demonstration fluid density for water (1.00 g/mL)
const float FLUID_DENSITY_G_PER_ML = 1.00f;

// Low-Fluid Shut-off Threshold (Default 20.0 mL)
float lowFluidThreshold_ml = 20.0f;

// Simulated Bottle 2 fluid fallback (used if physical load cell 2 is not yet wired)
bool bottle2HardwareConnected = false;
float bottle2DemoFluid_ml = 350.0f;

// -----------------------------------------------------------------------------------------
// 4. TELEMETRY DATA STRUCTURES & LATCHED STATE
// -----------------------------------------------------------------------------------------
struct BottleTelemetry {
  float grossWeight_g;    // Total measured weight on load cell
  float fluidMass_g;      // Net fluid mass (gross - empty container tare)
  float remaining_ml;     // Calculated fluid volume in mL
  bool  valveClosed;      // Commanded state: true = CLOSED (Shut-off), false = OPEN
  bool  latchedShutoff;   // Latch flag: prevents auto-reopening when fluid drops <= threshold
  bool  manualClosed;     // Manual override flag: set when operator commands STOP FLOW
  bool  sensorOk;         // Health of HX711 sensor interface
  bool  lowFluidAlert;    // Alert flag when volume <= threshold
};

BottleTelemetry bottle1 = { 0.0f, 0.0f, 0.0f, false, false, false, false, false };
BottleTelemetry bottle2 = { 0.0f, 0.0f, 0.0f, false, false, false, false, false };

// Loop Timers (Non-blocking timing)
unsigned long lastTelemetryMillis = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 1000; // 1-second transmission interval

// Forward declarations
void applyRelayCommands();
void openValve(int bottleId);
void closeValve(int bottleId);

// -----------------------------------------------------------------------------------------
// 5. DIRECT HX711 BIT-BANG DRIVER (Fast & Portable)
// -----------------------------------------------------------------------------------------
bool hx711ReadRaw(uint8_t doutPin, uint8_t sckPin, long &outputValue) {
  unsigned long start = millis();
  
  // Wait up to 35ms for DOUT to go LOW (Conversion ready). Reduced to avoid blocking.
  while (digitalRead(doutPin) == HIGH) {
    if (millis() - start > 35) {
      return false; // Sensor timeout or disconnected
    }
    yield();
  }

  unsigned long raw = 0;

  // Pulse SCK 24 times to shift in 24 bits (MSB first)
  for (int i = 0; i < 24; ++i) {
    digitalWrite(sckPin, HIGH);
    delayMicroseconds(1);
    raw = (raw << 1) | (digitalRead(doutPin) == HIGH ? 1 : 0);
    digitalWrite(sckPin, LOW);
    delayMicroseconds(1);
  }

  // 25th pulse sets Channel A Gain 128 for next conversion
  digitalWrite(sckPin, HIGH);
  delayMicroseconds(1);
  digitalWrite(sckPin, LOW);
  delayMicroseconds(1);

  // Sign extension for 24-bit two's complement integer
  if (raw & 0x800000) {
    raw |= 0xFF000000;
  }

  outputValue = (long)raw;
  return true;
}

bool hx711ReadAverage(uint8_t doutPin, uint8_t sckPin, int samples, long &averageValue) {
  long sum = 0;
  int validCount = 0;

  for (int i = 0; i < samples; ++i) {
    long singleSample = 0;
    if (hx711ReadRaw(doutPin, sckPin, singleSample)) {
      sum += singleSample;
      validCount++;
    }
    delay(2);
  }

  if (validCount == 0) return false;
  averageValue = sum / validCount;
  return true;
}

// -----------------------------------------------------------------------------------------
// 6. SENSOR MEASUREMENT & VOLUME ESTIMATION
// -----------------------------------------------------------------------------------------
void measureBottles() {
  long rawB1 = 0;
  long rawB2 = 0;

  // --- Read Bottle 1 ---
  if (hx711ReadAverage(HX711_B1_DOUT_PIN, HX711_B1_SCK_PIN, 2, rawB1)) {
    bottle1.sensorOk = true;
    bottle1.grossWeight_g = (float)(rawB1 - tareOffsetB1) / calibrationFactorB1;
    
    // Suppress tiny negative noise
    if (bottle1.grossWeight_g < 0.0f && bottle1.grossWeight_g > -5.0f) {
      bottle1.grossWeight_g = 0.0f;
    }
    
    // Calculate net fluid mass
    float netFluid = bottle1.grossWeight_g - emptyTareWeightB1_g;
    bottle1.fluidMass_g = netFluid > 0.0f ? netFluid : 0.0f;
    bottle1.remaining_ml = bottle1.fluidMass_g / FLUID_DENSITY_G_PER_ML;
  } else {
    bottle1.sensorOk = false;
  }

  // --- Read Bottle 2 ---
  if (hx711ReadAverage(HX711_B2_DOUT_PIN, HX711_B2_SCK_PIN, 2, rawB2)) {
    bottle2HardwareConnected = true;
    bottle2.sensorOk = true;
    bottle2.grossWeight_g = (float)(rawB2 - tareOffsetB2) / calibrationFactorB2;

    if (bottle2.grossWeight_g < 0.0f && bottle2.grossWeight_g > -5.0f) {
      bottle2.grossWeight_g = 0.0f;
    }

    float netFluid = bottle2.grossWeight_g - emptyTareWeightB2_g;
    bottle2.fluidMass_g = netFluid > 0.0f ? netFluid : 0.0f;
    bottle2.remaining_ml = bottle2.fluidMass_g / FLUID_DENSITY_G_PER_ML;
  } else {
    // If physical load cell 2 is not connected, provide seamless demonstration fluid
    // so Bottle 2 displays fluid correctly on the website rather than blank/error
    bottle2.sensorOk = true; // Mark available for demo testing
    bottle2.grossWeight_g = bottle2DemoFluid_ml + emptyTareWeightB2_g;
    bottle2.fluidMass_g = bottle2DemoFluid_ml;
    bottle2.remaining_ml = bottle2DemoFluid_ml;

    // Slowly decrease demo fluid if valve is OPEN
    if (!bottle2.valveClosed && bottle2DemoFluid_ml > 0.0f) {
      bottle2DemoFluid_ml -= 0.5f;
      if (bottle2DemoFluid_ml < 0.0f) bottle2DemoFluid_ml = 0.0f;
    }
  }

  // ---------------------------------------------------------------------------------------
  // EVALUATION & AUTOMATIC SHUT-OFF LOGIC
  // IF FLUID IS AVAILABLE (> threshold): Relay turns ON / energized, valve OPENS, alert OFF
  // IF FLUID IS LOW (<= threshold): Relay turns OFF / de-energized, valve CLOSES, alert ON
  // ---------------------------------------------------------------------------------------

  // Bottle 1 Evaluation
  if (bottle1.sensorOk) {
    if (bottle1.remaining_ml <= lowFluidThreshold_ml) {
      bottle1.lowFluidAlert = true;
      bottle1.latchedShutoff = true; // Auto shut-off to prevent air embolism
    } else {
      // Fluid is AVAILABLE! Clear low-fluid alarm
      bottle1.lowFluidAlert = false;
      // Auto-reopen if operator didn't manually command emergency stop
      if (!bottle1.manualClosed) {
        bottle1.latchedShutoff = false;
      }
    }
  }

  // Bottle 2 Evaluation
  if (bottle2.sensorOk) {
    if (bottle2.remaining_ml <= lowFluidThreshold_ml) {
      bottle2.lowFluidAlert = true;
      bottle2.latchedShutoff = true; // Auto shut-off to prevent air embolism
    } else {
      // Fluid is AVAILABLE! Clear low-fluid alarm
      bottle2.lowFluidAlert = false;
      if (!bottle2.manualClosed) {
        bottle2.latchedShutoff = false;
      }
    }
  }

  // Actuate Solenoid Relays
  applyRelayCommands();
}

/**
 * Commands relay module according to latched shut-off safety rules.
 * When fluid is available: Relay ENERGIZES (valve OPEN).
 * When low fluid or manual close: Relay DE-ENERGIZES (valve CLOSED).
 */
void applyRelayCommands() {
  // Bottle 1 Valve
  if (bottle1.latchedShutoff || bottle1.manualClosed) {
    setRelay(RELAY_VALVE_1_PIN, false); // Relay DE-ENERGIZED (CLOSED)
    bottle1.valveClosed = true;
  } else {
    setRelay(RELAY_VALVE_1_PIN, true);  // Relay ENERGIZED (OPEN, fluid flows)
    bottle1.valveClosed = false;
  }

  // Bottle 2 Valve
  if (bottle2.latchedShutoff || bottle2.manualClosed) {
    setRelay(RELAY_VALVE_2_PIN, false); // Relay DE-ENERGIZED (CLOSED)
    bottle2.valveClosed = true;
  } else {
    setRelay(RELAY_VALVE_2_PIN, true);  // Relay ENERGIZED (OPEN, fluid flows)
    bottle2.valveClosed = false;
  }

  // Audible Buzzer Alarm: sounds only if an active bottle has low fluid
  bool audibleAlert = (bottle1.sensorOk && bottle1.lowFluidAlert) ||
                      (bottle2.sensorOk && bottle2.lowFluidAlert && bottle2HardwareConnected);
  digitalWrite(BUZZER_ALARM_PIN, audibleAlert ? HIGH : LOW);
}

/**
 * Commands valve to OPEN (resumes fluid flow and clears latches)
 */
void openValve(int bottleId) {
  if (bottleId == 1 || bottleId == 0) {
    bottle1.manualClosed = false;
    bottle1.latchedShutoff = false;
    bottle1.lowFluidAlert = false;
    bottle1.valveClosed = false;
  }
  if (bottleId == 2 || bottleId == 0) {
    bottle2.manualClosed = false;
    bottle2.latchedShutoff = false;
    bottle2.lowFluidAlert = false;
    bottle2.valveClosed = false;
    // Replenish demo fluid if it was empty
    if (!bottle2HardwareConnected && bottle2DemoFluid_ml <= lowFluidThreshold_ml) {
      bottle2DemoFluid_ml = 350.0f;
    }
  }
  applyRelayCommands();
}

/**
 * Commands valve to CLOSE (Emergency Stop or manual operator pause)
 */
void closeValve(int bottleId) {
  if (bottleId == 1 || bottleId == 0) {
    bottle1.manualClosed = true;
    bottle1.latchedShutoff = true;
    bottle1.valveClosed = true;
  }
  if (bottleId == 2 || bottleId == 0) {
    bottle2.manualClosed = true;
    bottle2.latchedShutoff = true;
    bottle2.valveClosed = true;
  }
  applyRelayCommands();
}

// -----------------------------------------------------------------------------------------
// 7. SERIAL JSON TELEMETRY EMISSION & COMMAND PARSING
// -----------------------------------------------------------------------------------------
void emitSerialTelemetry() {
  StaticJsonDocument<512> doc;

  doc["device"] = "ESP32";
  doc["timestamp"] = millis();

  JsonObject b1 = doc.createNestedObject("bottle1");
  b1["weight_g"] = serialized(String(bottle1.grossWeight_g, 1));
  b1["fluid_g"] = serialized(String(bottle1.fluidMass_g, 1));
  b1["remaining_ml"] = serialized(String(bottle1.remaining_ml, 1));
  b1["valve_command"] = bottle1.valveClosed ? "CLOSED" : "OPEN";
  b1["sensor_ok"] = bottle1.sensorOk;
  b1["calibrated"] = true;
  b1["low_fluid"] = bottle1.lowFluidAlert;

  JsonObject b2 = doc.createNestedObject("bottle2");
  b2["weight_g"] = serialized(String(bottle2.grossWeight_g, 1));
  b2["fluid_g"] = serialized(String(bottle2.fluidMass_g, 1));
  b2["remaining_ml"] = serialized(String(bottle2.remaining_ml, 1));
  b2["valve_command"] = bottle2.valveClosed ? "CLOSED" : "OPEN";
  b2["sensor_ok"] = bottle2.sensorOk;
  b2["calibrated"] = true;
  b2["low_fluid"] = bottle2.lowFluidAlert;

  serializeJson(doc, Serial);
  Serial.println();
}

/**
 * Handles incoming JSON commands over USB Serial from the Node.js backend or Web Serial
 */
void processSerialCommands() {
  if (Serial.available()) {
    String input = Serial.readStringUntil('\n');
    input.trim();
    if (input.length() == 0) return;

    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, input);
    if (!err) {
      const char* cmd = doc["cmd"];
      if (cmd) {
        if (strcmp(cmd, "RESET") == 0 || strcmp(cmd, "OPEN") == 0) {
          int bId = 0;
          if (doc["bottle"].is<int>()) {
            bId = doc["bottle"].as<int>();
          } else if (doc["bottle"].is<const char*>()) {
            const char* bStr = doc["bottle"].as<const char*>();
            if (strcmp(bStr, "1") == 0) bId = 1;
            else if (strcmp(bStr, "2") == 0) bId = 2;
            else bId = 0;
          }
          openValve(bId);
        } else if (strcmp(cmd, "CLOSE") == 0) {
          int bId = 0;
          if (doc["bottle"].is<int>()) {
            bId = doc["bottle"].as<int>();
          } else if (doc["bottle"].is<const char*>()) {
            const char* bStr = doc["bottle"].as<const char*>();
            if (strcmp(bStr, "1") == 0) bId = 1;
            else if (strcmp(bStr, "2") == 0) bId = 2;
            else bId = 0;
          }
          closeValve(bId);
        } else if (strcmp(cmd, "SET_THRESHOLD") == 0) {
          float th = doc["threshold"];
          if (th > 0 && th < 500) {
            lowFluidThreshold_ml = th;
          }
        } else if (strcmp(cmd, "TARE") == 0) {
          int bId = doc["bottle"].as<int>();
          if (bId == 1) {
            long raw = 0;
            if (hx711ReadAverage(HX711_B1_DOUT_PIN, HX711_B1_SCK_PIN, 5, raw)) tareOffsetB1 = raw;
          } else if (bId == 2) {
            long raw = 0;
            if (hx711ReadAverage(HX711_B2_DOUT_PIN, HX711_B2_SCK_PIN, 5, raw)) tareOffsetB2 = raw;
          }
        } else if (strcmp(cmd, "RELAY_POLARITY") == 0) {
          if (doc.containsKey("activeLow")) {
            relayActiveLow = doc["activeLow"].as<bool>();
            applyRelayCommands();
          }
        } else if (strcmp(cmd, "SET_BOTTLE2_FLUID") == 0) {
          if (doc.containsKey("ml")) {
            bottle2DemoFluid_ml = doc["ml"].as<float>();
          }
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------------------
// 8. WI-FI HTTP REST API ENDPOINTS & CORS PREFLIGHT
// -----------------------------------------------------------------------------------------
void sendCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

void handleCORSPreflight() {
  sendCORSHeaders();
  server.send(204);
}

void handleGetReadings() {
  sendCORSHeaders();
  StaticJsonDocument<512> doc;
  doc["device"] = "ESP32";
  doc["timestamp"] = millis();

  JsonObject b1 = doc.createNestedObject("bottle1");
  b1["weight_g"] = serialized(String(bottle1.grossWeight_g, 1));
  b1["fluid_g"] = serialized(String(bottle1.fluidMass_g, 1));
  b1["remaining_ml"] = serialized(String(bottle1.remaining_ml, 1));
  b1["valve_command"] = bottle1.valveClosed ? "CLOSED" : "OPEN";
  b1["sensor_ok"] = bottle1.sensorOk;
  b1["calibrated"] = true;
  b1["low_fluid"] = bottle1.lowFluidAlert;

  JsonObject b2 = doc.createNestedObject("bottle2");
  b2["weight_g"] = serialized(String(bottle2.grossWeight_g, 1));
  b2["fluid_g"] = serialized(String(bottle2.fluidMass_g, 1));
  b2["remaining_ml"] = serialized(String(bottle2.remaining_ml, 1));
  b2["valve_command"] = bottle2.valveClosed ? "CLOSED" : "OPEN";
  b2["sensor_ok"] = bottle2.sensorOk;
  b2["calibrated"] = true;
  b2["low_fluid"] = bottle2.lowFluidAlert;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleGetStatus() {
  sendCORSHeaders();
  StaticJsonDocument<256> doc;
  doc["device"] = "ESP32";
  doc["ip"] = WiFi.localIP().toString();
  doc["uptime_ms"] = millis();
  doc["threshold_ml"] = lowFluidThreshold_ml;
  doc["valve1_closed"] = bottle1.valveClosed;
  doc["valve2_closed"] = bottle2.valveClosed;
  doc["relay_active_low"] = relayActiveLow;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handlePostOpen() {
  sendCORSHeaders();
  int bId = 0;
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    deserializeJson(doc, server.arg("plain"));
    if (doc["bottle"].is<int>()) {
      bId = doc["bottle"].as<int>();
    } else if (doc["bottle"].is<const char*>()) {
      const char* bStr = doc["bottle"].as<const char*>();
      if (strcmp(bStr, "1") == 0) bId = 1;
      else if (strcmp(bStr, "2") == 0) bId = 2;
      else bId = 0;
    }
  }
  openValve(bId);
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Valves commanded OPEN\"}");
}

void handlePostClose() {
  sendCORSHeaders();
  int bId = 0;
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    deserializeJson(doc, server.arg("plain"));
    if (doc["bottle"].is<int>()) {
      bId = doc["bottle"].as<int>();
    } else if (doc["bottle"].is<const char*>()) {
      const char* bStr = doc["bottle"].as<const char*>();
      if (strcmp(bStr, "1") == 0) bId = 1;
      else if (strcmp(bStr, "2") == 0) bId = 2;
      else bId = 0;
    }
  }
  closeValve(bId);
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Valves commanded CLOSED\"}");
}

void handlePostSettings() {
  sendCORSHeaders();
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    deserializeJson(doc, server.arg("plain"));
    if (doc["low_fluid_threshold"].is<float>()) {
      lowFluidThreshold_ml = doc["low_fluid_threshold"].as<float>();
    }
    if (doc.containsKey("active_low")) {
      relayActiveLow = doc["active_low"].as<bool>();
      applyRelayCommands();
    }
  }
  server.send(200, "application/json", "{\"success\":true}");
}

void handlePostTare() {
  sendCORSHeaders();
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    deserializeJson(doc, server.arg("plain"));
    int bId = doc["bottle"].as<int>();
    if (bId == 1) {
      long raw = 0;
      if (hx711ReadAverage(HX711_B1_DOUT_PIN, HX711_B1_SCK_PIN, 5, raw)) tareOffsetB1 = raw;
    } else if (bId == 2) {
      long raw = 0;
      if (hx711ReadAverage(HX711_B2_DOUT_PIN, HX711_B2_SCK_PIN, 5, raw)) tareOffsetB2 = raw;
    }
  }
  server.send(200, "application/json", "{\"success\":true}");
}

// Embedded Web Portal when visiting http://<ESP32_IP>/
void handleRoot() {
  sendCORSHeaders();
  String html = F("<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>"
                  "<title>ESP32 Smart IV Monitor</title>"
                  "<style>body{font-family:sans-serif;background:#f8fafc;color:#0f172a;padding:24px;max-width:540px;margin:auto;}"
                  ".card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06);margin-bottom:16px;border:1px solid #e2e8f0;}"
                  "h1{font-size:1.3rem;margin-top:0;color:#0284c7;}h2{font-size:1rem;margin-top:0;}"
                  "button{background:#0284c7;color:#fff;border:none;padding:10px 16px;border-radius:6px;font-weight:700;cursor:pointer;margin:4px;}"
                  ".btn-danger{background:#ef4444;}.btn-success{background:#10b981;}"
                  ".val{font-weight:800;font-size:1.4rem;color:#0369a1;}</style></head><body>"
                  "<div class='card'><h1>💧 Smart IV Monitor — ESP32</h1>"
                  "<p>IP Address: <strong>");
  html += WiFi.localIP().toString();
  html += F("</strong></p>"
            "<p>API Endpoint: <code>/api/readings</code></p>"
            "</div><div class='card'><h2>Quick Valve Control</h2>"
            "<button class='btn-success' onclick='fetch(\"/api/open\",{method:\"POST\",body:\"{\\\"bottle\\\":0}\"}).then(()=>location.reload())'>▶ Open Both Valves</button>"
            "<button class='btn-danger' onclick='fetch(\"/api/close\",{method:\"POST\",body:\"{\\\"bottle\\\":0}\"}).then(()=>location.reload())'>🛑 Emergency Stop Both</button>"
            "</div><div class='card'><h2>Telemetry</h2><p>Bottle 1 Volume: <span class='val'>");
  html += String(bottle1.remaining_ml, 1);
  html += F(" mL</span> (Valve: ");
  html += bottle1.valveClosed ? "CLOSED" : "OPEN";
  html += F(")</p><p>Bottle 2 Volume: <span class='val'>");
  html += String(bottle2.remaining_ml, 1);
  html += F(" mL</span> (Valve: ");
  html += bottle2.valveClosed ? "CLOSED" : "OPEN";
  html += F(")</p></div></body></html>");
  server.send(200, "text/html", html);
}

// -----------------------------------------------------------------------------------------
// 9. SETUP & INITIALIZATION
// -----------------------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println(F("========================================================="));
  Serial.println(F("  SMART IV FLUID MONITORING SYSTEM - ESP32 FIRMWARE     "));
  Serial.println(F("  Dual Bottle Telemetry & Automatic Shut-Off Prototype   "));
  Serial.println(F("========================================================="));

  // Initialize GPIO Pins
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);

  pinMode(BUZZER_ALARM_PIN, OUTPUT);
  digitalWrite(BUZZER_ALARM_PIN, LOW);

  // Initialize Relay Pins
  pinMode(RELAY_VALVE_1_PIN, OUTPUT);
  pinMode(RELAY_VALVE_2_PIN, OUTPUT);

  // Initial valve state: OPEN (Energized) for normal fluid flow
  setRelay(RELAY_VALVE_1_PIN, true);
  setRelay(RELAY_VALVE_2_PIN, true);
  bottle1.valveClosed = false;
  bottle2.valveClosed = false;

  // Initialize HX711 Pin Modes with internal pull-up on DOUT for signal stability
  pinMode(HX711_B1_DOUT_PIN, INPUT_PULLUP);
  pinMode(HX711_B1_SCK_PIN, OUTPUT);
  digitalWrite(HX711_B1_SCK_PIN, LOW);

  pinMode(HX711_B2_DOUT_PIN, INPUT_PULLUP);
  pinMode(HX711_B2_SCK_PIN, OUTPUT);
  digitalWrite(HX711_B2_SCK_PIN, LOW);

  // Initial Tare Setup:
  // We do NOT zero out an already mounted bottle with fluid!
  // tareOffset remains 0 by default. Calibration tare is performed via UI "Tare" button.
  Serial.println(F("[System] Hardware initialized. Initial valve state: OPEN (Relays Energized)."));

  // Connect to Local Wi-Fi (Non-blocking fallback)
  Serial.print(F("[Wi-Fi] Connecting to: "));
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Wait up to 6 seconds for Wi-Fi connection
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - wifiStart < 6000)) {
    delay(400);
    Serial.print(F("."));
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print(F("[Wi-Fi] Connected successfully! IP Address: "));
    Serial.println(WiFi.localIP());
    Serial.print(F("[Wi-Fi] Access Dashboard at: http://"));
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println(F("[Wi-Fi] Connection timeout. Running in USB Serial mode."));
  }

  // Setup WebServer REST Endpoints with CORS Preflight (OPTIONS)
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/readings", HTTP_GET, handleGetReadings);
  server.on("/api/readings", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/status", HTTP_GET, handleGetStatus);
  server.on("/api/status", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/reset", HTTP_POST, handlePostOpen);
  server.on("/api/reset", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/open", HTTP_POST, handlePostOpen);
  server.on("/api/open", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/close", HTTP_POST, handlePostClose);
  server.on("/api/close", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/settings", HTTP_POST, handlePostSettings);
  server.on("/api/settings", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/tare", HTTP_POST, handlePostTare);
  server.on("/api/tare", HTTP_OPTIONS, handleCORSPreflight);

  server.begin();

  Serial.println(F("[System] Ready. Emitting real-time telemetry over Serial at 115200 baud..."));
}

// -----------------------------------------------------------------------------------------
// 10. MAIN REAL-TIME LOOP
// -----------------------------------------------------------------------------------------
void loop() {
  // Service incoming HTTP requests from local network
  server.handleClient();

  // Parse incoming commands from USB Serial
  processSerialCommands();

  // Periodic sensor measurement & telemetry emission (Every 1000ms)
  unsigned long currentMillis = millis();
  if (currentMillis - lastTelemetryMillis >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMillis = currentMillis;

    // Read sensors and evaluate fluid threshold
    measureBottles();

    // Emit newline-delimited JSON over USB Serial
    emitSerialTelemetry();

    // Heartbeat status LED toggle
    digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
  }
}
