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
const latestDistances = { "0": null, "1": null, "2": null };
let coordBuffer = [];
const smoothingFactor = 10;
let stableCoords = {x: 0, y: 0};

// async function selectEnvironment(distance) {

//     // If not connected, trigger the pairing popup
//     if (!device) {
//         try {
//             await connectBluetooth();
//             await new Promise(res => setTimeout(res, 500));
//         } catch (err) {
//             statusText.innerText = "Connection required to calibrate.";
//             return; // Exit if user cancels the Bluetooth popup
//         }
//     }

//     if (state !== "idle" || sampling) return;

//     const button = distance === 1 ? btn1m : btn3m;

//     sampling = true;
//     button.disabled = true;
//     statusText.innerText = `Calibrating ${distance}m environment...`;

//     const duration = calibrationDuration;
//     let start = null;

//     // Create progress overlay
//     const progressOverlay = document.createElement("div");
//     progressOverlay.style.position = "absolute";
//     progressOverlay.style.left = "0";
//     progressOverlay.style.top = "0";
//     progressOverlay.style.height = "100%";
//     progressOverlay.style.width = "0%";
//     progressOverlay.style.borderRadius = "30px";
//     progressOverlay.style.background = "rgba(255,255,255,0.4)";
//     progressOverlay.style.transition = "width 0.05s linear";

//     button.style.position = "relative";
//     button.style.overflow = "hidden";
//     button.appendChild(progressOverlay);

//     function animate(timestamp) {
//         if (!start) start = timestamp;
//         let elapsed = timestamp - start;
//         let percent = Math.min((elapsed / duration) * 100, 100);
//         progressOverlay.style.width = percent + "%";

//         if (elapsed < duration) {
//             requestAnimationFrame(animate);
//         } else {
//             button.removeChild(progressOverlay);
//             finalizeCalibration(distance);
//         }
//     }

//     requestAnimationFrame(animate);
// }

// function finalizeCalibration(distance) {
//     // If temp array empty, show failed
//     if (calibrationBuffer.length === 0) {
//         console.error("No signal detected! Calibration failed. Please try again.");
//         sampling = false;
//         button.disabled = false; 
//         return;
//     }
    
//     // calculate average of signals, save to respective vars
//     const averageRSSI = calibrationBuffer.reduce((a, b) => a + b, 0) / calibrationBuffer.length;

//     if (distance === 1) {
//         rssiAt1m = averageRSSI; // We now have 'A'
//         console.log(`[CALIBRATION] 1m Baseline (A) set to: ${rssiAt1m.toFixed(2)}`);
//     } 
//     else if (distance === 3) {
//         rssiAt3m = averageRSSI;
//         console.log(`[CALIBRATION] 3m Reference set to: ${rssiAt3m.toFixed(2)}`);
//     }
    

//     // Calculate Path Loss Exponent (n) only if both are done
//     if (rssiAt1m !== null && rssiAt3m !== null) {
//         /* Formula for n: (RSSI_1m - RSSI_3m) / (10 * log10(d2/d1))
//            Since d2=3 and d1=1: 10 * log10(3) = 4.771
//         */
//         n_factor = (rssiAt1m - rssiAt3m) / 4.771;
        
//         // Sanity check: n is usually between 1.5 and 4.5
//         if (n_factor < 2.0) {
//             n_factor = 2.0;
//             console.warn("Calculated n was too low (" + n_factor.toFixed(2) + "). Forcing n = 2.0");        
//         }
        
//         console.log(`[CALIBRATION] Calculated Path Loss Exponent (n): ${n_factor.toFixed(2)}`);
//     }

//     // UI handling
//     calibratedEnvs.add(distance);

//     btn1m.classList.toggle("active", calibratedEnvs.has(1));
//     btn3m.classList.toggle("active", calibratedEnvs.has(3));

//     progressText.innerText = `Calibration Progress: ${calibratedEnvs.size} / 2`;

//     if (calibratedEnvs.size === 2) {
//         summonBtn.disabled = false;
//         statusText.innerText = "System calibrated. Ready for deployment.";
//         travelTime = 3;
//     } else {
//         statusText.innerText = "Calibration in progress...";
//     }

//     sampling = false;
//     const button = distance === 1 ? btn1m : btn3m;
//     button.disabled = false;

//     calibrationBuffer = [];
// }

