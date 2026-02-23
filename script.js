// DOM (interaction w/ html)
const bot = document.getElementById("bot");
const button = document.getElementById("actionBtn");
const statusText = document.getElementById("status");

const calibrateBtn = document.getElementById("calibrateBtn");
const distanceInput = document.getElementById("distanceInput");
const calibrateStatus = document.getElementById("calibrateStatus");

const sandContainer = document.querySelector('.sand');

let state = "idle";
let travelTime = 3;

// ESP32 IDs
const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

let device, characteristic;
let keepAliveInterval;
let writeInProgress = false; // to prevent overlapping writes

// For Kalman filter
const activeNodes = {}; // node manager

button.addEventListener("click", async () => {
    // If not connected yet, connect to ESP32 (get thru browser security thing)
    if (!device) {
        await connectBluetooth();
    }

    if (state === "idle") {
        summonBot();
    } else if (state === "arrived") {
        returnToBase();
    }
});

// For sending a connection to the ESP32 with specific UUID
async function connectBluetooth() {
    try {
        statusText.innerText = "Status: Pairing Bluetooth...";
        device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Summon' }], // Finds any device starting with "ESP32"
            optionalServices: [SERVICE_UUID]
        });

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
        statusText.innerText = "Status: Bluetooth Connected!";

        await characteristic.startNotifications();
        characteristic.addEventListener("characteristicvaluechanged", handleNotification);
        console.log("Notifications enabled");

        // Heartbeat every 3s, safely using writeInProgress
        keepAliveInterval = setInterval(() => {
            sendBleSignal(9); // heartbeat
        }, 3000);

    } catch (error) {
        console.log("Bluetooth Error: " + error);
        statusText.innerText = "Status: Connection Failed";
    }
}

async function sendBleSignal(value) {
    // If a heartbeat is happening and this is a MOVE command, wait slightly
    if (writeInProgress && isPriority) {
        await new Promise(res => setTimeout(res, 100)); // Short 100ms pause
    }

    if (!characteristic || writeInProgress) return;

    writeInProgress = true;
    try {
        await characteristic.writeValue(new Uint8Array([value]));
        console.log("Command sent: " + value);
    } catch (error) {
        console.log("Heartbeat failed or GATT busy");
    } finally {
        writeInProgress = false;
    }
}

function summonBot() {
    state = "going";
    statusText.innerText = "Status: Bot en route across the beach...";
    button.disabled = true;
    button.innerText = "TRAVELLING...";

    // PHYSICAL SIGNAL
    sendBleSignal(1); // Send '1' to start moving


    // Move diagonally (UI Visual Feedback)
    bot.style.transition = `transform ${travelTime}s ease-in-out`;
    bot.style.transform = "translate(300px, -150px)";

    setTimeout(() => {
        state = "arrived";
        statusText.innerText = "Status: Bot arrived at your location!";
        button.disabled = false;
        button.innerText = "RETURN TO BASE";

        // PHYSICAL SIGNAL
        sendBleSignal(0); // Send '0' to stop

    }, travelTime * 1000);
}

function returnToBase() {
    state = "returning";
    statusText.innerText = "Status: Returning to base...";
    button.disabled = true;
    button.innerText = "RETURNING...";
    
    // PHYSICAL SIGNAL
    sendBleSignal(2); // Send '2' for return command

    // Move back to original position (UI Visual Feedback)
    bot.style.transform = "translate(0px, 0px)";

    setTimeout(() => {
        state = "idle";
        statusText.innerText = "Status: Awaiting command";
        button.disabled = false;
        button.innerText = "SUMMON";

        // PHYSICAL SIGNAL
        sendBleSignal(0); // Send '0' to stop

    }, travelTime * 1000);
}

// function handleNotification(event) {
//     const decoder = new TextDecoder();
//     const value = decoder.decode(event.target.value);

//     // RSSI only
//     const rssi = parseInt(value);
//     console.log("📶 RSSI received:", rssi);

//     // ID + RSSI
//     if (value.includes(":")) {
//         const parts = value.split(":");
//         const id = parts[0];
//         const rssiValue = parseInt(parts[1]);
//         console.log(`📡 Sniffer ${id} RSSI = ${rssiValue}`);
//     }
// }

function handleNotification(event) {
    const decoder = new TextDecoder();
    const value = decoder.decode(event.target.value);

    // ID + RSSI Parsing (assuming format "ID:RSSI")
    if (value.includes(":")) {
        const [id, rssiStr] = value.split(":");
        const rawRssi = parseInt(rssiStr);
        const filteredRssi = processSignal(id, rawRssi);
        
        // Trigger UI updates based on filteredRssi, not rawRssi
    }
}

calibrateBtn.addEventListener("click", () => {
    const distance = parseFloat(distanceInput.value);
    calibrateStatus.className = "calibrate-status";

    if (isNaN(distance) || distance <= 0) {
        calibrateStatus.innerText = "Please enter a valid distance.";
        calibrateStatus.classList.add("error");
        return;
    }

    if (distance <= 100) {
        calibrateStatus.innerText = "Calibration successful. Optimal range confirmed.";
        calibrateStatus.classList.add("success");
        travelTime = Math.max(1, distance / 50);
    } else {
        calibrateStatus.innerText = "Distance too far. Bot may take longer.";
        calibrateStatus.classList.add("warning");
        travelTime = distance / 40;
    }
});

function createSandParticles(count) {
    for (let i = 0; i < count; i++) {
        const particle = document.createElement('div');
        particle.classList.add('sand-particle');
        particle.style.left = Math.random() * 100 + '%';
        particle.style.top = Math.random() * 100 + '%';
        particle.style.animationDuration = (3 + Math.random() * 3) + 's';
        sandContainer.appendChild(particle);
    }
}

// Kalman Filter Logic
class RSSIKalmanFilter {
  constructor(initialRSSI = -60) {
    // Expected movement speed of user (0.01 = slow/stable, 0.1 = fast movement)
    this.processChangeRate = 0.01; 

    // The dBm fluctuation you see in your raw data
    // 2 - 10 based on '10dBm'
    this.measurementNoise = 5.0; 

    this.currentEstimate = initialRSSI; 
    this.errorCovariance = 1.0; // filter's uncertainty
  }

  filter(rawRSSI) {
    // 1. Increase uncertainty because time passed and user couldve moved
    this.errorCovariance += this.processChangeRate;

    // 2. Calculate kalman gain
    const smartAlpha = this.errorCovariance / (this.errorCovariance + this.measurementNoise);

    // 3. Update Estimate (a-B eqn)
    this.currentEstimate += smartAlpha * (rawRSSI - this.currentEstimate);

    // 4. Decrease uncertainty coz got new data
    this.errorCovariance = (1 - smartAlpha) * this.errorCovariance;

    return this.currentEstimate;
  }
}

function processSignal(nodeId, rawRSSI) {
  // If this is the first time we've seen this ESP32, create its filter
  if (!activeNodes[nodeId]) {
    console.log(`Node ${nodeId} detected! Initializing filter...`);
    activeNodes[nodeId] = new RSSIKalmanFilter(rawRSSI);
  }

  // Run filter for node
  const cleanRSSI = activeNodes[nodeId].filter(rawRSSI);

  // Output for testing
  console.log(`[TESTING] Node: ${nodeId} | Raw: ${rawRSSI} | Clean: ${cleanRSSI.toFixed(2)}`);
  
  return cleanRSSI;
}

// UI: Generate Sand Particles
createSandParticles(50);