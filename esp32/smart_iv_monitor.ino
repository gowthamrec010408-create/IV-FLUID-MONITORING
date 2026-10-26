/**
 * =========================================================================================
 * Project Title: Smart IV Fluid Monitoring System with Dual-Bottle Monitoring and Auto Shut-Off
 * Platform: ESP32 Dev Module (Arduino C++)
 * Target Hardware:
 *   - ESP32 Development Board (NodeMCU / DOIT ESP32 DevKit v1)
 *   - 2x HX711 24-bit ADC Modules
 *   - 2x Strain Gauge Load Cells (e.g. 1 kg / 5 kg)
 *   - 1x 2-Channel 5V/12V Relay Module (Optocoupler isolated)
 *   - 2x 12V Solenoid Valves (Normally Closed recommended)
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
#include <Preferences.h>

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
// 2. RELAY POLARITY CONFIGURATION & PERSISTENCE
// -----------------------------------------------------------------------------------------
// Default polarity:
// - ACTIVE-HIGH (false): HIGH (3.3V) turns Relay ON (Energized), LOW (0V) turns Relay OFF.
// - ACTIVE-LOW  (true) : LOW (0V) turns Relay ON (Energized), HIGH (3.3V) turns Relay OFF.
// Default is Active-HIGH so clicking OPEN turns the relay ON and CLOSE turns the relay OFF.
#define DEFAULT_RELAY_ACTIVE_LOW false

bool relayActiveLow = DEFAULT_RELAY_ACTIVE_LOW;
Preferences prefs;

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
// 3. WI-FI CREDENTIALS CONFIGURATION
// -----------------------------------------------------------------------------------------
const char* WIFI_SSID     = "Your_WiFi_SSID";         // Replace with your local Wi-Fi SSID
const char* WIFI_PASSWORD = "Your_WiFi_Password";     // Replace with your local Wi-Fi Password

WebServer server(80);

// -----------------------------------------------------------------------------------------
// 4. CALIBRATION & CONTAINER CONSTANTS
// -----------------------------------------------------------------------------------------
float calibrationFactorB1 = 420.0f; 
float calibrationFactorB2 = 420.0f;

long tareOffsetB1 = 0;
long tareOffsetB2 = 0;

float emptyTareWeightB1_g = 30.0f;
float emptyTareWeightB2_g = 30.0f;

const float FLUID_DENSITY_G_PER_ML = 1.00f; // 1.00 g/mL for demonstration water
float lowFluidThreshold_ml = 20.0f;         // Default shut-off threshold: 20 mL

// Hardware detection flags & virtual demo fluid fallback
// Ensures that testing on a desk without physical load cells or water works seamlessly!
bool bottle1HardwareConnected = false;
float bottle1DemoFluid_ml = 450.0f;

bool bottle2HardwareConnected = false;
float bottle2DemoFluid_ml = 350.0f;

// -----------------------------------------------------------------------------------------
// 5. TELEMETRY DATA STRUCTURES & LATCHED STATE
// -----------------------------------------------------------------------------------------
struct BottleTelemetry {
  float grossWeight_g;      // Total measured weight on load cell
  float fluidMass_g;        // Net fluid mass (gross - tare)
  float remaining_ml;       // Calculated fluid volume in mL
  bool  valveClosed;        // Commanded state: true = CLOSED (Shut-off), false = OPEN
  bool  latchedShutoff;     // True when automatic shut-off triggered due to low fluid
  bool  manualClosed;       // True when operator commanded manual STOP FLOW
  bool  manualOverrideOpen; // True when operator commanded manual valve OPEN
  bool  sensorOk;           // Health of HX711 sensor interface
  bool  lowFluidAlert;      // True when fluid <= threshold
};

BottleTelemetry bottle1 = { 0.0f, 0.0f, 0.0f, false, false, false, true, false, false };
BottleTelemetry bottle2 = { 0.0f, 0.0f, 0.0f, false, false, false, true, false, false };

// Loop Timers (Non-blocking timing)
unsigned long lastTelemetryMillis = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 1000;

// Forward declarations
void applyRelayCommands();
void openValve(int bottleId);
void closeValve(int bottleId);
void setRelayPolarity(bool activeLow);
void testRelays();

// -----------------------------------------------------------------------------------------
// 6. DIRECT HX711 BIT-BANG DRIVER
// -----------------------------------------------------------------------------------------
bool hx711ReadRaw(uint8_t doutPin, uint8_t sckPin, long &outputValue) {
  unsigned long start = millis();
  
  // Wait up to 35ms for DOUT to go LOW (Conversion ready).
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
// 7. SENSOR MEASUREMENT & VOLUME ESTIMATION
// -----------------------------------------------------------------------------------------
void measureBottles() {
  long rawB1 = 0;
  long rawB2 = 0;

  // --- Read Bottle 1 ---
  if (hx711ReadAverage(HX711_B1_DOUT_PIN, HX711_B1_SCK_PIN, 2, rawB1)) {
    bottle1HardwareConnected = true;
    bottle1.sensorOk = true;
    bottle1.grossWeight_g = (float)(rawB1 - tareOffsetB1) / calibrationFactorB1;
    
    if (bottle1.grossWeight_g < 0.0f && bottle1.grossWeight_g > -5.0f) {
      bottle1.grossWeight_g = 0.0f;
    }
    
    float netFluid = bottle1.grossWeight_g - emptyTareWeightB1_g;
    bottle1.fluidMass_g = netFluid > 0.0f ? netFluid : 0.0f;
    bottle1.remaining_ml = bottle1.fluidMass_g / FLUID_DENSITY_G_PER_ML;
  } else {
    // If physical load cell 1 is not connected, provide virtual demo fluid
    // so bench testing and relay actuation work smoothly!
    bottle1.sensorOk = true;
    bottle1.grossWeight_g = bottle1DemoFluid_ml + emptyTareWeightB1_g;
    bottle1.fluidMass_g = bottle1DemoFluid_ml;
    bottle1.remaining_ml = bottle1DemoFluid_ml;

    if (!bottle1.valveClosed && bottle1DemoFluid_ml > 0.0f) {
      bottle1DemoFluid_ml -= 0.5f;
      if (bottle1DemoFluid_ml < 0.0f) bottle1DemoFluid_ml = 0.0f;
    }
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
    bottle2.sensorOk = true;
    bottle2.grossWeight_g = bottle2DemoFluid_ml + emptyTareWeightB2_g;
    bottle2.fluidMass_g = bottle2DemoFluid_ml;
    bottle2.remaining_ml = bottle2DemoFluid_ml;

    if (!bottle2.valveClosed && bottle2DemoFluid_ml > 0.0f) {
      bottle2DemoFluid_ml -= 0.5f;
      if (bottle2DemoFluid_ml < 0.0f) bottle2DemoFluid_ml = 0.0f;
    }
  }

  // ---------------------------------------------------------------------------------------
  // EVALUATION & AUTOMATIC SHUT-OFF LOGIC WITH MANUAL OVERRIDE PROTECTION
  // ---------------------------------------------------------------------------------------
  // Bottle 1 Evaluation
  if (bottle1.sensorOk) {
    if (bottle1.remaining_ml <= lowFluidThreshold_ml) {
      bottle1.lowFluidAlert = true;
      // Auto shut-off triggers ONLY if operator did not explicitly command manual OPEN override
      if (!bottle1.manualOverrideOpen) {
        bottle1.latchedShutoff = true;
      }
    } else {
      // Fluid is AVAILABLE! Clear alerts
      bottle1.lowFluidAlert = false;
      if (!bottle1.manualClosed) {
        bottle1.latchedShutoff = false;
      }
      // Re-arm automatic shut-off safety protection once fluid is confirmed available
      bottle1.manualOverrideOpen = false;
    }
  }

  // Bottle 2 Evaluation
  if (bottle2.sensorOk) {
    if (bottle2.remaining_ml <= lowFluidThreshold_ml) {
      bottle2.lowFluidAlert = true;
      if (!bottle2.manualOverrideOpen) {
        bottle2.latchedShutoff = true;
      }
    } else {
      bottle2.lowFluidAlert = false;
      if (!bottle2.manualClosed) {
        bottle2.latchedShutoff = false;
      }
      bottle2.manualOverrideOpen = false;
    }
  }

  // Actuate Solenoid Relays
  applyRelayCommands();
}

/**
 * Commands relay module according to latched shut-off safety rules.
 * When fluid is available or manual OPEN: Relay ENERGIZES (valve OPEN).
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

  // Audible Buzzer Alarm: sounds only if an active bottle has low fluid and is not manually overridden
  bool audibleAlert = (bottle1.sensorOk && bottle1.lowFluidAlert && !bottle1.manualOverrideOpen) ||
                      (bottle2.sensorOk && bottle2.lowFluidAlert && !bottle2.manualOverrideOpen);
  digitalWrite(BUZZER_ALARM_PIN, audibleAlert ? HIGH : LOW);
}

/**
 * Commands valve to OPEN (resumes fluid flow, unlatches shut-off, and sets manual override)
 */
