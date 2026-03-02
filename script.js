const bot = document.getElementById("bot");
const summonBtn = document.getElementById("actionBtn");
const recalibrateBtn = document.getElementById("recalibrateBtn");
const statusText = document.getElementById("status");
const progressText = document.getElementById("progressText");

const btn1m = document.getElementById("btn1m");
const btn3m = document.getElementById("btn3m");

let calibratedEnvs = new Set();
let travelTime = 2;
let state = "idle";
let sampling = false; // prevents double sampling

/* ENV BUTTONS */
btn1m.addEventListener("click", async() => await selectEnvironment(1));
btn3m.addEventListener("click", async() => await selectEnvironment(3));

// ESP32 IDs
const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

let device, characteristic;
let keepAliveInterval;
let writeInProgress = false; // to prevent overlapping writes

// Variables for Kalman filter
const activeNodes = {}; // node manager

// Variables for calibration
let calibrationBuffer = [];
let rssiAt1m = null;
let rssiAt3m = null;
let n_factor = 2.0; // path loss exponent, to be calculated. default 2.0
const calibrationDuration = 4000;

// Variables for trilateration
const userHeight = 1; // height of phone off ground, for calculating floor dist.
const snifferAnchors = {
    0: { x: 0,   y: 0 },    // Sniffer 0 at Origin
    1: { x: 5,   y: 0 },    // Sniffer 1 at 5m on X-axis
    2: { x: 2.5, y: 4.33 }  // Sniffer 2 forming a triangle
};

// For zone estimation
const currentClosestZone = null;

const zoneA_ID = 1;
const zoneB_ID = 2;
const zoneC_ID = 3;

const zoneA_Coords = {x: 3, y: 3};
const zoneB_Coords = {x: 3, y: 3};
const zoneC_Coords = {x: 3, y: 3};

const baseCoords = {x : -1, y: -1}
const latestDistances = { "0": null, "1": null, "2": null };
let coordBuffer = [];
const smoothingFactor = 10;
let stableCoords = {x: 0, y: 0};

async function selectEnvironment(distance) {
    const button = distance === 1 ? btn1m : btn3m;
    if (!device) {
        try {
            await connectBluetooth();
            // Give the BLE stack a moment to breathe
            await new Promise(r => setTimeout(r, 600)); 
        } catch (err) {
            statusText.innerText = "Connection required.";
            return;
        }
    }

    if (state !== "idle" || sampling) return;

    // RESET EVERYTHING BEFORE STARTING
    calibrationBuffer = []; 
    sampling = true; 

    button.disabled = true;
    statusText.innerText = `Calibrating ${distance}m...`;

    let start = null;
    const duration = calibrationDuration;

    function animate(timestamp) {
        if (!start) start = timestamp;
        let elapsed = timestamp - start;
        let percent = Math.min((elapsed / duration) * 100, 100);
        
        
        if (elapsed < duration) {
            requestAnimationFrame(animate);
        } else {
            // End of timer
            finalizeCalibration(distance);
        }
    }
    requestAnimationFrame(animate);
}

function finalizeCalibration(distance) {
    // 1. STOP SAMPLING IMMEDIATELY
    sampling = false;

    // 2. DEFINE BUTTON AT THE START (Fixes your ReferenceError)
    const button = distance === 1 ? btn1m : btn3m;
    button.disabled = false;

    console.log("Finalizing... Buffer count:", calibrationBuffer.length);

    // 3. CHECK BUFFER
    if (calibrationBuffer.length === 0) {
        statusText.innerText = "Error: No signal from Node 0!";
        console.error("Calibration failed: Buffer is empty.");
        return;
    }
    
    const averageRSSI = calibrationBuffer.reduce((a, b) => a + b, 0) / calibrationBuffer.length;

    if (distance === 1) {
        rssiAt1m = averageRSSI;
        console.log(`[CALIBRATION] 1m set: ${rssiAt1m.toFixed(2)}`);
    } else {
        rssiAt3m = averageRSSI;
        console.log(`[CALIBRATION] 3m set: ${rssiAt3m.toFixed(2)}`);
    }

    // Calculate N-Factor if both exist
    if (rssiAt1m !== null && rssiAt3m !== null) {
        n_factor = (rssiAt1m - rssiAt3m) / 4.771;
        if (n_factor < 2.0) n_factor = 2.0; 
        console.log(`[CALIBRATION] New n_factor: ${n_factor.toFixed(2)}`);
    }

    calibratedEnvs.add(distance);
    btn1m.classList.toggle("active", calibratedEnvs.has(1));
    btn3m.classList.toggle("active", calibratedEnvs.has(3));
    
    progressText.innerText = `Calibration Progress: ${calibratedEnvs.size} / 2`;

    if (calibratedEnvs.size === 2) {
        summonBtn.disabled = false;
        statusText.innerText = "Ready!";
    }
}

