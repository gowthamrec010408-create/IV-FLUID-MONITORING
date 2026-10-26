# Smart IV Fluid Monitoring System — Hardware Wiring Guide

## 1. Safety Cautions & Electrical Architecture

> [!CAUTION]
> **DO NOT DRIVE SOLENOID VALVES DIRECTLY FROM ESP32 GPIO PINS.**
> Solenoid valves draw 300 mA to 1.5 A of inductive DC current. Drawing inductive loads directly from ESP32 pins (rated for only 12 mA maximum) will instantly destroy the microcontroller.
> Always use an optocoupler-isolated relay module powered by a separate external 12V DC power supply.

> [!IMPORTANT]
> **Flyback Protection Diodes (1N4007)**:
> When a solenoid valve is de-energized, its collapsing magnetic field generates high-voltage inductive spikes (back-EMF) exceeding 100V. Install a 1N4007 diode directly across each solenoid valve's terminals with the diode cathode (silver band) connected to the positive supply line (+12V) and the anode connected to the switched negative line.

---

## 2. ESP32 Pin Allocation Table

All GPIO assignments are mapped to avoid boot strapping conflicts on the ESP32 (avoiding GPIO 0, 2, 12, 15 for sensitive boot straps):

| Device Subsystem | Hardware Pin Label | ESP32 GPIO | Description |
| :--- | :--- | :--- | :--- |
| **Bottle 1 HX711** | DOUT (Data) | **GPIO 16** | 24-bit ADC serial data input |
| **Bottle 1 HX711** | SCK (Clock) | **GPIO 4** | ADC clock pulse output |
| **Bottle 2 HX711** | DOUT (Data) | **GPIO 17** | 24-bit ADC serial data input |
| **Bottle 2 HX711** | SCK (Clock) | **GPIO 5** | ADC clock pulse output |
| **Relay Channel 1** | IN1 (Valve 1) | **GPIO 18** | Active-LOW solenoid valve 1 control |
| **Relay Channel 2** | IN2 (Valve 2) | **GPIO 19** | Active-LOW solenoid valve 2 control |
| **Buzzer / Audio** | Positive (+) | **GPIO 21** | Optional low-fluid alarm piezo buzzer |
| **Status LED** | Onboard LED | **GPIO 2** | Visual heartbeat & telemetry pulse |

---

## 3. Load Cell & HX711 Wiring (Dual Channel)

Each IV bottle rests on or hangs from a 1 kg or 5 kg strain-gauge load cell connected to its own dedicated HX711 amplifier.

### 4-Wire Load Cell Color Standard:
- **RED Wire**: Excitation + (Connects to HX711 `E+`)
- **BLACK Wire**: Excitation - (Connects to HX711 `E-`)
- **WHITE Wire**: Signal + (Connects to HX711 `A+`)
- **GREEN Wire**: Signal - (Connects to HX711 `A-`)

*(Note: Some load cell manufacturers swap Green and White wires. If reading direction is reversed, swap A+ and A-).*

### HX711 Module to ESP32 Connections:

#### Channel 1 (Bottle 1 — Left IV Container):
```
HX711 Module #1              ESP32 Dev Module
------------------------------------------------
VCC                   --->   3.3V (or 5V if 5V-tolerant module)
GND                   --->   GND
DOUT (DT)             --->   GPIO 16
SCK (CLK)             --->   GPIO 4
```

#### Channel 2 (Bottle 2 — Right IV Container):
```
HX711 Module #2              ESP32 Dev Module
------------------------------------------------
VCC                   --->   3.3V (or 5V if 5V-tolerant module)
GND                   --->   GND
DOUT (DT)             --->   GPIO 17
SCK (CLK)             --->   GPIO 5
```

---

## 4. 2-Channel Relay Module & Solenoid Valve Wiring

Use an optocoupler-isolated 5V 2-channel relay module to switch 12V DC power to the solenoid valves.