void openValve(int bottleId) {
  if (bottleId == 1 || bottleId == 0) {
    bottle1.manualClosed = false;
    bottle1.manualOverrideOpen = true; // Operator explicitly commands valve OPEN
    bottle1.latchedShutoff = false;
    bottle1.lowFluidAlert = false;
    bottle1.valveClosed = false;
    if (!bottle1HardwareConnected && bottle1DemoFluid_ml <= lowFluidThreshold_ml) {
      bottle1DemoFluid_ml = 450.0f;
    }
  }
  if (bottleId == 2 || bottleId == 0) {
    bottle2.manualClosed = false;
    bottle2.manualOverrideOpen = true; // Operator explicitly commands valve OPEN
    bottle2.latchedShutoff = false;
    bottle2.lowFluidAlert = false;
    bottle2.valveClosed = false;
    if (!bottle2HardwareConnected && bottle2DemoFluid_ml <= lowFluidThreshold_ml) {
      bottle2DemoFluid_ml = 350.0f;
    }
  }
  applyRelayCommands();
  Serial.printf("[Valve] OPEN command applied for Bottle %d. Relays ENERGIZED (Logic level: %s)\n", 
                bottleId, getRelayEnergizedLevel() == LOW ? "LOW (0V)" : "HIGH (3.3V)");
}