/* RECALIBRATE BUTTON */
recalibrateBtn.addEventListener("click", () => {
    if (state !== "idle" || sampling) return;

    calibratedEnvs.clear();
    btn1m.classList.remove("active");
    btn3m.classList.remove("active");
    progressText.innerText = "Calibration Progress: 0 / 2";
    summonBtn.disabled = true;
    statusText.innerText = "Calibration reset. Select both environments.";

    n_factor = null;
    rssiAt1m = null;
    rssiAt3m = null; 
    console.log(`n factor: ${n_factor} | 1m rssi: ${rssiAt1m} | 3m rssi: ${rssiAt3m}`);

});

/* SUMMON BUTTON */
summonBtn.addEventListener("click", async () => {
    // If not connected yet, connect to ESP32 (get thru browser security thing)
    if (!device) {
        await connectBluetooth();
    }

    if (state === "idle") summonBot();
    else if (state === "arrived") returnToBase();
});

function summonBot() {

    if (coordBuffer.length < 1) {
        statusText.innerText = "Error: No location data received yet.";
        console.warn(`coords buffer < 1. buffer: ${coordBuffer}`)
        return;
    }

    if(!stableCoords.x || !stableCoords.y) {
        statusText.innerText = "Error: no coordinates received yet. Please try again in 5 seconds.";
        console.warn(`stable coords empty. x: ${stableCoords.x}, y: ${stableCoords.y}`)
        return;
    }

    // change state, lock buttons, update status text
    state = "going";
    lockEnvironment(true);
    summonBtn.disabled = true;
    statusText.innerText = "Bot en route...";
    bot.style.transition = `transform ${travelTime}s ease-in-out`;
    bot.style.transform = "translate(300px, -150px)";

    // Use the averaged stable coordinates
    const targetX = stableCoords.x;
    const targetY = stableCoords.y;

    sendBleSignal(1, true, currentClosestZone); // Send '1' to start moving


    // status update after movement
    setTimeout(() => {
        state = "arrived";
        summonBtn.disabled = false;
        summonBtn.innerText = "RETURN TO BASE";
        statusText.innerText = `Bot arrived at (${targetX.toFixed(2)}m, ${targetY.toFixed(2)}m)`;

        sendBleSignal(0, true, currentClosestZone); // Send '0' to stop

    }, travelTime * 1000);
}

function returnToBase() {
    state = "returning";
    summonBtn.disabled = true;
    summonBtn.innerText = "RETURNING...";
    statusText.innerText = "Returning to base...";

    // PHYSICAL SIGNAL
    sendBleSignal(2, true, currentClosestZone); // Send '2' for return command

    bot.style.transform = "translate(0px, 0px)";

    setTimeout(() => {
        state = "idle";
        summonBtn.innerText = "SUMMON";

        // PHYSICAL SIGNAL
        sendBleSignal(0, true, currentClosestZone); // Send '0' to stop

        calibratedEnvs.clear();
        btn1m.classList.remove("active");
        btn3m.classList.remove("active");
        progressText.innerText = "Calibration Progress: 0 / 2";
        lockEnvironment(false);
        statusText.innerText = "Calibration required.";
    }, travelTime * 1000);
}

function lockEnvironment(lock) {
    // btn1m.disabled = lock;
    // btn3m.disabled = lock;
    // recalibrateBtn.disabled = lock;

    console.log(`environment lock set to: ${lock}`);
}

// ======= Functions specific to BLE trilateration subsystem =====================
// For sending a connection to the ESP32 with specific UUID
async function connectBluetooth() {
    try {
        statusText.innerText = "Status: Pairing Bluetooth...";
        device = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'Summon' }], 
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

async function sendBleSignal(signal, isPriority = false, zoneID) {
    // If a heartbeat is happening and this is a priority command (move commands), wait slightly
    if (writeInProgress && isPriority) {
        await new Promise(res => setTimeout(res, 100)); // Short 100ms pause
    }

    if (!characteristic || writeInProgress) return;

    writeInProgress = true;
    try {
        await characteristic.writeValue(new Uint8Array([signal, zoneID]));
        console.log(`BLE sent. Signal: ${signal} | Coordinates: ${xCoord}, ${yCoord} | ZoneID: ${zoneID}`);
    } catch (error) {
        console.log(`Heartbeat failed or GATT busy. isPriority: ${isPriority}`);
    } finally {
        writeInProgress = false;
    }
}