async function selectEnvironment(distance) {
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

    const button = distance === 1 ? btn1m : btn3m;
    button.disabled = true;
    statusText.innerText = `Calibrating ${distance}m...`;

    let start = null;
    const duration = calibrationDuration;

    function animate(timestamp) {
        if (!start) start = timestamp;
        let elapsed = timestamp - start;
        let percent = Math.min((elapsed / duration) * 100, 100);
        
        // If you have a progress bar element, update it here
        
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
        return;
    }

    state = "going";
    lockEnvironment(true);
    summonBtn.disabled = true;
    statusText.innerText = "Bot en route...";
    bot.style.transition = `transform ${travelTime}s ease-in-out`;
    bot.style.transform = "translate(300px, -150px)";

    // PHYSICAL SIGNAL
    sendBleSignal(1); // Send '1' to start moving

    // Use the averaged stable coordinates
    const targetX = stableCoords.x;
    const targetY = stableCoords.y;

    setTimeout(() => {
        state = "arrived";
        summonBtn.disabled = false;
        summonBtn.innerText = "RETURN TO BASE";
        statusText.innerText = `Bot arrived at (${targetX.toFixed(2)}m, ${targetY.toFixed(2)}m)`;

        // PHYSICAL SIGNAL
        sendBleSignal(0); // Send '0' to stop

    }, travelTime * 1000);
}

function returnToBase() {
    state = "returning";
    summonBtn.disabled = true;
    summonBtn.innerText = "RETURNING...";
    statusText.innerText = "Returning to base...";

    // PHYSICAL SIGNAL
    sendBleSignal(2); // Send '2' for return command

    bot.style.transform = "translate(0px, 0px)";

    setTimeout(() => {
        state = "idle";
        summonBtn.innerText = "SUMMON";

        // PHYSICAL SIGNAL
        sendBleSignal(0); // Send '0' to stop

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

function handleNotification(event) {
    const decoder = new TextDecoder();
    const value = decoder.decode(event.target.value);

    // ID + RSSI Parsing (assuming format "ID:RSSI")
    if (value.includes(":")) {
        const [id, rssiStr] = value.split(":");
        const rawRssi = parseInt(rssiStr);
        // Safety: If parsing fails, ignore the packet
        if (isNaN(rawRssi)) return;
        const filteredRssi = processSignal(id, rawRssi);    
        
        // if sampling for calibration, add to the calibration buffer list ONLY FROM NODE 0
        if (sampling && id.trim() === "0") {
            calibrationBuffer.push(filteredRssi);
            console.log(`Buffer Size: ${calibrationBuffer.length} | Value: ${filteredRssi}`);
            console.log(`Calibrating with Node 0... Current: ${filteredRssi.toFixed(2)}`);
        }

        // If system is calibrated, 
        if (calibratedEnvs.size === 2) {
            // calculate and show real distance for ALL 3 NODES
            const distance = calculateDistance(filteredRssi);
            
            // calculate actual floor distance (since user's phone will be off the ground)
            const floorDistance = calculateFloorDistance(distance);
            console.log(`Node ${id}: ${distance.toFixed(2)}m away | Floor dist: ${floorDistance.toFixed(2)}m away`);

            // update distances from all 3 nodes into an array for trilateration
            latestDistances[id] = floorDistance;

            // trilaterate if have distances from all 3 nodes
            if (latestDistances["0"] && latestDistances["1"] && latestDistances["2"]) {
                const rawCoords = trilaterate(
                    latestDistances["0"], 
                    latestDistances["1"], 
                    latestDistances["2"]
                );

                if (rawCoords) {
                    // 1. Add raw math result to Rolling Buffer (Prevents Teleporting)
                    coordBuffer.push({ x: rawCoords.x, y: rawCoords.y });
                    if (coordBuffer.length > smoothingFactor) coordBuffer.shift();

                    // 2. Update the background "Stable Target"
                    stableCoords.x = coordBuffer.reduce((sum, p) => sum + p.x, 0) / coordBuffer.length;
                    stableCoords.y = coordBuffer.reduce((sum, p) => sum + p.y, 0) / coordBuffer.length;

                    console.log(`Current coords (averaged): (${coords.x.toFixed(2)}, ${coords.y.toFixed(2)})`);
                }
            }
            
            else { console.log("Failed to trilaterate due to missing value(s)."); }
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

function trilaterate(d0, d1, d2) 
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

// Other
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