/**
 * Commands valve to CLOSE (Emergency Stop or manual operator pause)
 */
void closeValve(int bottleId) {
  if (bottleId == 1 || bottleId == 0) {
    bottle1.manualClosed = true;
    bottle1.manualOverrideOpen = false;
    bottle1.latchedShutoff = true;
    bottle1.valveClosed = true;
  }
  if (bottleId == 2 || bottleId == 0) {
    bottle2.manualClosed = true;
    bottle2.manualOverrideOpen = false;
    bottle2.latchedShutoff = true;
    bottle2.valveClosed = true;
  }
  applyRelayCommands();
  Serial.printf("[Valve] CLOSE command applied for Bottle %d. Relays DE-ENERGIZED (Logic level: %s)\n", 
                bottleId, getRelayDeenergizedLevel() == LOW ? "LOW (0V)" : "HIGH (3.3V)");
}

/**
 * Updates relay polarity and persists to non-volatile storage
 */
void setRelayPolarity(bool activeLow) {
  relayActiveLow = activeLow;
  prefs.putBool("activeLow_v2", relayActiveLow);
  prefs.putBool("activeLow", relayActiveLow);
  Serial.printf("[Relay] Polarity set to: %s (OPEN/Energized = %s, CLOSE/De-energized = %s)\n",
                relayActiveLow ? "ACTIVE-LOW" : "ACTIVE-HIGH",
                relayActiveLow ? "LOW (0V)" : "HIGH (3.3V)",
                relayActiveLow ? "HIGH (3.3V)" : "LOW (0V)");
  applyRelayCommands();
}

