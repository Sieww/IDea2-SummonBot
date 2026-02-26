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
let sampling = false;

// ===== BLE UUIDs =====
const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";

let device = null;
let characteristic = null;
let keepAliveInterval = null;
let writeInProgress = false;

// ===== Signal Variables =====
const activeNodes = {};
let calibrationBuffer = [];
let rssiAt1m = null;
let rssiAt3m = null;
let n_factor = 2.0;

const calibrationDuration = 4000;

// =============================
// RESET FUNCTION (Single Source of Truth)
// =============================
function resetCalibration() {
    calibratedEnvs.clear();

    btn1m.classList.remove("active");
    btn3m.classList.remove("active");

    progressText.innerText = "Calibration Progress: 0 / 2";
    summonBtn.disabled = true;

    rssiAt1m = null;
    rssiAt3m = null;
    n_factor = 2.0;
    calibrationBuffer = [];

    sampling = false;

    console.log("[RESET] Calibration fully cleared.");
}

// =============================
// ENV BUTTONS
// =============================
btn1m.addEventListener("click", async () => await selectEnvironment(1));
btn3m.addEventListener("click", async () => await selectEnvironment(3));

async function selectEnvironment(distance) {
    if (!device) {
        try {
            await connectBluetooth();
        } catch {
            statusText.innerText = "Connection required to calibrate.";
            return;
        }
    }

    if (state !== "idle" || sampling) return;

    calibrationBuffer = [];

    const button = distance === 1 ? btn1m : btn3m;
    sampling = true;
    button.disabled = true;
    statusText.innerText = `Calibrating ${distance}m environment...`;

    const duration = calibrationDuration;
    let start = null;

    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.height = "100%";
    overlay.style.width = "0%";
    overlay.style.borderRadius = "30px";
    overlay.style.background = "rgba(255,255,255,0.4)";
    overlay.style.transition = "width 0.05s linear";

    button.style.position = "relative";
    button.style.overflow = "hidden";
    button.appendChild(overlay);

    function animate(timestamp) {
        if (!start) start = timestamp;
        const elapsed = timestamp - start;
        const percent = Math.min((elapsed / duration) * 100, 100);
        overlay.style.width = percent + "%";

        if (elapsed < duration) {
            requestAnimationFrame(animate);
        } else {
            button.removeChild(overlay);
            finalizeCalibration(distance);
        }
    }

    requestAnimationFrame(animate);
}

function finalizeCalibration(distance) {
    if (calibrationBuffer.length === 0) {
        console.error("No signal detected!");
        sampling = false;
        return;
    }

    const avg = calibrationBuffer.reduce((a, b) => a + b, 0) / calibrationBuffer.length;

    if (distance === 1) {
        rssiAt1m = avg;
    } else {
        rssiAt3m = avg;
    }

    if (rssiAt1m !== null && rssiAt3m !== null) {
        n_factor = (rssiAt1m - rssiAt3m) / 4.771;
        if (n_factor <= 0 || n_factor > 6) n_factor = 2.0;
        console.log("Calculated n:", n_factor.toFixed(2));
    }

    calibratedEnvs.add(distance);

    btn1m.classList.toggle("active", calibratedEnvs.has(1));
    btn3m.classList.toggle("active", calibratedEnvs.has(3));

    progressText.innerText = `Calibration Progress: ${calibratedEnvs.size} / 2`;

    if (calibratedEnvs.size === 2) {
        summonBtn.disabled = false;
        statusText.innerText = "System calibrated. Ready for deployment.";
        travelTime = 3;
    } else {
        statusText.innerText = "Calibration in progress...";
    }

    sampling = false;
    button = distance === 1 ? btn1m : btn3m;
    button.disabled = false;
    calibrationBuffer = [];
}

// =============================
// RESET BUTTON
// =============================
recalibrateBtn.addEventListener("click", () => {
    if (state !== "idle") return;
    resetCalibration();
    statusText.innerText = "Calibration reset. Select both environments.";
});

// =============================
// SUMMON BUTTON
// =============================
summonBtn.addEventListener("click", async () => {
    if (!device) await connectBluetooth();

    if (state === "idle") summonBot();
    else if (state === "arrived") returnToBase();
});

function summonBot() {
    state = "going";
    lockEnvironment(true);
    summonBtn.disabled = true;
    statusText.innerText = "Bot en route...";

    bot.style.transition = `transform ${travelTime}s ease-in-out`;
    bot.style.transform = "translate(300px, -150px)";

    sendBleSignal(1);

    setTimeout(() => {
        state = "arrived";
        summonBtn.disabled = false;
        summonBtn.innerText = "RETURN TO BASE";
        statusText.innerText = "Bot arrived.";
        sendBleSignal(0);
    }, travelTime * 1000);
}

function returnToBase() {
    state = "returning";
    summonBtn.disabled = true;
    summonBtn.innerText = "RETURNING...";
    statusText.innerText = "Returning to base...";

    sendBleSignal(2);
    bot.style.transform = "translate(0px, 0px)";

    setTimeout(() => {
        state = "idle";
        summonBtn.innerText = "SUMMON";
        sendBleSignal(0);
        resetCalibration();
        lockEnvironment(false);
        statusText.innerText = "Calibration required.";
    }, travelTime * 1000);
}

function lockEnvironment(lock) {
    btn1m.disabled = lock;
    btn3m.disabled = lock;
    recalibrateBtn.disabled = lock;
}

// =============================
// BLE + SIGNAL PROCESSING
// =============================
async function connectBluetooth() {
    statusText.innerText = "Pairing Bluetooth...";
    device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "Summon" }],
        optionalServices: [SERVICE_UUID]
    });

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    statusText.innerText = "Bluetooth Connected!";
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", handleNotification);

    keepAliveInterval = setInterval(() => sendBleSignal(9), 3000);
}

async function sendBleSignal(value) {
    if (!characteristic || writeInProgress) return;

    writeInProgress = true;
    try {
        await characteristic.writeValue(new Uint8Array([value]));
    } catch {}
    writeInProgress = false;
}

function handleNotification(event) {
    const decoder = new TextDecoder();
    const value = decoder.decode(event.target.value);

    if (!value.includes(":")) return;

    const [id, rssiStr] = value.split(":");
    const raw = parseInt(rssiStr);
    const filtered = processSignal(id, raw);

    if (sampling && id === "0") {
        calibrationBuffer.push(filtered);
    }

    if (calibratedEnvs.size === 2 && rssiAt1m !== null) {
        const dist = calculateDistance(filtered);
        console.log(`Node ${id}: ~ ${dist.toFixed(2)}m`);
    }
}

class RSSIKalmanFilter {
    constructor(initialRSSI) {
        this.processChangeRate = 0.3;
        this.measurementNoise = 5.0;
        this.currentEstimate = initialRSSI;
        this.errorCovariance = 1.0;
    }

    filter(raw) {
        this.errorCovariance += this.processChangeRate;
        const k = this.errorCovariance / (this.errorCovariance + this.measurementNoise);
        this.currentEstimate += k * (raw - this.currentEstimate);
        this.errorCovariance *= (1 - k);
        return this.currentEstimate;
    }
}

function processSignal(id, raw) {
    if (!activeNodes[id]) {
        activeNodes[id] = new RSSIKalmanFilter(raw);
    }
    return activeNodes[id].filter(raw);
}

function calculateDistance(rssi) {
    if (rssiAt1m === null || n_factor <= 0) return -1;
    const exponent = (rssiAt1m - rssi) / (10 * n_factor);
    return Math.pow(10, exponent);
}