function handleNotification(event) {
    const decoder = new TextDecoder();
    const rawValue = decoder.decode(event.target.value).trim();
    
    let id = null;
    let rawRssi = NaN;

    // 1. Try parsing the simple "0:-70" format seen in your console
    if (rawValue.includes(":")) {
        const parts = rawValue.split(":");
        // If there's more than one colon (like "Node 0 | RSSI: -70"), 
        // we handle that by taking the last part as RSSI
        if (parts.length === 2) {
            id = parts[0].trim();
            rawRssi = parseInt(parts[1]);
        } else {
            // Backup: Try regex if it's the more complex string
            const idMatch = rawValue.match(/Node\s*(\d+)/i);
            const rssiMatch = rawValue.match(/RSSI:\s*(-?\d+)/i);
            if (idMatch) id = idMatch[1];
            if (rssiMatch) rawRssi = parseInt(rssiMatch[1]);
        }
    }

    // 2. If we successfully found an ID and a valid RSSI number
    if (id !== null && !isNaN(rawRssi)) {
        const filteredRssi = processSignal(id, rawRssi);    
        
        // Calibration Logic (Node 0)
        // can comment out if not needed
        if (sampling && id === "0") {
            calibrationBuffer.push(filteredRssi);
            console.log(`✅ MATCH! Node ${id} added to buffer. Count: ${calibrationBuffer.length}`);
        }

        // Live Tracking Logic
        if (calibratedEnvs.size === 2) {
            const distance = calculateDistance(filteredRssi);
            const floorDistance = calculateFloorDistance(distance);
            latestDistances[id] = floorDistance;
            
            console.log(`📡 Tracking Node ${id}: ${floorDistance.toFixed(2)}m`);
            checkAndTrilaterate();
        }
    } else {
        console.log("⚠️ Still can't parse this string:", rawValue);
    }

    // 3. estimate closest zone if have stable coords
    if (stableCoords.x && stableCoords.y) {
        currentClosestZone = estimateZone(stableCoords);

        switch (currentClosestZone) {
        case zoneA_ID:
            console.log("📍 Estimated Zone: A");
            break;
        case zoneB_ID:
            console.log("📍 Estimated Zone: B");
            break;
        case zoneC_ID:
            console.log("📍 Estimated Zone: C");
            break;
        default:
            console.log("No Zone Estimated due to missing stable coordinates.");
        }
    }
}



// Kalman Filter Logic
class RSSIKalmanFilter {
  constructor(initialRSSI = -60) {
    // Expected movement speed of user (0.01 = slow/stable, 0.1 = fast movement)
    this.processChangeRate = 0.1; 

    // The dBm fluctuation you see in your raw data
    // 2 - 10 based on '10dBm'
    this.measurementNoise = 3.0; 

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

// Calibration Logic
function calculateDistance(rssi) {
    // Check for null or if n_factor is invalid (0 or negative)
    if (rssiAt1m === null || n_factor <= 0 || n_factor == null) return -1;

    const exponent = (rssiAt1m - rssi) / (10 * n_factor);
    return Math.pow(10, exponent);
}

// Trilateration Logic
function calculateFloorDistance(distance)
{
    if(distance === null || distance < 0) return -1;

    // If the reported distance is smaller than the height of the phone,
    // assume the floor distance = 0 to avoid square rooting a negative.
    const diff = distance**2 - userHeight**2;
    return diff > 0? Math.sqrt(diff) : 0;
}

function trilaterate(d0, d1, d2) // returns object w/ x & y coords
{
    const p0 = snifferAnchors[0];
    const p1 = snifferAnchors[1];
    const p2 = snifferAnchors[2];

    // Subtracting circle equations to linearize: (x-x_i)^2 + (y-y_i)^2 = d_i^2
    const A = 2 * p1.x - 2 * p0.x;
    const B = 2 * p1.y - 2 * p0.y;
    const C = d0**2 - d1**2 - p0.x**2 + p1.x**2 - p0.y**2 + p1.y**2;
    const D = 2 * p2.x - 2 * p1.x;
    const E = 2 * p2.y - 2 * p1.y;
    const F = d1**2 - d2**2 - p1.x**2 + p2.x**2 - p1.y**2 + p2.y**2;

    const denominator = (A * E - D * B);
    
    // Check for division by zero (happens if anchors are collinear)
    if (Math.abs(denominator) < 0.0001) return null;

    const x = (C * E - F * B) / denominator;
    const y = (A * F - D * C) / denominator;

    return { x, y };

}

// Helper to keep trilateration clean
function checkAndTrilaterate() {
    if (latestDistances["0"] !== null && latestDistances["1"] !== null && latestDistances["2"] !== null) {
        const coords = trilaterate(latestDistances["0"], latestDistances["1"], latestDistances["2"]);
        if (coords) {
            // Update stableCoords and buffer...
            console.log("📍 Position Calculated:", coords);
        }
    }
}

// to estimate closest zone (A, B, or C) based on current coordinates and zone coordinates
function estimateZone(coords) {
    const distToA = Math.hypot(coords.x - zoneA_Coords.x, coords.y - zoneA_Coords.y);
    const distToB = Math.hypot(coords.x - zoneB_Coords.x, coords.y - zoneB_Coords.y);
    const distToC = Math.hypot(coords.x - zoneC_Coords.x, coords.y - zoneC_Coords.y);

    const minDist = Math.min(distToA, distToB, distToC);

    if (minDist === distToA) return zoneA_ID;
    if (minDist === distToB) return zoneB_ID;
    if (minDist === distToC) return zoneC_ID;

    return -1; // If no zone is closest
}

// Other
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