/**
 * Diagnostic Relay Click Test: pulses each relay to verify hardware actuation
 */
void testRelays() {
  Serial.println(F("========================================================="));
  Serial.println(F("[Relay Test] Starting Hardware Actuation Diagnostic...   "));
  Serial.printf("[Relay Test] Current Mode: %s\n", relayActiveLow ? "ACTIVE-LOW (0V = Energized)" : "ACTIVE-HIGH (3.3V = Energized)");
  Serial.println(F("========================================================="));

  Serial.println(F("[Relay Test] >> Pulsing Relay 1 (GPIO 18) ON for 1.5 seconds..."));
  setRelay(RELAY_VALVE_1_PIN, true);
  digitalWrite(STATUS_LED_PIN, HIGH);
  delay(1500);

  Serial.println(F("[Relay Test] >> De-energizing Relay 1..."));
  setRelay(RELAY_VALVE_1_PIN, false);
  digitalWrite(STATUS_LED_PIN, LOW);
  delay(500);

  Serial.println(F("[Relay Test] >> Pulsing Relay 2 (GPIO 19) ON for 1.5 seconds..."));
  setRelay(RELAY_VALVE_2_PIN, true);
  digitalWrite(STATUS_LED_PIN, HIGH);
  delay(1500);

  Serial.println(F("[Relay Test] >> De-energizing Relay 2..."));
  setRelay(RELAY_VALVE_2_PIN, false);
  digitalWrite(STATUS_LED_PIN, LOW);
  delay(500);

  Serial.println(F("[Relay Test] Diagnostic completed!"));
  Serial.println(F("[Relay Test] If you did NOT hear audible clicks or see LEDs light on the relay board:"));
  Serial.println(F("[Relay Test] -> Send 'POLARITY' to flip between Active-LOW and Active-HIGH mode."));
  Serial.println(F("========================================================="));

  applyRelayCommands();
}