### ESP32 to Relay Module Logic Connections:
```
2-Channel Relay Board        ESP32 Dev Module
------------------------------------------------
VCC                   --->   5V (VIN from USB or external 5V)
GND                   --->   GND (Common Ground)
IN1                   --->   GPIO 18
IN2                   --->   GPIO 19
```

### High-Current Solenoid Power Circuit (External 12V DC 2A Adapter):

```
                       +12V DC Power Supply (+)
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
             Relay 1 [COM]                  Relay 2 [COM]
             Relay 1 [NO]                   Relay 2 [NO]
                  │                               │
                  ├──[Cathode|Diode 1N4007]───────┤──[Cathode|Diode 1N4007]
                  │   (Silver Band)               │   (Silver Band)
             Solenoid Valve 1                Solenoid Valve 2
                  │   (Anode)                     │   (Anode)
                  ├──[Anode  |Diode 1N4007]───────┤──[Anode  |Diode 1N4007]
                  │                               │
                  └───────────────┬───────────────┘
                                  │
                       -12V DC Power Supply (GND)
```

- **COM (Common)**: Connected to +12V DC Power.
- **NO (Normally Open)**: Connected to the positive lead of the solenoid valve.
- When the ESP32 commands the valve to **OPEN** during infusion, the relay coil energizes, connecting COM to NO, supplying 12V to open the solenoid valve.
- When remaining volume reaches &le; 20 mL, the ESP32 commands the relay to **DE-ENERGIZE (CLOSED)**, instantly cutting 12V power and mechanically snapping the spring-loaded valve shut.

---

## 5. Physical Demonstration Rig Setup

1. **Bottle Stands**: Mount each load cell horizontally using M4/M5 standoffs. Attach an acrylic platform or 3D-printed cup holder on top to securely seat a 500 mL IV bottle or saline bag.
2. **Tubing Routing**: Connect silicone demonstration tubing from the base of Bottle 1 through Solenoid Valve 1 into a collection beaker. Repeat identically for Bottle 2 through Solenoid Valve 2.
3. **Common Ground**: Ensure the external 12V power supply ground, 5V power supply ground, and ESP32 GND pin share a common ground plane.

---

## 6. Relay Polarity Troubleshooting & Diagnostic Guide

### Why is the relay not turning on?

If your relay does not click or turn on, check these common causes:

1. **Relay Module Trigger Polarity (Active-LOW vs Active-HIGH)**:
   - **Active-LOW** (Most standard 5V optocoupler relay boards): Pin = `LOW (0V)` turns relay ON.
   - **Active-HIGH** (Transistor-driven or jumper-configured modules): Pin = `HIGH (3.3V)` turns relay ON.
   - **How to fix / switch polarity**:
     - **Web Dashboard**: Click the **🔄 Relay: Active-LOW / Active-HIGH** button on the top bar or in the Settings modal.
     - **Arduino Serial Monitor**: Type `POLARITY` and press Enter to toggle between Active-LOW and Active-HIGH.
     - **Hardware Jumper**: If your relay module has a small yellow jumper labeled `HIGH / LOW`, ensure it matches your chosen setting.

2. **Relay VCC Voltage Supply**:
   - The relay module `VCC` pin **must receive 5V** (from the ESP32 `VIN` pin when powered by USB, or from a 5V power supply). The ESP32 `3.3V` pin cannot output enough current to pull in a 5V mechanical relay coil.
   - Ensure the ESP32 `GND` and Relay Module `GND` are connected together (Common Ground).

3. **Valve Opening Logic & Bench Testing**:
   - The firmware includes manual open override protection. When you click **▶ Open Valve** or **▶ Open Both Valves**, the valve stays open even if the bottle has no fluid on the bench.
   - To test the relays without sensors, simply click **⚡ Test Relay** on the dashboard or type `TEST` in the Serial Monitor. The ESP32 will pulse Relay 1 for 1.5 seconds, then Relay 2 for 1.5 seconds.