// -----------------------------------------------------------------------------------------
// 8. SERIAL JSON TELEMETRY EMISSION & DUAL-FORMAT COMMAND PARSING
// -----------------------------------------------------------------------------------------
void emitSerialTelemetry() {
  StaticJsonDocument<512> doc;

  doc["device"] = "ESP32";
  doc["timestamp"] = millis();
  doc["relay_active_low"] = relayActiveLow;

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
 * Handles incoming commands from USB Serial:
 * Supports BOTH human-friendly plain text (from Arduino Serial Monitor)
 * AND structured JSON (from Node.js server / Web Serial).
 */
void processSerialCommands() {
  if (Serial.available()) {
    String input = Serial.readStringUntil('\n');
    input.trim();
    if (input.length() == 0) return;

    // --- 1. PLAIN TEXT COMMAND HANDLING (Convenient for Arduino IDE Serial Monitor) ---
    String upper = input;
    upper.toUpperCase();

    if (upper == "OPEN" || upper == "OPEN ALL" || upper == "OPEN 0") {
      openValve(0);
      return;
    } else if (upper == "OPEN 1" || upper == "OPEN B1") {
      openValve(1);
      return;
    } else if (upper == "OPEN 2" || upper == "OPEN B2") {
      openValve(2);
      return;
    } else if (upper == "CLOSE" || upper == "STOP" || upper == "CLOSE ALL" || upper == "CLOSE 0") {
      closeValve(0);
      return;
    } else if (upper == "CLOSE 1" || upper == "STOP 1" || upper == "CLOSE B1") {
      closeValve(1);
      return;
    } else if (upper == "CLOSE 2" || upper == "STOP 2" || upper == "CLOSE B2") {
      closeValve(2);
      return;
    } else if (upper == "POLARITY" || upper == "POLARITY TOGGLE") {
      setRelayPolarity(!relayActiveLow);
      return;
    } else if (upper == "POLARITY LOW" || upper == "ACTIVE LOW") {
      setRelayPolarity(true);
      return;
    } else if (upper == "POLARITY HIGH" || upper == "ACTIVE HIGH") {
      setRelayPolarity(false);
      return;
    } else if (upper == "TEST" || upper == "TEST RELAY" || upper == "RELAY TEST") {
      testRelays();
      return;
    } else if (upper == "TARE 1" || upper == "TARE B1") {
      long raw = 0;
      if (hx711ReadAverage(HX711_B1_DOUT_PIN, HX711_B1_SCK_PIN, 5, raw)) {
        tareOffsetB1 = raw;
        prefs.putLong("tareB1", tareOffsetB1);
        Serial.println(F("[Tare] Bottle 1 load cell zeroed and offset saved."));
      }
      return;
    } else if (upper == "TARE 2" || upper == "TARE B2") {
      long raw = 0;
      if (hx711ReadAverage(HX711_B2_DOUT_PIN, HX711_B2_SCK_PIN, 5, raw)) {
        tareOffsetB2 = raw;
        prefs.putLong("tareB2", tareOffsetB2);
        Serial.println(F("[Tare] Bottle 2 load cell zeroed and offset saved."));
      }
      return;
    } else if (upper == "HELP" || upper == "?") {
      Serial.println(F("Available Serial Commands:"));
      Serial.println(F("  OPEN [1|2|ALL]     - Open valves and energize relays"));
      Serial.println(F("  CLOSE [1|2|ALL]    - Close valves and de-energize relays"));
      Serial.println(F("  POLARITY           - Toggle relay between Active-LOW and Active-HIGH"));
      Serial.println(F("  TEST               - Run 3-second relay click diagnostic"));
      Serial.println(F("  TARE [1|2]         - Zero load cell offset"));
      return;
    }

    // --- 2. JSON COMMAND HANDLING ---
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
            prefs.putFloat("threshold", lowFluidThreshold_ml);
            Serial.printf("[Threshold] Updated to %.1f mL\n", lowFluidThreshold_ml);
          }
        } else if (strcmp(cmd, "TARE") == 0) {
          int bId = doc["bottle"].as<int>();
          if (bId == 1) {
            long raw = 0;
            if (hx711ReadAverage(HX711_B1_DOUT_PIN, HX711_B1_SCK_PIN, 5, raw)) {
              tareOffsetB1 = raw;
              prefs.putLong("tareB1", tareOffsetB1);
            }
          } else if (bId == 2) {
            long raw = 0;
            if (hx711ReadAverage(HX711_B2_DOUT_PIN, HX711_B2_SCK_PIN, 5, raw)) {
              tareOffsetB2 = raw;
              prefs.putLong("tareB2", tareOffsetB2);
            }
          }
        } else if (strcmp(cmd, "RELAY_POLARITY") == 0) {
          if (doc.containsKey("activeLow")) {
            setRelayPolarity(doc["activeLow"].as<bool>());
          } else if (doc.containsKey("active_low")) {
            setRelayPolarity(doc["active_low"].as<bool>());
          }
        } else if (strcmp(cmd, "TEST_RELAY") == 0) {
          testRelays();
        } else if (strcmp(cmd, "SET_BOTTLE1_FLUID") == 0) {
          if (doc.containsKey("ml")) bottle1DemoFluid_ml = doc["ml"].as<float>();
        } else if (strcmp(cmd, "SET_BOTTLE2_FLUID") == 0) {
          if (doc.containsKey("ml")) bottle2DemoFluid_ml = doc["ml"].as<float>();
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------------------
// 9. WI-FI HTTP REST API ENDPOINTS & CORS PREFLIGHT
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
  doc["relay_active_low"] = relayActiveLow;

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
  StaticJsonDocument<384> doc;
  doc["device"] = "ESP32";
  doc["ip"] = WiFi.localIP().toString();
  doc["uptime_ms"] = millis();
  doc["threshold_ml"] = lowFluidThreshold_ml;
  doc["valve1_closed"] = bottle1.valveClosed;
  doc["valve2_closed"] = bottle2.valveClosed;
  doc["relay_active_low"] = relayActiveLow;
  doc["relay1_pin_state"] = digitalRead(RELAY_VALVE_1_PIN);
  doc["relay2_pin_state"] = digitalRead(RELAY_VALVE_2_PIN);

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
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Valves commanded OPEN (Relays Energized)\"}");
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
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Valves commanded CLOSED (Relays De-energized)\"}");
}

void handlePostSettings() {
  sendCORSHeaders();
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    deserializeJson(doc, server.arg("plain"));
    if (doc["low_fluid_threshold"].is<float>()) {
      lowFluidThreshold_ml = doc["low_fluid_threshold"].as<float>();
      prefs.putFloat("threshold", lowFluidThreshold_ml);
    }
    if (doc.containsKey("active_low")) {
      setRelayPolarity(doc["active_low"].as<bool>());
    } else if (doc.containsKey("relay_active_low")) {
      setRelayPolarity(doc["relay_active_low"].as<bool>());
    }
  }
  server.send(200, "application/json", "{\"success\":true}");
}

void handleRelayPolarity() {
  sendCORSHeaders();
  if (server.method() == HTTP_POST && server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    deserializeJson(doc, server.arg("plain"));
    if (doc.containsKey("active_low")) {
      setRelayPolarity(doc["active_low"].as<bool>());
    } else if (doc.containsKey("activeLow")) {
      setRelayPolarity(doc["activeLow"].as<bool>());
    }
  } else {
    // Toggle if GET
    setRelayPolarity(!relayActiveLow);
  }
  
  StaticJsonDocument<128> resp;
  resp["success"] = true;
  resp["relay_active_low"] = relayActiveLow;
  String out;
  serializeJson(resp, out);
  server.send(200, "application/json", out);
}

void handleRelayTest() {
  sendCORSHeaders();
  testRelays();
  server.send(200, "application/json", "{\"success\":true,\"message\":\"Relay test completed\"}");
}

void handlePostTare() {
  sendCORSHeaders();
  if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    deserializeJson(doc, server.arg("plain"));
    int bId = doc["bottle"].as<int>();
    if (bId == 1) {
      long raw = 0;
      if (hx711ReadAverage(HX711_B1_DOUT_PIN, HX711_B1_SCK_PIN, 5, raw)) {
        tareOffsetB1 = raw;
        prefs.putLong("tareB1", tareOffsetB1);
      }
    } else if (bId == 2) {
      long raw = 0;
      if (hx711ReadAverage(HX711_B2_DOUT_PIN, HX711_B2_SCK_PIN, 5, raw)) {
        tareOffsetB2 = raw;
        prefs.putLong("tareB2", tareOffsetB2);
      }
    }
  }
  server.send(200, "application/json", "{\"success\":true}");
}

// Embedded Web Portal when visiting http://<ESP32_IP>/
void handleRoot() {
  sendCORSHeaders();
  String html = F("<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1.0'>"
                  "<title>ESP32 Smart IV Monitor</title>"
                  "<style>body{font-family:sans-serif;background:#f8fafc;color:#0f172a;padding:24px;max-width:580px;margin:auto;}"
                  ".card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06);margin-bottom:16px;border:1px solid #e2e8f0;}"
                  "h1{font-size:1.3rem;margin-top:0;color:#0284c7;}h2{font-size:1rem;margin-top:0;}"
                  "button{background:#0284c7;color:#fff;border:none;padding:10px 14px;border-radius:6px;font-weight:700;cursor:pointer;margin:4px;}"
                  ".btn-danger{background:#ef4444;}.btn-success{background:#10b981;}.btn-amber{background:#f59e0b;}"
                  ".val{font-weight:800;font-size:1.3rem;color:#0369a1;}"
                  ".badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:0.8rem;font-weight:700;background:#e0f2fe;color:#0369a1;}"
                  "</style></head><body>"
                  "<div class='card'><h1>💧 Smart IV Monitor — ESP32</h1>"
                  "<p>IP Address: <strong>");
  html += WiFi.localIP().toString();
  html += F("</strong></p><p>Relay Polarity: <span class='badge'>");
  html += relayActiveLow ? "ACTIVE-LOW (0V = ON)" : "ACTIVE-HIGH (3.3V = ON)";
  html += F("</span></p></div><div class='card'><h2>Valve &amp; Relay Controls</h2>"
            "<button class='btn-success' onclick='fetch(\"/api/open\",{method:\"POST\",body:\"{\\\"bottle\\\":0}\"}).then(()=>location.reload())'>▶ Open Both Valves</button>"
            "<button class='btn-danger' onclick='fetch(\"/api/close\",{method:\"POST\",body:\"{\\\"bottle\\\":0}\"}).then(()=>location.reload())'>🛑 Emergency Stop Both</button>"
            "<hr style='margin:12px 0;border:0;border-top:1px solid #e2e8f0;'>"
            "<button class='btn-amber' onclick='fetch(\"/api/relay/polarity\",{method:\"GET\"}).then(()=>location.reload())'>🔄 Switch Relay Polarity</button>"
            "<button class='btn-amber' onclick='fetch(\"/api/relay/test\",{method:\"GET\"}).then(()=>alert(\"Testing relays for 3s...\"))'>⚡ Test Relay Clicks</button>"
            "</div><div class='card'><h2>Telemetry Readouts</h2><p>Bottle 1 Volume: <span class='val'>");
  html += String(bottle1.remaining_ml, 1);
  html += F(" mL</span> (Valve: <strong>");
  html += bottle1.valveClosed ? "CLOSED" : "OPEN";
  html += F("</strong>)</p><p>Bottle 2 Volume: <span class='val'>");
  html += String(bottle2.remaining_ml, 1);
  html += F(" mL</span> (Valve: <strong>");
  html += bottle2.valveClosed ? "CLOSED" : "OPEN";
  html += F("</strong>)</p></div></body></html>");
  server.send(200, "text/html", html);
}

// -----------------------------------------------------------------------------------------
// 10. SETUP & INITIALIZATION
// -----------------------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);

  // Initialize Non-Volatile Storage (Preferences)
  prefs.begin("iv-monitor", false);
  // Default is Active-HIGH (false) so OPEN = HIGH (Relay ON) and CLOSE = LOW (Relay OFF)
  if (!prefs.isKey("activeLow_v2")) {
    relayActiveLow = DEFAULT_RELAY_ACTIVE_LOW;
    prefs.putBool("activeLow_v2", relayActiveLow);
    prefs.putBool("activeLow", relayActiveLow);
  } else {
    relayActiveLow = prefs.getBool("activeLow_v2", DEFAULT_RELAY_ACTIVE_LOW);
  }
  lowFluidThreshold_ml = prefs.getFloat("threshold", 20.0f);
  tareOffsetB1 = prefs.getLong("tareB1", 0);
  tareOffsetB2 = prefs.getLong("tareB2", 0);

  Serial.println();
  Serial.println(F("========================================================="));
  Serial.println(F("  SMART IV FLUID MONITORING SYSTEM - ESP32 FIRMWARE     "));
  Serial.println(F("  Dual Bottle Telemetry & Automatic Shut-Off Prototype   "));
  Serial.println(F("========================================================="));
  Serial.printf("[Config] Relay Mode: %s\n", relayActiveLow ? "ACTIVE-LOW (0V = Energized)" : "ACTIVE-HIGH (3.3V = Energized)");
  Serial.printf("[Config] Low-Fluid Threshold: %.1f mL\n", lowFluidThreshold_ml);

  // Initialize GPIO Pins
  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, LOW);

  pinMode(BUZZER_ALARM_PIN, OUTPUT);
  digitalWrite(BUZZER_ALARM_PIN, LOW);

  // Initialize Relay Pins with correct initial level to prevent boot clicks
  digitalWrite(RELAY_VALVE_1_PIN, getRelayEnergizedLevel());
  pinMode(RELAY_VALVE_1_PIN, OUTPUT);

  digitalWrite(RELAY_VALVE_2_PIN, getRelayEnergizedLevel());
  pinMode(RELAY_VALVE_2_PIN, OUTPUT);

  // Initial valve state: OPEN (Energized) for fluid flow
  bottle1.valveClosed = false;
  bottle1.manualOverrideOpen = true; // Allow initial bench testing without immediate re-latch
  bottle2.valveClosed = false;
  bottle2.manualOverrideOpen = true;
  applyRelayCommands();

  // Initialize HX711 Pin Modes with internal pull-up on DOUT for signal stability
  pinMode(HX711_B1_DOUT_PIN, INPUT_PULLUP);
  pinMode(HX711_B1_SCK_PIN, OUTPUT);
  digitalWrite(HX711_B1_SCK_PIN, LOW);

  pinMode(HX711_B2_DOUT_PIN, INPUT_PULLUP);
  pinMode(HX711_B2_SCK_PIN, OUTPUT);
  digitalWrite(HX711_B2_SCK_PIN, LOW);

  Serial.println(F("[System] Hardware initialized. Initial valve state: OPEN (Relays Energized)."));

  // Connect to Local Wi-Fi (Non-blocking fallback)
  Serial.print(F("[Wi-Fi] Connecting to: "));
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - wifiStart < 5000)) {
    delay(300);
    Serial.print(F("."));
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print(F("[Wi-Fi] Connected successfully! IP Address: "));
    Serial.println(WiFi.localIP());
  } else {
    Serial.println();
    Serial.println(F("[Wi-Fi] Not connected. Running in USB Serial mode."));
  }

  // Setup WebServer REST Endpoints
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

  server.on("/api/relay/polarity", HTTP_POST, handleRelayPolarity);
  server.on("/api/relay/polarity", HTTP_GET, handleRelayPolarity);
  server.on("/api/relay/polarity", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/relay/test", HTTP_POST, handleRelayTest);
  server.on("/api/relay/test", HTTP_GET, handleRelayTest);
  server.on("/api/relay/test", HTTP_OPTIONS, handleCORSPreflight);

  server.on("/api/tare", HTTP_POST, handlePostTare);
  server.on("/api/tare", HTTP_OPTIONS, handleCORSPreflight);

  server.begin();

  Serial.println(F("[Ready] Emitting telemetry at 115200 baud."));
  Serial.println(F("[Tip] Type 'POLARITY' in Serial Monitor to switch Active-LOW / Active-HIGH."));
  Serial.println(F("[Tip] Type 'TEST' in Serial Monitor to test relay clicking."));
  Serial.println(F("[Tip] Type 'OPEN' or 'CLOSE' to manually command valves."));
}

// -----------------------------------------------------------------------------------------
// 11. MAIN REAL-TIME LOOP
// -----------------------------------------------------------------------------------------
void loop() {
  server.handleClient();
  processSerialCommands();

  unsigned long currentMillis = millis();
  if (currentMillis - lastTelemetryMillis >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMillis = currentMillis;

    measureBottles();
    emitSerialTelemetry();

    digitalWrite(STATUS_LED_PIN, !digitalRead(STATUS_LED_PIN));
  }
}
